"""`unlink.py SOURCE TARGET TYPE`: remove one link between two memories. Neither memory changes."""
from __future__ import annotations

from hm import api, skill

COMMAND = "unlink"
HELP = "remove a link between two memories"


def register(parser):
    parser.add_argument("source")
    parser.add_argument("target")
    parser.add_argument("type", metavar="TYPE")


def run(ns):
    reply = api.request("POST", "/unlink", {"source_id": skill.resolve(ns.source), "target_id": skill.resolve(ns.target), "type": ns.type}, timeout=30)
    print("removed" if reply.get("removed") else "no such link")
    return 0
