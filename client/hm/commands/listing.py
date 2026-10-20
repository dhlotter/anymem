"""`list.py`: memories newest first, with filters. For a question use recall.py, this is for browsing what is stored."""
from __future__ import annotations

import json
import time
from urllib.parse import urlencode

from hm import api, shapes, skill

COMMAND = "list"
HELP = "list memories, newest first, with filters"


def register(parser):
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--status", choices=("canonical", "active", "deprecated", "pending"))
    parser.add_argument("--origin", choices=("explicit", "capture", "profile", "person", "system", "import"))
    parser.add_argument("--type", choices=("user", "feedback", "project", "reference"))
    parser.add_argument("--project")
    parser.add_argument("--days", type=float, help="only memories created in the last N days")
    parser.add_argument("--max-recalls", type=int, help="only memories recalled at most this many times")
    parser.add_argument("--deleted", action="store_true", help="the trash (the last 14 days)")
    parser.add_argument("-n", type=int, default=20, help="how many to show, up to 500 (default 20)")
    parser.add_argument("--json", action="store_true")


def query(ns, cursor=None, now=None) -> list:
    q = [("n", max(1, min(500, ns.n)))]
    q += [("tag", t) for t in ns.tag]
    for key in ("status", "origin", "type", "project"):
        if getattr(ns, key):
            q.append((key, getattr(ns, key)))
    if ns.days:
        q.append(("after", int(((now if now is not None else time.time()) - ns.days * 86400) * 1000)))
    if ns.max_recalls is not None:
        q.append(("max_recalls", ns.max_recalls))
    if ns.deleted:
        q.append(("deleted", 1))
    if cursor:
        q.append(("cursor", cursor))
    return q


def run(ns):
    reply = api.request("GET", "/list?" + urlencode(query(ns)), timeout=60)
    found = shapes.entries(reply)
    skill.note_ids([e.get("id") for e in found])
    if ns.json:
        print(json.dumps(reply, indent=2))
        return 0
    if not found:
        print("no memories match")
        return 0
    for e in found:
        print(f"{time.strftime('%Y-%m-%d', time.gmtime((e.get('created_at') or 0) / 1000))}  {skill.line(e)}")
    if isinstance(reply, dict) and reply.get("next_cursor"):
        print("more exist, narrow the filters or raise -n")
    return 0
