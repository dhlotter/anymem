"""`recall.py "query"`: search the store, best match first. The prompt hook already does this on every prompt, this is for a
specific question it did not answer."""
from __future__ import annotations

import json
from urllib.parse import urlencode

from hm import api, shapes, skill

COMMAND = "recall"
HELP = "search memories, best first. Shows the closest few with their text"
BODY_CHARS = 400


def register(parser):
    parser.add_argument("query")
    parser.add_argument("--limit", type=int, default=5, help="how many to show, 1 to 50 (default 5)")
    parser.add_argument("--all", action="store_true", help="search every project, not only this one plus global memories")
    parser.add_argument("--json", action="store_true", help="print the Worker's reply as it came")


def params(ns) -> dict:
    p = {"query": ns.query, "topK": max(1, min(50, ns.limit)), "count": 1}
    project = None if ns.all else skill.current_project()
    if project:
        p["scope"] = "project:" + project
    return p


def run(ns):
    reply = api.request("GET", "/recall?" + urlencode(params(ns)), timeout=60)
    if ns.json:
        print(json.dumps(reply, indent=2))
        return 0
    found = shapes.results(reply)
    skill.note_ids([r.get("id") for r in found])
    if not found:
        print("no memories found")
        return 0
    for i, r in enumerate(found, 1):
        mark = "" if r.get("relevant", True) else "  (weak match)"
        print(f"{i}. {skill.line(r)}{mark}")
        if shapes.description_of(r):
            print("   " + skill.clean(shapes.description_of(r)))
        body = " ".join(str(r.get("body") or r.get("content") or "").split())
        print("   " + skill.clean(body[:BODY_CHARS]) + ("..." if len(body) > BODY_CHARS else ""))
    if reply.get("degraded"):
        print(f"note: this answer is degraded ({reply['degraded']}), meaning search was weaker than usual")
    return 0
