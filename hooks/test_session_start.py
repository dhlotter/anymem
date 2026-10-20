#!/usr/bin/env python3
"""Runnable check for session_start.py. `python3 hooks/test_session_start.py`, exits non-zero on failure.

No network: the capsule fetch is replaced with a fake capsule, and the one subprocess case runs with no configuration,
so the hook never reaches for a URL. Every secret is built at runtime.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
ROOT = HOOKS.parent
SCRIPT = HOOKS / "session_start.py"

# Isolate every folder the hook can touch before anything imports the client core.
TMP = tempfile.mkdtemp()
os.environ["ANYMEM_CONFIG_DIR"] = TMP + "/config"
os.environ["ANYMEM_CACHE_DIR"] = TMP + "/cache"
os.environ["ANYMEM_LINK_CLI"] = "0"  # never touch the real ~/.local/bin from a test
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")) and key not in ("ANYMEM_CONFIG_DIR", "ANYMEM_CACHE_DIR", "ANYMEM_LINK_CLI"):
        del os.environ[key]

sys.path.insert(0, str(HOOKS))
import memory_capsule  # noqa: E402
import session_start  # noqa: E402
from hm import config  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool) -> None:
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def configured() -> config.Settings:
    return config.Settings(url="https://worker.invalid", token="tok-" + "a" * 16)


def unconfigured() -> config.Settings:
    return config.Settings()


SECTIONS = [
    {"slot": "identity", "content": "Recall before answering memory questions."},
    {"slot": "preferences", "content": "Draft outbound text in chat first."},
    {"slot": "constraints", "content": ""},
    {"slot": "principles", "content": "Verify before asserting."},
]


def run_main(settings: config.Settings, sections=SECTIONS, source="live") -> tuple[int, str]:
    """Run the hook's main() in process with the settings and the fake capsule, return (exit code, stdout)."""
    memory_capsule._settings = lambda: settings  # type: ignore[assignment]
    memory_capsule._fetch = lambda: (sections, source, None) if sections else (None, "none", None)  # type: ignore[assignment]
    out = io.StringIO()
    with redirect_stdout(out):
        code = session_start.main()
    return code, out.getvalue()


# 1. Unconfigured client: silent, exit 0, no capsule even if one would be served.
code, out = run_main(unconfigured())
check("unconfigured client exits 0 with no output", code == 0 and out == "")

# 2. Configured with a capsule: one JSON object in the Claude Code hook shape.
code, out = run_main(configured())
payload = json.loads(out) if out.strip() else {}
hook = payload.get("hookSpecificOutput", {})
ctx = hook.get("additionalContext", "")
check("configured client prints one SessionStart hookSpecificOutput object", code == 0 and hook.get("hookEventName") == "SessionStart")
check("the capsule text carries the sections that have content", "### identity" in ctx and "### principles" in ctx and "Draft outbound text" in ctx)
check("an empty section is left out", "### constraints" not in ctx)

# 3. A capsule longer than the limit is capped at 9500 characters.
long_sections = [{"slot": "identity", "content": "x" * 20000}]
code, out = run_main(configured(), long_sections)
ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
check("a long capsule is capped at 9500 characters", len(ctx) == 9500)

# 4. No capsule available (fetch finds nothing): silent, exit 0.
code, out = run_main(configured(), sections=[])
check("no capsule means silent exit 0", code == 0 and out == "")

# 5. Capsule switched off by the environment: silent, exit 0.
os.environ["ANYMEM_CAPSULE"] = "0"
memory_capsule._fetch = lambda: (SECTIONS, "live", None)  # type: ignore[assignment]
memory_capsule._settings = lambda: configured()  # type: ignore[assignment]
out = io.StringIO()
with redirect_stdout(out):
    code = session_start.main()
check("ANYMEM_CAPSULE=0 means silent exit 0", code == 0 and out.getvalue() == "")
del os.environ["ANYMEM_CAPSULE"]

# 6. The real script as a subprocess, with no configuration: exit 0 and nothing on stdout.
proc = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=30,
                      env={**os.environ, "ANYMEM_CONFIG_DIR": TMP + "/empty", "ANYMEM_CACHE_DIR": TMP + "/cache-empty"})
check("the script run unconfigured exits 0 with empty stdout", proc.returncode == 0 and proc.stdout == "")

rows = [{"id": "aaaa1111-0", "content": "---\nname: first-note\ndescription: d\n---\nb", "tags": ["auto-capture"]},
        {"id": "bbbb2222-0", "content": "---\nname: held-draft\ndescription: d\n---\nb", "tags": ["auto-capture", "status:draft"]},
        {"id": "cccc3333-0", "content": "---\nname: second-note\ndescription: d\n---\nb", "tags": ["auto-capture"]}]
session_start.api.request = lambda *a, **k: rows
line = session_start.recent_line()
check("the weekly line counts automatic captures and skips held drafts", "2 new memories" in line and "first-note" in line and "held-draft" not in line)
check("the weekly line says nothing needs reviewing and how to undo", "forget script" in line and "Nothing needs reviewing" in line)
session_start.api.request = lambda *a, **k: []
check("no new memories gives no line", session_start.recent_line() == "")
def boom(*a, **k): raise RuntimeError("down")
session_start.api.request = boom
check("a Worker that is down gives no line and no error", session_start.recent_line() == "")

