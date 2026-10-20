#!/usr/bin/env python3
"""Moves the live v1 store to anymem v2. Stdlib only. Four commands.

    export    read the live v1 Worker with GET only and save what it exposes to one file
    convert   map that file to a v2 import document (export format 2)
    load      send a v2 document to a v2 Worker in pages, then reindex until the vectors are done

The mapping is the pure function map_entry, with the helpers above it. It follows plan section 11.2.
The v1 read surface exposes less than the v2 format holds, and the script says so instead of guessing.

    1. Trash items arrive as a 160 character preview. They become soft deleted rows holding that preview, tagged migrated-preview-only.
    2. A v1 history change carries only a 160 character preview of the earlier content. A change that left the content alone
       (status, tags, validity) can be rebuilt as a full version. A change that rewrote the content cannot, and is counted.
    3. Device token hashes are not exposed, so no device is copied. Create devices on the new Worker.

Credentials come from the environment and are never printed. Reading the source needs ANYMEM_TOKEN, ANYMEM_ACCESS_CLIENT_ID and
ANYMEM_ACCESS_CLIENT_SECRET. ANYMEM_URL is the v1 Worker address. Loading needs TARGET_URL and TARGET_TOKEN, plus
TARGET_ACCESS_CLIENT_ID and TARGET_ACCESS_CLIENT_SECRET when the target sits behind Access. load refuses the address in
ANYMEM_LIVE_HOST, so set that to the v1 host name before loading.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

LIVE_HOST = os.environ.get("ANYMEM_LIVE_HOST", "")  # the v1 host load must refuse, set it in the environment
USER_AGENT = "anymem-migrate/1"
MAX_CONTENT_CHARS = 30_000
MAX_TAGS = 50
MAX_TAG_CHARS = 64
PAGE = 50
PREVIEW_ONLY_TAG = "migrated-preview-only"

SOURCE_TO_ORIGIN = {
    "session-capture": "capture",
    "claude": "explicit",
    "vault-memory-import": "import",
    "zcode-native-memory": "import",
    "profile": "profile",
    "person": "person",
    "system": "system",
}
PINNED_ORIGINS = ("profile", "person")
TRASHED_TAGS = ("synthesized", "rolled-up")
STATUSES = ("canonical", "active", "deprecated", "pending")
KINDS = ("semantic", "episodic")
TYPES = ("user", "feedback", "project", "reference")
KEPT_LINK_TYPES = ("about_person",)
PROJECT_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
LABEL = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
FRONTMATTER = re.compile(r"^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)")
HASHTAG = re.compile(r"(?<![^\s(\[,])#([A-Za-z](?:[\w-]*[A-Za-z0-9])?)", re.ASCII)
RESERVED = re.compile(r"^(status|kind|project|captured-by|session):(.*)$")

MEMORY_COLUMNS = [
    "id", "name", "description", "type", "body", "content", "content_hash", "status", "origin", "harness", "session", "project", "kind",
    "pinned", "probation_until", "valid_from", "valid_until", "superseded_by", "recall_count", "last_recalled_at", "created_at", "updated_at", "deleted_at",
]


# ---------------------------------------------------------------- the pure mapping

def utf16_len(text: str) -> int:
    """Length the way the Worker counts it (JavaScript string length)."""
    return len(text.encode("utf-16-le")) // 2


def content_hash(content: str) -> str:
    """SHA-256 of the content with every run of whitespace collapsed, as the Worker computes it."""
    return hashlib.sha256(" ".join(content.split()).encode("utf-8")).hexdigest()


def _unquote(v: str) -> str:
    v = v.strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v


def parse_frontmatter(text: str) -> dict:
    """name, description, type and body from a leading frontmatter block. No closed block means no frontmatter."""
    m = FRONTMATTER.match(text) if text.startswith("---") else None
    if not m:
        return {"name": None, "description": "", "type": None, "body": text}
    name, description, type_, in_meta = None, "", None, False
    for line in (m.group(1) or "").splitlines():
        top = re.match(r"^([A-Za-z_][\w-]*):[ \t]*(.*)$", line)
        if top:
            in_meta = top.group(1) == "metadata"
            if top.group(1) == "name":
                name = _unquote(top.group(2)) or None
            elif top.group(1) == "description":
                description = _unquote(top.group(2))
            continue
        nested = re.match(r"^[ \t]+type:[ \t]*(.*)$", line) if in_meta else None
        if nested:
            t = _unquote(nested.group(1)).lower()
            type_ = t if t in TYPES else None
    return {"name": name, "description": description, "type": type_, "body": text[m.end():].strip()}


def lift_hashtags(text: str) -> list:
    prose = re.sub(r"```[\s\S]*?```", " ", text)
    return [m.group(1).lower() for m in HASHTAG.finditer(prose)]


def tag_list(raw) -> list:
    """The tags of a v1 entry, a list or an older JSON string. Lowercase, no leading hash, spaces to hyphens, long ones dropped."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = raw.split(",")
    if not isinstance(raw, list):
        return []
    out = []
    for t in raw:
        if not isinstance(t, str):
            continue
        tag = re.sub(r"\s+", "-", t.strip().lstrip("#").lower())
        if tag and len(tag) <= MAX_TAG_CHARS and tag not in out:
            out.append(tag)
    return out


