"""Turns a ZCode hook payload into the keys the shared hooks read.

ZCode sends a Claude Code compatible payload, with every key twice: snake_case (hook_event_name, session_id, transcript_path)
and camelCase (hookEventName, sessionId, transcriptPath). Observed on ZCode 0.16.9:

    SessionStart      source, cwd, model, mode, session_id, transcript_path (an empty temporary file)
    UserPromptSubmit  prompt, cwd, session_id, transcript_path (a temporary file holding only this prompt)
    Stop              last_assistant_message, cwd, session_id, transcript_path (a temporary file holding only that reply)

ZCode has no PreCompact and no SessionEnd event. The names stay in EVENTS because the shared hooks know them.
stdlib only.
"""
from __future__ import annotations

EVENTS = ("SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd", "Stop")

# The word the hook command passes as its first argument, and the event it stands for.
ARGUMENT_EVENT = {
    "session-start": "SessionStart",
    "prompt": "UserPromptSubmit",
    "capture": "Stop",
}


def _first(raw: dict, *keys: str) -> str:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def normalize(raw, argument: str = "") -> dict:
    """The five shared keys, always present as strings, plus last_assistant_message (empty unless ZCode sent one).

    `argument` is the event word the hook command was started with. It only fills in an event name the payload lacks."""
    data = raw if isinstance(raw, dict) else {}
    event = _first(data, "hook_event_name", "hookEventName") or ARGUMENT_EVENT.get(argument, "")
    return {
        "hook_event_name": event,
        "session_id": _first(data, "session_id", "sessionId"),
        "prompt": _first(data, "prompt"),
        "transcript_path": _first(data, "transcript_path", "transcriptPath"),
        "cwd": _first(data, "cwd"),
        "last_assistant_message": _first(data, "last_assistant_message", "responseText"),
    }
