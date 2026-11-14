import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Player } from '../types'

// voice-reader: speaks Claude's replies with an offline Kokoro voice.
//
// This module is the control layer; ../backend/vr.py does the audio. Everything is kept
// per session (keyed by the session id), so each Claude window shows and plays only its
// own reply. Audio is cached by its text: Replay, Resume and the section buttons reuse
// what was already made. The bar reads the backend's now.json on a timer, so polling
// starts no processes.

const mode = atom({ plugin: 'voice-reader', key: 'mode' } as const, 'summary' as Mode)
const player = atom({ plugin: 'voice-reader', key: 'player' } as const, 'idle' as Player)
const sections = atom({ plugin: 'voice-reader', key: 'sections' } as const, [] as string[])
const active = atom({ plugin: 'voice-reader', key: 'active' } as const, -1)
const elsewhere = atom({ plugin: 'voice-reader', key: 'elsewhere' } as const, false)
const error = atom({ plugin: 'voice-reader', key: 'error' } as const, '')

const MODES: Mode[] = ['off', 'summary', 'full']
const POLL_MS = 1000
const STALE_S = 5 // a runner that has not beaten for this long is gone
const SHORT = 350 // replies this short are spoken as written, no summary needed

const SUMMARY_PROMPT = (question: string, reply: string) => `You turn a coding assistant's written reply into what it would say out loud to the user, like a colleague giving a quick verbal update.

The user said: ${question.slice(0, 1500)}

The written reply:
${reply.slice(0, 12000)}

Rules:
- If the user asked to explain, describe, or walk through something, explain it conversationally in up to 6 short sentences.
- Otherwise say only the outcome and anything the user must decide or do, in 1 to 3 short sentences.
- Never read code, file paths, URLs, commands, tables, or markdown. Say "I changed the hook script", not the path.
- Plain spoken English. Output only the words to speak.`

type Options = { voice: string; speed: string; model: string; summaryModel: string }
type Now = { sid?: string; index?: number; state?: string; paused?: boolean; hb?: number; error?: string }

let opts: Options = { voice: 'af_heart', speed: '1.0', model: 'full', summaryModel: 'haiku' }
let dataDir = ''
let lastSections = ''
let generation = 0 // bumped by Stop and by a new prompt: a summary still being written is dropped

function q<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s.trim().split('\n').at(-1) ?? '') as T
  } catch {
    return fallback
  }
}

async function home($: EngineInterface): Promise<string> {
  if (dataDir) return dataDir
  const custom = await $.env.get('VOICE_READER_HOME')
  dataDir = custom || `${(await $.env.get('HOME')) ?? ''}/.claude/voice-reader`
  return dataDir
}

async function vr($: EngineInterface, args: string[], stdin?: string): Promise<string> {
  const r = await $.process
    .run(['/usr/bin/env', 'python3', `${$.plugin.root}/backend/vr.py`, ...args], {
      stdin,
      timeoutMs: 20000,
      env: {
        VOICE_READER_HOME: await home($),
        VOICE_READER_VOICE: opts.voice,
        VOICE_READER_SPEED: opts.speed,
        VOICE_READER_MODEL: opts.model,
      },
    })
    .catch((err: unknown) => ({ stdout: '', stderr: String(err) }))
  return r.stdout
}

// Each write happens only when the value changed, so an idle poll redraws nothing.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
async function setPlayer($: EngineInterface, v: Player) {
  if (!same(await read($, player), v)) await update($, player, () => v)
}
async function setActive($: EngineInterface, v: number) {
  if (!same(await read($, active), v)) await update($, active, () => v)
}
async function setElsewhere($: EngineInterface, v: boolean) {
  if (!same(await read($, elsewhere), v)) await update($, elsewhere, () => v)
}
async function setError($: EngineInterface, v: string) {
  if (!same(await read($, error), v)) await update($, error, () => v)
}
async function setSections($: EngineInterface, v: string[]) {
  if (!same(await read($, sections), v)) await update($, sections, () => v)
}
async function setModeAtom($: EngineInterface, v: Mode) {
  if (!same(await read($, mode), v)) await update($, mode, () => v)
}

// ---------- reading state (no processes) ----------

