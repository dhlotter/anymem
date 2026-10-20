"""Kilo payload to the shared hook payload.

Kilo has no shell hooks, so the payload is the small JSON object the plugin (plugin.js) writes to hook.py's stdin:

    {"sessionID": "ses_...", "prompt": "the user's message", "directory": "/path/to/project", "spool": "/path/to/spool.jsonl"}

and the event name is the first argument of hook.py. normalise() returns the keys the shared hooks read:
hook_event_name (SessionStart, UserPromptSubmit, PreCompact or SessionEnd), session_id, prompt, transcript_path, cwd.
Every value is a string. Without a spool path the transcript is the plugin's default spool file for that session.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

EVENTS = {
    "session-start": "SessionStart",
    "prompt": "UserPromptSubmit",
    "pre-compact": "PreCompact",
    "capture": "SessionEnd",  # Kilo has no session end event: the end of a turn is the closest, and it keeps the 8 KB capture floor
}


def spool_name(session_id: str) -> str:
    """The spool file name for a session, the same rule plugin.js uses."""
    return (re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "session")[:80] or "session") + ".jsonl"


def default_spool(session_id: str) -> str:
    cache = os.environ.get("ANYMEM_CACHE_DIR") or str(Path.home() / ".cache" / "anymem")
    return str(Path(cache) / "kilo" / spool_name(session_id))


def _text(raw: dict, *keys: str) -> str:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def normalise(raw, event: str) -> dict:
    """The shared payload for a Kilo plugin payload and an event word. An unknown event gives an empty hook_event_name."""
    raw = raw if isinstance(raw, dict) else {}
    session_id = _text(raw, "sessionID", "session_id")
    spool = _text(raw, "spool", "transcript_path") or (default_spool(session_id) if session_id else "")
    return {
        "hook_event_name": EVENTS.get(event, ""),
        "session_id": session_id,
        "prompt": _text(raw, "prompt"),
        "transcript_path": spool,
        "cwd": _text(raw, "directory", "cwd"),
    }
