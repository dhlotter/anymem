"""`links.py ID`: the links of one memory, grouped by type. `out` means this memory is the source, `in` means it is the target."""
from __future__ import annotations

import json
from urllib.parse import urlencode

from hm import api, skill
from hm.commands.link import shown

COMMAND = "links"
HELP = "list the links of a memory"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("--json", action="store_true")


def run(ns):
    mid = skill.resolve(ns.id)
    reply = api.request("GET", "/links?" + urlencode({"id": mid}), timeout=30)
    if ns.json:
        print(json.dumps(reply, indent=2))
        return 0
    links = reply.get("links") if isinstance(reply, dict) else None
    if not links:
        print("no links")
        return 0
    for link in sorted(links, key=lambda l: shown(l.get("type"))):  # stable, so newest stays first inside a type
        print(f"{shown(link.get('type'))}  {link.get('direction')}  {link.get('other_id')}  {skill.clean(link.get('other_name') or '(unnamed)')}")
    skill.note_ids([l["other_id"] for l in links if l.get("other_id")])
    return 0
