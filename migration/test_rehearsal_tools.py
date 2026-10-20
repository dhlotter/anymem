#!/usr/bin/env python3
"""Runnable check for migration/reset_rehearsal.py (the table list) and migration/rehearse.py (the environment the client scripts get).
Uses a real SQLite database with an FTS5 table, so the shadow tables are the ones SQLite makes. No network, no Cloudflare."""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reset_rehearsal as reset  # noqa: E402
import rehearse  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


# ------------------------------------------------------------------ the reset clears every data table, not a fixed list
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
CREATE TABLE memory_tags (memory_id TEXT REFERENCES memories (id) ON DELETE CASCADE, tag TEXT);
CREATE TABLE recall_log (memory_id TEXT, at INTEGER);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE write_counter (slot INTEGER);
CREATE TABLE future_table (x TEXT);
CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE memory_fts USING fts5 (id, content);
""")


def sql(text):
    cur = db.execute(text)
    cols = [c[0] for c in cur.description] if cur.description else []
    return [dict(zip(cols, row)) for row in cur.fetchall()]


order = reset.tables_to_clear(sql)
check("the table list has every data table, including the ones the old list missed", {"recall_log", "counters", "write_counter", "future_table", "memories", "memory_fts"} <= set(order))
check("the FTS shadow tables are left out, the virtual table clears them", not any(t.startswith("memory_fts_") for t in order) and "memory_fts" in order)
check("D1 internal tables are never cleared", not {"_cf_KV", "d1_migrations"} & set(order))
check("the schema version table is kept", "meta" not in order)
check("the known children come before their parents", order.index("memory_tags") < order.index("memories") and order.index("recall_log") < order.index("memories"))

# the same deletes the script makes, run for real, leave every data table empty and the meta table alone
db.executescript("""
INSERT INTO memories VALUES ('m1', 'x'); INSERT INTO memory_tags VALUES ('m1', 't'); INSERT INTO recall_log VALUES ('m1', 1);
INSERT INTO counters VALUES ('c', 3); INSERT INTO write_counter VALUES (1); INSERT INTO future_table VALUES ('y');
INSERT INTO memory_fts (id, content) VALUES ('m1', 'x'); INSERT INTO meta VALUES ('schema_version', '3');
""")
for t in order:
    db.execute("DELETE FROM " + t)
left = {t: db.execute("SELECT COUNT(*) FROM " + t).fetchone()[0] for t in order}
check("after the reset every listed table is empty", not any(left.values()))
check("the schema version survives the reset", db.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0] == "3")

# ------------------------------------------------------------------ the rehearsal's environment for the client scripts
work = Path(tempfile.mkdtemp())
env = rehearse.stage_env({"TARGET_URL": "https://anymem-rehearse.example.test", "TARGET_TOKEN": "tok",
                          "TARGET_ACCESS_CLIENT_ID": "target-id.access", "TARGET_ACCESS_CLIENT_SECRET": "target-secret",
                          "ANYMEM_ACCESS_CLIENT_ID": "stale-live-id", "ANYMEM_ACCESS_CLIENT_SECRET": "stale-live-secret"}, work)
check("the target's Access pair reaches the client scripts", env["ANYMEM_ACCESS_CLIENT_ID"] == "target-id.access" and env["ANYMEM_ACCESS_CLIENT_SECRET"] == "target-secret")
check("the target URL and token are the client's", env["ANYMEM_URL"] == "https://anymem-rehearse.example.test" and env["ANYMEM_TOKEN"] == "tok")
check("the client config is in the rehearsal folder", env["ANYMEM_CONFIG_DIR"] == str(work / "config") and env["ANYMEM_CACHE_DIR"] == str(work / "cache"))
env = rehearse.stage_env({"TARGET_URL": "https://anymem-rehearse.example.test", "TARGET_TOKEN": "tok", "ANYMEM_ACCESS_CLIENT_ID": "stale-live-id"}, work)
check("without a target Access pair no live one is passed on", "ANYMEM_ACCESS_CLIENT_ID" not in env and "ANYMEM_ACCESS_CLIENT_SECRET" not in env)

print("%d failed" % len(failures) if failures else "all passed")
sys.exit(1 if failures else 0)
