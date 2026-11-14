"""voice-reader backend: per-session, cached, offline Kokoro playback of Claude's replies.

Runs on the system python3 (standard library only). The one command that needs Kokoro,
`run`, re-launches itself inside a private virtualenv that it creates on first use.

  vr.py save    <sid>          stdin {reply, question}: store the reply, print {hash, titles}
  vr.py summary <sid> <hash>   stdin: the spoken summary of reply <hash>, kept for replays
  vr.py play    <sid> <kind> [n] [prefix]  kind summary | full (from section n); prefix is said first
  vr.py say     <sid> <text>   speak one short line now (alerts: "api needs your approval")
  vr.py next    <sid>          in Full mode, skip to the next section
  vr.py toggle  <sid>          pause or resume this session's audio
  vr.py stop    [sid]          stop the audio (only this session's, when sid is given)
  vr.py setup                  create the virtualenv and download the model now
  vr.py run <sid> <kind> <n>   internal: the detached runner

Everything lives in $VOICE_READER_HOME (default ~/.claude/voice-reader):
  sessions/<sid>/{reply,sections,summary}.json   one folder per Claude session
  now.json      who holds the speakers: {sid, runner, player, index, state, paused, hb}
  cache/*.wav   audio keyed by model + voice + speed + text, so nothing is made twice
  models/, venv/  Kokoro model files and its Python packages
"""
import fcntl, hashlib, json, os, re, shutil, signal, subprocess, sys, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from clean import clean  # noqa: E402
from sections import split  # noqa: E402

HOME = os.path.expanduser(os.environ.get("VOICE_READER_HOME") or "~/.claude/voice-reader")
SESS, CACHE = os.path.join(HOME, "sessions"), os.path.join(HOME, "cache")
MODELS, VENV = os.path.join(HOME, "models"), os.path.join(HOME, "venv")
NOW, LOCK = os.path.join(HOME, "now.json"), os.path.join(HOME, "now.lock")
VOICE = os.environ.get("VOICE_READER_VOICE") or "af_heart"
SPEED = float(os.environ.get("VOICE_READER_SPEED") or 1.0)
MODEL = "int8" if os.environ.get("VOICE_READER_MODEL") == "int8" else "full"
# Kokoro voices start with a language letter: af_heart is American English, ef_dora Spanish...
VOICE_LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}
LANG = os.environ.get("VOICE_READER_LANG") or VOICE_LANG.get(VOICE[:1], "en-us")
CACHE_DAYS, SESSION_DAYS = 3, 7

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILE = {"full": "kokoro-v1.0.onnx", "int8": "kokoro-v1.0.int8.onnx"}[MODEL]
VOICES_FILE = "voices-v1.0.bin"
PACKAGES = ["kokoro-onnx==0.6.1", "soundfile>=0.12"]

for d in (HOME, SESS, CACHE, MODELS):
    os.makedirs(d, exist_ok=True)


# ---------- small helpers ----------

def sdir(sid):
    p = os.path.join(SESS, re.sub(r"[^\w.-]", "", sid)[:80] or "unknown")
    os.makedirs(p, exist_ok=True)
    return p


