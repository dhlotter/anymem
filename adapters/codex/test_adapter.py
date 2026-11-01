#!/usr/bin/env python3
"""Offline tests for the codex adapter. `python3 adapters/codex/test_adapter.py`, exits non-zero on failure.

No Codex and no network: a small fake `codex` command stands in for the real one (it edits config.toml the way Codex does,
and refuses a config it cannot parse), the Worker is the fake in client/hm/testing, and every folder is a temp folder. The
fixtures in adapters/codex/fixtures/ are recorded from a throwaway Codex 0.157 session with a harmless prompt, scrubbed of ids
and paths. Every secret and marker is built at runtime.
"""
from __future__ import annotations

import io
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
TMP = Path(tempfile.mkdtemp(prefix="hm-codex-test-"))

# Isolate every folder anything here can touch, before anything imports the client core.
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_", "CODEX_")):
        del os.environ[key]
HOME = TMP / "home"
HOME.mkdir()
os.environ["HOME"] = str(HOME)
os.environ["ANYMEM_HOME"] = str(HOME)
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "client"))
import adapter  # noqa: E402
import emit  # noqa: E402
import payload  # noqa: E402
import transcript  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures: list = []


def check(name: str, cond) -> None:
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


class Options:
    def __init__(self, home, plugin_root=ROOT, dry_run=False, yes=True):
        self.home, self.plugin_root, self.dry_run, self.yes = home, plugin_root, dry_run, yes


# ---------------------------------------------------------------- the fake codex command

FAKE_CODEX = r'''#!/usr/bin/env python3
import os, shutil, sys
from pathlib import Path
a = sys.argv[1:]
if a[:1] == ["--version"]:
    print("codex-cli 0.157.1"); sys.exit(0)
home = Path(os.environ["CODEX_HOME"])
cfg = home / "config.toml"
log = os.environ.get("FAKE_CODEX_LOG")
if log:
    open(log, "a").write(" ".join(a) + "\n")
def fail(msg):
    print("Error: " + msg, file=sys.stderr); sys.exit(1)
if not home.is_dir():
    fail("CODEX_HOME points to %s, but that path does not exist" % home)
t = cfg.read_text() if cfg.exists() else ""
for line in t.splitlines():
    s = line.strip()
    if (s.startswith("[") and not s.endswith("]")) or "===" in s:
        fail("failed to load bootstrap configuration: TOML parse error")
(home / ".tmp" / "marketplaces").mkdir(parents=True, exist_ok=True)
(home / "tmp" / "arg0").mkdir(parents=True, exist_ok=True)
MARKET = '\n[marketplaces.anymem]\nsource_type = "local"\nsource = "%s"\n'
PLUGIN = '\n[plugins."anymem@anymem"]\nenabled = true\n'
cache = home / "plugins" / "cache" / "anymem" / "anymem"
if a[:3] == ["plugin", "marketplace", "list"]:
    print("anymem" if "[marketplaces.anymem]" in t else "none"); sys.exit(0)
if os.environ.get("FAKE_CODEX_FAIL") == " ".join(a[:2]):
    fail("simulated failure")
if a[:3] == ["plugin", "marketplace", "add"]:
    cfg.write_text(t + MARKET % a[3]); print("Added marketplace"); sys.exit(0)
if a[:2] == ["plugin", "add"]:
    src = [l for l in t.splitlines() if l.startswith("source = ")][-1].split('"')[1]
    hooks = cache / "1.0.0" / "adapters" / "codex"
    hooks.mkdir(parents=True)
    shutil.copy(os.path.join(src, "adapters", "codex", "hooks.json"), str(hooks / "hooks.json"))
    (cache / "1.0.0" / "hooks").mkdir()  # the Claude Code hooks file sits in the same plugin copy, as it does in the repo
    shutil.copy(os.path.join(src, "hooks", "hooks.json"), str(cache / "1.0.0" / "hooks" / "hooks.json"))
    cfg.write_text(t + PLUGIN); print("Added plugin"); sys.exit(0)
if a[:2] == ["plugin", "remove"]:
    cfg.write_text(t.replace(PLUGIN, "", 1)); shutil.rmtree(str(cache), ignore_errors=True); print("Removed plugin"); sys.exit(0)
if a[:3] == ["plugin", "marketplace", "remove"]:
    import re
    cfg.write_text(re.sub(r'\n\[marketplaces\.anymem\]\nsource_type = "local"\nsource = "[^"\n]*"\n', "", t, count=1)); print("Removed marketplace"); sys.exit(0)
fail("unexpected arguments: %s" % a)
'''
BIN = TMP / "bin"
BIN.mkdir()
FAKE = BIN / "codex"
FAKE.write_text(FAKE_CODEX)
FAKE.chmod(0o755)
CALLS = TMP / "calls.log"
os.environ["ANYMEM_CODEX_BIN"] = str(FAKE)
os.environ["FAKE_CODEX_LOG"] = str(CALLS)
REAL_CONFIG = (
    'model = "some-model"\n\n[features]\nhooks = true\n\n[projects."/work/one"]\ntrust_level = "trusted"\n\n'
    '[hooks.state."/x/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n'
)


def snapshot(root: Path) -> dict:
    out = {}
    for p in sorted(root.rglob("*")):
        out[str(p.relative_to(root)) + ("/" if p.is_dir() else "")] = None if p.is_dir() else p.read_bytes()
    return out


