"""`link.py SOURCE TARGET`: record that two memories are related. Links never change a memory."""
from __future__ import annotations

from hm import api, skill

COMMAND = "link"
HELP = "link two memories"


def register(parser):
    parser.add_argument("source")
    parser.add_argument("target")
    parser.add_argument("--type", default="related", help="a short lowercase word, default related")


def run(ns):
    reply = api.request("POST", "/link", {"source_id": skill.resolve(ns.source), "target_id": skill.resolve(ns.target), "type": ns.type}, timeout=30)
    print("linked" if reply.get("created", True) else "already linked")
    return 0
