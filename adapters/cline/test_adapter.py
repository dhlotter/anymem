#!/usr/bin/env python3
"""Offline tests for the cline adapter. `/usr/bin/python3 adapters/cline/test_adapter.py`, exits non-zero on failure.

No Cline and no network beyond 127.0.0.1: the Worker is the fake in client/hm/testing/fake_worker.py, the Cline command line is
a stub written into a temporary folder (it records its arguments and makes the install folder the way the real one does), every
home, config and cache folder is a temporary one, and the JavaScript plugin tests run through `node --test` (skipped, with a
message, when node is missing). Nothing here touches the real ~/.cline.
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

TMP = Path(tempfile.mkdtemp(prefix="hm-cline-test-"))
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
    spec = importlib.util.spec_from_file_location("cline_test_" + name, HERE / f"{name}.py")
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
    """A plugin root with just the files the adapter looks for. The folder name can hold a space, a quote and a backslash."""
    root = TMP / name
    for rel in ("hooks/memory_recall.py", "hooks/memory_capsule.py", "hooks/memory_capture.py", "client/hm/config.py",
                "adapters/cline/hook.py", "adapters/cline/transcript.py"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("")
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "anymem", "version": "9.8.7"}))
    return root


# ------------------------------------------------------------------ payload

raw = {n: json.loads((FIX / f"{n}.json").read_text()) for n in ("session-start", "prompt", "capture")}
for event, expected in (("session-start", "SessionStart"), ("prompt", "UserPromptSubmit"), ("capture", "SessionEnd")):
    n = payload.normalise(raw[event], event)
    check(f"payload: the {event} fixture normalises to {expected}", n["hook_event_name"] == expected and set(n) == {"hook_event_name", "session_id", "prompt", "transcript_path", "cwd"}, str(n))
n = payload.normalise(raw["prompt"], "prompt")
check("payload: session, prompt, folder and spool path come through", n["session_id"] == raw["prompt"]["sessionID"] and n["prompt"] == raw["prompt"]["prompt"]
      and n["cwd"] == raw["prompt"]["directory"] and n["transcript_path"] == raw["prompt"]["spool"])
check("payload: every value is a string", all(isinstance(v, str) for v in n.values()))
check("payload: pre-compact is not an event of this adapter", payload.normalise(raw["capture"], "pre-compact")["hook_event_name"] == "")
check("payload: an unknown event has no name", payload.normalise(raw["prompt"], "bogus")["hook_event_name"] == "")
check("payload: garbage input gives empty strings, never an error", all(payload.normalise(x, "prompt")["session_id"] == "" for x in (None, "x", 5, [], {"sessionID": 7})))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache-for-default")
dflt = payload.normalise({"sessionID": "conv/odd id"}, "capture")["transcript_path"]
check("payload: with no spool path the default is the one plugin.js writes", dflt == str(TMP / "cache-for-default" / "cline" / "conv_odd_id.jsonl"), dflt)

# ------------------------------------------------------------------ emit

check("emit: the exact bytes for one piece of context and the keep answer", emit.reply("hello", True) == '{"keep": true, "additionalContext": "hello"}\n')
check("emit: no text, still the keep answer", emit.reply("", False) == '{"keep": false}\n')
check("emit: non ASCII text is escaped so any stdout encoding works", emit.reply("café", True).isascii() and json.loads(emit.reply("café", True))["additionalContext"] == "café")

# ------------------------------------------------------------------ transcript

spool = FIX / "spool.jsonl"
turns, end = transcript.read_turns(str(spool), 0)
check("transcript: the fixture reads as one user and one assistant turn", turns == [("USER", "Which codename did we pick for the ferry route?"), ("ASSISTANT", "The ferry route codename is quillfern.")], str(turns))
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
check("transcript: the capsule, reminders, system and tool text are dropped", all(x not in flat for x in ("CAPSULEWORD", "reminder text", "system prompt", "tool output", "synthetic text")))
check("transcript: a partial last record stays for the next capture", end == len((body).encode()) and "half written" not in flat)
mixed.write_text(body + partial + "\n")
turns2, end2 = transcript.read_turns(str(mixed), end)
check("transcript: the finished record is read from the saved offset", turns2 == [("ASSISTANT", "half written")] and end2 == mixed.stat().st_size, str(turns2))
wide = fresh("spool-wide") / "s.jsonl"
wide.write_text(json.dumps({"role": "user", "text": "café ☃ \U0001f600"}, ensure_ascii=False) + "\n" + json.dumps({"role": "assistant", "text": "ok"}) + "\n", encoding="utf-8")
wturns, wend = transcript.read_turns(str(wide), 0)
check("transcript: multibyte text keeps byte offsets exact", wturns[0][1] == "café ☃ \U0001f600" and wend == wide.stat().st_size and transcript.read_turns(str(wide), wend) == ([], wend))

os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "import-cache")
import memory_capture  # noqa: E402

check("transcript: the shared capture hook loads this reader for format cline", memory_capture.reader("cline")(str(spool), 0)[0] == [("USER", "Which codename did we pick for the ferry route?"), ("ASSISTANT", "The ferry route codename is quillfern.")])
text, user_chars, end = memory_capture.condense(str(spool), 0, "cline")
check("transcript: condense gives the conversation text", text == "USER: Which codename did we pick for the ferry route?\n\nASSISTANT: The ferry route codename is quillfern." and user_chars > 0, text)
check("transcript: the reader resolves to this adapter's file", Path(memory_capture.reader("cline").__code__.co_filename).resolve() == (HERE / "transcript.py").resolve())

# ------------------------------------------------------------------ the stub Cline command line

STUB = '''#!%(python)s
"""A stand in for `cline-cli`. It records its arguments and makes (and removes) the install folder the way the real one does."""
import json, os, shutil, sys
from pathlib import Path

args = sys.argv[1:]
home = Path(os.environ["HOME"])
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps({"args": args, "home": str(home)}) + "\\n")
fail = os.environ.get("STUB_FAIL", "")
if args == ["--version"]:
    print(os.environ.get("STUB_VERSION", "3.0.74"))
elif args[:2] == ["plugin", "install"]:
    if fail == "install":
        sys.stderr.write("error: Plugin install failed: boom\\n")
        sys.exit(1)
    if fail == "badjson":
        print("not json")
        sys.exit(0)
    src = Path(args[2])
    where = Path(os.environ["STUB_INSTALL_AT"]) if os.environ.get("STUB_INSTALL_AT") else home / ".cline" / "plugins" / "_installed" / "local" / (src.name + "-abc123def456")
    if where.exists():
        shutil.rmtree(where)
    (where / "package").mkdir(parents=True)
    for item in src.iterdir():
        shutil.copy2(item, where / "package" / item.name)
    (where / "package.json").write_text(json.dumps({"name": src.name, "private": True, "cline": {"plugins": [{"paths": ["./package/anymem.js"]}]}}))
    print(json.dumps({"source": str(src), "installPath": str(where), "entryPaths": [str(where / "package" / "anymem.js")], "mcpSyncFailures": []}))
elif args[:2] == ["plugin", "uninstall"]:
    if fail == "uninstall":
        sys.stderr.write("error: Plugin uninstall failed: boom\\n")
        sys.exit(1)
    target = Path(args[2])
    if not target.exists():
        sys.stderr.write('error: No plugin found matching "%%s"\\n' %% args[2])
        sys.exit(1)
    shutil.rmtree(target)
    parent = target.parent
    if parent.name == "local" and not any(parent.iterdir()):
        parent.rmdir()
    print(json.dumps({"name": args[2], "installPath": str(target), "removedPaths": [str(target)], "entryPaths": []}))
else:
    sys.exit(2)
'''


def make_stub(name: str) -> Path:
    d = fresh(name)
    exe = d / "cline"
    exe.write_text(STUB % {"python": sys.executable})
    exe.chmod(0o755)
    (d / "calls.jsonl").write_text("")
    return exe


def calls_of(exe: Path) -> list:
    return [json.loads(x) for x in (exe.parent / "calls.jsonl").read_text().splitlines() if x]


def use_stub(exe: Path, **extra) -> None:
    for var in ("STUB_FAIL", "STUB_VERSION", "STUB_INSTALL_AT"):
        os.environ.pop(var, None)
    os.environ.update({"ANYMEM_CLINE_BIN": str(exe), "STUB_LOG": str(exe.parent / "calls.jsonl"), **extra})


stub = make_stub("stub-ok")
use_stub(stub)
empty_path = fresh("empty-path")
os.environ["PATH"] = str(empty_path) + os.pathsep + os.environ.get("PATH", "")  # a `cline` of the real machine must not be picked up
adapter.APP_BIN = str(TMP / "no-such-app" / "cline-cli")  # nor the desktop app's

# ------------------------------------------------------------------ install, check, uninstall

check("adapter: NAME and TITLE", adapter.NAME == "cline" and adapter.TITLE == "Cline")
home = fresh("home-detect")
os.environ["ANYMEM_HOME"] = str(home)
d = adapter.detect()
check("adapter: detect returns found, version, config_path and notes", set(d) == {"found", "version", "config_path", "notes"} and isinstance(d["found"], bool) and isinstance(d["notes"], list))
check("adapter: detect finds the command line named by ANYMEM_CLINE_BIN and reads its version", d["found"] and d["version"] == "3.0.74" and d["config_path"] == str(home / ".cline"), str(d))
check("adapter: detect only runs --version", [c["args"] for c in calls_of(stub)] == [["--version"]] and not any(home.iterdir()), str(calls_of(stub)))
os.environ["ANYMEM_CLINE_BIN"] = str(TMP / "missing-cline")
d = adapter.detect()
check("adapter: detect says not found, with a reason, when there is no command line", not d["found"] and d["version"] == "" and any("not" in x for x in d["notes"]), str(d))
use_stub(stub, STUB_VERSION="2.9.0")
d = adapter.detect()
check("adapter: detect names an old Cline in the notes", d["found"] and d["version"] == "2.9.0" and any("Cline 3 or later" in x for x in d["notes"]), str(d))
use_stub(stub)

home = fresh("home-bare")
os.environ["ANYMEM_HOME"] = str(home)
before = tree(home)
folder = home / ".config" / "anymem" / "cline-plugin"
plan_lines = adapter.plan(options(home))
check("adapter: plan names the folder, the two files, the command and the folders it creates", any(str(folder) in x and "anymem.js" in x and "package.json" in x for x in plan_lines)
      and any("plugin install" in x and "--force" in x and str(home) in x for x in plan_lines) and any("Create the folder" in x and str(home / ".config") in x for x in plan_lines)
      and any(str(ROOT) in x for x in plan_lines) and any("Uninstall" in x for x in plan_lines), "\n".join(plan_lines))
check("adapter: plan writes nothing and runs only --version", tree(home) == before and all(c["args"] == ["--version"] for c in calls_of(stub)))
res = adapter.install(options(home, dry_run=True))
check("adapter: a dry run changes nothing and reports the plan", tree(home) == before and res["changed"] == [] and res["notes"] == plan_lines)
os.environ["ANYMEM_CLINE_BIN"] = str(TMP / "missing-cline")
check("adapter: a dry run without a command line still prints a plan that says install will stop", any("not found" in x for x in adapter.install(options(home, dry_run=True))["notes"]))
use_stub(stub)

res = adapter.install(options(home))
install_dirs = sorted((home / ".cline" / "plugins" / "_installed" / "local").iterdir())
check("adapter: the generated folder holds exactly anymem.js and package.json", sorted(p.name for p in folder.iterdir()) == ["anymem.js", "package.json"], str(sorted(p.name for p in folder.iterdir())))
install_calls = [c for c in calls_of(stub) if c["args"][:2] == ["plugin", "install"]]
check("adapter: install ran `plugin install FOLDER --force --json` with HOME set to the home folder", len(install_calls) == 1
      and install_calls[0]["args"] == ["plugin", "install", str(folder), "--force", "--json"] and install_calls[0]["home"] == str(home), str(install_calls))
check("adapter: Cline's copy is in place and the result lists the files and the install folder", len(install_dirs) == 1 and (install_dirs[0] / "package" / "anymem.js").is_file()
      and res["changed"] == [str(folder / "anymem.js"), str(folder / "package.json"), str(install_dirs[0])], str(res["changed"]))
check("adapter: nothing is written outside the home", all(Path(c).resolve().is_relative_to(home.resolve()) for c in res["changed"]))
text = (folder / "anymem.js").read_text()
check("adapter: anymem.js is marked, and carries the root and the Python", text.startswith("// anymem begin") and text.rstrip().endswith("// anymem end")
      and f'const BAKED = {json.dumps({"root": str(ROOT), "python": sys.executable})};' in text)
check("adapter: the created folders are recorded in the header", adapter.DIRS_RE.search(text).group(1) == json.dumps([str(home / ".config"), str(home / ".config" / "anymem"), str(folder)]))
pkg = json.loads((folder / "package.json").read_text())
plugin_version = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text())["version"]
check("adapter: package.json names the plugin, its version, ESM, and the one explicit entry that asks for hooks",
      pkg["name"] == "anymem" and pkg["version"] == plugin_version and pkg["type"] == "module" and pkg["cline"] == {"plugins": [{"paths": ["./anymem.js"], "capabilities": ["hooks"]}]}, str(pkg))
check("adapter: the plan after install says our folder is rewritten only where it differs", any("rewritten only where it differs" in x for x in adapter.plan(options(home))))

# idempotent
calls_before = len(calls_of(stub))
snapshot_tree = tree(home)
res2 = adapter.install(options(home))
check("adapter: a second install changes nothing and does not run the install command again", res2["changed"] == [] and tree(home) == snapshot_tree
      and not [c for c in calls_of(stub)[calls_before:] if c["args"][:2] == ["plugin", "install"]], str(res2))
(install_dirs[0] / "package" / "anymem.js").write_text("// edited by hand\n")
res3 = adapter.install(options(home))
check("adapter: an install repairs Cline's copy when it differs", str(install_dirs[0]) in res3["changed"] and (install_dirs[0] / "package" / "anymem.js").read_text() == text, str(res3))

srv = fake_worker.start(recall=[], capsule=[])
os.environ.update({"ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-0000", "ANYMEM_CONFIG_DIR": str(fresh("config-ok"))})
snapshot_tree = tree(home)
c = adapter.check()
check("adapter: check is ok and the Worker answered /health", c["ok"] and c["problems"] == [] and ("GET", "/health", None) in srv.requests, str(c))
check("adapter: check asks the user to restart Cline", c["pending"] and "Restart Cline" in c["pending"][0], str(c))
check("adapter: check wrote nothing and ran no Cline command beyond the earlier ones", tree(home) == snapshot_tree)
srv.requests.clear()
(folder / "package.json").write_text(json.dumps({"name": "anymem"}))
c = adapter.check()
check("adapter: check reports a package.json without the plugin entry", not c["ok"] and any("cline.plugins" in p for p in c["problems"]), str(c))
(folder / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")
shutil.move(str(install_dirs[0]), str(TMP / "moved-copy"))
c = adapter.check()
check("adapter: check reports that Cline has no copy of the plugin", not c["ok"] and any("no copy" in p for p in c["problems"]), str(c))
shutil.move(str(TMP / "moved-copy"), str(install_dirs[0]))
(install_dirs[0] / "package" / "anymem.js").write_text(text.replace(sys.executable, "/some/other/python"))
c = adapter.check()
check("adapter: check reports Cline's copy differing from the generated one", not c["ok"] and any("differs" in p for p in c["problems"]), str(c))
(install_dirs[0] / "package" / "anymem.js").write_text(text)
srv.stop()
c = adapter.check()
check("adapter: check reports a Worker that does not answer", not c["ok"] and any("/health" in p for p in c["problems"]), str(c))
for var in ("ANYMEM_URL", "ANYMEM_TOKEN"):
    os.environ.pop(var)
c = adapter.check()
check("adapter: check reports a client that is not configured", not c["ok"] and any("not configured" in p for p in c["problems"]), str(c))

# check runs hook.py: a plugin root whose hook.py is broken is reported
broken_hook = fake_root("root-broken-hook")
(broken_hook / "adapters" / "cline" / "hook.py").write_text("import sys\nsys.stdout.write('not json')\n")
home_b = fresh("home-broken-hook")
os.environ["ANYMEM_HOME"] = str(home_b)
adapter.install(options(home_b, broken_hook))
c = adapter.check()
check("adapter: check reports a hook.py that does not answer with valid JSON", not c["ok"] and any("hook.py session-start" in p for p in c["problems"]), str(c))
adapter.uninstall()
os.environ["ANYMEM_HOME"] = str(home)

res = adapter.uninstall()
uninstall_calls = [c for c in calls_of(stub) if c["args"][:2] == ["plugin", "uninstall"]]
check("adapter: uninstall asked Cline to remove its copy, by the path of our install, with HOME set", uninstall_calls and uninstall_calls[-1]["args"] == ["plugin", "uninstall", str(install_dirs[0]), "--json"] and uninstall_calls[-1]["home"] == str(home), str(uninstall_calls))
left = tree(home)
check("adapter: uninstall leaves only the folders Cline itself made, nothing of ours", not any("anymem" in k for k in left) and not (home / ".config").exists(), str(sorted(left)))
check("adapter: uninstall reports the copy, both files, the folder and the folders install created, all inside the home", len(res["changed"]) == 6 and all(Path(c).is_relative_to(home) for c in res["changed"]), str(res))
check("adapter: check finds the wiring gone after uninstall", not adapter.check()["ok"] and "does not exist" in adapter.check()["problems"][0])
check("adapter: uninstalling twice is a quiet no-op", adapter.uninstall() == {"changed": []})

# a home that already has folders and other plugins: they are never touched or removed
home = fresh("home-neighbours")
os.environ["ANYMEM_HOME"] = str(home)
(home / ".config" / "anymem").mkdir(parents=True)
(home / ".config" / "anymem" / "config.json").write_text('{"url": "https://example.invalid"}\n')
other = home / ".cline" / "plugins" / "_installed" / "local" / "other-plugin-111" / "package"
other.mkdir(parents=True)
(other / "other.js").write_text("export default { name: 'other' }\n")
before = tree(home)
adapter.install(options(home))
check("adapter: install leaves the config folder and another plugin byte identical", all(tree(home).get(k) == v for k, v in before.items()))
check("adapter: an install into existing folders records only the folder it created", adapter.DIRS_RE.search((home / ".config/anymem/cline-plugin/anymem.js").read_text()).group(1) == json.dumps([str(home / ".config/anymem/cline-plugin")]))
adapter.uninstall()
check("adapter: uninstall restores the home byte identical, other plugins and existing folders kept", tree(home) == before, str(sorted(set(tree(home)) ^ set(before))))

# a failing command changes nothing
for label, extra in (("exit code 1", {"STUB_FAIL": "install"}), ("an answer that is not JSON", {"STUB_FAIL": "badjson"})):
    use_stub(stub, **extra)
    home = fresh("home-fail-" + extra["STUB_FAIL"])
    os.environ["ANYMEM_HOME"] = str(home)
    before = tree(home)
    try:
        adapter.install(options(home))
        msg = ""
    except ValueError as exc:
        msg = str(exc)
    check(f"adapter: install with a Cline command that gives {label} is a clear error and the home is byte identical", "plugin install" in msg and "Nothing was changed" in msg and tree(home) == before, msg)
use_stub(stub, STUB_INSTALL_AT=str(TMP / "elsewhere" / "plugin"))
(TMP / "elsewhere" / "plugin").mkdir(parents=True)
home = fresh("home-outside")
os.environ["ANYMEM_HOME"] = str(home)
before = tree(home)
try:
    adapter.install(options(home))
    msg = ""
except ValueError as exc:
    msg = str(exc)
check("adapter: an install folder outside the home is refused and nothing is left behind", "outside" in msg and tree(home) == before, msg)
use_stub(stub)
# a failure while upgrading puts the earlier files back
home = fresh("home-fail-upgrade")
os.environ["ANYMEM_HOME"] = str(home)
adapter.install(options(home))
first = {n: (home / ".config/anymem/cline-plugin" / n).read_bytes() for n in ("anymem.js", "package.json")}
real_python = adapter.scripts.hook_python
adapter.scripts.hook_python = lambda: "/usr/bin/other-python3"
use_stub(stub, STUB_FAIL="install")
try:
    adapter.install(options(home))
    msg = ""
except ValueError as exc:
    msg = str(exc)
adapter.scripts.hook_python = real_python
use_stub(stub)
check("adapter: a failed upgrade restores the earlier generated files", "plugin install" in msg and {n: (home / ".config/anymem/cline-plugin" / n).read_bytes() for n in first} == first, msg)
use_stub(stub, STUB_FAIL="uninstall")
before = tree(home)
try:
    adapter.uninstall()
    msg = ""
except ValueError as exc:
    msg = str(exc)
check("adapter: a failing uninstall command is a clear error and the generated folder stays, so uninstall can be run again", "plugin uninstall" in msg and tree(home) == before, msg)
use_stub(stub)
adapter.uninstall()
check("adapter: the retry then removes everything", not (home / ".config").exists())

# no usable command line
home = fresh("home-no-cline")
os.environ["ANYMEM_HOME"] = str(home)
before = tree(home)
os.environ["ANYMEM_CLINE_BIN"] = str(TMP / "missing-cline")
try:
    adapter.install(options(home))
    msg = ""
except ValueError as exc:
    msg = str(exc)
check("adapter: install without a Cline command line stops with a plain sentence and changes nothing", "command line was not found" in msg and tree(home) == before, msg)
use_stub(stub, STUB_VERSION="2.9.0")
try:
    adapter.install(options(home))
    msg = ""
except ValueError as exc:
    msg = str(exc)
check("adapter: install with a Cline older than 3 stops and changes nothing", "Cline 3 or later" in msg and tree(home) == before, msg)
use_stub(stub)
adapter.install(options(home))
os.environ["ANYMEM_CLINE_BIN"] = str(TMP / "missing-cline")
res = adapter.uninstall()
check("adapter: uninstall without a command line removes the one install folder that is verified to be ours", not any("anymem" in k for k in tree(home)) and any("cline-plugin-abc123def456" in c for c in res["changed"]), str(res))
use_stub(stub)

# refusals
home = fresh("home-refuse")
os.environ["ANYMEM_HOME"] = str(home)
foreign = home / ".config/anymem/cline-plugin"
foreign.mkdir(parents=True)
(foreign / "anymem.js").write_text("export default { name: 'somebody else' }\n")
before = tree(home)
for label, fn in (("install", lambda: adapter.install(options(home))), ("uninstall", lambda: adapter.uninstall())):
    try:
        fn()
        refused = False
    except ValueError as exc:
        refused = "not written by anymem" in str(exc) or "was not written by anymem" in str(exc)
    check(f"adapter: {label} refuses a folder whose anymem.js is not ours and leaves it alone", refused and tree(home) == before)
check("adapter: the plan says install will stop", any("not ours" in x for x in adapter.plan(options(home))))
check("adapter: check names the foreign folder", "not written by anymem" in adapter.check()["problems"][0])
(foreign / "anymem.js").write_text(text)
(foreign / "notes.txt").write_text("a file of someone else\n")
before = tree(home)
try:
    adapter.install(options(home))
    refused = False
except ValueError:
    refused = True
check("adapter: a folder of ours that holds another file is treated as not ours", refused and tree(home) == before)
shutil.rmtree(foreign)
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

# a plugin root with awkward characters is baked in safely, and the version comes from the root
home = fresh("home-odd-root")
os.environ["ANYMEM_HOME"] = str(home)
odd = fake_root('root with "quote" and \\slash and $1 \\1')
adapter.install(options(home, odd))
installed = home / ".config/anymem/cline-plugin/anymem.js"
check("adapter: awkward characters in the plugin root survive the bake", adapter._baked(installed).get("root") == str(odd.resolve()), str(adapter._baked(installed)))
check("adapter: the package version is the version of the plugin root", json.loads((installed.parent / "package.json").read_text())["version"] == "9.8.7")
if shutil.which("node"):
    probe = TMP / "syntax.mjs"
    shutil.copy(installed, probe)
    ok = subprocess.run(["node", "--check", str(probe)], capture_output=True, text=True).returncode == 0
    check("adapter: the installed plugin file is valid JavaScript", ok)
adapter.uninstall()

# the installer's own view: --list and --dry-run through install.py
os.environ["ANYMEM_HOME"] = str(fresh("home-cli"))
cli_env = {**os.environ, "ANYMEM_CLINE_BIN": str(stub), "STUB_LOG": str(stub.parent / "calls.jsonl"), "HOME": os.environ["ANYMEM_HOME"]}
INSTALL_PY = str(ROOT / "skills" / "anymem" / "scripts" / "install.py")
listing_home = fresh("home-cli-list")  # other adapters' --version calls (Kilo) write into HOME, so --list gets a home of its own
listing = subprocess.run([sys.executable, INSTALL_PY, "--list"], capture_output=True, text=True, env={**cli_env, "HOME": str(listing_home), "ANYMEM_HOME": str(listing_home)}, timeout=60)
check("install.py --list shows cline, found, with its version", listing.returncode == 0 and any(x.startswith("cline  Cline  found  version 3.0.74") for x in listing.stdout.splitlines()), listing.stdout[-500:] + listing.stderr[-300:])
dry = subprocess.run([sys.executable, INSTALL_PY, "cline", "--dry-run"], capture_output=True, text=True, env=cli_env, timeout=60)
cli_home = Path(os.environ["ANYMEM_HOME"])
check("install.py cline --dry-run prints the plan and writes nothing", dry.returncode == 0 and "Cline (cline) plan:" in dry.stdout and "dry run, nothing written" in dry.stdout and not any(cli_home.iterdir()),
      f"rc={dry.returncode} home={sorted(str(x) for x in cli_home.rglob('*'))} err={dry.stderr[-300:]}")

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
# warm runs the credential command once and leaves its answer in the cache, which is the whole point of it: the first recall of a
# session then does not pay for a slow secret manager inside Cline's 3 second hook limit.
warm_marker = fresh("warm-marker") / "ran.txt"
warm_cfg_dir = fresh("warm-cfg")
(warm_cfg_dir / "config.json").write_text(json.dumps({"credential_command": f"echo ran >> {warm_marker}; echo '{{\"url\": \"http://127.0.0.1:9\", \"token\": \"warm-test-token\"}}'"}))
os.chmod(warm_cfg_dir / "config.json", 0o600)
p, warm_home = run_hook(["warm"], "", {"ANYMEM_CONFIG_DIR": str(warm_cfg_dir), "ANYMEM_CRED_TTL": "3600"})
cached = list((warm_home / "cache" / "credentials").glob("*.json")) if (warm_home / "cache" / "credentials").exists() else []
check("hook: warm prints nothing, runs the credential command once and caches its answer", p.returncode == 0 and p.stdout == b"" and p.stderr == b"" and warm_marker.read_text().count("ran") == 1 and len(cached) == 1, f"rc={p.returncode} out={p.stdout[:80]!r} err={p.stderr[:80]!r} marker={warm_marker.exists()} cached={cached}")
p, _ = run_hook(["warm"], "not json at all", {"ANYMEM_CONFIG_DIR": str(warm_cfg_dir), "ANYMEM_CRED_TTL": "3600"})
check("hook: warm ignores whatever is on stdin and starts no capture", p.returncode == 0 and p.stdout == b"" and p.stderr == b"" and not (warm_home / "cache" / "capture.log").exists())
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
check("the posted capture carries the harness name cline, in the body and in the header", srv.captured and srv.captured[0].get("harness") == "cline" and [h.get("x-anymem-harness") for (m, pth, _), h in zip(srv.requests, srv.headers) if pth == "/capture"] == ["cline"])
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
    (h / "cache" / "cline").mkdir(parents=True)
    old, new = h / "cache" / "cline" / "old.jsonl", h / "cache" / "cline" / "new.jsonl"
    old.write_text("{}\n")
    new.write_text("{}\n")
    os.utime(old, (time.time() - 20 * 86400,) * 2)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM", "CLAUDE_PLUGIN"))}
    env.update({"HOME": str(h), "ANYMEM_CONFIG_DIR": str(h / "cfg"), "ANYMEM_CACHE_DIR": str(h / "cache"), **extra})
    subprocess.run([sys.executable, HOOK, "session-start"], input=sample("session-start").encode(), capture_output=True, env=env, timeout=30)
    check(f"hook: a spool file older than 14 days is deleted at session start ({label}), a recent one stays", not old.exists() and new.exists())
# the 3 second limit: with the deadlines plugin.js sets, a Worker that never answers still gets a reply from hook.py inside the plugin's 2600 ms kill
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class Slow(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        time.sleep(12)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


slow = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
slow.daemon_threads = True
threading.Thread(target=slow.serve_forever, daemon=True).start()
slow_env = {"ANYMEM_URL": f"http://127.0.0.1:{slow.server_address[1]}", "ANYMEM_TOKEN": "test-token-0000", "ANYMEM_EXTRACTION": "worker", "ANYMEM_PROJECT": "global",
            "ANYMEM_HOOK_DEADLINE": "2", "ANYMEM_HOOK_TIMEOUT": "2"}  # exactly what plugin.js passes
for event, stdin in (("prompt", json.dumps({**json.loads(sample("prompt")), "prompt": "Which codename did we agree for the ferry route?"})), ("session-start", sample("session-start"))):
    started = time.time()
    p, _ = run_hook([event], stdin, slow_env, timeout=30)
    took = time.time() - started
    out = json.loads(p.stdout.decode().strip()) if p.stdout.strip() else {}
    check(f"hook: {event} against a Worker that never answers replies inside 2.6 s with no context ({took:.1f}s)", p.returncode == 0 and took < 2.6 and out.get("keep") is True and "additionalContext" not in out and p.stderr == b"", f"{took:.1f}s {p.stdout[:100]!r}")
slow.shutdown()

srv.stop()


# ------------------------------------------------------------------ the JavaScript plugin

if shutil.which("node"):
    p = subprocess.run(["node", "--test", str(HERE / "plugin.test.mjs")], capture_output=True, text=True, timeout=120)
    summary = [x for x in p.stdout.splitlines() if x.startswith("\u2139 pass") or x.startswith("\u2139 fail")]
    check("plugin: node --test plugin.test.mjs passes", p.returncode == 0, p.stdout[-600:] + p.stderr[-300:])
    print("     " + ", ".join(summary))
else:
    print("SKIP the JavaScript plugin tests: node is not installed (they run with `node --test adapters/cline/plugin.test.mjs`)")

# ------------------------------------------------------------------ house rules for the files in this folder

import re  # noqa: E402

BAD = re.compile("[" + chr(0x2014) + chr(0x2013) + "]| " + "-" * 2 + " ")  # built from parts so this file holds none of them
mine = [p for p in HERE.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix in (".py", ".js", ".mjs", ".md", ".json", ".jsonl")]
check("files: no em dash, en dash or spaced double dash in any file of this adapter", not [str(p.relative_to(ROOT)) for p in mine if BAD.search(p.read_text(encoding="utf-8"))])
check("files: no byte of the shipped adapter code mentions a personal path", not [str(p.relative_to(ROOT)) for p in mine if p.name != "test_adapter.py" and re.search("/Us" + "ers/|/opt" + "/drive", p.read_text(encoding="utf-8"))])

shutil.rmtree(TMP, ignore_errors=True)
print(f"{'FAILED' if failures else 'ok'}: {len(failures)} failed")
sys.exit(1 if failures else 0)
