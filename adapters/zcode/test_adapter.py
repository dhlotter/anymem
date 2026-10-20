#!/usr/bin/env python3
"""Runnable check for the ZCode adapter. `python3 adapters/zcode/test_adapter.py`, exits non-zero on failure.

Offline: no ZCode, no Worker, no credentials. ZCode's command line is replaced by fixtures/fake_zcode.py (run by Python, set up
as a fake app folder), the Worker by hm.testing.fake_worker. Every folder the code can touch is a temporary one, and every fake
secret is built at runtime.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIXTURES = HERE / "fixtures"
TMP = Path(tempfile.mkdtemp()).resolve()
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")):
        del os.environ[key]
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")

sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(HERE))
from hm.testing import fake_worker  # noqa: E402
import payload  # noqa: E402
import emit  # noqa: E402
import transcript  # noqa: E402

failures: list = []


def check(name: str, cond: bool) -> None:
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def load_adapter():
    spec = importlib.util.spec_from_file_location("zcode_adapter_under_test", HERE / "adapter.py")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HERE))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(HERE))
    return module


adapter = load_adapter()


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------- payload
KEYS = {"hook_event_name", "session_id", "prompt", "transcript_path", "cwd"}
for file, event in (("payload-session-start.json", "SessionStart"), ("payload-prompt.json", "UserPromptSubmit"), ("payload-stop.json", "Stop")):
    raw = fixture(file)
    norm = payload.normalize(raw)
    check(f"payload: {file} carries the five shared keys", KEYS <= set(norm) and all(isinstance(norm[k], str) for k in KEYS))
    check(f"payload: {file} is {event} with its session, folder and transcript", norm["hook_event_name"] == event
          and norm["session_id"] == raw["session_id"] and norm["cwd"] == raw["cwd"] and norm["transcript_path"] == raw["transcript_path"])
check("payload: the prompt comes through", payload.normalize(fixture("payload-prompt.json"))["prompt"] == "Reply with the single word OK")
check("payload: the last reply comes through on Stop", payload.normalize(fixture("payload-stop.json"))["last_assistant_message"] == "OK")
camel = {"hookEventName": "UserPromptSubmit", "sessionId": "s1", "transcriptPath": "/t.jsonl", "cwd": "/w", "prompt": "p"}
check("payload: camelCase keys alone are enough", payload.normalize(camel)["session_id"] == "s1" and payload.normalize(camel)["transcript_path"] == "/t.jsonl")
check("payload: the hook word fills a missing event name", payload.normalize({"session_id": "s"}, "capture")["hook_event_name"] == "Stop"
      and payload.normalize({}, "prompt")["hook_event_name"] == "UserPromptSubmit" and payload.normalize({}, "session-start")["hook_event_name"] == "SessionStart")
check("payload: garbage gives empty strings, never an error", all(payload.normalize(x) == payload.normalize({}) for x in (None, [], "text", 7)))
check("payload: every shared event name is known", set(payload.EVENTS) == {"SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd", "Stop"})

# ---------------------------------------------------------------- emit
text = "## Memory capsule\nrules"
check("emit: SessionStart bytes", emit.context("SessionStart", text) == json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}) + "\n")
check("emit: UserPromptSubmit bytes", emit.context("UserPromptSubmit", "m") == '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "m"}}\n')
check("emit: no text prints nothing", emit.context("SessionStart", "") == "" and emit.context("UserPromptSubmit", "  \n") == "")
check("emit: an event that takes no context prints nothing", emit.context("Stop", "x") == "")
check("emit: long context is cut under the shared cap", len(json.loads(emit.context("SessionStart", "x" * 20000))["hookSpecificOutput"]["additionalContext"]) == emit.LIMIT)

# ---------------------------------------------------------------- transcript reader
turns, end = transcript.read_turns(str(FIXTURES / "transcript.jsonl"), 0)
check("transcript: the recorded sample reads as one user and one assistant turn", turns == [("USER", "Reply with the single word OK"), ("ASSISTANT", "OK")])
check("transcript: it consumes the whole file", end == (FIXTURES / "transcript.jsonl").stat().st_size)
turns, end = transcript.read_turns(str(FIXTURES / "transcript-noisy.jsonl"), 0)
joined = "\n".join(t for _, t in turns)
check("transcript: tool calls, tool results, thinking, system, developer and tool messages are left out",
      "cat wrangler" not in joined and "d1_databases" not in joined and "hidden reasoning" not in joined and "coding agent" not in joined
      and "developer note" not in joined and "raw tool output" not in joined)
check("transcript: an injected capsule or recalled block is never captured back",
      "Memory capsule" not in joined and "Relevant memories" not in joined and "sessions-db" not in joined and "Always-on" not in joined
      and "must never be captured" not in joined and "system-reminder" not in joined)
check("transcript: the user's own text next to an injected block is kept", ("USER", "Which database do we use for sessions?") in turns)
check("transcript: assistant text is kept, string content and block content", ("ASSISTANT", "Checking the config first.") in turns and ("ASSISTANT", "Sessions use D1.") in turns)
check("transcript: a Claude layout record (top level type) is read", ("USER", "A Claude layout record with a top level type.") in turns)
check("transcript: nothing else got through", len(turns) == 4)
partial = TMP / "partial.jsonl"
partial.write_bytes((FIXTURES / "transcript.jsonl").read_bytes() + b'{"message": {"role": "user", "content": [{"type": "text", "text": "half')
turns, end = transcript.read_turns(str(partial), 0)
check("transcript: a partial last record stays for the next capture", len(turns) == 2 and end == (FIXTURES / "transcript.jsonl").stat().st_size)
with partial.open("ab") as f:
    f.write(b' a sentence"}]}}\n')
turns2, end2 = transcript.read_turns(str(partial), end)
check("transcript: the finished record is read from the saved offset", turns2 == [("USER", "half a sentence")] and end2 == partial.stat().st_size)
check("transcript: an offset past the end reads nothing", transcript.read_turns(str(partial), 10 ** 6) == ([], 10 ** 6))
junk = TMP / "junk.jsonl"
junk.write_bytes(b'not json\n\xff\xfe\n[1]\n{"message": 3}\n{"message": {"role": "user", "content": 5}}\n')
check("transcript: junk lines are skipped", transcript.read_turns(str(junk), 0)[0] == [])

# the shared Claude reader cannot read ZCode's records (no top level type), which is why this adapter has its own reader
spec = importlib.util.spec_from_file_location("memory_capture_claude_reader", ROOT / "hooks" / "memory_capture.py")
sys.path.insert(0, str(ROOT / "hooks"))
claude_side = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claude_side)
check("capture: the shared Claude reader finds nothing in a ZCode record file", claude_side.read_claude(str(FIXTURES / "transcript.jsonl"), 0)[0] == [])

# the shared capture code finds this reader by its format name
spec = importlib.util.spec_from_file_location("memory_capture_under_test", ROOT / "hooks" / "memory_capture.py")
sys.path.insert(0, str(ROOT / "hooks"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
check("capture: the shared code loads this reader by the format name zcode", capture.reader("zcode")(str(FIXTURES / "transcript.jsonl"), 0)[0][0] == ("USER", "Reply with the single word OK"))

# ---------------------------------------------------------------- a fake ZCode and a throwaway home
APP = TMP / "ZCode.app"
(APP / "Contents" / "Resources" / "glm").mkdir(parents=True)
shutil.copy(FIXTURES / "fake_zcode.py", APP / "Contents" / "Resources" / "glm" / "zcode.cjs")
with (APP / "Contents" / "Info.plist").open("wb") as f:
    plistlib.dump({"CFBundleShortVersionString": "9.9.9"}, f)
LOG = TMP / "fake-zcode.log"
os.environ.update({"ANYMEM_ZCODE_APP": str(APP), "ANYMEM_ZCODE_NODE": sys.executable, "FAKE_ZCODE_LOG": str(LOG)})


class Options:
    def __init__(self, home, root=ROOT, dry_run=False):
        self.dry_run, self.yes, self.plugin_root, self.home = dry_run, True, root, home


def make_home(name: str, with_state: bool = True) -> Path:
    home = TMP / name
    cli = home / ".zcode" / "cli"
    (cli / "plugins").mkdir(parents=True)
    if with_state:
        # a ZCode that already has another plugin, written the way a person or an older ZCode formatted it
        (cli / "config.json").write_text('{"plugins":{"enabledPlugins":{"other@elsewhere":true},"options":{}},"theme":"dark"}\n', encoding="utf-8")
        (cli / "plugins" / "installed_plugins.json").write_text('{\n  "version": 1,\n  "plugins": [{"id": "other@elsewhere", "path": "/nowhere"}]\n}\n', encoding="utf-8")
        (cli / "plugins" / "known_marketplaces.json").write_text('{"version":1,"marketplaces":[{"id":"elsewhere","name":"elsewhere"}]}', encoding="utf-8")
    return home


def snapshot(home: Path) -> dict:
    out = {}
    for path in sorted(home.rglob("*")):
        rel = str(path.relative_to(home))
        out[rel] = "dir" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def use_home(home: Path) -> None:
    os.environ["ANYMEM_HOME"] = str(home)


# detect
home = make_home("home-detect")
use_home(home)
info = adapter.detect()
check("detect: finds the app and node, reports ZCode's own version", info["found"] is True and info["version"] == "0.16.9" and info["config_path"].endswith(".zcode/cli/config.json"))
check("detect: the app version is in the notes", any("9.9.9" in n for n in info["notes"]))
check("detect: it writes nothing", not (home / ".zcode" / "anymem").exists() and not list(home.rglob("*.bak")))
os.environ["ANYMEM_ZCODE_APP"] = str(TMP / "missing.app")
info = adapter.detect()
check("detect: a missing app is found False with a note", info["found"] is False and info["notes"])
os.environ["ANYMEM_ZCODE_APP"] = str(APP)
os.environ["ANYMEM_ZCODE_NODE"] = ""
os.environ["PATH"], real_path = "", os.environ["PATH"]
check("detect: no node means not found", adapter.detect()["found"] is False)
os.environ["PATH"] = real_path
os.environ["ANYMEM_ZCODE_NODE"] = sys.executable

# ZCode's own Memory
home = make_home("home-memory")
use_home(home)
cli_config = home / ".zcode" / "cli" / "config.json"
check("memory: on by default for the command line, so it is reported", len(adapter.builtin_memory(home)) == 1)
cli_config.write_text(json.dumps({"features": {"memory": False}}), encoding="utf-8")
check("memory: features.memory false turns the warning off", adapter.builtin_memory(home) == [])
cli_config.write_text(json.dumps({"memory": {"use": False}}), encoding="utf-8")
check("memory: memory.use false turns the warning off", adapter.builtin_memory(home) == [])
(home / ".zcode" / "v2").mkdir()
(home / ".zcode" / "v2" / "setting.json").write_text(json.dumps({"memoryEnabled": True}), encoding="utf-8")
check("memory: the desktop switch memoryEnabled true is reported", len(adapter.builtin_memory(home)) == 1 and "desktop" in adapter.builtin_memory(home)[0])
(home / ".zcode" / "v2" / "setting.json").write_text(json.dumps({"memoryEnabled": False}), encoding="utf-8")
check("memory: memoryEnabled false is quiet", adapter.builtin_memory(home) == [])

# plan, install, check, uninstall
srv = fake_worker.start(recall=[], capsule=[])
os.environ["ANYMEM_URL"] = srv.url
os.environ["ANYMEM_TOKEN"] = "test-token-" + "0" * 8
home = make_home("home-main")
use_home(home)
before = snapshot(home)
calls0 = LOG.read_text()  # detect asked for the version, the plan and a dry run must add nothing
lines = adapter.plan(Options(home))
text = "\n".join(lines)
check("plan: names the plugin folder, the hook script and the three ZCode files",
      str(home / ".zcode" / "anymem" / "plugin") in text and str(ROOT / "adapters" / "zcode" / "hook.py") in text
      and "config.json" in text and "installed_plugins.json" in text and "known_marketplaces.json" in text)
check("plan: names the two zcode commands and says no setting changes", "plugins marketplace add" in text and "plugins install anymem@anymem" in text and "No ZCode setting is changed" in text)
check("plan: it writes nothing and runs nothing", snapshot(home) == before and LOG.read_text() == calls0)
check("plan: mentions ZCode's own Memory when it is on", "two memory systems" in text)

dry = adapter.install(Options(home, dry_run=True))
check("install: a dry run changes nothing", dry["changed"] == [] and snapshot(home) == before and LOG.read_text() == calls0)

problems = adapter.check()
check("check: before install it says the plugin is missing", problems["ok"] is False and any("not installed" in p for p in problems["problems"]))

result = adapter.install(Options(home))
changed = [Path(p) for p in result["changed"]]
check("install: every changed path is inside the home folder", changed and all(str(p.resolve()).startswith(str(home.resolve())) for p in changed))
source = home / ".zcode" / "anymem" / "plugin"
hooks = json.loads((source / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
check("install: three hooks, one command string each (ZCode ignores an args list)", sorted(hooks) == ["SessionStart", "Stop", "UserPromptSubmit"]
      and all(set(h[0]["hooks"][0]) == {"type", "command", "timeout"} and h[0]["hooks"][0]["command"].startswith(sys.executable + " ") for h in hooks.values()))
check("install: each hook runs hook.py with its own word", [hooks[e][0]["hooks"][0]["command"].split()[-1] for e in ("SessionStart", "UserPromptSubmit", "Stop")] == ["session-start", "prompt", "capture"])
check("install: the plugin is marked with the product's name", json.loads((source / ".claude-plugin" / "plugin.json").read_text())["name"] == "anymem")
calls = LOG.read_text().splitlines()
check("install: it drove zcode plugins validate, marketplace add and install", any(c.startswith("plugins validate") for c in calls)
      and any(c.startswith("plugins marketplace add") for c in calls) and any(c.startswith("plugins install anymem@anymem") for c in calls))
check("install: other plugins and settings are untouched", '"other@elsewhere"' in (home / ".zcode" / "cli" / "config.json").read_text() and "theme" not in "".join(calls))
cfg_bak = Path(str(home / ".zcode" / "cli" / "config.json") + ".anymem.bak")
check("install: each existing ZCode file was backed up once, byte for byte", cfg_bak.read_text() == '{"plugins":{"enabledPlugins":{"other@elsewhere":true},"options":{}},"theme":"dark"}\n'
      and len(list(home.rglob("*.anymem.bak"))) == 3)
check("install: the notes warn about ZCode's own Memory and tell the person to restart", any("Memory" in n for n in result["notes"]) and any("Restart" in n for n in result["notes"]))

good = adapter.check()
check("check: after install the wiring is ok", good["ok"] is True)
check("check: it still warns about ZCode's own Memory, without failing", any(p.startswith("warning:") for p in good["problems"]))
check("check: it reached the Worker's health route", any(path.startswith("/health") for _, path, _ in srv.requests))

adapter.install(Options(home))  # a second install must not change the backups or leave a second copy
check("install: twice is the same as once", len(list(home.rglob("*.anymem.bak"))) == 3 and cfg_bak.read_text().endswith('"theme":"dark"}\n'))
check("check: still ok after a second install", adapter.check()["ok"] is True)

kept = Path(os.environ["ANYMEM_CACHE_DIR"]) / "zcode-sessions"
kept.mkdir(parents=True, exist_ok=True)
(kept / "sess_x.jsonl").write_text("{}\n", encoding="utf-8")
un = adapter.uninstall()
check("uninstall: the conversation files the hook kept are removed too", not kept.exists())
check("uninstall: everything it reports is inside the home folder", un["changed"] and all(str(Path(p).resolve()).startswith(str(home.resolve())) for p in un["changed"]))
after = snapshot(home)
check("uninstall: the home folder is byte identical to before the install", after == before)
if after != before:
    print("     only before:", sorted(set(before) - set(after))[:6], "only after:", sorted(set(after) - set(before))[:6],
          "changed:", sorted(k for k in before if k in after and before[k] != after[k])[:6])
check("check: after uninstall it says the plugin is gone", adapter.check()["ok"] is False)
check("uninstall: a second one is quiet", adapter.uninstall()["changed"] == [])

# a bookkeeping folder that was there before install stays after uninstall, even when empty
home = make_home("home-empty-cache")
use_home(home)
(home / ".zcode" / "cli" / "plugins" / "cache").mkdir(parents=True)
adapter.install(Options(home))
adapter.uninstall()
check("uninstall keeps an empty ZCode folder that install did not create", (home / ".zcode" / "cli" / "plugins" / "cache").is_dir())

# a file that changed for another reason in between is not rolled back
home = make_home("home-between")
use_home(home)
adapter.install(Options(home))
cfg = home / ".zcode" / "cli" / "config.json"
data = json.loads(cfg.read_text())
data["plugins"]["enabledPlugins"]["later@else"] = True
cfg.write_text(json.dumps(data), encoding="utf-8")
adapter.uninstall()
check("uninstall: a plugin installed in between is kept, our entry and the backup are gone",
      "later@else" in cfg.read_text() and "anymem@anymem" not in cfg.read_text() and not list(home.rglob("*.bak")))

# a state file that is not valid JSON is refused, nothing is written
home = make_home("home-invalid")
use_home(home)
(home / ".zcode" / "cli" / "plugins" / "installed_plugins.json").write_text("{not json", encoding="utf-8")
before = snapshot(home)
calls_before = LOG.read_text() if LOG.exists() else ""
try:
    adapter.install(Options(home))
    refused = False
except ValueError as exc:
    refused = "installed_plugins.json" in str(exc)
check("install: refuses a ZCode file that is not valid JSON, and names it", refused)
check("install: a refused install wrote nothing and ran nothing", snapshot(home) == before and (LOG.read_text() if LOG.exists() else "") == calls_before)

# no ZCode at all
os.environ["ANYMEM_ZCODE_APP"] = str(TMP / "missing.app")
try:
    adapter.install(Options(make_home("home-none")))
    refused = False
except RuntimeError:
    refused = True
check("install: no ZCode means a clear refusal", refused)
check("check: no ZCode means not ok", adapter.check()["ok"] is False)
os.environ["ANYMEM_ZCODE_APP"] = str(APP)

# a hook that points at a script that is gone
home = make_home("home-gone")
use_home(home)
empty_root = TMP / "empty-root"
empty_root.mkdir()
adapter.install(Options(home, root=empty_root))
gone = adapter.check()
check("check: a hook pointing at a missing hook.py is a problem", gone["ok"] is False and any("does not exist" in p for p in gone["problems"]))
adapter.uninstall()

# the Worker is not configured
for key in ("ANYMEM_URL", "ANYMEM_TOKEN"):
    os.environ.pop(key)
home = make_home("home-noworker")
use_home(home)
adapter.install(Options(home))
res = adapter.check()
check("check: an unconfigured client is a problem, in plain words", res["ok"] is False and any("not reachable" in p and "not configured" in p for p in res["problems"]))
adapter.uninstall()
os.environ["ANYMEM_URL"] = srv.url
os.environ["ANYMEM_TOKEN"] = "test-token-" + "0" * 8

# uninstall accepts only the words for "already gone", not any error that happens to contain "not"
real_run = adapter._run
adapter._run = lambda args, home: (1, "", "Error: the plugin is locked, not allowed by policy")
check("uninstall: an error that only contains 'not' is reported", len(adapter._remove_from_zcode(TMP)) == 2)
adapter._run = lambda args, home: (1, "Plugin not installed: anymem@anymem", "")
check("uninstall: 'not installed' on stdout is the state we want", adapter._remove_from_zcode(TMP) == [])
adapter._run = lambda args, home: (1, "", "Marketplace not found: anymem")
check("uninstall: 'not found' on stderr is the state we want", adapter._remove_from_zcode(TMP) == [])
adapter._run = real_run

# a node warning on stderr must not break the version or the plugin list, which are read from stdout only
warn = TMP / "node-warn"
warn.write_text(f"#!{sys.executable}\nimport os, sys\nsys.stderr.write('(node) warning: deprecated option\\n')\n"
                f"os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n", encoding="utf-8")
warn.chmod(0o755)
node_before = os.environ.get("ANYMEM_ZCODE_NODE")
os.environ["ANYMEM_ZCODE_NODE"] = str(warn)
try:
    home = make_home("home-warn")
    use_home(home)
    adapter.install(Options(home))
    check("detect: a node warning on stderr leaves the version intact", adapter.detect()["version"] == "0.16.9")
    check("check: a node warning on stderr does not fail the check", adapter.check()["ok"] is True)
    adapter.uninstall()
finally:
    os.environ["ANYMEM_ZCODE_NODE"] = node_before or sys.executable

# the check runs the hook with the interpreter the hook command names: a command whose interpreter cannot run it is a problem
home = make_home("home-badpy")
use_home(home)
adapter.install(Options(home))
installed = json.loads((home / ".zcode" / "cli" / "plugins" / "installed_plugins.json").read_text())["plugins"]
hooks_json = Path(next(p["path"] for p in installed if p["id"] == adapter.PLUGIN_ID)) / "hooks" / "hooks.json"
data = json.loads(hooks_json.read_text())
for groups in data["hooks"].values():
    for group in groups:
        for hook in group["hooks"]:
            parts = shlex.split(hook["command"])
            parts[0] = "/nonexistent/python-for-anymem"
            hook["command"] = " ".join(shlex.quote(x) for x in parts)
hooks_json.write_text(json.dumps(data), encoding="utf-8")
bad = adapter.check()
check("check: a hook whose interpreter cannot run hook.py is a problem, in plain words",
      bad["ok"] is False and any("did not run" in p and "hook.py" in p for p in bad["problems"]))
adapter.uninstall()

# the shared clean up of per session files: one untouched for 14 days goes, a recent one stays
sys.path.insert(0, str(ROOT / "hooks"))
import adapter_gate  # noqa: E402
stale_dir = TMP / "prune-check"
stale_dir.mkdir()
stale = stale_dir / "stale.jsonl"
stale.write_text("{}\n", encoding="utf-8")
os.utime(stale, (time.time() - 15 * 86400, time.time() - 15 * 86400))
fresh_file = stale_dir / "fresh.jsonl"
fresh_file.write_text("{}\n", encoding="utf-8")
adapter_gate.prune(stale_dir)
check("prune: a session file untouched for 14 days goes, a recent one stays", not stale.exists() and fresh_file.exists())

# ---------------------------------------------------------------- hook.py
HOOK = str(HERE / "hook.py")
hook_cache = TMP / "hook-cache"


def hook_env(**extra) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("ANYMEM_")}
    # HOME too: the shared recall hook keeps its "already shown" file under the home folder, whatever the cache setting says
    env.update({"HOME": str(TMP / "hook-home"), "ANYMEM_CONFIG_DIR": str(TMP / "hook-config"),
                "ANYMEM_CACHE_DIR": str(hook_cache), "ANYMEM_PROJECT": "global"})
    env.update(extra)
    return env


def run_hook(word, stdin, env=None, args=None):
    argv = [sys.executable, HOOK] + ([word] if args is None else args)
    return subprocess.run(argv, input=stdin, capture_output=True, env=env or hook_env(), timeout=60)


garbage = [b"", b"not json", b"[]", b"null", b'"text"', b"\xff\xfe\x00", b"{" * 5000, b'{"prompt": 7, "session_id": [1], "cwd": {}}']
quiet = True
for word in ("session-start", "prompt", "capture", "nonsense", ""):
    for data in garbage:
        done = run_hook(word, data)
        if done.returncode != 0 or done.stdout or done.stderr:
            quiet = False
            print("     noisy:", word, data[:20], done.returncode, done.stdout[:60], done.stderr[:60])
check("hook: garbage on stdin never raises, prints nothing, exits 0 (every event, unconfigured client)", quiet)
done = run_hook("x", b"{}", args=[])
check("hook: no argument at all is quiet too", done.returncode == 0 and not done.stdout and not done.stderr)
real = json.dumps(fixture("payload-prompt.json")).encode()
done = run_hook("prompt", real)
check("hook: a real prompt payload with no client configured prints nothing and exits 0", done.returncode == 0 and not done.stdout and not done.stderr)

marker = "HMZC" + "".join(chr(97 + (i * 7) % 26) for i in range(8))
memory = {"id": "mem-0001", "content": f"---\nname: marker-memory\ndescription: the {marker} fact\n---\nThe unique word is {marker}.", "tags": []}
capsule = [{"slot": "identity", "content": f"identity rules {marker}"}]
proposal = {"name": "zcode-sample-fact", "type": "project", "description": "a fact from a ZCode session",
            "body": "The sample project keeps its sessions in D1.\n**Why:** it was decided in this session.\n**How to apply:** assume D1."}
srv2 = fake_worker.start(recall=[memory], capsule=capsule, proposals=[proposal])
env = hook_env(ANYMEM_URL=srv2.url, ANYMEM_TOKEN="test-token-" + "0" * 8)

done = run_hook("session-start", json.dumps(fixture("payload-session-start.json")).encode(), env)
out = json.loads(done.stdout or "{}")
check("hook: session-start prints the capsule in ZCode's protocol", done.returncode == 0 and not done.stderr
      and out.get("hookSpecificOutput", {}).get("hookEventName") == "SessionStart" and marker in out["hookSpecificOutput"]["additionalContext"])
check("hook: session-start prints exactly one line", done.stdout.count(b"\n") == 1 and done.stdout.endswith(b"\n"))

prompt_payload = {**fixture("payload-prompt.json"), "session_id": "sess_00000000-0000-4000-8000-000000000005", "prompt": "Which fact do we hold about the unique word?"}
done = run_hook("prompt", json.dumps(prompt_payload).encode(), env)
out = json.loads(done.stdout or "{}")
check("hook: prompt prints the recalled memory in ZCode's protocol", done.returncode == 0 and not done.stderr
      and out.get("hookSpecificOutput", {}).get("hookEventName") == "UserPromptSubmit" and marker in out["hookSpecificOutput"]["additionalContext"])
sid = prompt_payload["session_id"]
buf = hook_cache / "zcode-sessions" / (sid + ".jsonl")
check("hook: the prompt was kept for capture, in a private file", buf.is_file() and (buf.stat().st_mode & 0o777) == 0o600
      and transcript.read_turns(str(buf), 0)[0] == [("USER", prompt_payload["prompt"])])
check("hook: what it kept never holds the injected memory", marker not in buf.read_text())

stop_payload = {**fixture("payload-stop.json"), "session_id": prompt_payload["session_id"], "last_assistant_message": "We keep sessions in D1."}
done = run_hook("capture", json.dumps(stop_payload).encode(), env)
check("hook: capture prints nothing and exits 0", done.returncode == 0 and not done.stdout and not done.stderr)
check("hook: the reply was kept after the prompt", transcript.read_turns(str(buf), 0)[0] == [("USER", prompt_payload["prompt"]), ("ASSISTANT", "We keep sessions in D1.")])
time.sleep(0.5)
check("hook: a short session starts no capture worker (under 8 KB of new conversation)", not srv2.captured and not any(p == "/extract" for _, p, _ in srv2.requests))

# enough conversation: the worker starts, reads this adapter's own file, extracts on the fake Worker and stores one proposal
long_session = "sess_00000000-0000-4000-8000-000000000002"
big = "We decided the sample project keeps its sessions in D1 and never in KV, because D1 is the single source of truth. " * 90
for n in range(2):
    run_hook("prompt", json.dumps({**prompt_payload, "session_id": long_session, "prompt": f"Part {n}. {big}"}).encode(), env)
    run_hook("capture", json.dumps({**stop_payload, "session_id": long_session, "last_assistant_message": f"Noted, part {n}."}).encode(),
             hook_env(ANYMEM_URL=srv2.url, ANYMEM_TOKEN="test-token-" + "0" * 8, ANYMEM_EXTRACTION="worker"))
deadline = time.time() + 30
while time.time() < deadline and not srv2.captured:
    time.sleep(0.3)
check("hook: a long session starts a worker, it reads the kept conversation and POSTs /capture", len(srv2.captured) >= 1)
check("hook: the stored memory is a proposal with the session source", bool(srv2.captured) and "auto-capture" in srv2.captured[0].get("tags", [])
      and srv2.captured[0].get("source") == "session-capture" and "zcode-sample-fact" in srv2.captured[0].get("content", ""))
sent = [b for m, p, b in srv2.requests if p == "/extract" and m == "POST"]
check("hook: the transcript sent for extraction holds the user's text and not an injected block", bool(sent)
      and "never in KV" in sent[0]["transcript"] and "Relevant memories" not in sent[0]["transcript"] and marker not in sent[0]["transcript"])

# capture off: nothing is kept at all
off_session = "sess_00000000-0000-4000-8000-000000000003"
run_hook("prompt", json.dumps({**prompt_payload, "session_id": off_session}).encode(), {**env, "ANYMEM_CAPTURE": "0"})
run_hook("capture", json.dumps({**stop_payload, "session_id": off_session}).encode(), {**env, "ANYMEM_CAPTURE": "0"})
check("hook: with capture off nothing is written to the cache", not (hook_cache / "zcode-sessions" / (off_session + ".jsonl")).exists())
(TMP / "hook-config").mkdir(exist_ok=True)
(TMP / "hook-config" / "config.json").write_text(json.dumps({"exclude_paths": [prompt_payload["cwd"]]}), encoding="utf-8")
ex_session = "sess_00000000-0000-4000-8000-000000000004"
run_hook("prompt", json.dumps({**prompt_payload, "session_id": ex_session}).encode(), env)
check("hook: an excluded folder keeps nothing", not (hook_cache / "zcode-sessions" / (ex_session + ".jsonl")).exists())
(TMP / "hook-config" / "config.json").unlink()

# recall off, and the capture child guard
done = run_hook("prompt", json.dumps(prompt_payload).encode(), {**env, "ANYMEM_RECALL": "0"})
check("hook: ANYMEM_RECALL=0 prints nothing", done.returncode == 0 and not done.stdout)
done = run_hook("prompt", json.dumps(prompt_payload).encode(), {**env, "ANYMEM_CAPTURE_CHILD": "1"})
check("hook: inside a capture child it does nothing", done.returncode == 0 and not done.stdout)

# the check word prints ok once the shared modules load, the adapter's check runs it
check("hook: the check word prints ok", run_hook("check", b"").stdout == b"ok\n")

# a session file past the cap is rotated aside, the turn goes into a new file, and the rotation is logged
big_session = "sess_00000000-0000-4000-8000-000000000006"
big_file = hook_cache / "zcode-sessions" / (big_session + ".jsonl")
big_file.parent.mkdir(parents=True, exist_ok=True)
big_file.write_bytes(b"x" * 4_000_100)
run_hook("prompt", json.dumps({**prompt_payload, "session_id": big_session, "prompt": "a turn after the cap was reached"}).encode(), env)
full = big_file.with_name(big_session + ".full.jsonl")
check("hook: a session file past 4 MB is rotated aside, not kept growing", full.is_file() and full.stat().st_size == 4_000_100)
check("hook: the new file holds the turn that came after the rotation", big_file.is_file() and b"a turn after the cap" in big_file.read_bytes()
      and big_file.stat().st_size < 10_000)
check("hook: the rotation is written to the capture log", "zcode-buffer-rotated" in (hook_cache / "capture.log").read_text())

# an unwritable cache costs the kept copy, never the recall for the prompt
blocker = TMP / "cache-blocker"
blocker.write_text("not a folder", encoding="utf-8")
done = run_hook("prompt", json.dumps({**prompt_payload, "session_id": "sess_00000000-0000-4000-8000-000000000007"}).encode(),
                {**env, "ANYMEM_CACHE_DIR": str(blocker / "cache")})
out = json.loads(done.stdout or "{}")
check("hook: with an unwritable cache the recall still prints", done.returncode == 0 and marker in out.get("hookSpecificOutput", {}).get("additionalContext", ""))

srv.stop()
srv2.stop()
shutil.rmtree(TMP, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'all passed'}: {len(failures)} failure(s)" if failures else "all zcode adapter checks passed")
sys.exit(1 if failures else 0)
