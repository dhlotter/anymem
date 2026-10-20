"""`forget.py ID`: move a memory to the trash. It can be restored for 14 days, then it is gone."""
from __future__ import annotations

from hm import api, skill

COMMAND = "forget"
HELP = "move a memory to the trash for 14 days"


def register(parser):
    parser.add_argument("id")


def run(ns):
    mid = skill.resolve(ns.id)
    api.request("POST", "/forget", {"id": mid}, timeout=30)
    print(f"{mid} is in the trash for 14 days, restore.py brings it back")
    return 0
