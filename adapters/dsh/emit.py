"""Prints context the way DSH's Claude Code hook bridge reads it.

The bridge takes a hook's stdout as JSON and turns hookSpecificOutput.additionalContext into a message the model sees
(proven live for UserPromptSubmit, see docs/harnesses/dsh.md). Plain text on stdout is ignored by the bridge, so the JSON
form is the only one used. The session start text gets one closing line, see CAPSULE_END in payload.py.
"""
from __future__ import annotations

import json

from payload import CAPSULE_END


def context(event: str, text: str) -> str:
    """The exact bytes to print for `event` (SessionStart or UserPromptSubmit). An empty text prints nothing."""
    if not text:
        return ""
    if event == "SessionStart":
        text = text + "\n" + CAPSULE_END  # lets payload.normalise cut the capsule out of the prompt DSH reports
    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}) + "\n"
