"""Antigravity CLI (agy) transcript reader.

The file is JSON lines at ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl.
Each record has step_index, source, type, status, created_at and content. The ones that matter:

    source USER_EXPLICIT, type USER_INPUT         what the person typed, wrapped as <USER_REQUEST>...</USER_REQUEST> and followed by
                                                  <ADDITIONAL_METADATA> and settings change blocks that are not theirs
    source MODEL, type PLANNER_RESPONSE           the model's own turn. Its content is the answer text. A turn that only calls
                                                  a tool has no content (it carries tool_calls and thinking instead)
    source MODEL, type GENERIC                    tool output, never captured
    source SYSTEM_SDK, type EPHEMERAL_MESSAGE     context a hook injected (our memory capsule and recalled memories), never captured,
                                                  or the next capture would store our own injection as if the person said it

Standalone on purpose: hooks/memory_capture.py loads this file by path (reader("agy")), so it imports nothing from its
folder. Python 3.9, stdlib only.
"""
from __future__ import annotations

import json
import os
import re

USER_RE = re.compile(r"<USER_REQUEST>\s*(.*)\s*</USER_REQUEST>", re.S)
TRAILING_BLOCKS = ("<ADDITIONAL_METADATA>", "<USER_SETTINGS_CHANGE>")
# Headings our own hooks put on the context they inject. A turn that starts with one is an echo of our injection.
INJECTED_PREFIXES = ("## Memory capsule (anymem", "## Relevant memories (anymem")
TAIL_BYTES = 1 << 20


def user_request(content) -> str:
    """The text the person typed, from a USER_INPUT step's content."""
    if not isinstance(content, str):
        return ""
    m = USER_RE.search(content)
    if m:
        return m.group(1).strip()
    cut = len(content)
    for marker in TRAILING_BLOCKS:
        i = content.find(marker)
        if i >= 0:
            cut = min(cut, i)
    return content[:cut].strip()


def turn_of(rec) -> "tuple | None":
    """(ROLE, text) for a record that is a genuine user or model message, else None."""
    if not isinstance(rec, dict) or rec.get("status") not in (None, "DONE"):
        return None
    source, kind = rec.get("source"), rec.get("type")
    if source == "USER_EXPLICIT" and kind == "USER_INPUT":
        role, text = "USER", user_request(rec.get("content"))
    elif source == "MODEL" and kind == "PLANNER_RESPONSE" and isinstance(rec.get("content"), str):
        role, text = "ASSISTANT", rec["content"].strip()
    else:
        return None
    if not text or text.startswith(INJECTED_PREFIXES):
        return None
    return role, text


def read_turns(path: str, offset: int = 0) -> tuple:
    """([(ROLE, text)], new byte offset). A last record that is still being written stays for the next capture."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = offset + len(data)
    if data and not data.endswith(b"\n"):
        cut = data.rfind(b"\n") + 1
        tail = data[cut:]
        try:
            complete = isinstance(json.loads(tail), dict)
        except ValueError:
            complete = False
        if not complete:
            end = offset + cut
            data = data[:cut]
    turns = []
    for raw in data.splitlines():
        try:
            turn = turn_of(json.loads(raw))
        except ValueError:
            continue
        if turn:
            turns.append(turn)
    return turns, end


def last_user_request(path: str) -> "tuple | None":
    """(step_index, text) of the newest USER_INPUT step, read from the end of the file, or None. The prompt is not in
    the hook payload, so the recall hook finds it here."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            start = max(0, size - TAIL_BYTES)
            f.seek(start)
            data = f.read()
    except OSError:
        return None
    lines = data.splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # the first line of a tail read is usually cut in half
    for raw in reversed(lines):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        turn = turn_of(rec)
        if turn and turn[0] == "USER":
            step = rec.get("step_index")
            return (step if isinstance(step, int) and not isinstance(step, bool) else -1), turn[1]
    return None
