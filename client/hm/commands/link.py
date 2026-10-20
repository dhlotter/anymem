"""`link.py SOURCE TARGET [TYPE]`: record how two memories relate. Links never change a memory."""
from __future__ import annotations

import sys

from hm import api, skill

COMMAND = "link"
HELP = "link two memories"

# The closed list of link types, the same as the Worker's. The last two are written by the system only, a caller is refused.
RESERVED = ("supersedes", "derived_from")
TYPES = ("about", "part_of", "owns", "affects", "decided", "contradicts", "about_person", "related")


def shown(link_type) -> str:
    """The type as it is displayed: a type outside the list (free text from an older version) shows as related."""
    return link_type if link_type in TYPES or link_type in RESERVED else "related"


def register(parser):
    parser.add_argument("source")
    parser.add_argument("target")
    parser.add_argument("type", nargs="?", metavar="TYPE", help="one of " + ", ".join(TYPES) + ", default related")
    parser.add_argument("--type", dest="type_flag", metavar="TYPE", help="the same as TYPE")


def run(ns):
    link_type = ns.type_flag or ns.type or "related"
    if link_type in RESERVED:
        print(f"anymem: {link_type} is written by the system only. Use one of: {', '.join(TYPES)}", file=sys.stderr)
        return 2
    if link_type not in TYPES:
        print(f"anymem: {link_type} is not a link type. Use one of: {', '.join(TYPES)}", file=sys.stderr)
        return 2
    reply = api.request("POST", "/link", {"source_id": skill.resolve(ns.source), "target_id": skill.resolve(ns.target), "type": link_type}, timeout=30)
    print("linked" if reply.get("created", True) else "already linked")
    return 0