def split_tags(tags: list) -> tuple:
    """Moves the first valid status, kind, project, captured-by and session tag into columns. Anything else stays a plain tag."""
    col = {"status": None, "kind": None, "project": None, "captured-by": "", "session": ""}
    plain = []
    for tag in tags:
        m = RESERVED.match(tag)
        if not m:
            plain.append(tag)
            continue
        key, value = m.groups()
        if key == "status" and value == "draft":
            continue  # draft is gone in v2, the row is active
        ok = (
            (key == "status" and value in STATUSES)
            or (key == "kind" and value in KINDS)
            or (key == "project" and PROJECT_SLUG.match(value))
            or (key in ("captured-by", "session") and LABEL.match(value))
        )
        if ok and not col[key]:
            col[key] = value
        else:
            plain.append(tag)
    return col, plain


def is_pinned(plain: list) -> bool:
    return any(t == "capsule:core" or t.startswith("capsule-slot:") for t in plain)


def _time(v, fallback):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else fallback


def _row(entry_id: str, text: str, tags: list, origin: str, created: int, updated: int, imported_at: int, **over) -> dict:
    content = text.strip()
    fm = parse_frontmatter(content)
    col, plain = split_tags(tags)
    plain = list(dict.fromkeys([*plain, *lift_hashtags(fm["body"])]))
    row = {
        "id": entry_id, "name": fm["name"] or "", "description": fm["description"], "type": fm["type"], "body": fm["body"],
        "content": content, "content_hash": content_hash(content),
        "status": col["status"] or "active", "origin": origin, "harness": col["captured-by"], "session": col["session"],
        "project": col["project"] or "", "kind": col["kind"],
        "pinned": 1 if is_pinned(plain) or origin in PINNED_ORIGINS else 0,
        "probation_until": None, "valid_from": created, "valid_until": None, "superseded_by": None,
        "recall_count": 0, "last_recalled_at": None, "created_at": created, "updated_at": updated, "deleted_at": None,
        "tags": plain,
    }
    row.update(over)
    return row


def map_entry(entry: dict, imported_at: int) -> dict:
    """One live v1 entry to one v2 entry (a memories row plus its tags). Raises ValueError for an entry that cannot be stored."""
    eid = entry.get("id")
    if not isinstance(eid, str) or not eid.strip() or len(eid.encode("utf-8")) > 50:
        raise ValueError("an entry needs an id of at most 50 bytes, so its search ids fit the 64 byte limit of Vectorize")
    text = entry.get("content")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("content is empty")
    if utf16_len(text.strip()) > MAX_CONTENT_CHARS:
        raise ValueError("content is over %d characters" % MAX_CONTENT_CHARS)
    tags = tag_list(entry.get("tags"))
    created = _time(entry.get("created_at"), imported_at)
    row = _row(
        eid.strip(), text, tags, SOURCE_TO_ORIGIN.get(entry.get("source"), "explicit"), created, _time(entry.get("updated_at"), created), imported_at,
        valid_from=_time(entry.get("valid_from"), created), valid_until=_time(entry.get("valid_until"), None),
        recall_count=_time(entry.get("recall_count"), 0),
        deleted_at=imported_at if any(t in TRASHED_TAGS for t in tags) else None,
    )
    if len(row["tags"]) > MAX_TAGS:
        raise ValueError("more than %d tags" % MAX_TAGS)
    return row