async function refresh($: EngineInterface) {
  const sid = await $.session.id()
  const dir = await home($)
  const now = q<Now>(String(await $.fs.read(`${dir}/now.json`).catch(() => '')), {})
  const alive = typeof now.hb === 'number' && Date.now() / 1000 - now.hb < STALE_S
  const mine = alive && now.sid === sid
  const busy = (await read($, player)) === 'preparing' && generation > 0 && !alive // writing a summary
  if (!busy) {
    const st: Player = !mine
      ? 'idle'
      : now.paused
        ? 'paused'
        : (['preparing', 'installing', 'downloading', 'playing', 'error'] as const).find(s => s === now.state) ?? 'preparing'
    await setPlayer($, st)
    await setActive($, mine && typeof now.index === 'number' ? now.index : -1)
    await setError($, mine && now.state === 'error' ? (now.error ?? 'error') : '')
  }
  await setElsewhere($, alive && now.sid !== sid)

  const raw = String(await $.fs.read(`${dir}/sessions/${sid}/sections.json`).catch(() => ''))
  const key = `${sid}:${raw.length}:${raw.slice(0, 64)}`
  if (key !== lastSections) {
    lastSections = key
    const titles = q<{ titles?: unknown[] }>(raw, {}).titles
    await setSections($, Array.isArray(titles) ? titles.map(String) : [])
  }

  const saved = String(await $.fs.read(`${dir}/mode`).catch(() => '')).trim()
  if (saved === 'off' || saved === 'summary' || saved === 'full') await setModeAtom($, saved)
}

// ---------- actions ----------

// Make sure this session's latest reply has a spoken summary (made once per reply).
async function ensureSummary($: EngineInterface, sid: string, gen: number): Promise<boolean> {
  const dir = `${await home($)}/sessions/${sid}`
  const reply = q<{ hash?: string; reply?: string; question?: string }>(
    String(await $.fs.read(`${dir}/reply.json`).catch(() => '')), {})
  const cached = q<{ hash?: string }>(String(await $.fs.read(`${dir}/summary.json`).catch(() => '')), {})
  if (!reply.hash || cached.hash === reply.hash) return true
  if (opts.summaryModel === 'none' || (reply.reply ?? '').length <= SHORT) {
    if ((reply.reply ?? '').length <= SHORT) await vr($, ['summary', sid, reply.hash], reply.reply ?? '')
    return true // 'none': the backend reads the opening sentences
  }
  const r = await $.model
    .complete({ model: opts.summaryModel, prompt: SUMMARY_PROMPT(reply.question ?? '', reply.reply ?? ''), maxTokens: 400 })
    .catch(() => undefined)
  if (gen !== generation) return false // stopped, or a newer reply came in, while it was written
  if (r && r.isAnswered && r.text.trim()) await vr($, ['summary', sid, reply.hash], r.text.trim())
  return true
}

async function play($: EngineInterface, from?: number) {
  const sid = await $.session.id()
  const gen = ++generation
  await setPlayer($, 'preparing')
  await setActive($, from ?? -1)
  const m = await read($, mode)
  if (from === undefined && m !== 'full') {
    if (!(await ensureSummary($, sid, gen))) return
    await vr($, ['play', sid, 'summary'])
  } else {
    await vr($, ['play', sid, 'full', String(from ?? 0)])
  }
  generation = 0
  await refresh($)
}

async function toggle($: EngineInterface) {
  const state = await read($, player)
  if (state === 'idle' || state === 'error') return play($)
  await vr($, ['toggle', await $.session.id()])
  await refresh($)
}

async function stop($: EngineInterface) {
  generation = 0
  await vr($, ['stop', await $.session.id()])
  await setPlayer($, 'idle')
  await refresh($)
}

async function setMode($: EngineInterface, m: Mode) {
  await $.fs.write(`${await home($)}/mode`, `${m}\n`)
  await setModeAtom($, m)
  if (m === 'off') await stop($)
}

// A reply just finished: store it, show its sections, speak it per the mode.
async function onReply($: EngineInterface, reply: string) {
  const sid = await $.session.id()
  const msgs = await $.session.messages().catch(() => [])
  const question = [...msgs].reverse().find(m => m.role === 'user' && m.text.trim())?.text ?? ''
  const saved = q<{ titles?: string[] }>(await vr($, ['save', sid], JSON.stringify({ reply, question })), {})
  await setSections($, saved.titles ?? [])
  if ((await read($, mode)) !== 'off') await play($)
}

