#!/usr/bin/env python3
"""The harness names. One list, the same one in the Worker, and every entry point sends its own name.

`python3 client/tests/test_harness_names.py`, exits non-zero on failure. No network beyond 127.0.0.1 (the fake Worker), every folder
the code touches is a temp folder, and the fake credential is built at runtime.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))

TMP = Path(tempfile.mkdtemp(prefix="hm-harness-"))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["HOME"] = str(TMP / "home")
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")) and key not in ("ANYMEM_CACHE_DIR", "ANYMEM_CONFIG_DIR"):
        del os.environ[key]

from hm import audit, harnesses  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures: list = []
TOKEN = "test-token-" + "0000"


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else (f"  [{detail}]" if detail else "")))
    if not cond:
        failures.append(name)


# 1. The list, and the Worker's copy of it.
js = (ROOT / "worker" / "harnesses.js").read_text(encoding="utf-8")
rows = re.findall(r'\{ id: "([a-z]+)", label: "([^"]+)", aliases: \[([^\]]*)\] \}', js.split("export const DASHBOARD")[0])
worker_ids = tuple(r[0] for r in rows)
worker_aliases = {a: r[0] for r in rows for a in re.findall(r'"([^"]+)"', r[2])}
check("the Worker's list was read", len(rows) >= 6, str(rows))
check("the client and the Worker list the same ids, in the same order", worker_ids == harnesses.IDS, f"{worker_ids} {harnesses.IDS}")
check("the client and the Worker know the same aliases", worker_aliases == harnesses.ALIASES, f"{worker_aliases} {harnesses.ALIASES}")
check("the five adapters and Claude Code are all in the list", set(harnesses.IDS) >= {"claude", "codex", "agy", "dsh", "kilo", "zcode"})

# 2. Names.
check("a known name resolves to its id whatever its case", harnesses.resolve("Codex") == "codex" and harnesses.resolve(" ZCODE ") == "zcode")
check("an alias resolves to its id", harnesses.resolve("claude-code") == "claude" and harnesses.resolve("Antigravity") == "agy")
check("an unknown name is kept, cleaned", harnesses.resolve("my tool!") == "mytool" and harnesses.resolve(None) == "")
check("a name is cut to 64 characters", len(harnesses.clean("a" * 100)) == 64)
for adapter in sorted((ROOT / "adapters").glob("*/hook.py")):
    ids = re.findall(r'os\.environ\["ANYMEM_HARNESS"\] = "([a-z]+)"', adapter.read_text(encoding="utf-8"))
    check(f"the {adapter.parent.name} hook assigns one harness id, outright, and it is in the list", len(ids) == 1 and ids[0] in harnesses.IDS, str(ids))
    check(f"the {adapter.parent.name} hook does not use setdefault for its name", "setdefault(\"ANYMEM_HARNESS\"" not in adapter.read_text(encoding="utf-8"))
check("every adapter in the list has a hook", {p.parent.name for p in (ROOT / "adapters").glob("*/hook.py")} == set(harnesses.IDS) - {"claude"})
check("default_to names the process only when nothing else did", harnesses.default_to("claude") == "claude")
check("default_to leaves a name that is already there", harnesses.default_to("codex") == "claude")
del os.environ["ANYMEM_HARNESS"]

# 3. The note a hook leaves, and the order audit.harness() reads.
check("with no variable and no note the harness is blank, not Claude Code", audit.harness() == "" and audit.headers()["X-Anymem-Harness"] == "")
harnesses.hint("codex")
check("a note names the harness for a script run later", audit.harness() == "codex")
os.environ["ANYMEM_HARNESS"] = "zcode"
check("the variable beats the note", audit.harness() == "zcode")
del os.environ["ANYMEM_HARNESS"]
check("an old note is ignored", harnesses.read_hint(time.time() + harnesses.HINT_TTL + 5) == "" and harnesses.read_hint(time.time() + 60) == "codex")
hint_path = TMP / "cache" / "harness-hint.json"
check("the note is private", (hint_path.stat().st_mode & 0o777) == 0o600)
before = hint_path.stat().st_mtime_ns
harnesses.hint("codex")
check("an unchanged recent note is not rewritten", hint_path.stat().st_mtime_ns == before)
harnesses.hint("agy")
check("a different harness replaces the note", harnesses.read_hint() == "agy")
hint_path.write_text("not json", encoding="utf-8")
check("a damaged note reads as nothing and never raises", harnesses.read_hint() == "" and audit.harness() == "")
audit.set_origin("script", "recall")
os.environ["ANYMEM_HARNESS"] = "dsh"
audit.set_origin("script", "recall")
check("a script does not write a note", harnesses.read_hint() == "")
audit.set_origin("hook", "recall", "s")
check("a hook writes the note for its harness", harnesses.read_hint() == "dsh")
os.environ["ANYMEM_HARNESS"] = "not-a-harness"
audit.set_origin("hook", "recall", "s")
check("a name that is not in the list is never written as a note", harnesses.read_hint() == "dsh")
del os.environ["ANYMEM_HARNESS"]
hint_path.unlink()

# 4. Every entry point sends its own name, also when the environment already holds another one.
HOOKS = {
    "agy": ("adapters/agy/hook.py", ["prompt"], "adapters/agy/fixtures/pre_invocation_first.json"),
    "codex": ("adapters/codex/hook.py", ["prompt"], "adapters/codex/fixtures/payload-UserPromptSubmit.json"),
    "dsh": ("adapters/dsh/hook.py", ["prompt"], "adapters/dsh/fixtures/payload-prompt.json"),
    "kilo": ("adapters/kilo/hook.py", ["prompt"], "adapters/kilo/fixtures/prompt.json"),
    "zcode": ("adapters/zcode/hook.py", ["prompt"], "adapters/zcode/fixtures/payload-prompt.json"),
}
SKIP = ("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")


def run_hook(argv: list, data: str, env_extra: dict, cache: Path):
    srv = fake_worker.start(recall=[{"id": "a1", "content": "---\nname: m\ndescription: d\n---\nbody", "tags": []}], capsule=[{"slot": "identity", "content": "rules"}])
    env = {k: v for k, v in os.environ.items() if not k.startswith(SKIP)}
    env.update(ANYMEM_URL=srv.url, ANYMEM_TOKEN=TOKEN, ANYMEM_CACHE_DIR=str(cache), ANYMEM_CONFIG_DIR=str(cache / "cfg"), HOME=str(cache / "home"), **env_extra)
    p = subprocess.run([sys.executable, *argv], input=data, capture_output=True, text=True, env=env, timeout=60)
    srv.stop()
    return p, srv


for name, (script, args, fixture) in HOOKS.items():
    data = (ROOT / fixture).read_text(encoding="utf-8")
    for label, extra in (("with a clean environment", {}), ("with another harness's name already in the environment", {"ANYMEM_HARNESS": "claude"})):
        cache = TMP / f"{name}-{len(label)}"
        p, srv = run_hook([str(ROOT / script), *args], data, extra, cache)
        names = {h.get("x-anymem-harness") for h in srv.headers}
        check(f"{name} hook, {label}, sends its own name", p.returncode == 0 and srv.headers and names == {name}, f"{names} {p.stderr[-200:]}")
    note = json.loads((cache / "harness-hint.json").read_text(encoding="utf-8")) if (cache / "harness-hint.json").exists() else {}
    check(f"{name} hook leaves a note naming itself", note.get("harness") == name, str(note))

recall_in = json.dumps({"prompt": "What did we decide about the restore window for the trash?", "session_id": "s1", "cwd": str(TMP)})
for label, hook in (("recall", "hooks/memory_recall.py"), ("session start", "hooks/session_start.py")):
    p, srv = run_hook([str(ROOT / hook)], recall_in, {}, TMP / f"claude-{label[:3]}")
    names = {h.get("x-anymem-harness") for h in srv.headers}
    check(f"the Claude Code {label} hook names itself", p.returncode == 0 and srv.headers and names == {"claude"}, f"{names} {p.stderr[-200:]}")

# 5. A skill script run by an agent in another harness. Only the note can tell it which harness it is in.
cache = TMP / "scripts"
data = (ROOT / HOOKS["codex"][2]).read_text(encoding="utf-8")
run_hook([str(ROOT / HOOKS["codex"][0]), "prompt"], data, {}, cache)
check("the codex hook left a note in this cache folder", (cache / "harness-hint.json").exists())
srv = fake_worker.start()
env = {k: v for k, v in os.environ.items() if not k.startswith(SKIP)}
env.update(ANYMEM_URL=srv.url, ANYMEM_TOKEN=TOKEN, ANYMEM_CACHE_DIR=str(cache), ANYMEM_CONFIG_DIR=str(cache / "cfg"), HOME=str(cache / "home"))
TEXT = "---\nname: restore-window\ndescription: how long the trash keeps a memory\n---\n\nThe trash keeps a memory for fourteen days."
p = subprocess.run([sys.executable, str(ROOT / "skills/anymem/scripts/remember.py"), TEXT, "--project", "global"], capture_output=True, text=True, env=env, timeout=60)
check("remember.py in a codex session saves under codex, body and header", p.returncode == 0 and srv.captured and srv.captured[0].get("harness") == "codex" and srv.headers[-1].get("x-anymem-harness") == "codex", f"{p.stderr[-200:]} {srv.captured}")
old = json.loads((cache / "harness-hint.json").read_text(encoding="utf-8"))
(cache / "harness-hint.json").write_text(json.dumps({**old, "ts": time.time() - harnesses.HINT_TTL - 60}), encoding="utf-8")
p = subprocess.run([sys.executable, str(ROOT / "skills/anymem/scripts/remember.py"), TEXT + " Again.", "--project", "global"], capture_output=True, text=True, env=env, timeout=60)
check("with an old note remember.py saves with no harness, never under Claude Code", p.returncode == 0 and len(srv.captured) == 2 and "harness" not in srv.captured[1] and srv.headers[-1].get("x-anymem-harness") == "", str(srv.captured[-1]))
env["ANYMEM_HARNESS"] = "claude"
p = subprocess.run([sys.executable, str(ROOT / "skills/anymem/scripts/remember.py"), TEXT + " Third.", "--project", "global"], capture_output=True, text=True, env=env, timeout=60)
check("with the variable set (Claude Code's env file) remember.py saves under claude", p.returncode == 0 and srv.captured[2].get("harness") == "claude" and srv.headers[-1].get("x-anymem-harness") == "claude")
srv.stop()

# 6. A save from the capture hook carries the format as its harness, which is the id.
sys.path.insert(0, str(ROOT / "hooks"))
import memory_capture  # noqa: E402
from hm import api  # noqa: E402

srv = fake_worker.start()
os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"] = srv.url, TOKEN
for ident in harnesses.IDS:
    os.environ["ANYMEM_HARNESS"] = ident
    memory_capture.store({"name": "n-" + ident, "description": "d", "type": "user", "body": "b " * 30}, None, ["captured-by:" + ident], ident, "sess-1")
    sent = srv.captured[-1]
    check(f"a {ident} capture carries its id in the body and the header", sent.get("harness") == ident and srv.headers[-1].get("x-anymem-harness") == ident)
srv.stop()

print()
print(f"{len(failures)} failed" if failures else "ok")
sys.exit(1 if failures else 0)
