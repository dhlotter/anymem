#!/usr/bin/env python3
"""The lifecycle planner and the migration runner, in Python (setup/resources.py), checked against worker/test/fixtures/parity.json.
The Worker's test/parity.test.js reads the same fixture for its own copies, so a change to one side that the other does not
make fails one of the two. `python3 client/tests/test_parity.py`, exits non-zero on failure. No network, no account."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
from setup import resources  # noqa: E402

FIXTURE = json.loads((ROOT / "worker" / "test" / "fixtures" / "parity.json").read_text(encoding="utf-8"))
RULE_ID = FIXTURE["rule"]["id"]
failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


check(
    "the backup rule has the same id, prefix and age on both sides",
    {"id": resources.LIFECYCLE_RULE_ID, "prefix": resources.LIFECYCLE_PREFIX, "max_age_seconds": resources.LIFECYCLE_SECONDS} == FIXTURE["rule"],
)

for case in FIXTURE["lifecycle"]:
    rules, changed = resources.plan_rules(case["current"])
    mine = [r for r in rules if r.get("id") == RULE_ID]
    others_kept = [r for r in rules if r.get("id") != RULE_ID] == [r for r in case["current"] if r.get("id") != RULE_ID]
    check("lifecycle: " + case["name"], changed == case["changed"] and len(mine) == 1 and mine[0] == resources.wanted_rule() and others_kept)


def fake_meta(current: int, written: list):
    """A stand-in for the D1 query: the recorded version is `current`, and every schema_version row written is kept."""

    def d1_query(client, db_id, sql, show=""):
        if "SELECT value FROM meta" in sql:
            return [{"value": str(current)}] if current else []
        found = re.search(r"VALUES \('schema_version', '(\d+)'\)", sql)
        if found:
            written.append(int(found.group(1)))
        return []

    return d1_query


real_query = resources.d1_query
try:
    for current in FIXTURE["migrations_current"]:
        written = []
        resources.d1_query = fake_meta(current, written)
        applied = resources.apply_migrations(None, "db", ROOT, lambda line: None)
        expected = [version for version, _, _ in resources.migrations(ROOT) if version > current]
        check(f"migrations after recorded version {current} apply in order", applied == expected and written == applied)
finally:
    resources.d1_query = real_query

if failures:
    print(f"{len(failures)} failed")
    sys.exit(1)
print("all passed")
