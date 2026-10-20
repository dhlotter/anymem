#!/usr/bin/env python3
"""Fills in the harness of memories that have none, where their own tags say which harness saved them. Stdlib only.

    python3 migration/harness_backfill.py            report only, changes nothing (the default)
    python3 migration/harness_backfill.py --apply    set the column, one POST /admin/harness call per memory

It reads the open memories with no harness through GET /list?harness=none, which only reads. A memory is a candidate when its
tags give evidence of exactly one known harness.

    1. A captured-by:NAME or harness:NAME tag where NAME is a known harness id or alias.
    2. A session:VALUE tag where VALUE is a known name, or starts with one followed by a dash, an underscore, a dot or a colon.

A memory whose tags point at two different harnesses is listed as conflicting and left alone. A memory with no evidence stays
blank, and the report says how many. Memories in the trash or closed by a newer fact are not listed by /list and are not touched.
The route never replaces a harness that is already set, so a second run changes nothing.

The Worker comes from TARGET_URL and TARGET_TOKEN, plus TARGET_ACCESS_CLIENT_ID and TARGET_ACCESS_CLIENT_SECRET when it sits behind
Access. Only the admin token can call the route, a device token or a browser login is refused. Nothing secret is printed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "client"))
from hm import harnesses  # noqa: E402
from migrate_v1_to_v2 import Http  # noqa: E402

PAGE = 500
SAMPLE = 5
NAMES = sorted([*harnesses.IDS, *harnesses.ALIASES], key=len, reverse=True)
SESSION_NAME = re.compile(r"^(%s)(?:[-_.:].*)?$" % "|".join(re.escape(n) for n in NAMES))


def evidence(tags: list) -> "tuple[list, list]":
    """(harness ids the tags point at, the tags that said so). A list of more than one id is a conflict."""
    found: dict = {}
    for raw in tags or []:
        tag = str(raw).strip().lower()
        key, _, value = tag.partition(":")
        if key in ("captured-by", "harness"):
            name = harnesses.resolve(value)
            if name in harnesses.IDS:
                found.setdefault(name, []).append(tag)
        elif key == "session":
            m = SESSION_NAME.match(value)
            if m:
                found.setdefault(harnesses.resolve(m.group(1)), []).append(tag)
    return sorted(found), [t for tags in found.values() for t in tags]


def blanks(http: Http) -> list:
    """Every open memory with no harness, newest first. GET only."""
    out, cursor = [], None
    while True:
        page = http.call("GET", "/list?harness=none&n=%d%s" % (PAGE, "&cursor=" + cursor if cursor else ""))
        out += page.get("entries", [])
        cursor = page.get("next_cursor")
        if not cursor:
            return out


def classify(entries: list) -> dict:
    """Sort the blank memories into those with one clear harness, those that conflict, and those with no evidence."""
    out = {"fill": [], "conflict": [], "none": []}
    for e in entries:
        ids, tags = evidence(e.get("tags"))
        row = {"id": e["id"], "name": e.get("name") or "", "origin": e.get("origin", ""), "tags": tags}
        if len(ids) == 1:
            out["fill"].append({**row, "harness": ids[0]})
        elif ids:
            out["conflict"].append({**row, "harnesses": ids})
        else:
            out["none"].append(row)
    return out


def report(sorted_: dict, total: int, say=print) -> None:
    fill, conflict, none = sorted_["fill"], sorted_["conflict"], sorted_["none"]
    say("%d open memories have no harness." % total)
    say("  %d have evidence of one harness and can be filled in." % len(fill))
    for ident in harnesses.IDS:
        mine = [r for r in fill if r["harness"] == ident]
        if mine:
            say("    %s %d" % (ident, len(mine)))
            for r in mine[:SAMPLE]:
                say("      %s  %s  (%s)" % (r["id"][:8], r["name"][:50] or "no name", ", ".join(r["tags"])))
    say("  %d point at more than one harness and are left alone." % len(conflict))
    for r in conflict[:SAMPLE]:
        say("      %s  %s  (%s)" % (r["id"][:8], r["name"][:50] or "no name", ", ".join(r["harnesses"])))
    by_origin: dict = {}
    for r in none:
        by_origin[r["origin"]] = by_origin.get(r["origin"], 0) + 1
    say("  %d have no evidence and stay blank%s." % (len(none), (" (" + ", ".join("%s %d" % kv for kv in sorted(by_origin.items())) + ")") if by_origin else ""))


def apply(http: Http, fill: list, say=print) -> dict:
    """Set the column for each memory with one clear harness. Counts what changed, what was already set, and what failed."""
    done = {"changed": 0, "already_set": 0, "failed": 0}
    for r in fill:
        try:
            reply = http.call("POST", "/admin/harness", {"id": r["id"], "harness": r["harness"]})
        except RuntimeError as e:
            done["failed"] += 1
            say("  failed %s, %s" % (r["id"][:8], e))
            continue
        done["changed" if reply.get("changed") else "already_set"] += 1
    return done


def target() -> Http:
    try:
        url, token = os.environ["TARGET_URL"], os.environ["TARGET_TOKEN"]
    except KeyError:
        raise SystemExit("Set TARGET_URL and TARGET_TOKEN, the address and the admin token of the Worker.") from None
    headers = {"Authorization": "Bearer " + token}
    if os.environ.get("TARGET_ACCESS_CLIENT_ID"):
        headers["CF-Access-Client-Id"] = os.environ["TARGET_ACCESS_CLIENT_ID"]
        headers["CF-Access-Client-Secret"] = os.environ.get("TARGET_ACCESS_CLIENT_SECRET", "")
    headers["X-Anymem-Script"] = "harness_backfill"
    return Http(url, headers)


def main(argv=None, http: "Http | None" = None, say=print) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--apply", action="store_true", help="set the harness of every memory with clear evidence. Without it nothing changes")
    ap.add_argument("--json", action="store_true", help="print the sorted list as JSON instead of the report")
    args = ap.parse_args(argv)
    http = http or target()
    entries = blanks(http)
    sorted_ = classify(entries)
    if args.json:
        say(json.dumps(sorted_, indent=2))
    else:
        report(sorted_, len(entries), say)
    if not args.apply:
        say("Dry run. Nothing was changed. Run again with --apply to set %d harnesses." % len(sorted_["fill"]) if sorted_["fill"] else "Dry run. Nothing was changed, and there is nothing to fill in.")
        return 0
    done = apply(http, sorted_["fill"], say)
    say("Applied. %d changed, %d already set, %d failed." % (done["changed"], done["already_set"], done["failed"]))
    return 1 if done["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
