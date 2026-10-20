"""Reads ZCode transcript records for capture: read_turns(path, offset) -> ([(ROLE, text)], new_offset).

A record is one JSON line shaped like ZCode's own hook transcript: {"message": {"role": "user" | "assistant", "content":
[{"type": "text", "text": "..."}]}}. The content may also be a plain string, and a record may carry a top level "type" of
user or assistant instead of a message role (the Claude layout), both are read.

Left out: tool calls and tool results, thinking blocks, system, developer and tool messages, system reminders (ZCode
wraps every hook context in one), and any text this product injected itself (the capsule and the recalled memories). An
injected block is never captured back as if the user had said it. A partial last line stays for the next capture.

The file ZCode passes to a hook is a temporary one holding a single message, so the hook in this folder keeps its own
per session file in the same layout, and capture reads that, which sees the whole conversation. Either file is read by
this module.
stdlib only.
"""
from __future__ import annotations

import json
import re

REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
INJECTED_RE = re.compile(r"^## (?:Memory capsule|Relevant memories) \(anymem", re.M)
NOISE_PREFIXES = ("<command-name>", "<local-command", "Caveat:", "[SYSTEM NOTIFICATION", "<task-notification>",
                  "<ci-monitor-event", "[Request interrupted")
ROLES = {"user": "USER", "human": "USER", "assistant": "ASSISTANT"}


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def _clean(text: str) -> str:
    text = REMINDER_RE.sub("", text)
    hit = INJECTED_RE.search(text)
    if hit:
        text = text[:hit.start()]  # our own block starts here and runs to the end of that message
    return text.strip()


def _role(record: dict) -> str:
    message = record.get("message") if isinstance(record.get("message"), dict) else {}
    value = message.get("role") or record.get("role") or record.get("type")
    return ROLES.get(str(value).lower(), "")


def read_turns(path: str, offset: int = 0) -> tuple:
    with open(path, "rb") as f:
        f.seek(max(0, int(offset)))
        data = f.read()
    end = int(offset) + len(data)
    if data and not data.endswith(b"\n"):  # a partial last record stays for the next capture
        cut = data.rfind(b"\n") + 1
        end = int(offset) + cut
        data = data[:cut]
    turns: list = []
    for raw in data.splitlines():
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("isMeta") or record.get("isSidechain"):
            continue
        role = _role(record)
        if not role:
            continue
        message = record.get("message") if isinstance(record.get("message"), dict) else record
        text = _clean(_text_of(message.get("content")))
        if text and not text.startswith(NOISE_PREFIXES):
            turns.append((role, text))
    return turns, end