def map_trash(item: dict, imported_at: int) -> dict:
    """One v1 trash item. Only a preview is readable, so the row holds the preview and says so in a tag."""
    eid, preview = item.get("id"), item.get("preview")
    if not isinstance(eid, str) or not eid.strip() or len(eid.encode("utf-8")) > 50:
        raise ValueError("a trash item needs an id of at most 50 bytes, so its search ids fit the 64 byte limit of Vectorize")
    if not isinstance(preview, str) or not preview.strip():
        raise ValueError("a trash item has no preview")
    deleted = _time(item.get("deleted_at"), imported_at)
    return _row(
        eid.strip(), preview, [PREVIEW_ONLY_TAG], SOURCE_TO_ORIGIN.get(item.get("source"), "explicit"), deleted, deleted, imported_at, deleted_at=deleted,
    )


def snapshot_of(row: dict) -> dict:
    """What the Worker stores in a version, the whole row with sorted tags."""
    snap = {c: row[c] for c in MEMORY_COLUMNS}
    snap["tags"] = sorted(row["tags"])
    return snap


def rebuild_versions(row: dict, changes: list) -> tuple:
    """Full versions from a v1 history. Returns (versions, skipped).

    changes are v1 history items of kind change, each with seq, at, reason, before_preview and before_status. v2 numbers versions
    1..n in time order, and a version is the row as it stood before that change. Only a status change can be rebuilt exactly, since
    it touched the status and nothing else, so an older state is the current row with the earlier status. Any other reason
    (update, append, tags, validity) changed something v1 only shows as a 160 character preview, so that change and every older
    one are counted in skipped and not stored. A version with guessed content would be worse than none."""
    state, built, skipped = dict(row), [], 0
    ordered = sorted(changes, key=lambda c: (c.get("at", 0), c.get("seq", 0)), reverse=True)
    for n, ch in enumerate(ordered):
        if ch.get("reason") != "status":
            skipped = len(ordered) - n
            break
        older = ordered[n + 1]["at"] if n + 1 < len(ordered) else row["created_at"]
        state = dict(state, status=ch.get("before_status") or "active", updated_at=older)
        built.append({"snapshot": json.dumps(snapshot_of(state), separators=(",", ":")), "reason": "status", "created_at": ch["at"]})
    return [{"seq": seq, **v} for seq, v in enumerate(reversed(built), 1)], skipped


