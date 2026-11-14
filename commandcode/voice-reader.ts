// voice-reader for Command Code: hear each reply, with an offline Kokoro voice.
//
// Same backend as the Claude Code plugin (../backend/vr.py) and the same data folder
// (~/.claude/voice-reader), so the mode, the audio cache and "who holds the speakers" are
// shared. Command Code sessions are stored as cc-<session id>, apart from Claude's.
//
// Install: cmd mods add -g abhinay-hat/voice-reader

import type {ModApi} from '@commandcode/harness';
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type Mode = 'off' | 'summary' | 'full';
type Now = {sid?: string; index?: number; state?: string; paused?: boolean; hb?: number; error?: string};

const MODES: Mode[] = ['off', 'summary', 'full'];
const SHORT = 350; // replies this short are spoken as written
const STALE_S = 5;

const SUMMARY_PROMPT = (question: string, reply: string): string => `You turn a coding assistant's written reply into what it would say out loud to the user, like a colleague giving a quick verbal update.

The user said: ${question.slice(0, 1500)}

The written reply:
${reply.slice(0, 12000)}

Rules:
- If the user asked to explain, describe, or walk through something, explain it conversationally in up to 6 short sentences.
- Otherwise say only the outcome and anything the user must decide or do, in 1 to 3 short sentences.
- Never read code, file paths, URLs, commands, tables, or markdown. Say "I changed the hook script", not the path.
- Plain spoken words in the same language as the written reply. Output only the words to speak.`;

function here(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return typeof __dirname === 'string' ? __dirname : process.cwd();
	}
}

function json<T>(text: string, fallback: T): T {
	try {
		return JSON.parse(text.trim().split('\n').at(-1) ?? '') as T;
	} catch {
		return fallback;
	}
}

