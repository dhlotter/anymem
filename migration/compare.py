#!/usr/bin/env python3
"""Row by row compare of two v2 stores. Stdlib only. Prints a clear PASS or FAIL, counts, and the first differences.

    python3 migration/compare.py expected.json target        the document the migration made against a v2 Worker
    python3 migration/compare.py a.json b.json               two documents or backups (format 2, gz allowed)
    ... --v1 source.json                                     also check side B against the raw v1 export, with no mapping code

The --v1 check uses the file that migrate_v1_to_v2.py export saved. It needs every v1 id on side B with the same trimmed content,
every trash id as a soft deleted row, every digest and rolled-up entry soft deleted, and every about_person edge as a link.

Each side is a file, or the word target, which pages GET /export of the Worker named by TARGET_URL, TARGET_TOKEN and, behind
Access, TARGET_ACCESS_CLIENT_ID and TARGET_ACCESS_CLIENT_SECRET. Exit 0 on a pass, 1 on any difference.

It checks the counts by status and origin, that every id is on both sides, every column of every memory, that the content is
byte for byte equal, the tags, every version and the links. Devices are not compared: their token hashes are not copied, and each
store makes its own devices (see docs/migration.md). It prints ids and field names only, never content.
"""
from __future__ import annotations

import gzip
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate_v1_to_v2 as mig  # noqa: E402

COLUMNS = mig.MEMORY_COLUMNS
SHOWN = 20


def load_side(spec: str) -> dict:
    if spec == "target":
        http = mig.target_http()
        doc = {"entries": [], "versions": [], "questions": [], "links": [], "devices": []}
        offset = 0
        while offset is not None:
            page = http.call("GET", "/export?offset=%d&limit=500" % offset)
            for k in doc:
                doc[k] += page.get(k, [])
            offset = page.get("next_offset")
        return doc
    raw = Path(spec).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def _tags(row: dict) -> list:
    return sorted(row.get("tags") or [])


def _snap(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


def compare(a: dict, b: dict) -> tuple:
    """(differences, counts). A difference is a (kind, id, field) tuple, counts are two Counters per label."""
    diffs = []
    ea, eb = {e["id"]: e for e in a["entries"]}, {e["id"]: e for e in b["entries"]}
    for i in sorted(set(ea) - set(eb)):
        diffs.append(("missing in B", i, ""))
    for i in sorted(set(eb) - set(ea)):
        diffs.append(("extra in B", i, ""))
    for i in sorted(set(ea) & set(eb)):
        x, y = ea[i], eb[i]
        if x["content"] != y["content"]:
            diffs.append(("content differs", i, "content"))
        for c in COLUMNS:
            if c != "content" and x.get(c) != y.get(c):
                diffs.append(("column differs", i, c))
        if _tags(x) != _tags(y):
            diffs.append(("tags differ", i, "tags"))
    va = {(v["memory_id"], v["seq"]): v for v in a["versions"]}
    vb = {(v["memory_id"], v["seq"]): v for v in b["versions"]}
    for k in sorted(set(va) - set(vb)):
        diffs.append(("version missing in B", k[0], "seq %d" % k[1]))
    for k in sorted(set(vb) - set(va)):
        diffs.append(("version extra in B", k[0], "seq %d" % k[1]))
    for k in sorted(set(va) & set(vb)):
        x, y = va[k], vb[k]
        for f in ("reason", "created_at"):
            if x[f] != y[f]:
                diffs.append(("version differs", k[0], "seq %d %s" % (k[1], f)))
        if _snap(x["snapshot"]) != _snap(y["snapshot"]):
            diffs.append(("version differs", k[0], "seq %d snapshot" % k[1]))
    la = {(l["source_id"], l["target_id"], l["link_type"]): l for l in a["links"]}
    lb = {(l["source_id"], l["target_id"], l["link_type"]): l for l in b["links"]}
    for k in sorted(set(la) - set(lb)):
        diffs.append(("link missing in B", k[0], "to " + k[1]))
    for k in sorted(set(lb) - set(la)):
        diffs.append(("link extra in B", k[0], "to " + k[1]))
    counts = {}
    for label, doc in (("A", a), ("B", b)):
        es = doc["entries"]
        counts[label] = {
            "memories": len(es), "live": sum(1 for e in es if e.get("deleted_at") is None), "trash": sum(1 for e in es if e.get("deleted_at") is not None),
            "pinned": sum(1 for e in es if e.get("pinned")), "versions": len(doc["versions"]), "links": len(doc["links"]), "devices": len(doc["devices"]),
            "status": dict(Counter(e.get("status") for e in es)), "origin": dict(Counter(e.get("origin") for e in es)),
        }
    return diffs, counts


def check_v1(src: dict, b: dict) -> list:
    """Differences between the raw v1 data and a v2 side, using none of the mapping code."""
    diffs = []
    rows = {e["id"]: e for e in b["entries"]}
    for e in src["export"]["entries"]:
        row = rows.get(e["id"])
        if row is None:
            diffs.append(("v1 entry missing in B", e["id"], ""))
            continue
        if row["content"] != e["content"].strip():
            diffs.append(("v1 content differs", e["id"], "content"))
        if (row["deleted_at"] is not None) != any(t in ("synthesized", "rolled-up") for t in e["tags"]):
            diffs.append(("v1 trash state differs", e["id"], "deleted_at"))
        if row["created_at"] != e["created_at"] or row["recall_count"] != e["recall_count"]:
            diffs.append(("v1 column differs", e["id"], "created_at or recall_count"))
        if row["valid_until"] != e["valid_until"]:
            diffs.append(("v1 column differs", e["id"], "valid_until"))
    for t in src["trash"]:
        row = rows.get(t["id"])
        if row is None or row["deleted_at"] != t["deleted_at"]:
            diffs.append(("v1 trash item missing or not soft deleted in B", t["id"], ""))
    links = {(l["source_id"], l["target_id"], l["link_type"]) for l in b["links"]}
    for x in src["export"]["edges"]:
        if x["type"] == "about_person" and (x["source_id"], x["target_id"], "about_person") not in links:
            diffs.append(("v1 about_person edge missing in B", x["source_id"], "to " + x["target_id"]))
    return diffs


def main(argv=None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    v1 = None
    if "--v1" in args:
        at = args.index("--v1")
        v1 = args[at + 1] if at + 1 < len(args) else ""
        del args[at:at + 2]
    if len(args) != 2 or args[0] in ("-h", "--help") or v1 == "":
        print(__doc__)
        return 0 if args and args[0] in ("-h", "--help") else 2
    a, b = load_side(args[0]), load_side(args[1])
    diffs, counts = compare(a, b)
    if v1:
        diffs += check_v1(json.loads(Path(v1).read_text()), b)
    for key in ("memories", "live", "trash", "pinned", "versions", "links", "status", "origin"):
        same = "same" if counts["A"][key] == counts["B"][key] else "DIFFERENT"
        print("%-9s A=%s B=%s %s" % (key, counts["A"][key], counts["B"][key], same))
    kinds = Counter(d[0] for d in diffs)
    print("devices (not compared) A=%s B=%s" % (counts["A"]["devices"], counts["B"]["devices"]))
    print("differences: %d %s" % (len(diffs), dict(kinds) if diffs else ""))
    for kind, i, field in diffs[:SHOWN]:
        print("  %s  %s  %s" % (kind, i, field))
    if len(diffs) > SHOWN:
        print("  ... and %d more" % (len(diffs) - SHOWN))
    print("PASS" if not diffs else "FAIL")
    return 0 if not diffs else 1


if __name__ == "__main__":
    sys.exit(main())
