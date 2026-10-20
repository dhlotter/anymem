"""D1, Vectorize and R2. Each ensure_* looks first, creates only what is missing and refuses a name it did not make.

State is the dict kept by hm.deploy. A kind is marked pending before its create call, so a create that worked but whose
reply was lost is adopted on the rerun. A name that exists and is neither recorded nor pending belongs to someone else.
"""
from __future__ import annotations

import re
from pathlib import Path

from . import cf

DIMENSIONS = 384
METRIC = "cosine"
METADATA_INDEXES = ("project", "origin")
LIFECYCLE_RULE_ID = "expire-backups-30d"
LIFECYCLE_PREFIX = "backups/"
LIFECYCLE_SECONDS = 30 * 24 * 60 * 60
DRY_ID = "<id-from-cloudflare>"


class NameTaken(Exception):
    def __init__(self, what: str, name: str):
        super().__init__("%s %s already exists and was not made by setup" % (what, name))
        self.what, self.name = what, name


def names(prefix: str) -> dict:
    return {"worker": prefix, "d1": prefix + "-db", "vectorize": prefix + "-vectors", "r2": prefix + "-backups"}


def _mine(state: dict, kind: str, name: str) -> bool:
    return (state.get(kind) or {}).get("name") == name or kind in state.get("pending", [])


def mark_pending(state: dict, kind: str, save) -> None:
    state["pending"] = sorted(set(state.get("pending", [])) | {kind})
    save(state)


def record(state: dict, kind: str, name: str, save, **extra) -> None:
    state[kind] = {"name": name, **extra}
    state["pending"] = [p for p in state.get("pending", []) if p != kind]
    save(state)


# ------------------------------------------------------------------------ D1

def find_d1(client: cf.Client, name: str):
    rows = client.call("GET", client.acct("/d1/database?name=" + name), default=[]) or []
    return next((d for d in rows if isinstance(d, dict) and d.get("name") == name), None)


def ensure_d1(client: cf.Client, state: dict, name: str, save, say) -> str:
    found = find_d1(client, name)
    if found and not _mine(state, "d1", name):
        raise NameTaken("D1 database", name)
    if not found:
        mark_pending(state, "d1", save)
        say("  creating D1 database %s" % name)
        made = client.call("POST", client.acct("/d1/database"), {"name": name}, default={}) or {}
        if client.dry_run:
            return DRY_ID
        found = made if made.get("uuid") else find_d1(client, name)
        if not found:
            raise cf.CfError(0, [], "the D1 database was created but its id could not be read back")
    else:
        say("  D1 database %s already there" % name)
    record(state, "d1", name, save, id=found["uuid"])
    return found["uuid"]


def migrations(root: Path) -> list:
    """(version, file name, sql) from worker/db/migrations, numbered 0001, 0002 and so on."""
    out = []
    for f in sorted((root / "worker" / "db" / "migrations").glob("*.sql")):
        m = re.fullmatch(r"(\d{4})_[a-z0-9_]+\.sql", f.name)
        if m:
            out.append((int(m.group(1)), f.name, f.read_text(encoding="utf-8")))
    for i, (version, name, _) in enumerate(out, 1):
        if version != i:
            raise cf.CfError(0, [], "migration numbers must run 0001, 0002 and so on, found %s at position %d" % (name, i))
    return out


def d1_query(client: cf.Client, db_id: str, sql: str, show: str = ""):
    result = client.call("POST", client.acct("/d1/database/%s/query" % db_id), {"sql": sql}, default=[], show=show) or []
    last = result[-1] if result else {}
    return last.get("results", []) if isinstance(last, dict) else []


def apply_migrations(client: cf.Client, db_id: str, root: Path, say) -> list:
    """Same rule as worker/migrate.js. The version is written in the same request as the schema change, so a rerun does nothing."""
    d1_query(client, db_id, "CREATE TABLE IF NOT EXISTS meta (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n) WITHOUT ROWID", "(meta table)")
    rows = d1_query(client, db_id, "SELECT value FROM meta WHERE key = 'schema_version'", "(read schema version)")
    current = int(rows[0]["value"]) if rows else 0
    applied = []
    for version, name, sql in migrations(root):
        if version <= current:
            continue
        say("  applying migration %s" % name)
        d1_query(client, db_id, "%s\nINSERT INTO meta (key, value) VALUES ('schema_version', '%d') ON CONFLICT (key) DO UPDATE SET value = excluded.value;" % (sql, version), "(%s)" % name)
        applied.append(version)
    if not applied:
        say("  schema already at version %d" % current)
    return applied


# ------------------------------------------------------------------ Vectorize

def find_vectorize(client: cf.Client, name: str):
    rows = client.call("GET", client.acct("/vectorize/v2/indexes"), default=[]) or []
    return next((i for i in rows if isinstance(i, dict) and i.get("name") == name), None)


