"""Context injection in Codex's protocol.

Codex reads one JSON object from a hook's stdout and adds hookSpecificOutput.additionalContext to the model's context. The
contract is the same one Claude Code uses, so the shared hooks already print it, and this module exists for hook.py. Only
SessionStart and UserPromptSubmit carry context, every other event prints nothing.
"""
from __future__ import annotations

import json
import sys

CONTEXT_EVENTS = ("SessionStart", "UserPromptSubmit")
SESSION_START_LIMIT = 9500  # Codex, like Claude Code, shows a hook's output in full only below about 10,000 characters


def render(event: str, text: str) -> str:
    """The exact bytes to print, or '' when there is nothing to say."""
    if event not in CONTEXT_EVENTS or not text or not text.strip():
        return ""
    if event == "SessionStart":
        text = text[:SESSION_START_LIMIT]
    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}) + "\n"


def emit(event: str, text: str, stream=None) -> bool:
    """Print the context for `event`. Returns True when something was written."""
    out = render(event, text)
    if not out:
        return False
    (stream or sys.stdout).write(out)
    return True
