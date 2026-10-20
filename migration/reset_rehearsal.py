#!/usr/bin/env python3
"""Empties the rehearsal store so a second rehearsal starts from nothing. Stdlib only.

The Worker has no route that empties its store, so this goes to the two stores directly. It lists the vector ids kept in
memory_keys, deletes those vectors from the index, then clears the data tables of the D1 database. The schema, the meta
table and the Worker are left alone.

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 migration/reset_rehearsal.py [--name anymem-rehearse]

It only accepts a name that starts with anymem-rehearse, so it cannot reach the live store or the live Worker.
It prints counts, never content or credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
PREFIX = "anymem-rehearse"
BATCH = 100
# Child tables first. Any table the schema has that is not listed here is cleared too, after these, so a table added by a later
# migration is never left full. The meta table is kept: it holds the schema version.
TABLES = ["memory_fts", "links", "memory_tags", "memory_versions", "memory_keys", "recall_log", "memories", "devices", "capsule_cache", "audit", "runs",
          "counters", "write_counter"]
KEEP = {"meta"}


def tables_to_clear(sql) -> list:
    """Every data table of the store in the order to clear them. sql(text) returns the rows of a query. A virtual table's shadow
    tables (memory_fts_data and the like) are left out: they are emptied by clearing the virtual table itself."""
    rows = [r for r in sql("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") if not r["name"].startswith(("_cf_", "d1_"))]  # D1's own tables are not ours to clear
    virtual = [r["name"] for r in rows if (r.get("sql") or "").upper().startswith("CREATE VIRTUAL TABLE")]
    shadow = {r["name"] for r in rows for v in virtual if r["name"].startswith(v + "_")}
    names = {r["name"] for r in rows} - KEEP - shadow
    ordered = [t for t in TABLES if t in names]
    return ordered + sorted(names - set(ordered))


def call(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json", "User-Agent": "anymem-migrate/1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit("%s %s answered HTTP %d" % (method, path.split("?")[0].split("/")[-1], e.code)) from None
    if not out.get("success", True):
        raise SystemExit("%s failed: %s" % (method, [e.get("message") for e in out.get("errors", [])]))
    return out.get("result")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--name", default=PREFIX)
    args = ap.parse_args(argv)
    if not args.name.startswith(PREFIX):
        raise SystemExit("Refusing: the name must start with %s." % PREFIX)
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    t0 = time.time()
    dbs = call("GET", "/accounts/%s/d1/database?name=%s-db" % (account, args.name))
    dbs = [d for d in dbs if d["name"] == args.name + "-db"]
    if len(dbs) != 1:
        raise SystemExit("Expected exactly one database named %s-db, found %d." % (args.name, len(dbs)))
    db = "/accounts/%s/d1/database/%s/query" % (account, dbs[0]["uuid"])
    index = "/accounts/%s/vectorize/v2/indexes/%s-vectors" % (account, args.name)

    def sql(text):
        return call("POST", db, {"sql": text})[0]["results"]

    ids = [r["vector_id"] for r in sql("SELECT vector_id FROM memory_keys WHERE vector_id IS NOT NULL")]
    print("vectors to delete: %d" % len(ids))
    for at in range(0, len(ids), BATCH):
        call("POST", index + "/delete_by_ids", {"ids": ids[at:at + BATCH]})
    tables = tables_to_clear(sql)
    for t in tables:
        sql("DELETE FROM " + t)
    sql("DELETE FROM meta WHERE key LIKE 'no_questions:%'")
    left = {t: sql("SELECT COUNT(*) AS n FROM " + t)[0]["n"] for t in tables}
    print("rows left: %s" % left)
    print("done in %.1fs" % (time.time() - t0))
    return 0 if not any(left.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
