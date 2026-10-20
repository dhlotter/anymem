"""`history.py ID`: every change to a memory, newest first, one line each."""
from __future__ import annotations

import json
import time
from urllib.parse import urlencode

from hm import api, skill

COMMAND = "history"
HELP = "show the changes to a memory"


def register(parser):
    parser.add_argument("id")
    parser.add_argument("--json", action="store_true")


def run(ns):
    mid = skill.resolve(ns.id)
    reply = api.request("GET", "/history?" + urlencode({"id": mid}), timeout=30)
    if ns.json:
        print(json.dumps(reply, indent=2))
        return 0
    versions = reply.get("versions") if isinstance(reply, dict) else None
    if not versions:
        print("no changes yet, the memory is as first saved")
        return 0
    for v in versions:
        stamp = time.strftime("%Y-%m-%d %H:%M", time.gmtime((v.get("at") or 0) / 1000))
        print(f"{v.get('seq')}  {stamp} UTC  {v.get('reason')}  {skill.clean(v.get('summary', ''))}")
    print("get.py ID --version N shows the memory as it was before change N")
    return 0