def fresh_home(name: str, config: "str | None" = REAL_CONFIG) -> tuple:
    home = TMP / name
    codex = home / ".codex"
    codex.mkdir(parents=True)
    if config is not None:
        (codex / "config.toml").write_text(config)
    os.environ["ANYMEM_HOME"] = str(home)
    os.environ.pop("CODEX_HOME", None)
    return home, codex


# ---------------------------------------------------------------- 1. payload normalisation

def fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


for event in ("SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"):
    raw = fixture("payload-%s.json" % event)
    out = payload.normalise(raw)
    check("%s fixture normalises to exactly the five shared keys, all strings" % event,
          sorted(out) == sorted(payload.KEYS) and all(isinstance(v, str) for v in out.values()))
    check("%s fixture keeps its event, session id, transcript path and cwd" % event,
          out["hook_event_name"] == event and out["session_id"] == raw["session_id"] and out["transcript_path"] == raw["transcript_path"] and out["cwd"] == raw["cwd"])
check("the UserPromptSubmit fixture keeps the prompt", payload.normalise(fixture("payload-UserPromptSubmit.json"))["prompt"] == fixture("payload-UserPromptSubmit.json")["prompt"] != "")
check("other Codex keys (model, turn_id, permission_mode) are dropped", "model" not in payload.normalise(fixture("payload-UserPromptSubmit.json")))
check("event names are accepted in snake and kebab case", payload.event_name("session_start") == "SessionStart" and payload.event_name("user-prompt-submit") == "UserPromptSubmit")
check("an event the adapter does not handle normalises to an empty name", payload.normalise({"hook_event_name": "PreToolUse"})["hook_event_name"] == "")
check("a null transcript_path becomes an empty string", payload.normalise({"transcript_path": None})["transcript_path"] == "")
check("garbage input gives empty values, never an exception", all(payload.normalise(x) == {k: "" for k in payload.KEYS} for x in (None, [], "text", 7, {"prompt": 5, "cwd": ["a"]})))
internal = fixture("payload-SessionStart-internal.json")
check("Codex's own memory session (no transcript, cwd ends in /memories) is recognised as internal", payload.is_internal(internal) and internal["transcript_path"] is None)
check("a normal session is not internal", not payload.is_internal(fixture("payload-SessionStart.json")))
check("a session without a transcript outside a memories folder is not internal", not payload.is_internal({"transcript_path": None, "cwd": "/work/app"}))
check("a session with a transcript inside a memories folder is not internal", not payload.is_internal({"transcript_path": "/x/rollout.jsonl", "cwd": "/work/memories"}))

# ---------------------------------------------------------------- 2. the emit protocol

check("UserPromptSubmit context is the exact Codex protocol bytes",
      emit.render("UserPromptSubmit", "hello") == '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "hello"}}\n')
check("SessionStart context is the same protocol with its own event name",
      json.loads(emit.render("SessionStart", "cap"))["hookSpecificOutput"] == {"hookEventName": "SessionStart", "additionalContext": "cap"})
check("SessionStart context is capped under 10,000 characters", len(json.loads(emit.render("SessionStart", "x" * 20000))["hookSpecificOutput"]["additionalContext"]) == emit.SESSION_START_LIMIT)
check("events that carry no context print nothing", emit.render("Stop", "x") == "" and emit.render("SessionEnd", "x") == "" and emit.render("PreCompact", "x") == "")
check("empty or blank text prints nothing", emit.render("UserPromptSubmit", "") == "" and emit.render("UserPromptSubmit", "  \n") == "")
check("non ASCII text survives the round trip", json.loads(emit.render("UserPromptSubmit", "café → ok"))["hookSpecificOutput"]["additionalContext"] == "café → ok")
buf = io.StringIO()
check("emit() writes to the given stream and says so", emit.emit("UserPromptSubmit", "hi", buf) is True and buf.getvalue().endswith("}\n") and emit.emit("Stop", "hi", buf) is False)

# ---------------------------------------------------------------- 3. the transcript reader

ROLLOUT = FIX / "rollout.jsonl"
turns, end = transcript.read_turns(str(ROLLOUT), 0)
roles = [r for r, _ in turns]
alltext = "\n".join(t for _, t in turns)
check("the fixture rollout yields user and assistant turns, in order", roles[:1] == ["USER"] and "ASSISTANT" in roles and set(roles) <= {"USER", "ASSISTANT"})
check("the real user prompt is kept", any(r == "USER" and "aurora project" in t for r, t in turns))
check("the assistant answer is kept", any(r == "ASSISTANT" and t.strip() for r, t in turns))
check("developer messages are left out", "skills_instructions" not in alltext and "permissions instructions" not in alltext)
check("Codex's own environment block is left out", "environment_context" not in alltext and "<cwd>" not in alltext)
check("the recalled memories block that our hook injected is NOT captured back", "Relevant memories (anymem" not in alltext and "recalled for this prompt" not in alltext)
check("the memory capsule block that our hook injected is NOT captured back", "Memory capsule (anymem" not in alltext)
check("tool calls, reasoning and event records are left out", "function_call" not in alltext and "token_count" not in alltext)
check("the offset is the file size when every line is complete", end == ROLLOUT.stat().st_size)
check("reading again from that offset returns nothing and keeps the offset", transcript.read_turns(str(ROLLOUT), end) == ([], end))


def line(rec: dict) -> bytes:
    return (json.dumps(rec) + "\n").encode()