def build_document(export: dict, trash: list, histories: dict, imported_at: int) -> tuple:
    """The whole v2 document and a report of what was mapped, dropped and skipped. Pure."""
    entries, errors = [], []
    seen = set()
    for e in export.get("entries", []):
        try:
            row = map_entry(e, imported_at)
        except ValueError as err:
            errors.append({"id": str(e.get("id"))[:64], "error": str(err)})
            continue
        if row["id"] in seen:
            errors.append({"id": row["id"], "error": "duplicate id"})
            continue
        seen.add(row["id"])
        entries.append(row)
    live_count = len(entries)
    for t in trash:
        try:
            row = map_trash(t, imported_at)
        except ValueError as err:
            errors.append({"id": str(t.get("id"))[:64], "error": str(err)})
            continue
        if row["id"] in seen:
            errors.append({"id": row["id"], "error": "trash id is also a live id"})
            continue
        seen.add(row["id"])
        entries.append(row)
    by_id = {r["id"]: r for r in entries}

    for edge in export.get("edges", []):
        if edge.get("type") == "supersedes" and edge.get("target_id") in by_id and edge.get("source_id") in by_id:
            target = by_id[edge["target_id"]]
            if target["valid_until"] is not None and target["superseded_by"] is None:
                target["superseded_by"] = edge["source_id"]

    links, dropped_links = [], 0
    for edge in export.get("edges", []):
        if edge.get("type") in KEPT_LINK_TYPES and edge.get("source_id") in by_id and edge.get("target_id") in by_id:
            links.append({"source_id": edge["source_id"], "target_id": edge["target_id"], "link_type": edge["type"], "created_at": _time(edge.get("created_at"), imported_at)})
        else:
            dropped_links += 1

    versions, versions_skipped, versions_kept = [], 0, 0
    for eid, hist in (histories or {}).items():
        if eid not in by_id:
            continue
        changes = [i for i in (hist or {}).get("items", []) if i.get("kind") == "change"]
        if not changes:
            continue
        vs, skipped = rebuild_versions(by_id[eid], changes)
        versions_skipped += skipped
        versions_kept += len(vs)
        versions.extend({"memory_id": eid, **v} for v in vs)

    document = {"format": 2, "entries": entries, "versions": versions, "questions": [], "links": links, "devices": []}
    report = {
        "entries_in": len(export.get("entries", [])), "trash_in": len(trash), "entries_out": len(entries), "live_out": live_count,
        "trashed_out": sum(1 for r in entries if r["deleted_at"] is not None), "trash_preview_only": sum(1 for r in entries if PREVIEW_ONLY_TAG in r["tags"]),
        "rolled_up_trashed": sum(1 for r in entries[:live_count] if r["deleted_at"] is not None),
        "links_out": len(links), "edges_dropped": dropped_links, "versions_out": versions_kept, "versions_not_rebuilt": versions_skipped,
        "pinned": sum(r["pinned"] for r in entries), "errors": errors,
    }
    return document, report


# ---------------------------------------------------------------- reading the live store and loading the target

class Http:
    def __init__(self, base: str, headers: dict, say=print):
        self.base, self.headers, self.say = base.rstrip("/"), headers, say

    def call(self, method: str, path: str, body=None, tries: int = 4):
        data = None if body is None else json.dumps(body).encode()
        hdrs = {**self.headers, "User-Agent": USER_AGENT, **({"Content-Type": "application/json"} if data else {})}
        for n in range(tries):
            try:
                req = urllib.request.Request(self.base + path, data=data, headers=hdrs, method=method)
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return json.loads(resp.read() or b"{}")
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and n < tries - 1:
                    time.sleep(2 * (n + 1))
                    continue
                raise RuntimeError("%s %s answered HTTP %d" % (method, path.split("?")[0], e.code)) from None
            except (urllib.error.URLError, OSError) as e:
                if n < tries - 1:
                    time.sleep(2 * (n + 1))
                    continue
                raise RuntimeError("%s %s failed (%s)" % (method, path.split("?")[0], getattr(e, "reason", e))) from None


def source_http() -> Http:
    h = {"Authorization": "Bearer " + os.environ["ANYMEM_TOKEN"]}
    if os.environ.get("ANYMEM_ACCESS_CLIENT_ID"):
        h["CF-Access-Client-Id"] = os.environ["ANYMEM_ACCESS_CLIENT_ID"]
        h["CF-Access-Client-Secret"] = os.environ["ANYMEM_ACCESS_CLIENT_SECRET"]
    if not os.environ.get("ANYMEM_URL"):
        raise SystemExit("Set ANYMEM_URL to the v1 Worker address.")
    return Http(os.environ["ANYMEM_URL"], h)