def jread(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def jwrite(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def sha(text):
    return hashlib.sha1(text.encode()).hexdigest()


def out(obj):
    print(json.dumps(obj))


def lock(lk, wait=True):
    """Take the now.json lock; with wait=False give up after ~1s (signal handlers must not hang)."""
    if wait:
        fcntl.flock(lk, fcntl.LOCK_EX)
        return True
    for _ in range(20):
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            time.sleep(0.05)
    return False


def ps(pid, field):
    r = subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()


def runner_alive(now):
    pid = (now or {}).get("runner")
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return "vr.py run" in ps(pid, "args")  # a recycled pid must never be touched


def player_alive(now):
    pid, name = (now or {}).get("player"), (now or {}).get("player_name")
    return bool(pid and name) and os.path.basename(ps(pid, "comm")) == name


def kill_owner(now):
    """Stop whoever holds the speakers: the runner's whole group, so no player is left behind."""
    if not now:
        return
    if player_alive(now):
        for sig in (signal.SIGCONT, signal.SIGTERM):
            try:
                os.kill(now["player"], sig)
            except OSError:
                pass
    if runner_alive(now):
        for sig in (signal.SIGCONT, signal.SIGTERM):
            try:
                os.killpg(now["runner"], sig)
            except OSError:
                try:
                    os.kill(now["runner"], sig)
                except OSError:
                    pass


def prune():
    cutoff = time.time() - CACHE_DAYS * 86400
    for f in os.listdir(CACHE):
        p = os.path.join(CACHE, f)
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass
    cutoff = time.time() - SESSION_DAYS * 86400
    for d in os.listdir(SESS):
        p = os.path.join(SESS, d)
        try:
            if os.path.getmtime(p) < cutoff:
                shutil.rmtree(p)
        except OSError:
            pass


# ---------- environment: virtualenv, model files, audio player ----------

def venv_python():
    return os.path.join(VENV, "bin", "python")


STAMP = os.path.join(VENV, ".voice-reader-ok")


def ready():
    return (os.path.exists(STAMP) and os.path.exists(venv_python())
            and all(os.path.exists(os.path.join(MODELS, f)) for f in (MODEL_FILE, VOICES_FILE)))


def setup(report):
    """Create the virtualenv and download the model files; one setup at a time."""
    with open(os.path.join(HOME, "setup.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        if not os.path.exists(STAMP):
            report("installing")
            shutil.rmtree(VENV, ignore_errors=True)  # a half-made venv from a cut-off install
            uv = shutil.which("uv")
            if uv:
                subprocess.run([uv, "venv", "--quiet", VENV], check=True)
                subprocess.run([uv, "pip", "install", "--quiet", "--python", venv_python(), *PACKAGES], check=True)
            else:
                subprocess.run([sys.executable, "-m", "venv", VENV], check=True)
                subprocess.run([venv_python(), "-m", "pip", "install", "--quiet", *PACKAGES], check=True)
            subprocess.run([venv_python(), "-c", "import kokoro_onnx, soundfile"], check=True)
            open(STAMP, "w").write(time.ctime())
        for name in (MODEL_FILE, VOICES_FILE):
            dest = os.path.join(MODELS, name)
            if not os.path.exists(dest):
                report("downloading")
                urllib.request.urlretrieve(RELEASE + name, dest + ".part")
                os.replace(dest + ".part", dest)


def find_player():
    """(argv prefix, process name) of the first audio player on this machine."""
    for argv in (["afplay"], ["pw-play"], ["paplay"], ["aplay", "-q"],
                 ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]):
        path = shutil.which(argv[0])
        if path:
            return [path, *argv[1:]], argv[0]
    return None, None


# ---------- audio synthesis (inside the virtualenv only) ----------

_kokoro, _klock = None, threading.Lock()


def wav_for(text):
    """Cached Kokoro audio for this text; synthesized only on a cache miss."""
    global _kokoro
    path = os.path.join(CACHE, sha(f"{MODEL}|{VOICE}|{SPEED}|{LANG}|{text}") + ".wav")
    if os.path.exists(path):
        os.utime(path)  # recently played audio is kept longest
        return path
    with _klock:
        if os.path.exists(path):
            return path
        if _kokoro is None:
            from kokoro_onnx import Kokoro
            _kokoro = Kokoro(os.path.join(MODELS, MODEL_FILE), os.path.join(MODELS, VOICES_FILE))
        import soundfile as sf
        audio, sr = _kokoro.create(text, voice=VOICE, speed=SPEED, lang=LANG)
        tmp = f"{path}.{os.getpid()}.tmp.wav"
        sf.write(tmp, audio, sr)
        os.replace(tmp, path)
    return path


# ---------- the runner ----------

def set_now(me, **fields):
    """Update now.json for runner `me`, keeping what toggle wrote (the paused flag)."""
    with open(LOCK, "w") as lk:
        lock(lk)
        now = jread(NOW) or {}
        if now.get("runner") != me:
            return False
        now.update(fields, hb=time.time())
        jwrite(NOW, now)
        return True


def start_beat(me):
    """The panel reads now.json; a fresh heartbeat proves the runner is alive."""
    def beat():
        while set_now(me):
            time.sleep(1)
    threading.Thread(target=beat, daemon=True).start()


def items_for(sid, kind, start, prefix=""):
    sd = sdir(sid)
    if kind == "say":
        text = clean(jread(os.path.join(sd, "say.json"), {}).get("text", ""))
        return [(-1, text)] if text.strip() else []
    if kind == "summary":
        reply = jread(os.path.join(sd, "reply.json"), {})
        cached = jread(os.path.join(sd, "summary.json"), {})
        if cached.get("hash") == reply.get("hash") and cached.get("text"):
            text = clean(cached["text"])
        else:  # no summary made yet: the opening sentences of the reply
            text = " ".join(re.split(r"(?<=[.!?])\s+", clean(reply.get("reply", "")))[:3])[:400]
        text = f"{prefix} {text}".strip() if prefix else text
        return [(-1, text)] if text.strip() else []
    texts = (jread(os.path.join(sd, "sections.json"), {}) or {}).get("texts") or []
    items = [(i, clean(texts[i], limit=20000)) for i in range(max(start, 0), len(texts))]
    items = [(i, t) for i, t in items if t.strip()]
    if prefix and items and start <= 0:
        items[0] = (items[0][0], f"{prefix} {items[0][1]}")
    return items


def run(sid, kind, start, prefix=""):
    """Detached: hold the speakers, synthesize ahead on one thread, play each part in order."""
    me = os.getpid()
    child = {"p": None}

    def mine():
        return (jread(NOW) or {}).get("runner") == me

    def bye(*_):
        p = child["p"]
        if p and p.poll() is None:
            try:
                p.send_signal(signal.SIGCONT)
                p.terminate()
            except OSError:
                pass
        with open(LOCK, "w") as lk:
            lock(lk, wait=False)
            if mine():
                try:
                    os.remove(NOW)
                except OSError:
                    pass
        os._exit(0)

    signal.signal(signal.SIGTERM, bye)

    start_beat(me)

    argv, name = find_player()
    if not argv:
        set_now(me, state="error", error="no audio player found (afplay, pw-play, paplay, aplay or ffplay)")
        time.sleep(3)
        bye()

    items = items_for(sid, kind, start, prefix)
    ready = [threading.Event() for _ in items]
    paths = [None] * len(items)

    def worker():
        for k, (_, t) in enumerate(items):
            try:
                paths[k] = wav_for(t)
            except Exception:
                paths[k] = None
            ready[k].set()

    threading.Thread(target=worker, daemon=True).start()

    for k, (idx, _) in enumerate(items):
        if not set_now(me, index=idx, player=None, state="preparing"):
            break
        ready[k].wait()
        while (jread(NOW) or {}).get("paused") and mine():  # paused before this part began
            time.sleep(0.2)
        if not paths[k] or not mine():
            continue
        child["p"] = subprocess.Popen([*argv, paths[k]], stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not set_now(me, player=child["p"].pid, player_name=name, state="playing"):
            break
        if (jread(NOW) or {}).get("paused"):  # paused in the instant it started
            child["p"].send_signal(signal.SIGSTOP)
        child["p"].wait()
    bye()


def spawn(sid, kind, start=0, prefix=""):
    """Start a detached runner inside the virtualenv and hand it the speakers at once."""
    with open(LOCK, "w") as lk:
        lock(lk)
        kill_owner(jread(NOW))
        py = venv_python() if os.path.exists(venv_python()) else sys.executable
        p = subprocess.Popen([py, os.path.abspath(__file__), "run", sid, kind, str(start), prefix],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True, env=os.environ.copy())
        jwrite(NOW, {"sid": sid, "runner": p.pid, "player": None, "index": start if kind == "full" else -1,
                     "kind": kind, "state": "preparing", "paused": False, "hb": time.time()})


# ---------- commands ----------

def cmd_save(sid):
    d = json.load(sys.stdin)
    reply, question = d.get("reply") or "", d.get("question") or ""
    if not reply.strip():
        return out({"hash": "", "titles": []})
    h = sha(reply)
    sd = sdir(sid)
    jwrite(os.path.join(sd, "reply.json"), {"hash": h, "reply": reply, "question": question, "ts": time.time()})
    secs = split(reply)
    titles = [t for t, _ in secs]
    jwrite(os.path.join(sd, "sections.json"), {"hash": h, "titles": titles, "texts": [b for _, b in secs]})
    prune()
    out({"hash": h, "titles": titles, "others_active": others_active(sid)})


def others_active(sid, window=3600):
    """How many other sessions replied within the last hour (then summaries name the project)."""
    me, n, cutoff = os.path.basename(sdir(sid)), 0, time.time() - window
    for d in os.listdir(SESS):
        try:
            if d != me and os.path.getmtime(os.path.join(SESS, d, "reply.json")) > cutoff:
                n += 1
        except OSError:
            pass
    return n


def cmd_say(sid, text):
    jwrite(os.path.join(sdir(sid), "say.json"), {"text": text, "ts": time.time()})
    spawn(sid, "say", 0)
    out(status(sid))


def cmd_next(sid):
    now = jread(NOW) or {}
    if status(sid)["state"] != "idle" and now.get("kind") == "full":
        texts = (jread(os.path.join(sdir(sid), "sections.json"), {}) or {}).get("texts") or []
        nxt = int(now.get("index", -1)) + 1
        if nxt < len(texts):
            spawn(sid, "full", nxt)
        else:
            cmd_stop(sid)
            return
    out(status(sid))


def cmd_summary(sid, h):
    text = sys.stdin.read().strip()
    if text:
        jwrite(os.path.join(sdir(sid), "summary.json"), {"hash": h, "text": text})
    out({"ok": bool(text)})


def status(sid):
    now = jread(NOW)
    if not now or not runner_alive(now):
        return {"state": "idle", "index": -1, "other": False}
    if now.get("sid") != sid:
        return {"state": "idle", "index": -1, "other": True}
    st = "paused" if now.get("paused") else now.get("state") or "preparing"
    return {"state": st, "index": now.get("index", -1), "other": False}


def cmd_toggle(sid):
    if status(sid)["state"] == "idle":
        return out({"state": "idle", "index": -1, "other": False})
    with open(LOCK, "w") as lk:
        lock(lk)
        now = jread(NOW) or {}
        pause = not now.get("paused")
        now["paused"] = pause
        jwrite(NOW, now)
        if player_alive(now):
            try:
                os.kill(now["player"], signal.SIGSTOP if pause else signal.SIGCONT)
            except OSError:
                pass
    out(status(sid))


def cmd_stop(sid=None):
    with open(LOCK, "w") as lk:
        lock(lk)
        now = jread(NOW)
        if now and (sid is None or now.get("sid") == sid):
            kill_owner(now)
            try:
                os.remove(NOW)
            except OSError:
                pass
    out(status(sid) if sid else {"state": "idle", "index": -1, "other": False})


def cmd_setup():
    setup(lambda s: print(s, flush=True))
    argv, name = find_player()
    out({"ok": True, "player": name})


def main():
    a = sys.argv[1:]
    cmd = a[0] if a else ""
    if cmd == "run":
        me = os.getpid()
        if not ready():
            # First use: set up in a process of its own session, so a Stop or a new prompt
            # that ends this runner never cuts the install or download short.
            start_beat(me)
            set_now(me, state="installing")
            p = subprocess.Popen([sys.executable, os.path.abspath(__file__), "setup"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=open(os.path.join(HOME, "setup.log"), "w"), start_new_session=True)
            while p.poll() is None:
                set_now(me, state="downloading" if os.path.exists(STAMP) else "installing")
                time.sleep(1)
            if not ready():
                set_now(me, state="error", error="setup failed, see setup.log")
                time.sleep(4)
                with open(LOCK, "w") as lk:
                    lock(lk)
                    if (jread(NOW) or {}).get("runner") == me:
                        os.remove(NOW)
                return
        # Re-launch inside the virtualenv once (same pid, so still the owner). Compare real paths:
        # a symlinked data folder (macOS /tmp is one) must not cause an exec loop.
        if (os.path.realpath(sys.executable) != os.path.realpath(venv_python())
                and not os.environ.get("VOICE_READER_IN_VENV")):
            os.environ["VOICE_READER_IN_VENV"] = "1"
            os.execv(venv_python(), [venv_python(), os.path.abspath(__file__), *a])
        run(a[1], a[2], int(a[3]), a[4] if len(a) > 4 else "")
    elif cmd == "save":
        cmd_save(a[1])
    elif cmd == "summary":
        cmd_summary(a[1], a[2])
    elif cmd == "play":
        spawn(a[1], a[2] if a[2] in ("summary", "full") else "full", int(a[3]) if len(a) > 3 else 0,
              a[4] if len(a) > 4 else "")
        out(status(a[1]))
    elif cmd == "say":
        cmd_say(a[1], " ".join(a[2:]))
    elif cmd == "next":
        cmd_next(a[1])
    elif cmd == "toggle":
        cmd_toggle(a[1])
    elif cmd == "stop":
        cmd_stop(a[1] if len(a) > 1 else None)
    elif cmd == "status":
        out(status(a[1]) if len(a) > 1 else jread(NOW, {}))
    elif cmd == "setup":
        cmd_setup()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