def msg(role: str, text: str, kind: str = "") -> dict:
    return {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": kind or ("output_text" if role == "assistant" else "input_text"), "text": text}]}}


INJECT = "## Relevant memories (anymem, recalled for this prompt)\nContext only.\n- launch-codename: the codename is zqtestmarker"
CAPSULE = "## Memory capsule (anymem Worker, live)\nAlways-on rules.\n### identity\nBe brief."
records = [
    {"type": "session_meta", "payload": {"id": "s"}},
    msg("developer", "<permissions instructions>never say this</permissions instructions>"),
    msg("user", "<environment_context>\n<cwd>/work</cwd>\n</environment_context>"),
    msg("user", "# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nrule one\n</INSTRUCTIONS>"),
    msg("user", INJECT),
    msg("user", CAPSULE),
    msg("user", "Please pin the build to node 20, it matters for the release.\n" + INJECT),
    msg("assistant", "Pinned to node 20."),
    msg("assistant", "Done.\n" + INJECT),
    {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{\"cmd\":\"ls\"}"}},
    {"type": "response_item", "payload": {"type": "function_call_output", "output": "tool output must not appear"}},
    {"type": "event_msg", "payload": {"type": "user_message", "message": "duplicate of a user message"}},
    msg("system", "system text must not appear"),
    msg("user", "   "),
]
path = TMP / "synthetic-rollout.jsonl"
path.write_bytes(b"".join(line(r) for r in records))
turns, end = transcript.read_turns(str(path), 0)
check("only the user's own words and the assistant's words survive", turns == [("USER", "Please pin the build to node 20, it matters for the release."), ("ASSISTANT", "Pinned to node 20."), ("ASSISTANT", "Done.")])
check("an injected block is removed even when Codex files it as a user message, and even when it is appended to real text",
      all("zqtestmarker" not in t and "Relevant memories" not in t and "Memory capsule" not in t for _, t in turns))

complete = b"".join(line(r) for r in records[:8])
partial = line(msg("user", "this record is still being written"))[:-30]
path.write_bytes(complete + partial)
turns1, off1 = transcript.read_turns(str(path), 0)
check("a partial last record is not consumed: the offset stops before it", off1 == len(complete) and not any("still being written" in t for _, t in turns1))
path.write_bytes(complete + line(msg("user", "this record is still being written")))
turns2, off2 = transcript.read_turns(str(path), off1)
check("the next capture picks the completed record up from that offset", turns2 == [("USER", "this record is still being written")] and off2 == path.stat().st_size)
path.write_bytes(complete + b"{not json}\n" + line(msg("user", "after a bad line")))
turns3, off3 = transcript.read_turns(str(path), 0)
check("a line that is not JSON is skipped and consumed", ("USER", "after a bad line") in turns3 and off3 == path.stat().st_size)
check("an offset past the end of the file returns nothing and does not raise", transcript.read_turns(str(path), 10 ** 9)[0] == [])

# ---------------------------------------------------------------- 4. install, check, uninstall

check("detect() finds the fake codex and reads its version", adapter.detect()["found"] is True and adapter.detect()["version"] == "0.157.1")
os.environ["ANYMEM_CODEX_BIN"] = str(TMP / "nowhere" / "codex")
check("detect() says not found when there is no codex command, without raising", adapter.detect()["found"] is False)
os.environ["ANYMEM_CODEX_BIN"] = str(FAKE)

home, codex = fresh_home("h1")
before = snapshot(home)
opts = Options(home)
steps = adapter.plan(opts)
joined = "\n".join(steps)
check("plan() names the backup, both codex commands, and says nothing is approved for you",
      "config.toml.anymem.bak" in joined and "codex plugin marketplace add %s" % ROOT in joined and "codex plugin add anymem@anymem" in joined and "approve" in joined)
check("plan() writes nothing", snapshot(home) == before)
dry = adapter.install(Options(home, dry_run=True))
check("install() with dry_run writes nothing and returns no changed paths", dry["changed"] == [] and snapshot(home) == before)

res = adapter.install(opts)
cfg_text = (codex / "config.toml").read_text()
check("install() adds the marketplace and plugin tables and nothing else to config.toml", cfg_text.startswith(REAL_CONFIG) and cfg_text[len(REAL_CONFIG):].count("[") == 2)
check("the config.toml backup is byte identical to the original", (codex / "config.toml.anymem.bak").read_bytes() == REAL_CONFIG.encode())
check("install() reports every changed path and all of them are inside the home folder", len(res["changed"]) == 3 and all(Path(p).resolve().is_relative_to(home.resolve()) if hasattr(Path, "is_relative_to") else str(Path(p).resolve()).startswith(str(home.resolve())) for p in res["changed"]))
check("install() tells the user to approve the hooks and says it approved nothing", any("approve" in n and "Nothing was approved" in n for n in res["notes"]))
check("install() never wrote a trust record", "trusted_hash" not in cfg_text.replace('trusted_hash = "sha256:abc"', ""))
check("the plugin copy with its hooks is in the cache", (codex / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0" / "adapters" / "codex" / "hooks.json").is_file())
installed_hooks = codex / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0" / "adapters" / "codex" / "hooks.json"
kept_hooks = installed_hooks.read_bytes()
installed_hooks.unlink()
check("check() reports a plugin copy with no Codex hooks file, even though the Claude hooks file is in the same plugin",
      any("adapters/codex/hooks.json" in p for p in adapter.check()["problems"]))
installed_hooks.write_bytes(kept_hooks)
plan_after = adapter.plan(opts)
check("plan() after install says nothing would change", len(plan_after) == 1 and "already installed" in plan_after[0])
again = adapter.install(opts)
check("a second install() changes nothing", again["changed"] == [] and (codex / "config.toml").read_text() == cfg_text)

chk = adapter.check()
check("check() reports the hooks are not yet trusted by Codex as a pending next step, not a failure", any("not trusted" in p for p in chk["pending"]) and not any("not trusted" in p for p in chk["problems"]))
check("check() reports an unconfigured client", any("not configured" in p for p in chk["problems"]))

srv = fake_worker.start(recall=[], capsule=[])
os.environ["ANYMEM_URL"] = srv.url
os.environ["ANYMEM_TOKEN"] = "test-token-" + os.urandom(4).hex()
trust_key = str(codex / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0" / "adapters" / "codex" / "hooks.json")
with (codex / "config.toml").open("a") as f:  # what Codex 0.157 and 0.164 write once the user approves the hooks, one record per hook
    for key in adapter.declared_keys(codex / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0"):
        f.write('\n[hooks.state."%s"]\ntrusted_hash = "sha256:def"\n' % key)
chk = adapter.check()
check("check() is ok once Codex has recorded its approval and the Worker answers /health", chk["ok"] is True and chk["problems"] == [])
check("check() reached the Worker with a GET /health and nothing else", [(m, p) for m, p, _ in srv.requests] == [("GET", "/health")])

# Codex 0.164 runs approved plugin hooks only while the installed copy hashes to what it was at approval (plugin_trust.rs)
copy_root = codex / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0"
baseline = adapter.legacy_baseline(codex)
kept_config, readme = (codex / "config.toml").read_text(), copy_root / "README.md"
kept_readme = readme.read_bytes() if readme.exists() else None
EVENTS = [k.split(":")[-3] for k in adapter.declared_keys(copy_root)]
check("the trust keys are built from the copy's hooks.json as Codex builds them",
      adapter.declared_keys(copy_root) == ["anymem@anymem:adapters/codex/hooks.json:%s:0:0" % e for e in ("session_start", "user_prompt_submit", "stop", "session_end")])


def approvals(default, extra="", **override):
    """config.toml as Codex 0.164 keeps it: one record per declared hook, each with its own content pin or none (an approval
    made before 0.164). `override` sets one hook's pin, a pin of False leaves that hook's record out."""
    pins = {e: override.get(e, default) for e in EVENTS}
    (codex / "config.toml").write_text(cfg_text + extra + "".join('\n[hooks.state."anymem@anymem:adapters/codex/hooks.json:%s:0:0"]\ntrusted_hash = "sha256:x"\n%s' % (
        e, 'trusted_content_hash = "%s"\n' % pin if pin else "") for e, pin in pins.items() if pin is not False))


approvals(None)
check("with no pinned baseline yet, check() stays ok (Codex pins the contents the first time a hook runs)", adapter.check()["ok"] is True)
baseline.parent.mkdir(parents=True, exist_ok=True)
baseline.write_text(adapter.content_hash(copy_root))
check("a baseline that matches the installed copy is ok", adapter.check()["ok"] is True)
check("install notes say the approval is recorded while it matches", adapter.trust_notes(adapter.state(codex), codex) == ["Codex has recorded its approval for the anymem hooks."])
readme.write_text("changed after approval\n")
chk = adapter.check()
check("a copy that changed since the approval is a problem, so check() is not ok and says to approve again",
      chk["ok"] is False and any("approve the anymem hooks again" in p and "/hooks" in p for p in chk["problems"]))
check("install notes say to approve again after a copy changed", "approve the anymem hooks again" in adapter.trust_notes(adapter.state(codex), codex)[0])
baseline.write_text(adapter.content_hash(copy_root) + "\n")
check("the baseline is compared as written, as Codex compares it, so a trailing newline does not match", adapter.check()["ok"] is False)
baseline.write_bytes(b"\xff\xfe not text")
check("a baseline that is not text is reported, it does not crash check() or the install notes",
      any("cannot read its approval baseline" in p for p in adapter.check()["problems"]) and "cannot read" in adapter.trust_notes(adapter.state(codex), codex)[0])
baseline.unlink()
fresh, old = adapter.content_hash(copy_root), "sha256:" + "0" * 64
approvals(fresh)
check("a trusted_content_hash on every hook that matches the copy is ok", adapter.check()["ok"] is True)
approvals(fresh, session_start=old)
chk = adapter.check()
check("one hook with a stale pin among fresh ones is a problem that names that hook, as Codex checks each hook on its own",
      chk["ok"] is False and any("(session_start)" in p for p in chk["problems"]))
approvals(fresh, session_end=False)
check("a declared hook with no approval record is a problem that names it", any("no approval" in p and "(session_end)" in p for p in adapter.check()["problems"]))
approvals(fresh, session_end=False, extra='\n[hooks.state."anymem@anymem:adapters/codex/hooks.json:session_end:0:0"]\nenabled = false\n')
check("a record with no trusted_hash is no approval, as Codex rates it untrusted", any("no approval" in p and "(session_end)" in p for p in adapter.check()["problems"]))
broken = Path(tempfile.mkdtemp())
(broken / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0" / "adapters" / "codex").mkdir(parents=True)
(broken / "plugins" / "cache" / "anymem" / "anymem" / "1.0.0" / "adapters" / "codex" / "hooks.json").write_text("{ not json")
check("a hooks.json Codex cannot parse says to reinstall, not only to approve again", "Reinstall the plugin" in adapter.stale_trust(broken, ["x"]))
check("the keys assume the manifest's hooks file, so the manifest still names it",
      json.loads((HERE.parent.parent / ".codex-plugin" / "plugin.json").read_text())["hooks"] == "./adapters/codex/hooks.json")
approvals(fresh, extra='\n[hooks.state."anymem@anymem:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\ntrusted_content_hash = "%s"\n' % old)
check("a leftover record for a hook the copy no longer declares is ignored, as Codex never reads it", adapter.check()["ok"] is True)
baseline.write_text(old)
approvals(fresh, session_start=None)
check("a hook with no content pin falls back to the baseline file, here a stale one", any("(session_start)" in p for p in adapter.check()["problems"]))
(codex / "config.toml").write_text(cfg_text + '\n[hooks.state."%s:stop:0:0"]\ntrusted_hash = "sha256:def"\n' % trust_key)  # only a record keyed by file path, as older Codex wrote, stale baseline in place
check("records keyed by file path (older Codex) are not approvals Codex 0.164 reads, so that is reported, whatever the baseline says",
      adapter.state(codex)["trusted"] != [] and "no approval" in adapter.stale_trust(codex, adapter.state(codex)["trusted"]))
baseline.unlink()
(codex / "config.toml").write_text(kept_config)
readme.write_bytes(kept_readme) if kept_readme is not None else readme.unlink()
baseline.parent.rmdir()

# the active copy is picked as Codex picks it (core-plugin-common installed.rs active_plugin_version)
versions = Path(tempfile.mkdtemp())
vbase = versions / "plugins" / "cache" / "anymem" / "anymem"
for name in ("2.1.3", "2.1.10", "2.2.0-beta.1", "notes~", "zzz-not-semver"):
    (vbase / name).mkdir(parents=True)
check("the active copy is the highest version by semver, with names that are not semver compared as text",
      adapter.active_copy(versions).name == "zzz-not-semver")
(vbase / "zzz-not-semver").rmdir()
check("a prerelease sorts above lower releases when its numbers are higher", adapter.active_copy(versions).name == "2.2.0-beta.1")
(vbase / "2.2.0").mkdir()
check("a release sorts above its own prerelease", adapter.active_copy(versions).name == "2.2.0")
os.symlink(str(vbase / "2.1.3"), str(vbase / "9.9.9"))
check("a symlinked version folder is skipped, as Codex skips it", adapter.active_copy(versions).name == "2.2.0")
(vbase / "local").mkdir()
check("a folder named local always wins, and a mix of local and numbers no longer raises", adapter.active_copy(versions).name == "local")
check("no cache folder gives no active copy", adapter.active_copy(Path(tempfile.mkdtemp())) is None)
import functools  # noqa: E402
order = sorted(["2.1.10", "2.1.3", "2.2.0-beta.10", "2.2.0-beta.2", "2.2.0", "2.2.0-alpha"], key=functools.cmp_to_key(adapter._compare_versions))
check("versions sort by number, not as text: 2.1.3 below 2.1.10, beta.2 below beta.10, alpha below beta, a release above its prereleases",
      order == ["2.1.3", "2.1.10", "2.2.0-alpha", "2.2.0-beta.2", "2.2.0-beta.10", "2.2.0"])

# a known answer: on 2026-10-31 Codex 0.164, run with CODEX_HOME set to the path below (already a real path), wrote its baseline
# for anymem@anymem as .hook-trust/e0eeb046... The path is only the input string, it does not need to exist.
_saved = os.environ.pop("CODEX_HOME", None)
check("the legacy baseline name matches the file Codex wrote",
      adapter.legacy_baseline(Path("/private/tmp/claude-501/-opt-drive-vault/8b8c2ee9-863d-4939-b029-b28fddb8c00a/scratchpad/codex-refresh/home")).name
      == "e0eeb0463ad1187093d899e95406a74c052c6ef59f652c1d8a037bc73a466705")
real_home = Path(tempfile.mkdtemp())
link = Path(tempfile.mkdtemp()) / "link"
os.symlink(str(real_home), str(link))
unresolved = adapter.legacy_baseline(link).name
os.environ["CODEX_HOME"] = str(link)
check("with CODEX_HOME set, the baseline name uses its real path, as Codex resolves it",
      adapter.legacy_baseline(link).name != unresolved and adapter.legacy_baseline(link).name == adapter.legacy_baseline(real_home.resolve()).name)
os.environ.pop("CODEX_HOME")
if _saved is not None:
    os.environ["CODEX_HOME"] = _saved

bundle = Path(tempfile.mkdtemp())
(bundle / "b").mkdir()
(bundle / "b" / "x.py").write_text("print(1)\n")
(bundle / "a.txt").write_text("hi\n")
pinned = adapter.content_hash(bundle)  # the algorithm was checked against Codex 0.164 on 2026-10-31: same hash as the baseline Codex wrote for a real copy
check("the bundle hash is stable for a fixed folder", pinned == "sha256:" + __import__("hashlib").sha256(
      b"codex-plugin-bundle-v1" + (0).to_bytes(8, "little") + b"directory"
      + (5).to_bytes(8, "little") + b"a.txt" + b"file" + (3).to_bytes(8, "little") + b"hi\n"
      + (1).to_bytes(8, "little") + b"b" + b"directory"
      + (6).to_bytes(8, "little") + b"b/x.py" + b"file" + (9).to_bytes(8, "little") + b"print(1)\n").hexdigest())
(bundle / "b" / "__pycache__").mkdir()
(bundle / "b" / "__pycache__" / "x.cpython-39.pyc").write_bytes(b"\0")
(bundle / "c.pyc").write_bytes(b"\0")
check("bytecode is left out of the hash, as Codex leaves it out", adapter.content_hash(bundle) == pinned)
os.symlink(str(bundle / "a.txt"), str(bundle / "link"))
try:
    adapter.content_hash(bundle)
    refused = False
except OSError:
    refused = True
check("a symlink in the copy is refused, as Codex refuses it", refused)
check("a trust record keyed by the plugin selector counts as ours (Codex 0.157, seen live)",
      (lambda d: ((d / "config.toml").write_text('[hooks.state."anymem@anymem:adapters/codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n'), adapter.state(d)["trusted"] != [])[1])(Path(tempfile.mkdtemp())))
srv.stop()
for k in ("ANYMEM_URL", "ANYMEM_TOKEN"):
    del os.environ[k]
os.environ["ANYMEM_URL"] = "http://127.0.0.1:1"
os.environ["ANYMEM_TOKEN"] = "test-token-0000"
check("check() reports an unreachable Worker", any("could not be reached" in p for p in adapter.check()["problems"]))
for k in ("ANYMEM_URL", "ANYMEM_TOKEN"):
    del os.environ[k]

# drop the approval record again, as if Codex never wrote it, then uninstall and compare with the start
(codex / "config.toml").write_text(cfg_text)
un = adapter.uninstall()
check("uninstall() leaves the whole Codex folder byte identical to before install", snapshot(home) == before)
check("uninstall() reports its changed paths inside the home folder", un["changed"] and all(str(Path(p).resolve()).startswith(str(home.resolve())) for p in un["changed"]))
check("check() no longer finds the wiring after uninstall", adapter.check()["ok"] is False and any("not installed" in p for p in adapter.check()["problems"]))
check("a second uninstall() does nothing", adapter.uninstall()["changed"] == [] and snapshot(home) == before)

# a config.toml that changed after install keeps its backup and its edits
adapter.install(opts)
with (codex / "config.toml").open("a") as f:
    f.write('\n[projects."/work/two"]\ntrust_level = "trusted"\n')
adapter.uninstall()
check("uninstall() keeps the user's later edits, and keeps the backup because the file no longer matches it",
      '[projects."/work/two"]' in (codex / "config.toml").read_text() and (codex / "config.toml.anymem.bak").exists() and "anymem" not in (codex / "config.toml").read_text().replace("anymem.bak", ""))

# no config.toml before: none after
home2, codex2 = fresh_home("h2", config=None)
before2 = snapshot(home2)
adapter.install(Options(home2))
check("with no config.toml there is nothing to back up", not (codex2 / "config.toml.anymem.bak").exists() and (codex2 / "config.toml").exists())
adapter.uninstall()
check("with no config.toml before, none is left after uninstall", snapshot(home2) == before2)

# a config.toml with no trailing newline
home3, codex3 = fresh_home("h3", config='model = "x"')
before3 = snapshot(home3)
adapter.install(Options(home3))
adapter.uninstall()
check("a config.toml without a trailing newline comes back byte identical", snapshot(home3) == before3)

# CODEX_HOME honoured when it is inside the home folder
home4, _ = fresh_home("h4")
(home4 / "elsewhere").mkdir()
(home4 / "elsewhere" / "config.toml").write_text(REAL_CONFIG)
os.environ["CODEX_HOME"] = str(home4 / "elsewhere")
before4 = snapshot(home4)
adapter.install(Options(home4))
check("CODEX_HOME is honoured: its config.toml changed, ~/.codex did not", "anymem" in (home4 / "elsewhere" / "config.toml").read_text() and (home4 / ".codex" / "config.toml").read_text() == REAL_CONFIG)
adapter.uninstall()
check("uninstall honours CODEX_HOME too", snapshot(home4) == before4)

# ---------------------------------------------------------------- 5. refusals

home5, codex5 = fresh_home("h5", config='model = "x"\n[broken\nfoo === 1\n')
before5 = snapshot(home5)
try:
    adapter.install(Options(home5))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
check("install refuses a config.toml that is not valid, says why, and changes nothing", "not valid" in refused or "cannot read" in refused.lower() or "Codex cannot read" in refused)
check("a refused install leaves no backup, no plugin copy and the file untouched", snapshot(home5) == before5)

home6, codex6 = fresh_home("h6")
(codex6 / "config.toml").write_text(REAL_CONFIG + '\n[marketplaces.anymem]\nsource_type = "local"\nsource = "/somewhere/else"\n')
before6 = snapshot(home6)
try:
    adapter.install(Options(home6))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
check("install refuses when a marketplace of that name points somewhere else", "already exists" in refused and "/somewhere/else" in refused and snapshot(home6) == before6)

home7, codex7 = fresh_home("h7")
os.environ["CODEX_HOME"] = str(TMP / "outside-the-home")
(TMP / "outside-the-home").mkdir()
try:
    adapter.install(Options(home7))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
check("install refuses a CODEX_HOME outside the home folder", "outside the home folder" in refused and not list((TMP / "outside-the-home").iterdir()))
os.environ.pop("CODEX_HOME", None)

home8, codex8 = fresh_home("h8")
before8 = snapshot(home8)
try:
    adapter.install(Options(home8, plugin_root=TMP))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
check("install refuses a folder that is not a Codex plugin package", "not a Codex plugin package" in refused and snapshot(home8) == before8)

os.environ["ANYMEM_CODEX_BIN"] = str(TMP / "nowhere" / "codex")
try:
    adapter.install(Options(home8))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
check("install says so plainly when the codex command is missing", "codex command was not found" in refused and snapshot(home8) == before8)
os.environ["ANYMEM_CODEX_BIN"] = str(FAKE)

home9, codex9 = fresh_home("h9")
before9 = snapshot(home9)
os.environ["FAKE_CODEX_FAIL"] = "plugin add"
try:
    adapter.install(Options(home9))
    refused = ""
except adapter.AdapterError as e:
    refused = str(e)
del os.environ["FAKE_CODEX_FAIL"]
check("when `codex plugin add` fails the marketplace it added is removed again and the error is reported",
      "plugin add failed" in refused and (codex9 / "config.toml").read_text() == REAL_CONFIG)

# ---------------------------------------------------------------- 6. hook.py

HOOK = HERE / "hook.py"


def hook_env(extra: "dict | None" = None) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_", "CODEX_"))}
    env.update(HOME=str(HOME), ANYMEM_CONFIG_DIR=str(TMP / "config"), ANYMEM_CACHE_DIR=str(TMP / "cache-hook"), PYTHONDONTWRITEBYTECODE="1")
    env.update(extra or {})
    return env


def run_hook(arg, stdin: str, env: dict, timeout: int = 60):
    cmd = [sys.executable, str(HOOK)] + ([arg] if arg is not None else [])
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, env=env)


quiet = True
for arg in ("session-start", "prompt", "capture", "nonsense", None):
    for stdin in ("", "not json", "[1, 2]", "null", '{"hook_event_name": 5, "prompt": []}', "\x00\xff garbage", json.dumps(fixture("payload-UserPromptSubmit.json"))):
        p = run_hook(arg, stdin, hook_env())
        if p.returncode != 0 or p.stdout != "" or p.stderr != "":
            quiet = False
            print("   not quiet:", arg, repr(stdin[:30]), p.returncode, repr(p.stdout[:80]), repr(p.stderr[:80]))
check("hook.py exits 0 with no stdout and no stderr on garbage input and on an unconfigured client, for every event", quiet)

marker = "zq" + os.urandom(4).hex()
memory = "---\nname: launch-codename\ndescription: \"The launch codename for the aurora project is %s\"\n---\n\nThe launch codename is %s." % (marker, marker)
proposal = {"name": "release-notes-style", "type": "feedback", "description": "We write release notes as plain sentences and like short answers",
            "body": "We write release notes as plain sentences and prefer short answers.\n**Why:** stated in a session.\n**How to apply:** keep replies short."}
srv = fake_worker.start(recall=[{"id": "m1", "content": memory, "tags": []}], capsule=[{"slot": "identity", "content": "Capsule rule: keep answers short."}], proposals=[proposal])
env = hook_env({"ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-" + os.urandom(4).hex(), "ANYMEM_EXTRACTION": "worker"})

prompt_payload = fixture("payload-UserPromptSubmit.json")
prompt_payload["prompt"] = "What is the launch codename for the aurora project?"
p = run_hook("prompt", json.dumps(prompt_payload), env)
out = json.loads(p.stdout) if p.stdout.strip() else {}
check("hook.py prompt prints the recalled memory in Codex's protocol",
      p.returncode == 0 and p.stderr == "" and out.get("hookSpecificOutput", {}).get("hookEventName") == "UserPromptSubmit" and marker in out["hookSpecificOutput"]["additionalContext"] and p.stdout.endswith("}\n"))

n = len(srv.requests)
p = run_hook("prompt", json.dumps({**internal, "hook_event_name": "UserPromptSubmit", "prompt": "## Memory Writing Agent: Phase 2 (Consolidation) " + "x" * 400}), env)
check("hook.py prompt skips Codex's internal memory session: no output and no request to the Worker", p.stdout == "" and len(srv.requests) == n)

p = run_hook("prompt", json.dumps(prompt_payload), {**env, "ANYMEM_RECALL": "0"})
check("ANYMEM_RECALL=0 turns recall off", p.stdout == "")

p = run_hook("session-start", json.dumps(fixture("payload-SessionStart.json")), env)
out = json.loads(p.stdout) if p.stdout.strip() else {}
check("hook.py session-start prints the capsule as SessionStart context",
      p.returncode == 0 and out.get("hookSpecificOutput", {}).get("hookEventName") == "SessionStart" and "Capsule rule: keep answers short." in out["hookSpecificOutput"]["additionalContext"])
# the status lines reach Codex as they reach Claude Code: a recall warning in the hook's cache folder shows at session start
(TMP / "cache-hook").mkdir(parents=True, exist_ok=True)
(TMP / "cache-hook" / "recall-check.json").write_text(json.dumps({"status": "warn", "why": "the top five rate fell"}))
p = run_hook("session-start", json.dumps(fixture("payload-SessionStart.json")), env)
out = json.loads(p.stdout) if p.stdout.strip() else {}
check("hook.py session-start shows the status lines too, as Claude Code does",
      "Memory health: the top five rate fell" in out.get("hookSpecificOutput", {}).get("additionalContext", ""))
(TMP / "cache-hook" / "recall-check.json").unlink()
n = len(srv.requests)
p = run_hook("session-start", json.dumps(internal), env)
check("hook.py session-start skips Codex's internal memory session", p.stdout == "" and len(srv.requests) == n)

# capture end to end: a rollout big enough to be due, read with the codex reader, extracted by the fake Worker, stored by POST /capture
big = TMP / "capture-rollout.jsonl"
body = [{"type": "session_meta", "payload": {"id": "s", "pad": "p" * 9000}},
        msg("developer", "developer text that must never be captured"),
        msg("user", "<environment_context>\n<cwd>/work</cwd>\n</environment_context>"),
        msg("user", "We write release notes as plain sentences. We like short answers, we review every change before it ships, and the aurora project is the one we are shipping in the spring. Please remember that for next time, it is how this team works and it applies to every project we run, not only this one, and we have worked this way for years."),
        msg("user", INJECT),
        msg("assistant", "Understood, plain sentences and short answers.")]
big.write_bytes(b"".join(line(r) for r in body))
sid = "test-session-" + os.urandom(3).hex()
cap_payload = {**fixture("payload-SessionEnd.json"), "session_id": sid, "transcript_path": str(big), "cwd": str(TMP / "work")}
n = len(srv.requests)
p = run_hook("capture", json.dumps(cap_payload), env)
check("hook.py capture returns at once, silently, after starting the detached worker", p.returncode == 0 and p.stdout == "" and p.stderr == "")
deadline = time.time() + 40
while time.time() < deadline and not srv.captured:
    time.sleep(0.5)
check("the detached worker read the rollout with the codex reader and the Worker received POST /capture", len(srv.captured) == 1 and "release-notes-style" in srv.captured[0].get("content", ""))
check("the posted capture carries the harness name codex, in the body and in the header", srv.captured and srv.captured[0].get("harness") == "codex" and [h.get("x-anymem-harness") for (m, pth, _), h in zip(srv.requests, srv.headers) if pth == "/capture"] == ["codex"])
extract = [b for m, pth, b in srv.requests[n:] if pth == "/extract"]
sent = extract[0]["transcript"] if extract else ""
check("what was sent for extraction holds the user's words and none of the injected or developer text",
      "release notes as plain sentences" in sent and "Relevant memories" not in sent and marker not in sent and "developer text" not in sent and "environment_context" not in sent)
check("the capture is saved active, tagged as an automatic capture with its origin", srv.captured and "status:draft" not in srv.captured[0].get("tags", []) and any(t.startswith("captured-by:") for t in srv.captured[0].get("tags", [])) and "auto-capture" in srv.captured[0].get("tags", []))
state_file = TMP / "cache-hook" / "capture-state.json"
time.sleep(1)
check("the capture offset moved to the end of the rollout, so the next capture starts after it", state_file.exists() and json.loads(state_file.read_text()).get(sid, {}).get("offset") == big.stat().st_size)

small = TMP / "small-rollout.jsonl"
small.write_bytes(b"".join(line(r) for r in body[2:4]))
n = len(srv.requests)
p = run_hook("capture", json.dumps({**cap_payload, "session_id": sid + "-small", "transcript_path": str(small)}), env)
time.sleep(1)
check("a short rollout is below the capture threshold: no worker, no request", p.stdout == "" and len(srv.requests) == n)
n = len(srv.requests)
p = run_hook("capture", json.dumps({**cap_payload, "session_id": sid + "-off"}), {**env, "ANYMEM_CAPTURE": "0"})
time.sleep(1)
check("ANYMEM_CAPTURE=0 turns capture off", p.stdout == "" and len(srv.requests) == n)
srv.stop()

# ---------------------------------------------------------------- 7. the install command finds this adapter

from hm.commands import install as install_cmd  # noqa: E402

loaded = install_cmd.load_adapters()
check("install.py loads this adapter by its folder, with the contract's names",
      "codex" in loaded and loaded["codex"][0] is not None and all(hasattr(loaded["codex"][0], f) for f in ("NAME", "TITLE", "detect", "plan", "install", "check", "uninstall")))

# ---------------------------------------------------------------- 8. files

hooks_json = json.loads((HERE / "hooks.json").read_text())
commands = [h["command"] for groups in hooks_json["hooks"].values() for g in groups for h in g["hooks"]]
check("hooks.json uses plain command strings (Codex 0.157 ignores an args list) that call hook.py through CLAUDE_PLUGIN_ROOT",
      commands and all("args" not in h and h["command"].startswith('python3 "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hook.py" ') for groups in hooks_json["hooks"].values() for g in groups for h in g["hooks"]))
check("hooks.json wires exactly the events Codex has: SessionStart, UserPromptSubmit, Stop, SessionEnd, and SessionEnd stays within Codex's 3 second clamp",
      sorted(hooks_json["hooks"]) == ["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"] and hooks_json["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"] <= 3)

bad = []
for p in sorted(HERE.rglob("*")):
    if p.is_file() and p.suffix in (".py", ".json", ".jsonl", ".md"):
        text = p.read_text(encoding="utf-8")
        for needle in ("\u2014", "\u2013", " " + "-" * 2 + " "):
            if needle in text:
                bad.append("%s has %r" % (p.name, needle))
check("no em dash, en dash or spaced double hyphen in the adapter files (%s)" % ", ".join(bad), not bad)

print("ok" if not failures else "%d failed" % len(failures))
sys.exit(1 if failures else 0)