function readText(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

export default function (cmd: ModApi): void {
	const backend = process.env.VOICE_READER_BACKEND || resolve(here(), '..', 'backend', 'vr.py');
	const dataDir = process.env.VOICE_READER_HOME || join(homedir(), '.claude', 'voice-reader');
	mkdirSync(dataDir, {recursive: true});

	// Settings: /speak voice <id>, /speak speed <n>, /speak alerts on|off (kept across sessions).
	const setting = (key: string, fallback: string): string => String(cmd.store.get<string>(key) ?? fallback);

	// Headless runs (cmd -p, CI, scripted workers) stay silent: nothing to show, nobody listening.
	const interactive = (): boolean => Boolean(cmd.ui.capabilities.surface);

	let sid = '';
	let question = '';
	let prefix = '';
	let generation = 0; // bumped by stop / a new prompt: a summary still being written is dropped

	const sessionId = (): string => `cc-${sid || 'unknown'}`;

	// Run the backend with the system python3 (it re-launches itself in its own venv for audio).
	const vr = (args: string[], stdin?: string): Promise<string> =>
		new Promise(done => {
			const child = spawn('python3', [backend, ...args], {
				env: {
					...process.env,
					VOICE_READER_HOME: dataDir,
					VOICE_READER_VOICE: setting('voice', 'af_heart'),
					VOICE_READER_SPEED: setting('speed', '1.0'),
					VOICE_READER_MODEL: setting('model', 'full'),
				},
				stdio: ['pipe', 'pipe', 'ignore'],
			});
			let out = '';
			child.stdout.on('data', chunk => (out += String(chunk)));
			child.on('error', () => done(''));
			child.on('close', () => done(out));
			child.stdin.end(stdin ?? '');
		});

	const mode = (): Mode => {
		const m = readText(join(dataDir, 'mode')).trim();
		return m === 'off' || m === 'summary' || m === 'full' ? m : 'summary';
	};
	const setMode = async (m: Mode): Promise<void> => {
		writeFileSync(join(dataDir, 'mode'), `${m}\n`);
		if (m === 'off') await stop();
		refresh();
	};

	// ---------- what the band shows (read from files, no processes) ----------

	type View = {state: string; index: number; other: boolean; titles: string[]; error: string};
	const view = (): View => cmd.state.get<View>('view') ?? {state: 'idle', index: -1, other: false, titles: [], error: ''};

	function refresh(): void {
		const now = json<Now>(readText(join(dataDir, 'now.json')), {});
		const alive = typeof now.hb === 'number' && Date.now() / 1000 - now.hb < STALE_S;
		const mine = alive && now.sid === sessionId();
		const busy = generation > 0 && !alive; // a summary is being written
		const titles = json<{titles?: string[]}>(readText(join(dataDir, 'sessions', sessionId(), 'sections.json')), {}).titles ?? [];
		const next: View = {
			state: busy ? 'preparing' : !mine ? 'idle' : now.paused ? 'paused' : now.state ?? 'preparing',
			index: mine && typeof now.index === 'number' ? now.index : -1,
			other: alive && now.sid !== sessionId(),
			titles,
			error: mine && now.state === 'error' ? now.error ?? 'error' : '',
		};
		if (JSON.stringify(next) !== JSON.stringify(view())) cmd.state.set('view', next);
	}

	const statusText = (v: View): string => {
		const where = v.index >= 0 && v.index < v.titles.length ? ` · section ${v.index + 1}/${v.titles.length}` : '';
		switch (v.state) {
			case 'playing':
				return `speaking${where}`;
			case 'paused':
				return `paused${where}`;
			case 'preparing':
				return 'preparing voice';
			case 'installing':
				return 'first run: installing voice engine';
			case 'downloading':
				return 'first run: downloading voice model';
			case 'error':
				return v.error;
			default:
				return v.other ? 'another session is speaking' : '';
		}
	};

	// ---------- actions ----------

	async function ensureSummary(gen: number): Promise<boolean> {
		const dir = join(dataDir, 'sessions', sessionId());
		const reply = json<{hash?: string; reply?: string; question?: string}>(readText(join(dir, 'reply.json')), {});
		const cached = json<{hash?: string}>(readText(join(dir, 'summary.json')), {});
		if (!reply.hash || cached.hash === reply.hash) return true;
		const text = reply.reply ?? '';
		if (text.length <= SHORT) {
			await vr(['summary', sessionId(), reply.hash], text);
			return true;
		}
		if (setting('summary', 'on') === 'off') return true; // the backend reads the opening sentences
		const r = await cmd.model.complete({prompt: SUMMARY_PROMPT(reply.question ?? '', text), maxOutputTokens: 400});
		if (gen !== generation) return false;
		if (r.isAnswered && r.text.trim()) await vr(['summary', sessionId(), reply.hash], r.text.trim());
		return true;
	}

	async function play(from?: number): Promise<void> {
		const gen = ++generation;
		refresh();
		if (from === undefined && mode() !== 'full') {
			if (!(await ensureSummary(gen))) return;
			await vr(['play', sessionId(), 'summary', '0', prefix]);
		} else {
			await vr(['play', sessionId(), 'full', String(from ?? 0), from ? '' : prefix]);
		}
		generation = 0;
		refresh();
	}

	async function toggle(): Promise<void> {
		const s = view().state;
		if (s === 'idle' || s === 'error') return play();
		await vr(['toggle', sessionId()]);
		refresh();
	}

	async function stop(): Promise<void> {
		generation = 0;
		await vr(['stop', sessionId()]);
		refresh();
	}

	async function next(): Promise<void> {
		await vr(['next', sessionId()]);
		refresh();
	}

	async function onReply(reply: string): Promise<void> {
		const saved = json<{titles?: string[]; others_active?: number}>(
			await vr(['save', sessionId()], JSON.stringify({reply, question})),
			{},
		);
		const project = basename(cmd.cwd || '');
		prefix = (saved.others_active ?? 0) > 0 && project ? `In ${project}.` : '';
		refresh();
		if (mode() !== 'off') await play();
	}

	// ---------- hooks ----------

	cmd.on('run_start', (e: {sessionId?: string}) => {
		if (e?.sessionId) sid = e.sessionId;
	});

	cmd.hooks({
		// A typed prompt: remember it for the summary, and stop this session's voice.
		transformInput: ({text}: {text: string}) => {
			question = text;
			if (view().state !== 'idle') void stop();
			return {action: 'continue'};
		},
		// The reply is complete.
		onStop: ({lastAssistantText}: {lastAssistantText?: string}) => {
			if (interactive() && lastAssistantText?.trim()) void onReply(lastAssistantText);
			return undefined;
		},
		// Command Code is about to ask you something: say so, naming the project.
		onPermissionRequest: () => {
			if (interactive() && setting('alerts', 'on') !== 'off' && mode() !== 'off') {
				void vr(['say', sessionId(), `${basename(cmd.cwd || '') || 'Command Code'} needs your approval.`]).then(refresh);
			}
			return undefined;
		},
		onSessionStart: () => {
			if (cmd.ui.capabilities.surface && setting('panel', 'open') === 'open') cmd.ui.openPane('voice');
		},
	});

	cmd.clock.every(1000, refresh);

	// ---------- drawing ----------

	cmd.ui.widget({
		placement: 'below-editor',
		render: () => {
			const v = view();
			const s = statusText(v);
			return [{type: 'text', text: `voice: ${mode()}${s ? ` · ${s}` : ''}`, dim: true}];
		},
	});

	type Btn = {type: 'button'; label: string; hotkey?: string; key?: string; onPress: () => unknown};

	// Buttons draw as "[ k: Label ]" with one space between: pack them into rows that fit the
	// pane, which docks to the right at 40 to 72 columns on wide terminals.
	const pack = (buttons: Btn[], width: number): unknown[] => {
		const rows: unknown[] = [];
		let row: Btn[] = [];
		let used = 0;
		for (const b of buttons) {
			const w = b.label.length + (b.hotkey ? 3 : 0) + 4 + (row.length ? 1 : 0);
			if (row.length && used + w > width) {
				rows.push({type: 'row', children: row});
				row = [];
				used = 0;
			}
			used += w;
			row.push(b);
		}
		if (row.length) rows.push({type: 'row', children: row});
		return rows;
	};

	const short = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

	cmd.ui.pane({
		id: 'voice',
		title: 'Voice',
		render: ({width}: {width: number}) => {
			const v = view();
			const m = mode();
			const w = Math.max(20, (width || 60) - 2);
			const live = v.state !== 'idle' && v.state !== 'error';
			const label = v.state === 'playing' ? 'Pause' : v.state === 'paused' ? 'Resume' : 'Play';
			const s = statusText(v);
			const nodes: unknown[] = [
				{type: 'text', text: `${m === 'off' ? 'Off' : m === 'summary' ? 'Summary' : 'Full'}${s ? ` · ${s}` : ''}`, dim: true},
			];
			const modeBtn = (x: Mode, key: string, name: string): Btn => ({
				type: 'button',
				key: `mode-${x}`,
				label: m === x ? `${name} ✓` : name,
				hotkey: key,
				onPress: () => setMode(x),
			});
			nodes.push(...pack([modeBtn('off', 'o', 'Off'), modeBtn('summary', 's', 'Summary'), modeBtn('full', 'f', 'Full')], w));
			const controls: Btn[] = [
				{type: 'button', key: 'toggle', label, hotkey: 'k', onPress: () => toggle()},
				{type: 'button', key: 'stop', label: 'Stop', hotkey: 'x', onPress: () => stop()},
				{type: 'button', key: 'replay', label: 'Replay', hotkey: 'r', onPress: () => play()},
			];
			if (live && v.index >= 0 && v.index < v.titles.length - 1) {
				controls.push({type: 'button', key: 'next', label: 'Next', hotkey: 'n', onPress: () => next()});
			}
			nodes.push(...pack(controls, w));
			if (v.titles.length > 1) {
				nodes.push({type: 'text', text: 'Sections', dim: true});
				const room = Math.max(8, Math.min(22, w - 9));
				nodes.push(
					...pack(
						v.titles.slice(0, 9).map((t, i) => ({
							type: 'button' as const,
							key: `section-${i}`,
							label: `${i === v.index && live ? '▶ ' : ''}${short(t, room)}`,
							hotkey: String(i + 1),
							onPress: () => play(i),
						})),
						w,
					),
				);
			}
			return nodes as never;
		},
	});

	// ---------- /speak ----------

	cmd.addCommand({
		name: 'speak',
		description: 'Voice: off | summary | full | play | stop | replay | next | panel | setup | <n> | voice <id> | speed <n> | alerts on|off',
		argumentHint: 'off|summary|full|play|stop|replay|next|panel|setup|<n>|voice <id>|speed <n>|alerts on|off',
		handler: async ({args}: {args: string}) => {
			const [word = '', value = ''] = args.trim().split(/\s+/);
			const arg = word.toLowerCase();
			if (arg === '') {
				const m = MODES[(MODES.indexOf(mode()) + 1) % MODES.length] ?? 'off';
				await setMode(m);
				return {message: `Voice: ${m}`};
			}
			if (arg === 'off' || arg === 'summary' || arg === 'full') {
				await setMode(arg);
				return {message: `Voice: ${arg}`};
			}
			if (arg === 'play' || arg === 'pause') {
				await toggle();
				return {message: `Voice: ${view().state}`};
			}
			if (arg === 'stop') {
				await stop();
				return {message: 'Voice: stopped'};
			}
			if (arg === 'replay') {
				void play();
				return {message: 'Voice: replaying'};
			}
			if (arg === 'next') {
				await next();
				return {message: 'Voice: next section'};
			}
			if (arg === 'panel') {
				cmd.ui.openPane('voice');
				await cmd.store.set('panel', 'open');
				return;
			}
			if (arg === 'setup') {
				const out = await vr(['setup']);
				return {message: out.includes('"ok": true') ? 'Voice: ready' : 'Voice: setup failed, see ~/.claude/voice-reader/setup.log'};
			}
			if (arg === 'voice' && value) {
				await cmd.store.set('voice', value);
				return {message: `Voice: ${value}`};
			}
			if (arg === 'speed' && value) {
				await cmd.store.set('speed', value);
				return {message: `Voice speed: ${value}`};
			}
			if (arg === 'alerts' && (value === 'on' || value === 'off')) {
				await cmd.store.set('alerts', value);
				return {message: `Voice alerts: ${value}`};
			}
			if (/^\d+$/.test(arg)) {
				const i = Number(arg) - 1;
				const titles = view().titles;
				if (i < 0 || i >= titles.length) return {message: `Voice: no section ${arg} (the last reply has ${titles.length})`};
				void play(i);
				return {message: `Voice: from section ${arg}, ${titles[i]}`};
			}
			return {message: 'Usage: /speak [off|summary|full|play|stop|replay|next|panel|setup|<n>|voice <id>|speed <n>|alerts on|off]'};
		},
	});

	if (!existsSync(backend)) cmd.ui.notify(`voice-reader: backend not found at ${backend}`, 'warning');
}
