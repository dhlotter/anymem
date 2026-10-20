"""Turns the payload DSH's Claude Code hook bridge sends into the shared keys the hooks expect.

    normalise(raw, default_event) -> {"hook_event_name", "session_id", "prompt", "transcript_path", "cwd"}

The bridge speaks the Claude Code contract, so the keys already match. Three things differ and are handled here:
1. `transcript_path` is always an empty string, because DSH keeps its own log (see below). It is found from the session id.
2. DSH has no SessionEnd or PreCompact event, so capture rides on Stop.
3. The bridge builds `prompt` from every message waiting for the turn, so when the session start capsule landed first,
   `prompt` is the capsule followed straight by what the person typed. The capsule we inject ends with CAPSULE_END, and
   everything up to it is cut off here, otherwise recall would search with the capsule text instead of the question.

DSH keeps each session at <sessions>/<project folder>/<session id>/session.v4.jsonl.zstd, where <sessions> is
$DSH_HOME/sessions (default ~/.dsh/sessions). ANYMEM_DSH_SESSIONS points somewhere else when a profile moves it.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

EVENTS = {name.lower(): name for name in ("SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd", "Stop")}
SESSION_FILE = "session.v4.jsonl.zstd"
SAFE_ID = re.compile(r"[A-Za-z0-9_.-]{1,120}")
CAPSULE_END = "(end of the anymem capsule)"


def sessions_root() -> Path:
    explicit = os.environ.get("ANYMEM_DSH_SESSIONS")
    if explicit:
        return Path(explicit)
    return Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "sessions"


def find_transcript(session_id: str) -> str:
    """The session log for this id, or "" when there is none (yet)."""
    if not SAFE_ID.fullmatch(session_id or ""):
        return ""
    try:
        for path in sessions_root().glob("*/" + session_id + "/" + SESSION_FILE):
            return str(path)
    except OSError:
        pass
    return ""


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def normalise(raw, default_event: str = "") -> dict:
    """Never raises. Anything that is not a JSON object gives empty strings."""
    raw = raw if isinstance(raw, dict) else {}
    event = EVENTS.get(_text(raw.get("hook_event_name")).lower()) or EVENTS.get(default_event.lower(), "")
    session_id = _text(raw.get("session_id"))
    path = _text(raw.get("transcript_path"))
    if not (path and os.path.isfile(path)):
        path = find_transcript(session_id)
    prompt = _text(raw.get("prompt"))
    if CAPSULE_END in prompt:
        prompt = prompt.split(CAPSULE_END, 1)[1].lstrip("\n")
    return {
        "hook_event_name": event,
        "session_id": session_id,
        "prompt": prompt,
        "transcript_path": path,
        "cwd": _text(raw.get("cwd")),
    }
