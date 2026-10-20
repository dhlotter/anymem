#!/usr/bin/env python3
"""Runnable check for hooks/hooks.json, the Claude Code wiring. `python3 hooks/test_hooks_json.py`, exits non-zero on failure.

Reads the file and checks what the hooks rely on: every script it names exists, the events and matchers are the ones the
docs describe, and each timeout is longer than the deadline its script stops itself at (the recall hook stops at 8 s under
its 9 s limit, the session start at 8 s under its 10 s limit). No network, no Worker.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS))
for _name in [k for k in os.environ if k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_"))]:
    del os.environ[_name]  # the developer's shell must not change a check
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()  # importing the hooks must not touch a real cache folder
os.environ["ANYMEM_CONFIG_DIR"] = tempfile.mkdtemp()

failures: list = []


def check(name: str, cond: bool) -> None:
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


data = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))
events = data.get("hooks", {})
check("hooks.json parses and holds the hooks table", isinstance(events, dict) and bool(events))
check("the six events are wired: SessionStart, UserPromptSubmit, PreCompact, SessionEnd, Stop, PreToolUse",
      sorted(events) == ["PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"])

entries = [(event, group, hook) for event, groups in events.items() for group in groups for hook in group.get("hooks", [])]
check("every hook is a command", bool(entries) and all(h.get("type") == "command" for _, _, h in entries))

scripts = []
for event, group, hook in entries:
    args = hook.get("args") or []
    script = args[0] if args else ""
    m = re.fullmatch(r"\$\{CLAUDE_PLUGIN_ROOT\}/hooks/([A-Za-z0-9_]+\.py)", script)
    scripts.append((event, m.group(1) if m else None))
check("every script is named as ${CLAUDE_PLUGIN_ROOT}/hooks/<name>.py", all(name for _, name in scripts))
check("every script named in the file exists in hooks/", all(name and (HOOKS / name).is_file() for _, name in scripts))
check("every command runs python3", all(h.get("command") == "python3" for _, _, h in entries))

timeouts = {event: hook.get("timeout") for event, _, hook in entries}
check("SessionStart runs on startup, resume, clear and compact", re.fullmatch(r"startup\|resume\|clear\|compact", events["SessionStart"][0].get("matcher", "")) is not None)
check("PreToolUse guards Write, Edit, MultiEdit and Bash", re.fullmatch(r"Write\|Edit\|MultiEdit\|Bash", events["PreToolUse"][0].get("matcher", "")) is not None)
check("the prompt hook has no matcher, so every prompt is recalled", "matcher" not in events["UserPromptSubmit"][0])

# each limit the script stops itself at must sit under the limit the harness gives the hook, with room to write the answer
import memory_recall  # noqa: E402
import session_start  # noqa: E402
check("the prompt hook's 9 s limit is above its 8 s deadline", timeouts["UserPromptSubmit"] == 9 and memory_recall.DEADLINE_DEFAULT < timeouts["UserPromptSubmit"] - 0.5)
check("the session start's 10 s limit is above its 8 s deadline", timeouts["SessionStart"] == 10 and session_start.DEADLINE_DEFAULT < timeouts["SessionStart"] - 1)
check("the capture hooks give 5 s, and the worker they start detaches at once", all(timeouts[e] == 5 for e in ("PreCompact", "SessionEnd", "Stop")))
check("the PreToolUse guard has 5 s", timeouts["PreToolUse"] == 5)

print()
print(f"{len(failures)} failed" if failures else "ok")
sys.exit(1 if failures else 0)