from hm.commands import recall_check  # noqa: E402
recall_check.state_file().parent.mkdir(parents=True, exist_ok=True)
recall_check.state_file().write_text(json.dumps({"status": "warn", "why": "the top five rate fell from 0.95 to 0.80"}))
check("a warn from the monthly recall check shows at session start", "Memory health: the top five rate fell" in session_start.health_line())
recall_check.state_file().write_text(json.dumps({"status": "ok"}))
check("an ok recall check shows nothing", session_start.health_line() == "")
_pend = [{"id": "pp1", "tags": ["profile-proposal", "status:draft", "field:address"], "content": "---\nname: profile-proposal-address\n---\n\nProposed Home address: 9 New Road\nCurrent Home address: 1 Test Street\n"}]
session_start.api.request = lambda *a, **k: _pend
from hm.commands import profile as _p
_p.api.request = lambda *a, **k: _pend
check("a pending profile change is shown with how to accept or dismiss it", "home address to \"9 New Road\"" in session_start.pending_line() and "accept <field>" in session_start.pending_line() and "dismiss <field>" in session_start.pending_line())
_p.api.request = lambda *a, **k: []
check("no pending change shows nothing", session_start.pending_line() == "")
# the v2 list shape, and a pending memory is not counted
session_start.api.request = lambda *a, **k: {"ok": True, "entries": [{**rows[0], "status": "active"}, {**rows[1], "status": "pending", "tags": ["auto-capture"]}, {**rows[2], "status": "active"}], "next_cursor": None}
v2line = session_start.recent_line()
check("a v2 list reply is read, and a pending memory is left out", "2 new memories" in v2line and "held-draft" not in v2line)

# a slow Worker: the extra lines wait only for the hook's deadline, and the capsule is still printed in time
import time as _time  # noqa: E402
def _slow(*a, **k):
    _time.sleep(5)
    return rows  # a real answer, too late: the weekly line must not show it
session_start.api.request = _slow
_p.api.request = _slow
os.environ["ANYMEM_HOOK_DEADLINE"] = "1"
_t0 = _time.monotonic()
code, out = run_main(configured())
_took = _time.monotonic() - _t0
del os.environ["ANYMEM_HOOK_DEADLINE"]
_ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out.strip() else ""
check("a slow Worker still gets the capsule printed inside the hook deadline", code == 0 and "### identity" in _ctx and _took < 2.5)
check("a slow Worker drops the extra lines when the deadline is spent", "Memory:" not in _ctx and "Profile:" not in _ctx)
session_start._budget.clear()

# a new user has no capsule yet, and a pending profile change still reaches the session
session_start.api.request = lambda *a, **k: []
_p.api.request = lambda *a, **k: _pend
code, out = run_main(configured(), sections=[])
_ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out.strip() else ""
check("with no capsule the pending profile change is still shown", code == 0 and "Profile: you said" in _ctx)

# a long capsule gives up its tail to the status lines, so the lines are never cut off
code, out = run_main(configured(), long_sections)
_ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
check("a long capsule leaves room for the pending profile change, and the text stays under 9500", "Profile: you said" in _ctx and len(_ctx) <= 9500)
_p.api.request = lambda *a, **k: []

# the capsule step is bounded as well: a fetch that stalls (a DNS lookup holds the thread) is cut at the capsule cap, with no output
def _stalled(*a, **k):
    _time.sleep(5)
    return SECTIONS, "live", None
memory_capsule._settings = lambda: configured()  # type: ignore[assignment]
memory_capsule._fetch = _stalled  # type: ignore[assignment]
session_start.CAPSULE_CAP = 0.5
_t0 = _time.monotonic()
_out = io.StringIO()
with redirect_stdout(_out):
    code = session_start.main()
_took = _time.monotonic() - _t0
session_start.CAPSULE_CAP = 6.0
check("a stalled capsule fetch is cut at the capsule cap, and the hook exits 0 with no output", code == 0 and _out.getvalue() == "" and _took < 2.5)

# the session id reaches the later commands through CLAUDE_ENV_FILE
import pathlib as _pl  # noqa: E402
envfile = _pl.Path(TMP) / "claude-env.sh"
os.environ["CLAUDE_ENV_FILE"] = str(envfile)
session_start.export_session("abc-123; rm -rf /")
text_env = envfile.read_text()
check("the env file gets the session and harness exports, and the id is made safe", "export ANYMEM_SESSION=abc-123rm-rf" in text_env and "export ANYMEM_HARNESS=claude" in text_env and ";" not in text_env)
envfile.unlink()
session_start.export_session("")
check("no session id writes nothing", not envfile.exists())
del os.environ["CLAUDE_ENV_FILE"]
session_start.export_session("abc")
check("without CLAUDE_ENV_FILE nothing is written", not envfile.exists())
# the Worker is late: the last good capsule from the cache is still shown, and nothing else
from hm import api as _api  # noqa: E402
_real_within, _real_cache = session_start._within, memory_capsule._read_cache


def _late(seconds, fn):
    raise _api.NetworkError("no answer inside the hook's deadline")


session_start._within = _late
memory_capsule._read_cache = lambda: {"sections": SECTIONS, "fetched_at": None}
memory_capsule._settings = lambda: configured()
late = session_start.context()
check("a late Worker still gets the cached capsule", "Recall before answering memory questions." in late and "cache" in late.lower())
os.environ["ANYMEM_CAPSULE"] = "0"
check("with the capsule switched off a late Worker shows nothing", session_start.context() == "")
del os.environ["ANYMEM_CAPSULE"]
memory_capsule._read_cache = lambda: None
check("a late Worker with no cache shows nothing", session_start.context() == "")
session_start._within, memory_capsule._read_cache = _real_within, _real_cache

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
