"""`status.py ID STATUS`: canonical, active, deprecated or pending. Deprecated memories stop ranking in recall."""
from __future__ import annotations

from hm import api, skill

COMMAND = "status"
HELP = "set a memory's status (canonical, active, deprecated, pending)"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("status", choices=("canonical", "active", "deprecated", "pending"))


def run(ns):
    mid = skill.resolve(ns.id)
    api.request("POST", "/status", {"id": mid, "status": ns.status}, timeout=30)
    print(f"{mid} is now {ns.status}")
    return 0
