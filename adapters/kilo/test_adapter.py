#!/usr/bin/env python3
"""Offline tests for the kilo adapter. `/usr/bin/python3 adapters/kilo/test_adapter.py`, exits non-zero on failure.

No Kilo and no network beyond 127.0.0.1: the Worker is the fake in client/hm/testing/fake_worker.py, every home, config and
cache folder is a temporary one, and the JavaScript plugin tests run through `node --test` (skipped, with a message, when
node is missing). The live check against a real Kilo is adapters/kilo/live_proof.py.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIX = HERE / "fixtures"
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT / "hooks"))

TMP = Path(tempfile.mkdtemp(prefix="hm-kilo-test-"))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "import-cache")  # modules read the cache folder when they are imported
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "import-config")

from hm.testing import fake_worker  # noqa: E402
from hm.commands import install as installer  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def load(name):
    spec = importlib.util.spec_from_file_location("kilo_test_" + name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


payload, emit, transcript = load("payload"), load("emit"), load("transcript")
adapter = installer.load_module(HERE)  # the same loader install.py uses


def tree(folder: Path) -> dict:
    return {str(p.relative_to(folder)): ("dir" if p.is_dir() else hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(folder.rglob("*"))}


def fresh(name: str) -> Path:
    d = TMP / name
    d.mkdir()
    return d


def options(home: Path, root: Path = ROOT, dry_run: bool = False):
    return SimpleNamespace(dry_run=dry_run, yes=True, plugin_root=root, home=home)


def fake_root(name: str) -> Path:
    """A plugin root with just the files the adapter looks for. The folder name holds a space, a quote and a backslash."""
    root = TMP / name
    for rel in ("hooks/memory_recall.py", "hooks/memory_capsule.py", "hooks/memory_capture.py", "client/hm/config.py",
                "adapters/kilo/hook.py", "adapters/kilo/transcript.py"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("")
    return root


# ------------------------------------------------------------------ payload

raw = {n: json.loads((FIX / f"{n}.json").read_text()) for n in ("session-start", "prompt", "capture", "pre-compact")}
for event, expected in (("session-start", "SessionStart"), ("prompt", "UserPromptSubmit"), ("capture", "SessionEnd"), ("pre-compact", "PreCompact")):
    n = payload.normalise(raw[event], event)
    check(f"payload: the {event} fixture normalises to {expected}", n["hook_event_name"] == expected and set(n) == {"hook_event_name", "session_id", "prompt", "transcript_path", "cwd"}, str(n))
n = payload.normalise(raw["prompt"], "prompt")
check("payload: session, prompt, folder and spool path come through", n["session_id"] == raw["prompt"]["sessionID"] and n["prompt"] == raw["prompt"]["prompt"]
      and n["cwd"] == raw["prompt"]["directory"] and n["transcript_path"] == raw["prompt"]["spool"])
check("payload: every value is a string", all(isinstance(v, str) for v in n.values()))
check("payload: the stop word is gone, nothing sends it", payload.normalise({"sessionID": "s"}, "stop")["hook_event_name"] == "")
check("payload: an unknown event has no name", payload.normalise(raw["prompt"], "bogus")["hook_event_name"] == "")
check("payload: garbage input gives empty strings, never an error", all(payload.normalise(x, "prompt")["session_id"] == "" for x in (None, "x", 5, [], {"sessionID": 7})))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache-for-default")
dflt = payload.normalise({"sessionID": "ses/odd id"}, "capture")["transcript_path"]
check("payload: with no spool path the default is the one plugin.js writes", dflt == str(TMP / "cache-for-default" / "kilo" / "ses_odd_id.jsonl"), dflt)

# ------------------------------------------------------------------ emit

check("emit: the exact bytes for one piece of context and the keep answer", emit.reply("hello", True) == '{"keep": true, "additionalContext": "hello"}\n')
check("emit: no text, still the keep answer", emit.reply("", False) == '{"keep": false}\n')
check("emit: non ASCII text is escaped so any stdout encoding works", emit.reply("café", True).isascii() and json.loads(emit.reply("café", True))["additionalContext"] == "café")

# ------------------------------------------------------------------ transcript

spool = FIX / "spool.jsonl"
turns, end = transcript.read_turns(str(spool), 0)
check("transcript: the fixture reads as one user and one assistant turn", turns == [("USER", '"Reply with the single word OK"'), ("ASSISTANT", "OK")], str(turns))
check("transcript: the offset is the end of the file", end == spool.stat().st_size)
check("transcript: reading from the end gives nothing", transcript.read_turns(str(spool), end) == ([], end))

mixed = fresh("spool-mixed") / "s.jsonl"
recall_block = ("## Relevant memories (anymem, recalled for this prompt)\n"
                "Context only, check it against the prompt. Fuller detail: the anymem skill's recall script.\n"
                "- injected-memory-one: a description INJECTEDWORD1\n- injected-memory-two: another INJECTEDWORD2\n")
lines = [
    {"role": "user", "text": "first real question"},
    {"role": "user", "text": recall_block + "what the user typed after the block"},
    {"role": "user", "text": recall_block.strip()},
    {"role": "assistant", "text": "<system-reminder>reminder text</system-reminder>the real answer"},
    {"role": "assistant", "text": "## Memory capsule (anymem Worker, live)\nCAPSULEWORD"},
    {"role": "system", "text": "system prompt text"},
    {"role": "developer", "text": "developer text"},
    {"role": "tool", "text": "tool output text"},
    {"role": "assistant", "text": "synthetic text", "synthetic": True},
    {"role": "user", "text": 42},
    {"role": "user"},
    {"text": "no role"},
]
body = "\n".join(json.dumps(x) for x in lines) + "\nnot json at all\n"
partial = json.dumps({"role": "assistant", "text": "half written"})
mixed.write_text(body + partial[:20])
turns, end = transcript.read_turns(str(mixed), 0)
flat = json.dumps(turns)
check("transcript: only plain user and assistant text is kept, in order", [t[0] for t in turns] == ["USER", "USER", "ASSISTANT"]
      and turns[0][1] == "first real question" and turns[1][1] == "what the user typed after the block" and turns[2][1] == "the real answer", flat)
check("transcript: an injected memory block is never captured back", "INJECTEDWORD" not in flat and "injected-memory" not in flat and "Relevant memories" not in flat)
check("transcript: the capsule, reminders, system, developer and tool text are dropped", all(x not in flat for x in ("CAPSULEWORD", "reminder text", "system prompt", "developer text", "tool output", "synthetic text")))
check("transcript: a partial last record stays for the next capture", end == len((body).encode()) and "half written" not in flat)
mixed.write_text(body + partial + "\n")
turns2, end2 = transcript.read_turns(str(mixed), end)
check("transcript: the finished record is read from the saved offset", turns2 == [("ASSISTANT", "half written")] and end2 == mixed.stat().st_size, str(turns2))
wide = fresh("spool-wide") / "s.jsonl"
wide.write_text(json.dumps({"role": "user", "text": "caf\u00e9 \u2603 \U0001f600"}, ensure_ascii=False) + "\n" + json.dumps({"role": "assistant", "text": "ok"}) + "\n", encoding="utf-8")
wturns, wend = transcript.read_turns(str(wide), 0)
check("transcript: multibyte text keeps byte offsets exact", wturns[0][1] == "caf\u00e9 \u2603 \U0001f600" and wend == wide.stat().st_size and transcript.read_turns(str(wide), wend) == ([], wend))

os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "import-cache")
import memory_capture  # noqa: E402

check("transcript: the shared capture hook loads this reader for format kilo", memory_capture.reader("kilo")(str(spool), 0)[0] == [("USER", '"Reply with the single word OK"'), ("ASSISTANT", "OK")])
text, user_chars, end = memory_capture.condense(str(spool), 0, "kilo")
check("transcript: condense gives the conversation text", text == 'USER: "Reply with the single word OK"\n\nASSISTANT: OK' and user_chars > 0, text)

# ------------------------------------------------------------------ install, check, uninstall

check("adapter: NAME and TITLE", adapter.NAME == "kilo" and adapter.TITLE)
d = adapter.detect()
check("adapter: detect returns found, version, config_path and notes", set(d) == {"found", "version", "config_path", "notes"} and isinstance(d["found"], bool) and isinstance(d["notes"], list))

home = fresh("home-bare")
os.environ["ANYMEM_HOME"] = str(home)
before = tree(home)
plan_lines = adapter.plan(options(home))
target = home / ".config" / "kilo" / "plugin" / "anymem.js"
check("adapter: plan names the plugin file, the folders it creates, the plugin root and the uninstall", any(str(target) in x for x in plan_lines)
      and any("Create the folder" in x and str(home / ".config") in x for x in plan_lines) and any(str(ROOT) in x for x in plan_lines) and any("Uninstall" in x for x in plan_lines))
check("adapter: plan writes nothing", tree(home) == before)
res = adapter.install(options(home, dry_run=True))
check("adapter: a dry run changes nothing and reports the plan", tree(home) == before and res["changed"] == [] and res["notes"] == plan_lines)

res = adapter.install(options(home))
check("adapter: install writes exactly one file", res["changed"] == [str(target)] and sorted(tree(home)) == sorted([".config", ".config/kilo", ".config/kilo/plugin", ".config/kilo/plugin/anymem.js"]), str(sorted(tree(home))))
text = target.read_text()
check("adapter: the file is marked, and carries the root and the Python", text.startswith("// anymem begin") and text.rstrip().endswith("// anymem end")
      and f'const BAKED = {json.dumps({"root": str(ROOT), "python": sys.executable})};' in text)
check("adapter: the created folders are recorded in the header", adapter.DIRS_RE.search(text).group(1) == json.dumps([str(home / ".config"), str(home / ".config" / "kilo"), str(home / ".config" / "kilo" / "plugin")]))
check("adapter: nothing is written outside the home", all(Path(c).resolve().is_relative_to(home.resolve()) for c in res["changed"]))
check("adapter: the plan after install says our file is replaced after a backup", any("backup" in x for x in adapter.plan(options(home))))

srv = fake_worker.start(recall=[], capsule=[])
os.environ.update({"ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-0000", "ANYMEM_CONFIG_DIR": str(fresh("config-ok"))})
c = adapter.check()
check("adapter: check is ok and the Worker answered /health", c["ok"] and c["problems"] == [] and ("GET", "/health", None) in srv.requests, str(c))
check("adapter: check wrote nothing", sorted(tree(home)) == sorted([".config", ".config/kilo", ".config/kilo/plugin", ".config/kilo/plugin/anymem.js"]))
srv.stop()
c = adapter.check()
check("adapter: check reports a Worker that does not answer", not c["ok"] and any("/health" in p for p in c["problems"]), str(c))
for var in ("ANYMEM_URL", "ANYMEM_TOKEN"):
    os.environ.pop(var)
c = adapter.check()
check("adapter: check reports a client that is not configured", not c["ok"] and any("not configured" in p for p in c["problems"]), str(c))

res = adapter.uninstall()
check("adapter: uninstall leaves the home byte identical to before install", tree(home) == before, str(sorted(tree(home))))
check("adapter: uninstall reports the file and the folders it removed, all inside the home", res["changed"][0] == str(target) and len(res["changed"]) == 4 and all(Path(c).is_relative_to(home) for c in res["changed"]), str(res))
check("adapter: check finds the wiring gone after uninstall", not adapter.check()["ok"] and "does not exist" in adapter.check()["problems"][0])
check("adapter: uninstalling twice is a quiet no-op", adapter.uninstall() == {"changed": []} and tree(home) == before)

# existing neighbours are never touched, and folders that were already there are never removed
home = fresh("home-neighbours")
os.environ["ANYMEM_HOME"] = str(home)
(home / ".config" / "kilo" / "plugin").mkdir(parents=True)
(home / ".config" / "kilo" / "opencode.jsonc").write_text('{\n  // my config\n  "model": "x"\n}\n')
(home / ".config" / "kilo" / "plugin" / "other.js").write_text("export default async () => ({})\n")
before = tree(home)
adapter.install(options(home))
check("adapter: install leaves the Kilo config and other plugins byte identical", all(tree(home).get(k) == v for k, v in before.items()))
check("adapter: an install into existing folders records no created folders", adapter.DIRS_RE.search((home / ".config/kilo/plugin/anymem.js").read_text()).group(1) == "[]")
adapter.uninstall()
check("adapter: uninstall restores the folder byte identical, keeping the folders that were there", tree(home) == before)

# reinstall: one backup, restored state still byte identical
home = fresh("home-reinstall")
os.environ["ANYMEM_HOME"] = str(home)
before = tree(home)
adapter.install(options(home))
first = (home / ".config/kilo/plugin/anymem.js").read_bytes()
res = adapter.install(options(home))
bak = home / ".config/kilo/plugin/anymem.js.anymem.bak"
check("adapter: reinstalling backs our file up once", bak.exists() and bak.read_bytes() == first and str(bak) in res["changed"])
(home / ".config/kilo/plugin/anymem.js").write_text(first.decode().replace("// anymem end", "// anymem end\n// edited"))
res = adapter.install(options(home))
check("adapter: a second reinstall keeps the first backup", bak.read_bytes() == first and str(bak) not in res["changed"])
check("adapter: a reinstall keeps the list of folders the first install created", len(json.loads(adapter.DIRS_RE.search((home / ".config/kilo/plugin/anymem.js").read_text()).group(1))) == 3)
adapter.uninstall()
check("adapter: uninstall after reinstalls is still byte identical, the backup included", tree(home) == before, str(sorted(tree(home))))

# refusals
home = fresh("home-refuse")
os.environ["ANYMEM_HOME"] = str(home)
foreign = home / ".config/kilo/plugin/anymem.js"
foreign.parent.mkdir(parents=True)
foreign.write_text("export default async () => ({}) // somebody else's file\n")
before = tree(home)
for label, fn in (("install", lambda: adapter.install(options(home))), ("uninstall", lambda: adapter.uninstall())):
    try:
        fn()
        refused = False
    except ValueError as exc:
        refused = "not written by anymem" in str(exc)
    check(f"adapter: {label} refuses a file that is not ours and leaves it alone", refused and tree(home) == before)
check("adapter: the plan says install will stop", any("not ours" in x for x in adapter.plan(options(home))))
foreign.unlink()
foreign.mkdir()
before = tree(home)
try:
    adapter.install(options(home))
    refused = False
except ValueError as exc:
    refused = "not a plugin file" in str(exc)
check("adapter: install refuses a folder in the place of the plugin file", refused and tree(home) == before)
foreign.rmdir()
foreign.symlink_to(TMP / "nowhere")
try:
    adapter.install(options(home))
    refused = False
except ValueError:
    refused = True
check("adapter: install refuses a symlink", refused and foreign.is_symlink())
foreign.unlink()
broken = fake_root("broken-root")
(broken / "hooks" / "memory_capture.py").unlink()
before = tree(home)
try:
    adapter.install(options(home, broken))
    refused = False
except ValueError as exc:
    refused = "memory_capture.py" in str(exc)
check("adapter: install refuses a plugin root without the shared hooks", refused and tree(home) == before)

# a plugin root with awkward characters is baked in safely
home = fresh("home-odd-root")
os.environ["ANYMEM_HOME"] = str(home)
odd = fake_root('root with "quote" and \\slash and $1 \\1')
adapter.install(options(home, odd))
installed = home / ".config/kilo/plugin/anymem.js"
check("adapter: awkward characters in the plugin root survive the bake", adapter._baked(installed).get("root") == str(odd.resolve()), str(adapter._baked(installed)))
if shutil.which("node"):
    probe = TMP / "syntax.mjs"
    shutil.copy(installed, probe)
    ok = subprocess.run(["node", "--check", str(probe)], capture_output=True, text=True).returncode == 0
    check("adapter: the installed plugin file is valid JavaScript", ok)
adapter.uninstall()

# ------------------------------------------------------------------ hook.py

HOOK = str(HERE / "hook.py")


def run_hook(args, stdin, env_extra, timeout=30):
    home_dir = fresh(f"hook-home-{time.time_ns()}")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM", "CLAUDE_PLUGIN"))}
    env.update({"HOME": str(home_dir), "ANYMEM_CONFIG_DIR": str(home_dir / "cfg"), "ANYMEM_CACHE_DIR": str(home_dir / "cache")})
    env.update(env_extra)
    p = subprocess.run([sys.executable, HOOK, *args], input=stdin.encode() if isinstance(stdin, str) else stdin, capture_output=True, env=env, timeout=timeout)
    return p, home_dir


memory_text = "ferry-codename-memory: codename for the ferry route is quillfern"
srv = fake_worker.start(
    recall=[{"id": "m1", "tags": ["status:canonical"], "content": f"---\nname: ferry-codename-memory\ndescription: codename for the ferry route\n---\n\nThe codename is quillfern."}],
    capsule=[{"slot": "identity", "content": "The mascot is a heron."}],
    proposals=[{"name": "ferry-codename-stored", "type": "project", "description": "Ferry codename for the capture test",
                "body": "The ferry route codename is quillfern.\n**Why:** it came up in the test.\n**How to apply:** use it for the ferry route."}])
good_env = {"ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-0000", "ANYMEM_EXTRACTION": "worker", "ANYMEM_PROJECT": "global"}
sample = lambda name: (FIX / f"{name}.json").read_text()  # noqa: E731

p, _ = run_hook(["session-start"], sample("session-start"), good_env)
out = json.loads(p.stdout.decode().strip())
check("hook: session-start prints the capsule and keep in the reply protocol", p.returncode == 0 and set(out) == {"keep", "additionalContext"} and out["keep"] is True and "heron" in out["additionalContext"] and p.stdout.endswith(b"\n") and p.stderr == b"", p.stdout.decode()[:200])
p, _ = run_hook(["prompt"], json.dumps({**json.loads(sample("prompt")), "prompt": "Which codename did we agree for the ferry route?"}), good_env)
out = json.loads(p.stdout.decode().strip())
check("hook: prompt prints the recalled memory", p.returncode == 0 and "ferry-codename-memory" in out["additionalContext"] and "quillfern" in out["additionalContext"] and out["keep"] is True and p.stderr == b"", p.stdout.decode()[:200])
p, _ = run_hook(["prompt"], sample("prompt"), good_env)
check("hook: the recorded prompt fixture is handled without noise", p.returncode == 0 and p.stderr == b"")

# keep: the policy answer the plugin uses to decide whether it may spool the conversation text
p, _ = run_hook(["prompt"], sample("prompt"), {**good_env, "ANYMEM_CAPTURE": "0"})
check("hook: capture switched off, the prompt reply says keep false", p.returncode == 0 and json.loads(p.stdout.decode())["keep"] is False and p.stderr == b"", p.stdout.decode()[:200])
p, _ = run_hook(["session-start"], sample("session-start"), {**good_env, "ANYMEM_CAPTURE": "0"})
out = json.loads(p.stdout.decode().strip())
check("hook: capture switched off, the session-start reply says keep false and still carries the capsule", out["keep"] is False and "heron" in out["additionalContext"], p.stdout.decode()[:200])
excluded = fresh("excluded-project")
excluded_cfg = fresh("excluded-cfg")
(excluded_cfg / "config.json").write_text(json.dumps({"exclude_paths": [str(excluded)]}))
p, _ = run_hook(["prompt"], json.dumps({**json.loads(sample("prompt")), "directory": str(excluded)}), {**good_env, "ANYMEM_CONFIG_DIR": str(excluded_cfg)})
check("hook: a folder the config excludes gets keep false", p.returncode == 0 and json.loads(p.stdout.decode())["keep"] is False, p.stdout.decode()[:200])
p, _ = run_hook(["prompt"], json.dumps({**json.loads(sample("prompt")), "directory": str(excluded)}), good_env)
check("hook: the same folder with no exclusion gets keep true", p.returncode == 0 and json.loads(p.stdout.decode())["keep"] is True, p.stdout.decode()[:200])


def quiet(p) -> bool:
    """No context in the output: nothing at all, or only the keep answer."""
    if p.stdout == b"":
        return True
    try:
        out = json.loads(p.stdout.decode())
    except ValueError:
        return False
    return isinstance(out, dict) and set(out) == {"keep"}


quiet_cases = {
    "garbage stdin": ("prompt", b"\x00\xffnot json {{{", good_env),
    "empty stdin": ("prompt", b"", good_env),
    "stdin that is not an object": ("capture", b"[1, 2, 3]", good_env),
    "unknown event": ("bogus", sample("prompt").encode(), good_env),
    "no event": ("", sample("prompt").encode(), good_env),
    "huge garbage": ("prompt", b"x" * 3_000_000, good_env),
    "an unconfigured client, session-start": ("session-start", sample("session-start").encode(), {}),
    "an unconfigured client, prompt": ("prompt", sample("prompt").encode(), {}),
    "an unconfigured client, capture": ("capture", sample("capture").encode(), {}),
    "an unreachable Worker": ("prompt", sample("prompt").encode(), {"ANYMEM_URL": "http://127.0.0.1:1", "ANYMEM_TOKEN": "test-token-0000", "ANYMEM_RECALL_TIMEOUT": "2", "ANYMEM_HOOK_TIMEOUT": "2"}),
    "recall switched off": ("prompt", sample("prompt").encode(), {**good_env, "ANYMEM_RECALL": "0"}),
    "capsule switched off": ("session-start", sample("session-start").encode(), {**good_env, "ANYMEM_CAPSULE": "0"}),
    "the capture child": ("prompt", sample("prompt").encode(), {**good_env, "ANYMEM_CAPTURE_CHILD": "1"}),
    "a plugin root that does not exist": ("prompt", sample("prompt").encode(), {**good_env, "ANYMEM_PLUGIN_ROOT": str(TMP / "nope")}),
}
for label, (event, stdin, env_extra) in quiet_cases.items():
    started = time.time()
    p, _ = run_hook([event] if event else [], stdin, env_extra)
    check(f"hook: {label}: exit 0, no context, nothing on stderr", p.returncode == 0 and quiet(p) and p.stderr == b"", f"rc={p.returncode} out={p.stdout[:100]!r} err={p.stderr[:200]!r}")
p, _ = run_hook(["prompt"], b"", good_env)
check("hook: no stdin at all is quiet too", p.returncode == 0 and quiet(p) and p.stderr == b"")

# capture: a short spool declines, a long one starts a detached worker that reaches the Worker, and an injected block is never sent
def capture_case(spool_lines, extra=None):
    h = fresh(f"capture-{time.time_ns()}")
    sp = h / "spool.jsonl"
    sp.write_text("".join(json.dumps(x) + "\n" for x in spool_lines))
    srv.requests.clear()
    srv.captured.clear()
    pl = json.dumps({"sessionID": "ses_capture_test", "directory": str(h), "spool": str(sp)})
    # Start from the real environment like run_hook does, minus ANYMEM and CLAUDE_PLUGIN. An empty environment drops
    # LD_LIBRARY_PATH, and a Python that finds libpython through it (setup-python on a self-hosted runner) then cannot start.
    base = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM", "CLAUDE_PLUGIN"))}
    env = {**base, **good_env, "HOME": str(h), "ANYMEM_CONFIG_DIR": str(h / "cfg"), "ANYMEM_CACHE_DIR": str(h / "cache"), **(extra or {})}
    started = time.time()
    p = subprocess.run([sys.executable, HOOK, "capture"], input=pl.encode(), capture_output=True, env=env, timeout=30)
    return p, time.time() - started, h


p, took, h = capture_case([{"role": "user", "text": "hello"}, {"role": "assistant", "text": "OK"}])
time.sleep(1.5)
check("hook: a short spool starts no capture worker", p.returncode == 0 and p.stdout == b"" and p.stderr == b"" and not any(pth == "/extract" for _, pth, _ in srv.requests) and not srv.captured)
check("hook: the capture state is written for the session with offset 0", json.loads((h / "cache" / "capture-state.json").read_text())["ses_capture_test"]["offset"] == 0)

injected = "## Relevant memories (anymem, recalled for this prompt)\n- planted-memory: PLANTEDWORD must never be captured\n"
long_lines = [{"role": "user", "text": injected + f"Real note {i}: " + "the ferry route needs a codename and we talked about it at length. " * 3} for i in range(40)]
long_lines.append({"role": "assistant", "text": "Understood, the codename is quillfern."})
p, took, h = capture_case(long_lines)
deadline = time.time() + 30
while time.time() < deadline and not srv.captured:
    time.sleep(0.3)
check("hook: a long spool returns at once, with no output", p.returncode == 0 and p.stdout == b"" and p.stderr == b"" and took < 10, f"{took:.1f}s")
check("hook: the detached worker reached the Worker with POST /extract and POST /capture", any(pth == "/extract" for _, pth, _ in srv.requests) and len(srv.captured) == 1
      and srv.captured[0]["source"] == "session-capture" and "auto-capture" in srv.captured[0]["tags"], str(srv.requests[-3:]))
check("the posted capture carries the harness name kilo, in the body and in the header", srv.captured and srv.captured[0].get("harness") == "kilo" and [h.get("x-anymem-harness") for (m, pth, _), h in zip(srv.requests, srv.headers) if pth == "/capture"] == ["kilo"])
sent = json.dumps([b for m, pth, b in srv.requests if pth == "/extract"])
check("hook: what was sent for extraction holds the user's words and no injected block", "ferry route needs a codename" in sent and "PLANTEDWORD" not in sent and "planted-memory" not in sent)
log = (h / "cache" / "capture.log").read_text().splitlines()[-1]
check("hook: the capture log records the SessionEnd event", json.loads(log)["event"] == "SessionEnd" and json.loads(log)["memories"][0]["result"].startswith("stored"), log[:200])
p, took, h = capture_case(long_lines, {"ANYMEM_CAPTURE": "0"})
time.sleep(1.5)
check("hook: capture switched off starts nothing", p.returncode == 0 and not srv.captured and not any(pth == "/extract" for _, pth, _ in srv.requests))

# the spool pruning at session start
for label, extra in (("configured", good_env), ("capsule switched off", {**good_env, "ANYMEM_CAPSULE": "0"}), ("unconfigured client", {})):
    h = fresh(f"prune-{len(label)}-{time.time_ns()}")
    (h / "cache" / "kilo").mkdir(parents=True)
    old, new = h / "cache" / "kilo" / "old.jsonl", h / "cache" / "kilo" / "new.jsonl"
    old.write_text("{}\n")
    new.write_text("{}\n")
    os.utime(old, (time.time() - 20 * 86400,) * 2)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM", "CLAUDE_PLUGIN"))}
    env.update({"HOME": str(h), "ANYMEM_CONFIG_DIR": str(h / "cfg"), "ANYMEM_CACHE_DIR": str(h / "cache"), **extra})
    subprocess.run([sys.executable, HOOK, "session-start"], input=sample("session-start").encode(), capture_output=True, env=env, timeout=30)
    check(f"hook: a spool file older than 14 days is deleted at session start ({label}), a recent one stays", not old.exists() and new.exists())
srv.stop()

# ------------------------------------------------------------------ the JavaScript plugin

if shutil.which("node"):
    p = subprocess.run(["node", "--test", str(HERE / "plugin.test.mjs")], capture_output=True, text=True, timeout=120)
    summary = [x for x in p.stdout.splitlines() if x.startswith("ℹ pass") or x.startswith("ℹ fail")]
    check("plugin: node --test plugin.test.mjs passes", p.returncode == 0, p.stdout[-600:] + p.stderr[-300:])
    print("     " + ", ".join(summary))
else:
    print("SKIP the JavaScript plugin tests: node is not installed (they run with `node --test adapters/kilo/plugin.test.mjs`)")

# ------------------------------------------------------------------ house rules for the files in this folder

import re  # noqa: E402

BAD = re.compile("[" + chr(0x2014) + chr(0x2013) + "]| " + "-" * 2 + " ")  # built from parts so this file holds none of them
mine = [p for p in HERE.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix in (".py", ".js", ".mjs", ".md", ".json", ".jsonl")]
check("files: no em dash, en dash or spaced double dash in any file of this adapter", not [str(p.relative_to(ROOT)) for p in mine if BAD.search(p.read_text(encoding="utf-8"))])
check("files: no byte of the shipped adapter code mentions a personal path", not [str(p.relative_to(ROOT)) for p in mine if p.name != "test_adapter.py" and re.search("/Us" + "ers/|/opt" + "/drive", p.read_text(encoding="utf-8"))])

shutil.rmtree(TMP, ignore_errors=True)
print(f"{'FAILED' if failures else 'ok'}: {len(failures)} failed")
sys.exit(1 if failures else 0)
