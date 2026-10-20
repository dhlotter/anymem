"""`update.py ID "new content"`: replace a memory's text, or its tags. The old state stays in the history, `undo.py` reverts."""
from __future__ import annotations

import sys

from hm import api, private, skill

COMMAND = "update"
HELP = "replace a memory's text, its tags, or both"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("content", nargs="?", help="the full new text, or - to read standard input. Leave out to change only tags")
    parser.add_argument("--tag", action="append", help="the new tag list, repeat for more. Replaces the old tags")
    parser.add_argument("--if-updated-at", type=int, help="refuse when the memory changed since this time in milliseconds")


def run(ns):
    body = {}
    if ns.content is not None:
        content = private.strip(skill.read_text(ns.content)).strip()
        secrets = skill.secret_kinds(content) if content else []
        if secrets:
            print(f"anymem: not updated, the text looks like it holds a secret ({', '.join(secrets)}). Remove it and run again.", file=sys.stderr)
            return 2
        body["content"] = content
    if ns.tag is not None:
        body["tags"] = ns.tag
    if not body or body.get("content") == "":
        print("anymem: give the new content or --tag", file=sys.stderr)
        return 2
    body["id"] = skill.resolve(ns.id)
    if ns.if_updated_at is not None:
        body["if_updated_at"] = ns.if_updated_at
    api.request("POST", "/update", body, timeout=60)
    print(f"updated {body['id']}")
    return 0
