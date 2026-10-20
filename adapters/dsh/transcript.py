"""Reads a DSH session log into [(ROLE, text)] for the capture hook.

    read_turns(path, offset) -> ([("USER" | "ASSISTANT", text)], new_offset)

The file is DSH's session.v4.jsonl.zstd: Zstandard frames appended as the session goes, each frame a whole number of JSON
lines, one event per line. `offset` is a byte position in the compressed file and always sits on a frame boundary, so a
frame that is still being written stays for the next capture (the offset stays before it).

Kept: user/message events whose source kind is "user" (what the person typed) and assistant/message events from the model,
text blocks only. Left out: reasoning, tool calls and results, the system prompt, the workspace instructions and skill lists
DSH adds, and everything a hook injected (source kind hooks-claude-code), which is where our own recalled memories land.
A plain JSON lines file is read too, so the same reader works on an uncompressed log.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

MAX_READ = 16 * 1024 * 1024  # compressed bytes per call, a longer log is read over several captures
REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
INJECTED = "## Relevant memories (anymem"
MAGICS = (b"\x28\xb5\x2f\xfd", b"\x50\x2a\x4d\x18")


def _zstd():
    """The decoder next to this file. Loaded by path with its own module name, because the capture hook imports this file
    without its folder on sys.path and other adapters ship files with the same short names."""
    key = "hm_dsh_zstd"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name("dsh_zstd.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        spec.loader.exec_module(module)
    return sys.modules[key]


def _lines(data: bytes, offset: int) -> tuple:
    """(JSON lines as bytes, new offset) for the data read from `offset`."""
    if data[:4] in MAGICS:
        frames, used = _zstd().decode_frames(data, 0)
        return b"".join(frames).splitlines(), offset + used
    cut = data.rfind(b"\n") + 1  # a partial last line stays for the next capture
    return data[:cut].splitlines(), offset + cut


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def read_turns(path: str, offset: int) -> tuple:
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read(MAX_READ)
    lines, end = _lines(data, offset)
    turns: list = []
    seen: set = set()
    for raw in lines:
        try:
            event = json.loads(raw)
            body = event.get("data") or {}
            if event.get("type") == "user/message":
                message, role, source = body, "USER", body.get("source")
                wanted = (source or {}).get("kind") == "user"
            elif event.get("type") == "assistant/message":
                message = body.get("message") or {}
                role, source = "ASSISTANT", message.get("source")
                wanted = (source or {}).get("kind", "model") == "model"
            else:
                continue
            ident = message.get("id")
            if not wanted or (ident and ident in seen):
                continue
            seen.add(ident)
            text = REMINDER_RE.sub("", _text(message.get("content"))).strip()
        except (ValueError, AttributeError, TypeError):
            continue
        if text and not text.startswith(INJECTED):
            turns.append((role, text))
    return turns, end
