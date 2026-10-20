"""Readers for the Worker's replies, in the v2 shape and the old one, so a rollback to the old Worker still works.

Every function takes whatever the Worker sent and never raises. Drop the old branches a week after the cutover.
"""
from __future__ import annotations

import json
import re


def entries(reply) -> list:
    """The memories of a /list reply. v2 is {ok, entries, next_cursor}, the old Worker sent a bare list."""
    if isinstance(reply, list):
        return [e for e in reply if isinstance(e, dict)]
    rows = reply.get("entries") if isinstance(reply, dict) else None
    return [e for e in rows if isinstance(e, dict)] if isinstance(rows, list) else []


def entry(reply) -> dict:
    """The memory of an /entry or write reply. v2 and the old Worker both wrap it in `entry`, an unwrapped one is accepted."""
    if not isinstance(reply, dict):
        return {}
    inner = reply.get("entry")
    return inner if isinstance(inner, dict) else reply


def results(reply) -> list:
    rows = reply.get("results") if isinstance(reply, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def subjects(reply) -> list:
    """The subject cards of a recall reply, or the rows of a /subjects reply. Empty when the Worker sent none (the variable is off, or an older Worker)."""
    rows = reply.get("subjects") if isinstance(reply, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def sections(reply) -> "list | None":
    """The capsule sections that have text. v2 puts them flat in `sections`, the old Worker put a JSON string in `text`.
    None when the reply is neither, an empty list when the capsule is empty."""
    if not isinstance(reply, dict):
        return None
    rows = reply.get("sections")
    if not any(isinstance(x, dict) and "content" in x for x in rows or []):
        try:
            rows = json.loads(reply.get("text") or "").get("sections")
        except (AttributeError, TypeError, ValueError):
            pass  # no old shape either: what `sections` held (a list, even an empty one) stands
    if not isinstance(rows, list):
        return None
    return [x for x in rows if isinstance(x, dict) and str(x.get("content", "")).strip()]


def source_id(section: dict) -> str:
    return str(section.get("source_id") or section.get("source_entry_id") or "")


def ids_of(reply) -> list:
    """The memory ids a reply mentions, for the audit log. Ids only, never text."""
    out = []

    def add(v):
        if isinstance(v, str) and v and v not in out:
            out.append(v)

    if isinstance(reply, dict):
        add(reply.get("id"))
        add(reply.get("matchId"))
        for key in ("replaced", "kept_both"):
            if isinstance(reply.get(key), dict):
                add(reply[key].get("id"))
        if isinstance(reply.get("entry"), dict):
            add(reply["entry"].get("id"))
        if isinstance(reply.get("subject"), dict):
            add(reply["subject"].get("id"))
        for key in ("results", "entries", "subjects"):
            if isinstance(reply.get(key), list):
                for r in reply[key]:
                    if isinstance(r, dict):
                        add(r.get("id"))
    elif isinstance(reply, list):
        for r in reply:
            if isinstance(r, dict):
                add(r.get("id"))
    return out


def _front(content: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*(.+)$", (content or "").lstrip(), re.M)
    return m.group(1).strip().strip("\"'") if m else ""


def name_of(e: dict) -> str:
    """A memory's name, from the v2 `name` field or the frontmatter of an old reply."""
    return str(e.get("name") or "") or _front(e.get("content", ""), "name")


def description_of(e: dict) -> str:
    return str(e.get("description") or "") or _front(e.get("content", ""), "description")