def ensure_vectorize(client: cf.Client, state: dict, name: str, save, say) -> None:
    found = find_vectorize(client, name)
    if found and not _mine(state, "vectorize", name):
        raise NameTaken("Vectorize index", name)
    if not found:
        mark_pending(state, "vectorize", save)
        say("  creating Vectorize index %s (%d dimensions, %s)" % (name, DIMENSIONS, METRIC))
        client.call("POST", client.acct("/vectorize/v2/indexes"), {"name": name, "config": {"dimensions": DIMENSIONS, "metric": METRIC}})
    else:
        cfg = found.get("config") or {}
        if cfg.get("dimensions") != DIMENSIONS or cfg.get("metric") != METRIC:
            raise cf.CfError(0, [], "the Vectorize index %s has %s dimensions and metric %s, anymem needs %d and %s" % (name, cfg.get("dimensions"), cfg.get("metric"), DIMENSIONS, METRIC))
        say("  Vectorize index %s already there" % name)
    record(state, "vectorize", name, save)


def _metadata_names(client: cf.Client, name: str) -> list:
    got = client.call("GET", client.acct("/vectorize/v2/indexes/%s/metadata_index/list" % name), default={}) or {}
    return [m.get("propertyName") for m in got.get("metadataIndexes", []) if isinstance(m, dict)]


def _when_ready(client: cf.Client, wait: float, call):
    """A just created index, or one whose old namesake was just deleted, can answer 404 or "index deleted" for a short while."""
    waited = 0.0
    while True:
        try:
            return call()
        except cf.CfError as e:
            if e.status not in (404, 400, 409) or waited >= wait:
                raise
        client.sleep(2.0)
        waited += 2.0


def _metadata_names_when_ready(client: cf.Client, name: str, wait: float) -> list:
    return _when_ready(client, wait, lambda: _metadata_names(client, name))


def ensure_metadata_indexes(client: cf.Client, state: dict, name: str, save, say, wait=180.0) -> None:
    """The indexes on project and origin, made one at a time and read back. A vector written before its index exists is not
    filterable, and two requests sent back to back lost one on 2026-10-17. This runs before any vector is written."""
    for prop in METADATA_INDEXES:
        if prop in _metadata_names_when_ready(client, name, wait):
            say("  metadata index %s already there" % prop)
            continue
        say("  creating metadata index %s" % prop)
        _when_ready(client, wait, lambda: client.call("POST", client.acct("/vectorize/v2/indexes/%s/metadata_index/create" % name), {"propertyName": prop, "indexType": "string"}))
        waited = 0.0
        while not client.dry_run and prop not in _metadata_names_when_ready(client, name, wait):
            if waited >= wait:
                raise cf.CfError(0, [], "the metadata index %s was asked for but did not show up after %d seconds" % (prop, int(wait)))
            client.sleep(1.0)
            waited += 1.0
    state["metadata_indexes"] = list(METADATA_INDEXES)
    save(state)


# ------------------------------------------------------------------------- R2

def find_bucket(client: cf.Client, name: str):
    got = client.call("GET", client.acct("/r2/buckets?name_contains=" + name), default={}) or {}
    return next((b for b in got.get("buckets", []) if isinstance(b, dict) and b.get("name") == name), None)


def wanted_rule() -> dict:
    return {"id": LIFECYCLE_RULE_ID, "enabled": True, "conditions": {"prefix": LIFECYCLE_PREFIX},
            "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": LIFECYCLE_SECONDS}}}


def _rule_ok(r: dict) -> bool:
    cond = (r.get("deleteObjectsTransition") or {}).get("condition") or {}
    return (r.get("enabled") is True and (r.get("conditions") or {}).get("prefix") == LIFECYCLE_PREFIX and cond.get("type") == "Age"
            and cond.get("maxAge") == LIFECYCLE_SECONDS and not r.get("abortMultipartUploadsTransition"))


def plan_rules(current: list):
    """The rules the bucket should hold, and whether that differs from what it holds. Other rules are kept."""
    mine = [r for r in current if r.get("id") == LIFECYCLE_RULE_ID]
    if len(mine) == 1 and _rule_ok(mine[0]):
        return current, False
    return [r for r in current if r.get("id") != LIFECYCLE_RULE_ID] + [wanted_rule()], True


def ensure_lifecycle(client: cf.Client, name: str, say) -> None:
    path = client.acct("/r2/buckets/%s/lifecycle" % name)
    got = client.call("GET", path, default={}) or {}
    rules, changed = plan_rules(got.get("rules", []))
    if changed:
        say("  setting the 30 day backup rule on %s" % name)
        client.call("PUT", path, {"rules": rules})
    else:
        say("  30 day backup rule already in place")


def ensure_r2(client: cf.Client, state: dict, name: str, save, say) -> None:
    found = find_bucket(client, name)
    if found and not _mine(state, "r2", name):
        raise NameTaken("R2 bucket", name)
    if not found:
        mark_pending(state, "r2", save)
        say("  creating R2 bucket %s" % name)
        client.call("POST", client.acct("/r2/buckets"), {"name": name})
    else:
        say("  R2 bucket %s already there" % name)
    record(state, "r2", name, save)
    ensure_lifecycle(client, name, say)
