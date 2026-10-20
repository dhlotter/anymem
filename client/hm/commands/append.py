"""`append.py ID "text"`: add text to the end of a memory. The earlier text stays and the history keeps the change."""
from __future__ import annotations

import sys

from hm import api, private, skill

COMMAND = "append"
HELP = "add text to the end of a memory"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("text", nargs="?", help="the text to add, or - (or nothing) to read standard input")


def run(ns):
    text = private.strip(skill.read_text(ns.text)).strip()
    if not text:
        print("anymem: there is nothing to add", file=sys.stderr)
        return 2
    secrets = skill.secret_kinds(text)
    if secrets:
        print(f"anymem: not added, the text looks like it holds a secret ({', '.join(secrets)}). Remove it and run again.", file=sys.stderr)
        return 2
    mid = skill.resolve(ns.id)
    api.request("POST", "/append", {"id": mid, "addition": text}, timeout=60)
    print(f"appended to {mid}")
    return 0
