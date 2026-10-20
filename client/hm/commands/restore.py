"""`restore.py ID`: bring a memory back from the trash, within 14 days of forgetting it."""
from __future__ import annotations

from hm import api, skill

COMMAND = "restore"
HELP = "bring a memory back from the trash"


def register(parser):
    parser.add_argument("id")


def run(ns):
    mid = skill.resolve(ns.id, deleted=True)
    api.request("POST", "/restore", {"id": mid}, timeout=30)
    print(f"{mid} is back")
    return 0
