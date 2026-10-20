#!/usr/bin/env python3
"""Offline tests for the Antigravity CLI adapter. `python3 adapters/agy/test_adapter.py`, exits non-zero on failure.

No harness needed, no network beyond 127.0.0.1: the Worker is the fake one in client/hm/testing/fake_worker.py, every folder the
code can touch is a temp folder, and the fake credential is built at runtime. Samples in fixtures/ were recorded from a throwaway
agy 1.3.1 run with a harmless prompt, with machine specific paths replaced.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIX = HERE / "fixtures"
HOOK = HERE / "hook.py"

TMP = Path(tempfile.mkdtemp(prefix="agy-test-"))
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["HOME"] = str(TMP / "realhome")
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")) and key not in ("ANYMEM_CONFIG_DIR", "ANYMEM_CACHE_DIR"):
        del os.environ[key]

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "client"))
import adapter  # noqa: E402
import emit  # noqa: E402
import payload  # noqa: E402
import transcript  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures: list = []
TOKEN = "test-token-" + "0000"
PROMPT = "First run the shell command 'echo hello'. After it finishes, reply with only the release codename for the staging cluster."


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else (f"  [{detail}]" if detail else "")))
    if not cond:
        failures.append(name)


def tree(root: Path) -> dict:
    return {str(p.relative_to(root)): (None if p.is_dir() else p.read_bytes()) for p in sorted(root.rglob("*"))}


class Opt:
    def __init__(self, home: Path, workspace=None, plugin_root: Path = ROOT):
        self.dry_run, self.yes, self.plugin_root, self.home = False, True, plugin_root, home
        if workspace is not None:
            self.workspace = workspace


def fresh(name: str) -> Path:
    d = TMP / name
    d.mkdir(parents=True)
    return d


def fixture_payload(name: str, transcript_path: Path) -> dict:
    data = json.loads((FIX / name).read_text(encoding="utf-8"))
    data["transcriptPath"] = str(transcript_path)
    return data


def rec(step: int, source: str, kind: str, content=None, **extra) -> str:
    d = {"step_index": step, "source": source, "type": kind, "status": "DONE", "created_at": "2026-10-08T11:00:00Z", **extra}
    if content is not None:
        d["content"] = content
    return json.dumps(d)


def user_rec(step: int, text: str) -> str:
    return rec(step, "USER_EXPLICIT", "USER_INPUT", f"<USER_REQUEST>\n{text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>")


# ---------------------------------------------------------------- 1. payload normalisation
FIXTURE_TRANSCRIPT = FIX / "transcript_full.jsonl"
first = payload.normalise(fixture_payload("pre_invocation_first.json", FIXTURE_TRANSCRIPT), "prompt")
check("first PreInvocation fixture: shared keys, prompt read from the transcript",
      sorted(first) == sorted(payload.KEYS) and first["hook_event_name"] == "UserPromptSubmit" and first["prompt"] == PROMPT
      and first["session_id"] == "11111111-2222-4333-8444-555555555555" and first["cwd"] == "/tmp/example-workspace"
      and first["transcript_path"] == str(FIXTURE_TRANSCRIPT), str(first))
later = payload.normalise(fixture_payload("pre_invocation_later.json", FIXTURE_TRANSCRIPT), "prompt")
check("later PreInvocation fixture: same prompt, the injected steps are not mistaken for it", later["prompt"] == PROMPT)
stop = payload.normalise(fixture_payload("stop_idle.json", FIXTURE_TRANSCRIPT), "capture")
check("idle Stop fixture is SessionEnd", stop["hook_event_name"] == "SessionEnd" and stop["prompt"] == "" and stop["session_id"] == first["session_id"], str(stop))
busy = payload.normalise({**fixture_payload("stop_idle.json", FIXTURE_TRANSCRIPT), "fullyIdle": False}, "capture")
check("a Stop that is not idle stays Stop", busy["hook_event_name"] == "Stop")
for junk in (None, [], "text", 7, {}, {"conversationId": 5, "workspacePaths": "x", "transcriptPath": ["a"]}, {"transcriptPath": "/does/not/exist"}):
    got = payload.normalise(junk, "prompt")
    check(f"normalise survives {type(junk).__name__} input", sorted(got) == sorted(payload.KEYS) and all(isinstance(v, str) for v in got.values()))
check("an event the adapter does not handle gets no event name", payload.normalise({}, "other")["hook_event_name"] == "")
check("workspacePaths: the first usable path wins", payload.cwd_of({"workspacePaths": ["", 3, "/a", "/b"]}) == "/a")

# ---------------------------------------------------------------- 2. emit protocol
check("emit.render is one ephemeralMessage step, exact bytes", emit.render("alpha") == '{"injectSteps": [{"ephemeralMessage": "alpha"}]}\n')
check("emit.render joins blocks with a blank line and drops empty ones", json.loads(emit.render("a", "", "  ", "b"))["injectSteps"] == [{"ephemeralMessage": "a\n\nb"}])
check("emit.render prints nothing for no context", emit.render() == "" and emit.render("", "  ") == "" and emit.render(None) == "")  # type: ignore[arg-type]
check("emit keeps non ASCII text valid JSON", json.loads(emit.render("café ✓"))["injectSteps"][0]["ephemeralMessage"] == "café ✓")

# ---------------------------------------------------------------- 3. transcript reader
turns, end = transcript.read_turns(str(FIXTURE_TRANSCRIPT), 0)
check("fixture transcript: one user turn and the model's final answer", turns == [("USER", PROMPT), ("ASSISTANT", "quillfernabc123")], str(turns))
check("the injected memory block, tool output and the tool only model turn are left out",
      not any("Memory capsule" in t or "hello" in t.replace(PROMPT, "") or "Relevant memories" in t for _, t in turns))
check("the reader consumed the whole fixture", end == FIXTURE_TRANSCRIPT.stat().st_size)
check("reading again from the end finds nothing new", transcript.read_turns(str(FIXTURE_TRANSCRIPT), end) == ([], end))

f = fresh("transcripts") / "t.jsonl"
lines = [
    user_rec(0, "first question"),
    rec(1, "SYSTEM_SDK", "EPHEMERAL_MESSAGE", "## Memory capsule (anymem Worker, live)\nrules"),
    rec(2, "SYSTEM_SDK", "EPHEMERAL_MESSAGE", "## Relevant memories (anymem, recalled for this prompt)\n- a: b"),
    rec(3, "MODEL", "PLANNER_RESPONSE", None, thinking="private", tool_calls=[{"name": "run_command"}]),
    rec(4, "MODEL", "GENERIC", "tool output text"),
    rec(5, "MODEL", "PLANNER_RESPONSE", "the answer"),
    rec(6, "SYSTEM_SDK", "USER_INPUT", "<USER_REQUEST>\nnot typed by the person\n</USER_REQUEST>"),
    rec(7, "MODEL", "PLANNER_RESPONSE", "an echo", status="CANCELED"),
    rec(8, "MODEL", "PLANNER_RESPONSE", "## Relevant memories (anymem, recalled for this prompt)\nechoed"),
    "not json at all",
    user_rec(9, "second question"),
]
f.write_text("\n".join(lines) + "\n", encoding="utf-8")
got, end = transcript.read_turns(str(f), 0)
check("only genuine user and model messages are kept, in order", got == [("USER", "first question"), ("ASSISTANT", "the answer"), ("USER", "second question")], str(got))
partial = rec(10, "MODEL", "PLANNER_RESPONSE", "late answer")
with f.open("a", encoding="utf-8") as fh:
    fh.write(partial[:25])
got2, end2 = transcript.read_turns(str(f), end)
check("a partial last record stays for the next capture (offset before it)", got2 == [] and end2 == end, f"{got2} {end2} {end}")
with f.open("a", encoding="utf-8") as fh:
    fh.write(partial[25:] + "\n")
got3, end3 = transcript.read_turns(str(f), end2)
check("the completed record is read on the next capture", got3 == [("ASSISTANT", "late answer")] and end3 == f.stat().st_size)
g = fresh("t2") / "t.jsonl"
g.write_text(user_rec(0, "no trailing newline"), encoding="utf-8")
check("a complete last record without a newline is not held back", transcript.read_turns(str(g), 0)[0] == [("USER", "no trailing newline")])
check("a user step without the request tags falls back to its text before the metadata blocks",
      transcript.user_request("plain words\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>") == "plain words" and transcript.user_request(None) == "")
check("a request that itself contains angle bracket text stays whole", transcript.user_request("<USER_REQUEST>\nuse <b>bold</b> here\n</USER_REQUEST>\n<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>") == "use <b>bold</b> here")
check("last_user_request returns the newest user step and its index", transcript.last_user_request(str(f)) == (9, "second question"))
check("last_user_request on a missing file or no user step is None", transcript.last_user_request(str(TMP / "missing")) is None and transcript.last_user_request(str(g.parent / "none")) is None)
big = fresh("t3") / "t.jsonl"
big.write_text(user_rec(0, "old question") + "\n" + rec(1, "MODEL", "GENERIC", "x" * (transcript.TAIL_BYTES + 5000)) + "\n" + rec(2, "MODEL", "PLANNER_RESPONSE", "ok") + "\n", encoding="utf-8")
check("a user step older than the tail window is not found, and nothing raises", transcript.last_user_request(str(big)) is None)

# ---------------------------------------------------------------- 4. install, check, uninstall
KEY = adapter.KEY
check("contract names", adapter.NAME == "agy" and adapter.TITLE and all(callable(getattr(adapter, n)) for n in ("detect", "plan", "install", "check", "uninstall")))
home0 = fresh("home-detect")
snap = tree(home0)
os.environ["ANYMEM_HOME"] = str(home0)
info = adapter.detect()
check("detect() returns the contract keys and writes nothing", set(info) == {"found", "version", "config_path", "notes"} and isinstance(info["found"], bool)
      and info["config_path"] == str(home0 / ".gemini" / "config" / "hooks.json") and tree(home0) == snap, str(info))
del os.environ["ANYMEM_HOME"]

# 4a. no config file yet
home = fresh("home-a")
opt = Opt(home)
cfg = home / ".gemini" / "config" / "hooks.json"
plan_lines = adapter.plan(opt)
check("plan for a missing file says it will be created and names the file", any("Create" in l and str(cfg) in l for l in plan_lines) and not any("Back up" in l for l in plan_lines), str(plan_lines))
before = tree(home)
res = adapter.install(opt)
data = json.loads(cfg.read_text())
cmds = [data[KEY][e][0]["command"] for e in ("PreInvocation", "Stop")]
check("install reports exactly the files it wrote, inside the home folder", res["changed"] == [str(cfg), str(cfg) + adapter.DIRS_SUFFIX])
check("install wrote one marked entry with both events, run by the Python that installed it", list(data) == [KEY] and cmds[0].startswith(sys.executable + " ") and cmds[0].endswith("hook.py prompt") and cmds[1].endswith("hook.py capture")
      and data[KEY]["PreInvocation"][0]["type"] == "command" and data[KEY]["PreInvocation"][0]["timeout"] > 0 and data[KEY]["Stop"][0]["timeout"] > 0, str(data))
check("the hook path points at this plugin's adapters/agy/hook.py", str(HOOK) in cmds[0] and str(HOOK) in cmds[1])
check("the folders install created are recorded next to the file", json.loads((home / ".gemini" / "config" / "hooks.json.anymem.dirs").read_text()) == [str(home / ".gemini" / "config"), str(home / ".gemini")])
check("nothing else was written under the home folder", sorted(tree(home)) == sorted([".gemini", ".gemini/config", ".gemini/config/hooks.json", ".gemini/config/hooks.json.anymem.dirs"]))
res2 = adapter.install(opt)
check("a second install changes nothing and says so", res2["changed"] == [] and json.loads(cfg.read_text()) == data)
check("plan after install says nothing to change", any("nothing to change" in l for l in adapter.plan(opt)))

srv = fake_worker.start(recall=[{"id": "m1", "tags": [], "content": "---\nname: staging-release-codename\ndescription: the staging codename\n---\nThe codename is quillfernabc123."}],
                        capsule=[{"slot": "identity", "content": "Be brief."}])
os.environ.update({"ANYMEM_HOME": str(home), "ANYMEM_URL": srv.url, "ANYMEM_TOKEN": TOKEN})
c = adapter.check()
check("check() is ok with the wiring in place and a reachable Worker", c == {"ok": True, "problems": []}, str(c))
check("check() hit the Worker's health route and nothing that writes", [r[1] for r in srv.requests] == ["/health"] and all(r[0] == "GET" for r in srv.requests), str(srv.requests))
srv.stop()
c = adapter.check()
check("check() reports an unreachable Worker", not c["ok"] and any("not reachable" in p for p in c["problems"]), str(c))
del os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"]
c = adapter.check()
check("check() reports an unconfigured client", not c["ok"] and any("not configured" in p for p in c["problems"]), str(c))

res = adapter.uninstall()
check("uninstall removes the file install created, its record and the folders it made", not (home / ".gemini").exists() and res["changed"] == [str(cfg), str(cfg) + adapter.DIRS_SUFFIX], str(res))
check("the home folder is byte identical to before install", tree(home) == before)
check("check() after uninstall is not ok and says the entry is missing", not adapter.check()["ok"] and "no" in adapter.check()["problems"][0])
check("uninstall twice is harmless", adapter.uninstall()["changed"] == [] and tree(home) == before)

# a folder that was there before install stays, even when it is empty: uninstall removes only the folders install made
home = fresh("home-empty-dir")
(home / ".gemini" / "config").mkdir(parents=True)
kept_before = tree(home)
adapter.install(Opt(home))
adapter.uninstall(Opt(home))
check("uninstall keeps an empty folder that install did not create", (home / ".gemini" / "config").is_dir() and tree(home) == kept_before, str(sorted(tree(home))))

# 4b. an existing file with other hooks, odd formatting and no trailing newline
home = fresh("home-b")
opt = Opt(home)
cfg = home / ".gemini" / "config" / "hooks.json"
cfg.parent.mkdir(parents=True)
original = b'{\n    "other-tool": {"Stop": [{"type": "command", "command": "echo \\u00e9 done", "timeout": 5}]},\n    "second":{"PreInvocation":[]}\n}'
cfg.write_bytes(original)
os.chmod(cfg, 0o640)
before = tree(home)
plan_lines = adapter.plan(opt)
check("plan for an existing file mentions the backup and the hooks it keeps", any("Back up" in l and "hooks.json.anymem.bak" in l for l in plan_lines) and any("2 hook name" in l for l in plan_lines), str(plan_lines))
res = adapter.install(opt)
bak = cfg.with_name("hooks.json.anymem.bak")
after = json.loads(cfg.read_text())
check("install keeps every other hook name and adds ours last", list(after) == ["other-tool", "second", KEY] and after["other-tool"] == json.loads(original)["other-tool"])
check("the backup is the original bytes, written once", bak.read_bytes() == original and sorted(res["changed"]) == sorted([str(cfg), str(bak)]))
check("the file keeps its indentation and its mode", cfg.read_text().startswith('{\n    "other-tool"') and oct(cfg.stat().st_mode)[-3:] == "640" and oct(bak.stat().st_mode)[-3:] == "640")
adapter.install(Opt(home, plugin_root=Path("/somewhere/else")))
check("changing the plugin folder replaces only our entry and keeps the first backup", bak.read_bytes() == original and list(json.loads(cfg.read_text())) == ["other-tool", "second", KEY]
      and "/somewhere/else/adapters/agy/hook.py" in json.loads(cfg.read_text())[KEY]["Stop"][0]["command"])
res = adapter.uninstall(opt)
check("uninstall restores the original bytes and removes the backup", cfg.read_bytes() == original and not bak.exists() and tree(home) == before, str(res))

# 4c. the user adds their own hook after ours: it must survive uninstall
adapter.install(opt)
edited = json.loads(cfg.read_text())
edited["added-later"] = {"Stop": []}
cfg.write_text(json.dumps(edited), encoding="utf-8")
adapter.uninstall(opt)
left = json.loads(cfg.read_text())
check("a hook the user added after install survives uninstall, ours is gone", list(left) == ["other-tool", "second", "added-later"] and KEY not in left)

# 4d. invalid config files are refused and left alone
for label, content in (("broken JSON", b'{"a": '), ("a JSON array", b"[1, 2]"), ("an empty file", b""), ("not UTF-8", b"\xff\xfe\x00")):
    h = fresh("home-bad-" + label.replace(" ", "-"))
    p = h / ".gemini" / "config" / "hooks.json"
    p.parent.mkdir(parents=True)
    p.write_bytes(content)
    snapshot = tree(h)
    refused = False
    try:
        adapter.install(Opt(h))
    except adapter.Refused:
        refused = True
    check(f"install refuses {label}, writes and backs up nothing", refused and tree(h) == snapshot)
    check(f"plan for {label} says it would refuse", any("not valid" in l or "not an object" in l for l in adapter.plan(Opt(h))))
    os.environ["ANYMEM_HOME"] = str(h)
    check(f"check() on {label} is not ok and does not raise", adapter.check()["ok"] is False)
    del os.environ["ANYMEM_HOME"]

# 4e. workspace scope stays inside the home folder
home = fresh("home-ws")
ws = home / "ws"
ws.mkdir()
res = adapter.install(Opt(home, workspace=ws))
check("workspace install writes only the workspace file and its folder record", res["changed"] == [str(ws / ".agents" / "hooks.json"), str(ws / ".agents" / "hooks.json") + adapter.DIRS_SUFFIX] and not (home / ".gemini").exists())
check("workspace check() is ok on the wiring (Worker not needed to find the entry)", KEY in json.loads((ws / ".agents" / "hooks.json").read_text()))
adapter.uninstall(Opt(home, workspace=ws))
check("workspace uninstall leaves the workspace as it was", tree(home) == {"ws": None})
outside = fresh("elsewhere")
refused = False
try:
    adapter.install(Opt(home, workspace=outside))
except adapter.Refused:
    refused = True
check("a workspace outside the home folder is refused, nothing written", refused and tree(outside) == {})

# 4f. check() notices a plugin folder that moved
home = fresh("home-moved")
adapter.install(Opt(home, plugin_root=TMP / "gone"))
os.environ["ANYMEM_HOME"] = str(home)
c = adapter.check()
check("check() reports a hook script that no longer exists", not c["ok"] and any("does not exist" in p for p in c["problems"]), str(c))
del os.environ["ANYMEM_HOME"]

# ---------------------------------------------------------------- 5. hook.py
def hook_env(url: "str | None", name: str) -> dict:
    base = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_"))}
    env = {**base, "HOME": str(TMP / "home-for-hooks"), "ANYMEM_CONFIG_DIR": str(TMP / name / "config"), "ANYMEM_CACHE_DIR": str(TMP / name / "cache"),
           "ANYMEM_EXTRACTION": "worker"}
    if url:
        env.update({"ANYMEM_URL": url, "ANYMEM_TOKEN": TOKEN})
    return env


def run_hook(event: str, stdin, env: dict) -> subprocess.CompletedProcess:
    data = stdin if isinstance(stdin, bytes) else json.dumps(stdin).encode("utf-8")
    return subprocess.run([sys.executable, str(HOOK), event], input=data, capture_output=True, timeout=60, env=env)


def silent(p: subprocess.CompletedProcess) -> bool:
    return p.returncode == 0 and p.stdout == b"" and p.stderr == b""


unconf = hook_env(None, "unconfigured")
good = fixture_payload("pre_invocation_first.json", FIXTURE_TRANSCRIPT)
for label, stdin in (("garbage text", b"not json {{{"), ("empty stdin", b""), ("a JSON array", b"[1,2,3]"), ("a JSON string", b'"x"'), ("binary", bytes(range(256))), ("an empty object", b"{}")):
    for event in ("prompt", "capture"):
        check(f"hook.py {event} on {label}: exit 0, no output, nothing on stderr", silent(run_hook(event, stdin, unconf)))
check("hook.py with no event, an unknown event or session-start stays silent", all(silent(subprocess.run([sys.executable, str(HOOK)] + a, input=json.dumps(good).encode(), capture_output=True, timeout=60, env=unconf)) for a in ([], ["bogus"], ["session-start"])))
check("hook.py prompt with a valid payload and an unconfigured client is silent", silent(run_hook("prompt", good, unconf)))
check("hook.py capture with a valid payload and an unconfigured client is silent", silent(run_hook("capture", fixture_payload("stop_idle.json", FIXTURE_TRANSCRIPT), unconf)))
check("an unconfigured client leaves no state behind", not (TMP / "unconfigured" / "cache").exists())
p = subprocess.run([sys.executable, str(HOOK), "check"], capture_output=True, timeout=60, env=unconf)
check("hook.py check prints ok after importing everything", p.returncode == 0 and p.stdout == b"ok\n" and p.stderr == b"")

# 5a. prompt events against the fake Worker
srv = fake_worker.start(recall=[{"id": "m1", "tags": [], "content": "---\nname: staging-release-codename\ndescription: The release codename for the staging cluster\n---\nThe staging cluster release codename is quillfernabc123."}],
                        capsule=[{"slot": "identity", "content": "Be brief and plain."}])
env = hook_env(srv.url, "prompted")
conv = fresh("conv")
tpath = conv / "transcript_full.jsonl"
tpath.write_text(user_rec(0, PROMPT) + "\n", encoding="utf-8")
pre0 = {**fixture_payload("pre_invocation_first.json", tpath)}
p = run_hook("prompt", pre0, env)
out = json.loads(p.stdout.decode()) if p.stdout else {}
msg = (out.get("injectSteps") or [{}])[0].get("ephemeralMessage", "")
check("first call: one ephemeralMessage step holding the capsule and the recalled memory",
      p.returncode == 0 and p.stderr == b"" and list(out) == ["injectSteps"] and len(out["injectSteps"]) == 1
      and "## Memory capsule" in msg and "Be brief and plain." in msg and "## Relevant memories" in msg and "quillfernabc123" in msg, p.stdout.decode()[:300])
p = run_hook("prompt", {**pre0, "invocationNum": 1, "initialNumSteps": 4}, env)
check("a later call of the same tool loop prints nothing", silent(p))
paths = [r[1].split("?")[0] for r in srv.requests]
check("the capsule and the recall were each fetched once for that conversation", paths.count("/prompt-capsules/core") == 1 and paths.count("/recall") == 1, str(paths))
with tpath.open("a", encoding="utf-8") as fh:
    fh.write(rec(1, "MODEL", "PLANNER_RESPONSE", "done") + "\n" + user_rec(2, "Which release codename does the staging cluster use now?") + "\n")
srv.recall_results = [{"id": "m2", "tags": [], "content": "---\nname: release-branch-naming\ndescription: How release branches are named\n---\nBranches are named after the codename."}]
p = run_hook("prompt", {**pre0, "invocationNum": 0}, env)
msg2 = json.loads(p.stdout.decode())["injectSteps"][0]["ephemeralMessage"] if p.stdout else ""
check("a new user message in the same conversation gets recall but not a second capsule", "## Relevant memories" in msg2 and "release-branch-naming" in msg2 and "## Memory capsule" not in msg2, msg2[:200])
check("a later call for that same message prints nothing", silent(run_hook("prompt", {**pre0, "invocationNum": 2}, env)))
state = json.loads((TMP / "prompted" / "cache" / "agy-state.json").read_text())
check("the per conversation state is a small 0600 file under the cache folder", list(state) == [pre0["conversationId"]] and oct((TMP / "prompted" / "cache" / "agy-state.json").stat().st_mode)[-3:] == "600")
check("nothing was written to the home folder the hook ran under", not (TMP / "home-for-hooks").exists())
env_off = {**env, "ANYMEM_RECALL": "0", "ANYMEM_CACHE_DIR": str(TMP / "prompted-off" / "cache")}
p = run_hook("prompt", {**pre0, "conversationId": "other-conversation"}, env_off)
msg3 = json.loads(p.stdout.decode())["injectSteps"][0]["ephemeralMessage"] if p.stdout else ""
check("ANYMEM_RECALL=0 keeps the capsule and drops recall", "## Memory capsule" in msg3 and "Relevant memories" not in msg3)
p = run_hook("prompt", {**pre0, "conversationId": "child-conversation"}, {**env, "ANYMEM_CAPTURE_CHILD": "1"})
check("the extraction child never gets injected", silent(p))
dead = hook_env("http://127.0.0.1:9", "deadworker")
t0 = time.time()
p = run_hook("prompt", pre0, dead)
check("an unreachable Worker with no cache: silent and quick", silent(p) and time.time() - t0 < 20)

# 5b. capture
cap_conv = fresh("capconv")
short_t = cap_conv / "short.jsonl"
short_t.write_text(user_rec(0, "short question") + "\n" + rec(1, "MODEL", "PLANNER_RESPONSE", "short answer") + "\n", encoding="utf-8")
env_cap = hook_env(srv.url, "capture")
stop_payload = {**fixture_payload("stop_idle.json", short_t), "conversationId": "short-session"}
n_before = len(srv.requests)
p = run_hook("capture", {**stop_payload, "fullyIdle": False}, env_cap)
check("a Stop that is not idle does nothing at all", silent(p) and not (TMP / "capture" / "cache" / "capture-state.json").exists())
p = run_hook("capture", stop_payload, env_cap)
st = json.loads((TMP / "capture" / "cache" / "capture-state.json").read_text())
check("a short idle run is looked at but no worker starts (under the 8 KB threshold)", silent(p) and st["short-session"]["started"] == 0 and st["short-session"]["offset"] == 0, str(st))
check("and the Worker saw no capture or extraction request", not any(r[1].startswith(("/extract", "/capture")) for r in srv.requests[n_before:]))

long_t = cap_conv / "long.jsonl"
filler = "Prefer plain short sentences and verify every claim. " * 200
long_user = ("We settled on a plain release process for the staging cluster. Release branches are named after the current staging codename, the codename is "
             "recorded in the shared notes and the notes are the only source of truth. Please keep that wording consistent everywhere we write about it, "
             "and remember that the codename changes with every release so nobody should hard code it into scripts or pipelines.")
long_t.write_text("\n".join([user_rec(0, long_user), rec(1, "SYSTEM_SDK", "EPHEMERAL_MESSAGE", "## Memory capsule (anymem Worker, live)\n" + filler),
                             rec(2, "MODEL", "PLANNER_RESPONSE", "Understood, the codename lives in the shared notes.")]) + "\n", encoding="utf-8")
srv.proposals = [{"name": "staging-codename-rule", "type": "reference", "description": "Where the staging release codename is recorded",
                  "body": "The staging release codename is recorded in the shared notes, which are the source of truth. It changes every release."}]
p = run_hook("capture", {**stop_payload, "conversationId": "long-session", "transcriptPath": str(long_t)}, env_cap)
check("a long idle run starts a detached worker and returns at once, silently", silent(p))
deadline = time.time() + 30
while time.time() < deadline and not srv.captured:
    time.sleep(0.3)
check("the worker read the agy transcript and posted one capture to the Worker", len(srv.captured) == 1 and srv.captured[0]["source"] == "session-capture"
      and "staging-codename-rule" in srv.captured[0]["content"] and "auto-capture" in srv.captured[0]["tags"], str(srv.captured))
check("the posted capture carries the harness name agy, in the body and in the header", srv.captured and srv.captured[0].get("harness") == "agy" and [h.get("x-anymem-harness") for (m, pth, _), h in zip(srv.requests, srv.headers) if pth == "/capture"] == ["agy"])
check("the posted capture does not hold the injected capsule", "Memory capsule" not in json.dumps(srv.captured) and "Prefer plain short" not in json.dumps(srv.captured))
srv.stop()

# one model call reads the transcript tail once: the prompt and the message key share that read
import hook as agy_hook  # noqa: E402
agy_hook._imports()
import memory_capsule, memory_recall  # noqa: E402,F401
real_fns = (memory_capsule._settings, memory_capsule.block, memory_recall.run, transcript.last_user_request)
reads = []
memory_capsule._settings = lambda: type("Configured", (), {"configured": lambda self: True})()
memory_capsule.block = lambda: ""
memory_recall.run = lambda p: ""
transcript.last_user_request = lambda path: (reads.append(path), real_fns[3](path))[1]
try:
    agy_hook.handle_prompt(dict(good))
finally:
    memory_capsule._settings, memory_capsule.block, memory_recall.run, transcript.last_user_request = real_fns
check("one model call reads the transcript tail once", len(reads) == 1, str(len(reads)))

# ---------------------------------------------------------------- 6. files and text rules
mine = sorted(p for p in HERE.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
text_bad = []
for p in mine + [ROOT / "docs" / "harnesses" / "agy.md"]:
    if not p.exists():
        continue
    s = p.read_text(encoding="utf-8")
    if chr(0x2014) in s or chr(0x2013) in s or " " + "-" * 2 + " " in s:
        text_bad.append(f"{p.name}: dash")
    if p.suffix == ".py" and not s.lstrip().startswith(('#!', '"""', "from __future__")) or (p.suffix == ".py" and "from __future__ import annotations" not in s):
        text_bad.append(f"{p.name}: missing __future__ import")
check("no em dashes, en dashes or double dashes, and every Python file starts with the __future__ import", not text_bad, str(text_bad))

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