// ---------- registration ----------

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Partial<Options>
  opts = {
    voice: String(o.voice || 'af_heart'),
    speed: String(o.speed || '1.0'),
    model: o.model === 'int8' ? 'int8' : 'full',
    summaryModel: String(o.summaryModel || 'haiku'),
  }

  on('session.start', async ($, e, next) => {
    await refresh($).catch(() => undefined)
    await $.command.register({
      name: 'speak',
      description: 'Voice: off | summary | full | play | stop | replay | setup | <n> (from section n); no arg cycles the mode',
      argumentHint: 'off|summary|full|play|stop|replay|setup|<section number>',
    })
    void (async () => {
      for (;;) {
        await $.clock.sleep(POLL_MS)
        await refresh($).catch(() => undefined)
      }
    })()
    return next(e)
  })

  // The reply is complete (the settings hooks' Stop event, which carries its text).
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    const headless = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'sdk-cli'
    const reply = e.last_assistant_message ?? ''
    if (!headless && reply.trim()) void onReply($, reply).catch(() => undefined)
    return done
  })

  // A new prompt in this session stops this session's voice (other sessions keep playing).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const state = await read($, player)
    if (state !== 'idle') void stop($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      const cur = await read($, mode)
      const m = MODES[(MODES.indexOf(cur) + 1) % MODES.length] ?? 'off'
      await setMode($, m)
      return { text: `Voice: ${m}` }
    }
    if (arg === 'off' || arg === 'summary' || arg === 'full') {
      await setMode($, arg)
      return { text: `Voice: ${arg}` }
    }
    if (arg === 'play' || arg === 'pause') {
      await toggle($)
      return { text: `Voice: ${await read($, player)}` }
    }
    if (arg === 'stop') {
      await stop($)
      return { text: 'Voice: stopped' }
    }
    if (arg === 'replay') {
      void play($)
      return { text: 'Voice: replaying' }
    }
    if (arg === 'setup') {
      const r = await $.process
        .run(['/usr/bin/env', 'python3', `${$.plugin.root}/backend/vr.py`, 'setup'], {
          timeoutMs: 600000,
          env: { VOICE_READER_HOME: await home($), VOICE_READER_MODEL: opts.model },
        })
        .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
      return { text: r.exitCode === 0 ? 'Voice: ready' : `Voice setup failed: ${r.stderr.slice(-400)}` }
    }
    if (/^\d+$/.test(arg)) {
      const list = await read($, sections)
      const i = Number(arg) - 1
      if (i < 0 || i >= list.length) return { text: `Voice: no section ${arg} (the last reply has ${list.length})` }
      void play($, i)
      return { text: `Voice: from section ${arg}, ${list[i]}` }
    }
    return { text: 'Usage: /speak [off|summary|full|play|stop|replay|setup|<section number>]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const m = await read($, mode)
    const state = await read($, player)
    const list = await read($, sections)
    const cur = await read($, active)
    const other = await read($, elsewhere)
    const err = await read($, error)
    const live = state !== "idle" && state !== "error"
    const label = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'
    const status =
      state === 'playing'
        ? 'speaking'
        : state === 'paused'
          ? 'paused'
          : state === 'preparing'
            ? 'preparing voice'
            : state === 'installing'
              ? 'first run: installing voice engine'
              : state === 'downloading'
                ? 'first run: downloading voice model'
                : state === 'error'
                  ? err
                  : other
                    ? 'another session is speaking'
                    : ''
    const where = cur >= 0 && cur < list.length && live ? ` · section ${cur + 1}/${list.length}` : ''

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Voice </Text>
          {MODES.map(x => (
            <Button
              key={`mode-${x}`}
              label={x === 'off' ? 'Off' : x === 'summary' ? 'Summary' : 'Full'}
              variant={m === x ? 'primary' : undefined}
              dimColor={m !== x}
              onPress={() => setMode($, x)}
            />
          ))}
          <Text> </Text>
          <Button key="toggle" label={label} hotkey="p" onPress={() => toggle($)} />
          <Button key="stop" label="Stop" hotkey="s" dimColor onPress={() => stop($)} />
          <Button key="replay" label="Replay" hotkey="r" dimColor onPress={() => play($)} />
          {status !== '' && <Text dimColor> {status}{where}</Text>}
        </Box>
        {list.length > 1 && (
          <Box flexWrap="wrap">
            <Text dimColor>Sections </Text>
            {list.map((title, i) => (
              <Button
                key={`section-${i}`}
                label={`${i + 1} ${title}`}
                variant={i === cur && live ? 'primary' : undefined}
                dimColor={!(i === cur && live)}
                onPress={() => play($, i)}
              />
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
