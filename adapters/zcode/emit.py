"""Prints context the way ZCode reads it.

ZCode follows the Claude Code hook protocol: one JSON object on stdout, `hookSpecificOutput.additionalContext`. Verified on
ZCode 0.16.9 for SessionStart and UserPromptSubmit: ZCode hands the text to the model as a system reminder message named
after the event. Nothing else is printed, an empty text prints nothing at all.
stdlib only.
"""
from __future__ import annotations

import json

LIMIT = 9500  # the shared hooks keep context under about 10,000 characters, so does this


def context(event: str, text: str) -> str:
    """The exact bytes to print, or an empty string when there is nothing to say."""
    text = (text or "").strip()
    if not text or event not in ("SessionStart", "UserPromptSubmit"):
        return ""
    body = {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text[:LIMIT]}}
    return json.dumps(body) + "\n"

