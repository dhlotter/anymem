"""Codex hook payloads, normalised to the keys the shared hooks read.

Codex sends a JSON object on stdin: hook_event_name, session_id, transcript_path (a rollout file, or null for Codex's own
internal sessions), cwd, and prompt on UserPromptSubmit. It already uses the names the shared hooks expect, so this module
only guards the types and the event name. Everything else Codex sends (model, turn_id, permission_mode) is dropped.

Codex has no compaction event, so PreCompact never arrives from it. It stays in EVENTS because the shared hooks know it.
"""
from __future__ import annotations

import re

EVENTS = ("SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd", "Stop")
KEYS = ("hook_event_name", "session_id", "prompt", "transcript_path", "cwd")


def _snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


_BY_FLAT = {_snake(e): e for e in EVENTS}


def event_name(raw) -> str:
    """The canonical event name for 'SessionStart', 'session_start', 'session-start' and the like, or '' for any other event."""
    return _BY_FLAT.get(_snake(str(raw or "")), "")


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def normalise(raw) -> dict:
    """The five shared keys, always present, always strings. Anything that is not a JSON object gives empty values."""
    data = raw if isinstance(raw, dict) else {}
    return {
        "hook_event_name": event_name(data.get("hook_event_name")),
        "session_id": _text(data.get("session_id")),
        "prompt": _text(data.get("prompt")),
        "transcript_path": _text(data.get("transcript_path")),
        "cwd": _text(data.get("cwd")),
    }


def is_internal(raw) -> bool:
    """True for a session Codex runs for itself, which must neither receive memories nor be captured.

    Codex's own memory feature starts a second session with no transcript file and a working folder named `memories` under
    CODEX_HOME (seen on 0.157.1). Its prompt is a very long consolidation brief, and recalling against it would inject
    unrelated memories into an agent that writes Codex's own notes."""
    data = raw if isinstance(raw, dict) else {}
    if data.get("transcript_path"):
        return False
    cwd = _text(data.get("cwd")).rstrip("/")
    return cwd.rsplit("/", 1)[-1] == "memories"
