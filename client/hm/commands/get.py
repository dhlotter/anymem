"""`get.py ID`: read one memory in full. An 8 character id prefix is enough."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from urllib.parse import urlencode

from hm import api, shapes, skill

COMMAND = "get"
HELP = "print one memory in full"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("--version", type=int, help="the state before change N")
    parser.add_argument("--deleted", action="store_true", help="read it from the trash")
    parser.add_argument("--json", action="store_true")


def when(ms) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if isinstance(ms, (int, float)) and ms else "-"


def run(ns):
    mid = skill.resolve(ns.id, ns.deleted)
    skill.note_ids([mid])
    q = {"id": mid, **({"version": ns.version} if ns.version else {}), **({"deleted": 1} if ns.deleted else {})}
    reply = api.request("GET", "/entry?" + urlencode(q), timeout=30)
    if ns.json:
        print(json.dumps(reply, indent=2))
        return 0
    e = shapes.entry(reply)
    print(f"id {e.get('id')}  status {e.get('status')}  origin {e.get('origin')}  project {e.get('project') or '-'}  recalled {e.get('recall_count', 0)} times")
    print(f"created {when(e.get('created_at'))}  updated {when(e.get('updated_at'))}  tags {', '.join(e.get('tags') or []) or '-'}")
    if e.get("valid_until"):
        print(f"closed {when(e['valid_until'])}, replaced by {e.get('superseded_by') or '-'}")
    if e.get("deleted_at"):
        print(f"in the trash since {when(e['deleted_at'])}")
    print()
    print(skill.clean(e.get("content", "")))
    return 0
