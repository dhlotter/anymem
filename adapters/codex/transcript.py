"""Reads a Codex rollout file into [(ROLE, text)] for the capture worker.

A rollout is JSON lines. Each line has a "type": session_meta, event_msg, turn_context, world_state, token_usage_record or
response_item. Only response_item lines whose payload is a "message" matter. payload.role is user, assistant or developer, and
payload.content is a list of blocks of type input_text (user and developer) or output_text (assistant).

What is left out, so that capture never learns from text nobody said:
1. developer messages, and any role that is not user or assistant (Codex's own instructions and skill lists).
2. tool calls and tool output, reasoning, event_msg, world_state and the other record types.
3. user messages Codex adds for itself: <environment_context>, <user_instructions>, an AGENTS.md instructions block,
   <skills_instructions> and the like, wherever they sit in a message.
4. anything our own hooks injected: the recalled memories block and the memory capsule block. An injected memory must never
   come back as if the user had said it, so these are removed even when Codex files them as a user message.

read_turns(path, offset) -> ([(ROLE, text)], new_offset). Offsets are bytes. A partial last line (Codex is still writing it) is
not consumed: the returned offset stops before it, so the next capture starts there.
"""
from __future__ import annotations

import json
import re

ROLES = {"user": "USER", "assistant": "ASSISTANT"}

# Wrapper blocks Codex puts in user messages. A message that holds only these is dropped, one that holds more keeps the rest.
WRAPPER_TAGS = (
    "environment_context", "user_instructions", "INSTRUCTIONS", "skills_instructions", "permissions instructions",
    "collaboration_mode", "turn_aborted", "user_shell_command", "subagent_notification", "hook_context", "hook_additional_context",
    "system-reminder", "recalled_memories",
)
WRAPPER_RE = re.compile(r"<(%s)(?:\s[^>]*)?>.*?</\1\s*>" % "|".join(re.escape(t) for t in WRAPPER_TAGS), re.S | re.I)
AGENTS_RE = re.compile(r"^\s*#\s*AGENTS\.md instructions for .*?(?:</INSTRUCTIONS>|\Z)", re.S)

# Headings our own hooks print (hooks/memory_recall.py render, hooks/memory_capsule.py render). A block starts at its heading and
# runs to the end of the message, because the hook's output is one block and Codex adds it as its own message.
OWN_BLOCK_RE = re.compile(r"(?m)^\s*## (?:Relevant memories \(anymem|Memory capsule \(anymem).*\Z", re.S)

NOISE_PREFIXES = ("[Request interrupted", "<turn_aborted")


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text") and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def clean_user(text: str) -> str:
    text = AGENTS_RE.sub("", text)
    text = WRAPPER_RE.sub("", text)
    text = OWN_BLOCK_RE.sub("", text)
    return text.strip()


def clean_assistant(text: str) -> str:
    return OWN_BLOCK_RE.sub("", text).strip()


def turn_from(record) -> "tuple | None":
    """(ROLE, text) for one rollout record, or None when it carries nothing to learn from."""
    if not isinstance(record, dict) or record.get("type") != "response_item":
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "message":
        return None
    role = ROLES.get(str(payload.get("role") or ""))
    if role is None:
        return None
    raw = _text_of(payload.get("content"))
    text = clean_user(raw) if role == "USER" else clean_assistant(raw)
    if not text or text.startswith(NOISE_PREFIXES):
        return None
    return role, text


def read_turns(path: str, offset: int = 0) -> tuple:
    """([(ROLE, text)], new_offset) for the rollout at `path`, from byte `offset` to the last complete line."""
    offset = max(int(offset or 0), 0)
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = offset + len(data)
    if data and not data.endswith(b"\n"):  # a write in progress, the partial record stays for the next capture
        cut = data.rfind(b"\n") + 1
        end = offset + cut
        data = data[:cut]
    turns = []
    for raw in data.splitlines():
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        turn = turn_from(record)
        if turn:
            turns.append(turn)
    return turns, end
