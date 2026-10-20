"""`undo.py ID`: revert a memory's last change. Undo again to go forward. It also reopens a memory a newer one replaced."""
from __future__ import annotations

from hm import api, skill

COMMAND = "undo"
HELP = "revert the last change to a memory"


def register(parser):
    parser.add_argument("id")


def run(ns):
    mid = skill.resolve(ns.id)
    api.request("POST", "/undo", {"id": mid}, timeout=30)
    print(f"reverted the last change to {mid}")
    return 0