def write_private(path, text: str) -> None:
    """Create or truncate a file that only this user can read. The mode is set at creation, so no other user can open it first."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)


def target_http() -> Http:
    url = os.environ["TARGET_URL"]
    if LIVE_HOST and urlparse(url).hostname == LIVE_HOST:
        raise SystemExit("Refusing to load into the live address.")
    h = {"Authorization": "Bearer " + os.environ["TARGET_TOKEN"]}
    if os.environ.get("TARGET_ACCESS_CLIENT_ID"):
        h["CF-Access-Client-Id"] = os.environ["TARGET_ACCESS_CLIENT_ID"]
        h["CF-Access-Client-Secret"] = os.environ["TARGET_ACCESS_CLIENT_SECRET"]
    return Http(url, h)


def unchanged(old: dict, new: dict) -> bool:
    """True when an entry reads the same as in an earlier export, ignoring the recall count. A status change shows in the tags and
    every other change shows in the content or the updated time, so a history fetched earlier for this entry is still right."""
    skip = ("recall_count",)
    return {k: v for k, v in old.items() if k not in skip} == {k: v for k, v in new.items() if k not in skip}


def fetch_source(http: Http, say=print, previous: "dict | None" = None) -> dict:
    """Everything the v1 read surface exposes. GET only, count=0 so reads do not bump recall counts.
    With a previous export, the history of an unchanged entry is reused, which turns about 13 minutes into seconds."""
    t0 = time.time()
    export = http.call("GET", "/export?count=0")
    say("export: %d entries, %d edges, %d projects (%.1fs)" % (len(export["entries"]), len(export.get("edges", [])), len(export.get("projects", [])), time.time() - t0))
    trash, cursor = [], None
    while True:
        page = http.call("GET", "/trash?count=0" + ("&cursor=" + cursor if cursor else ""))
        trash += page.get("items", [])
        cursor = page.get("next_cursor")
        if not cursor or not page.get("items"):
            break
    say("trash: %d items (%.1fs)" % (len(trash), time.time() - t0))
    histories, reused = {}, 0
    old = {e["id"]: e for e in (previous or {}).get("export", {}).get("entries", [])}
    for i, e in enumerate(export["entries"], 1):
        if e["id"] in old and e["id"] in previous["histories"] and unchanged(old[e["id"]], e):
            histories[e["id"]] = previous["histories"][e["id"]]
            reused += 1
        else:
            histories[e["id"]] = http.call("GET", "/entry?count=0&id=" + e["id"])["entry"].get("history") or {}
        if i % 200 == 0:
            say("history: %d of %d entries, %d reused (%.1fs)" % (i, len(export["entries"]), reused, time.time() - t0))
    devices = http.call("GET", "/devices").get("devices", [])
    say("devices: %d, none with a token hash exposed (%.1fs)" % (len(devices), time.time() - t0))
    return {"fetched_at": int(time.time() * 1000), "export": export, "trash": trash, "histories": histories, "devices": devices}


def load_document(http: Http, doc: dict, say=print, page: int = PAGE) -> dict:
    """Paged POST /import with each page's versions and questions, links and devices with the last page, then POST /admin/reindex until nothing is left. Returns timings and counts."""
    t0 = time.time()
    entries = doc["entries"]
    versions_of, questions_of = {}, {}
    totals = {"imported": 0, "skipped": 0, "versions": 0, "questions": 0, "links": 0, "devices": 0, "errors": []}
    for v in doc["versions"]:
        versions_of.setdefault(v["memory_id"], []).append(v)
    for q in doc.get("questions", []):
        questions_of.setdefault(q["memory_id"], []).append(q)
    for at in range(0, max(len(entries), 1), page):
        part = entries[at:at + page]
        last = at + page >= len(entries)
        body = {"format": 2, "entries": part, "versions": [v for e in part for v in versions_of.get(e["id"], [])],
                "questions": [q for e in part for q in questions_of.get(e["id"], [])],
                "links": doc["links"] if last else [], "devices": doc["devices"] if last else [], "offset": 0, "limit": max(len(part), 1)}
        r = http.call("POST", "/import", body)
        for k in ("imported", "skipped", "versions", "questions", "links", "devices"):
            totals[k] += r.get(k, 0)
        totals["errors"] += r.get("errors", [])
    import_secs = round(time.time() - t0, 1)
    say("import: %d imported, %d skipped, %d versions, %d questions, %d links, %d errors (%.1fs)" % (totals["imported"], totals["skipped"], totals["versions"], totals["questions"], totals["links"], len(totals["errors"]), import_secs))
    rounds, reindex_secs = reindex_all(http, say)
    say("reindex: %d rounds (%.1fs)" % (rounds, reindex_secs))
    return {"import_seconds": import_secs, "reindex_seconds": reindex_secs, "reindex_rounds": rounds, **{k: v for k, v in totals.items() if k != "errors"}, "error_ids": [e.get("id") for e in totals["errors"]]}


