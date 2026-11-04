"""Reader for the Cline spool file (the plugin's record of the conversation, so anymem never reads Cline's own session store).

One JSON object per line: {"role": "user" or "assistant", "text": "..."}. Written by plugin.js after each run from the user's
messages and the assistant's text parts. Tool calls and results, hook context, system reminders and reasoning are never
written, and read_turns drops anything else that is not plain user or assistant text. Text that anymem itself
injected (the recall block and the capsule) is cut out, so an injected memory is never captured back as if someone said it.

    read_turns(path, offset) -> ([(ROLE, text)], new_offset)      ROLE is USER or ASSISTANT, offset is a byte position

A partial last line (a write in progress) stays for the next capture: the returned offset stops before it.
"""
from __future__ import annotations

import json
import re

ROLES = {"user": "USER", "assistant": "ASSISTANT"}
REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
RECALL_HEADER = "## Relevant memories (anymem"
CAPSULE_HEADER = "## Memory capsule (anymem"


def strip_injected(text: str) -> str:
    """Text without the blocks hooks add: reminders, the recall block (header, one note line, bullets) and the capsule (to the end)."""
    text = REMINDER_RE.sub("", text)
    cut = text.find(CAPSULE_HEADER)
    if cut >= 0:
        text = text[:cut]
    kept, skipping = [], False
    for ln in text.split("\n"):
        if ln.startswith(RECALL_HEADER):
            skipping = True
        elif skipping and (ln.startswith("Context only") or ln.startswith("- ")):
            pass
        else:
            skipping = False
            kept.append(ln)
    return "\n".join(kept).strip()


def read_turns(path: str, offset: int) -> tuple:
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = offset + len(data)
    if data and not data.endswith(b"\n"):  # the last record is still being written
        cut = data.rfind(b"\n") + 1
        end = offset + cut
        data = data[:cut]
    turns = []
    for raw in data.splitlines():
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(rec, dict) or rec.get("synthetic"):
            continue
        role = ROLES.get(str(rec.get("role", "")).lower())
        text = rec.get("text")
        if role is None or not isinstance(text, str):
            continue
        text = strip_injected(text)
        if text:
            turns.append((role, text))
    return turns, end