def reindex_all(http: Http, say=print) -> tuple:
    """POST /admin/reindex until nothing is left. Returns (rounds, seconds)."""
    t, rounds, remaining = time.time(), 0, None
    while remaining != 0:
        remaining = http.call("POST", "/admin/reindex", {"limit": 100}).get("remaining", 0)
        rounds += 1
        if rounds > 400:
            raise RuntimeError("reindex did not finish in 400 rounds")
    return rounds, round(time.time() - t, 1)


def write_questions(http: Http, say=print) -> dict:
    """POST /admin/questions until every memory has its search questions, then reindex so they are searchable.
    A round in which every model call failed ends the loop: those memories are not marked, so the next run tries them again."""
    t, rounds, questions, failed = time.time(), 0, 0, 0
    while True:
        r = http.call("POST", "/admin/questions", {"limit": 50})
        rounds += 1
        questions += r["questions"]
        failed += r.get("failed", 0)
        if r["memories"] == 0:
            break
        if r.get("failed", 0) >= r["memories"]:
            say("questions: %d memories failed in this round and stay unmarked, run the questions step again later" % r["memories"])
            break
        if rounds > 100:
            raise RuntimeError("questions did not finish in 100 rounds")
    q_secs = round(time.time() - t, 1)
    say("questions: %d written, %d failed, in %d rounds (%.1fs)" % (questions, failed, rounds, q_secs))
    reindex_rounds, reindex_secs = reindex_all(http, say)
    say("reindex: %d rounds (%.1fs)" % (reindex_rounds, reindex_secs))
    return {"questions": questions, "questions_failed": failed, "question_rounds": rounds, "question_seconds": q_secs, "reindex_rounds": reindex_rounds, "reindex_seconds": reindex_secs}


# ---------------------------------------------------------------- command line

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("export", help="read the live v1 store, GET only")
    p.add_argument("--out", required=True)
    p.add_argument("--since", help="an earlier export file, whose history is reused for entries that have not changed")
    p = sub.add_parser("convert", help="map a v1 export file to a v2 document")
    p.add_argument("source")
    p.add_argument("--out", required=True)
    p.add_argument("--at", type=int, default=None, help="the import time in ms, default now. Fix it to make two runs identical")
    p = sub.add_parser("load", help="send a v2 document to a v2 Worker and reindex")
    p.add_argument("document")
    p.add_argument("--page", type=int, default=PAGE)
    sub.add_parser("questions", help="write search questions for every memory on a v2 Worker, then reindex")
    args = ap.parse_args(argv)
    if args.cmd == "questions":
        print(json.dumps(write_questions(target_http()), indent=2))
        return 0
    if args.cmd == "export":
        previous = None
        if args.since:
            with open(args.since) as f:
                previous = json.load(f)
        data = fetch_source(source_http(), previous=previous)
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        print("saved", args.out)
        return 0
    if args.cmd == "convert":
        with open(args.source) as f:
            src = json.load(f)
        doc, report = build_document(src["export"], src["trash"], src["histories"], args.at if args.at is not None else int(time.time() * 1000))
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f)
        print(json.dumps(report, indent=2))
        return 1 if report["errors"] else 0
    with open(args.document) as f:
        doc = json.load(f)
    result = load_document(target_http(), doc, page=args.page)
    print(json.dumps(result, indent=2))
    return 1 if result["error_ids"] else 0


if __name__ == "__main__":
    sys.exit(main())
