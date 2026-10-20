"""`backup.py`: keep a copy of the whole store on this machine, outside Cloudflare.

The Worker already backs itself up every night to its R2 bucket. By default this takes a fresh export, paged so a large store
still fits. --from-worker downloads the Worker's latest R2 backup instead (admin token), and --now has the Worker take today's
first. The file is anymem-YYYY-MM-DD.json.gz in the backups folder of the config folder, mode 0600, and restores through
POST /import. A restore needs a reindex afterwards, vectors are not part of a backup.

--markdown DIR also writes one file per live memory, named by its frontmatter name, for reading. Files are added or rewritten,
never deleted. A copy more than 20 percent smaller than the last one is refused, exit code 2, since a half empty export means
something is wrong. Older copies than --keep days are removed."""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from hm import api, config

COMMAND = "backup"
HELP = "save a local copy of the whole store (a fresh export, or the Worker's latest nightly backup)"
PAGE = 1000


class BackupError(Exception):
    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def register(parser):
    parser.add_argument("--dir", help="backup folder, default the backups folder inside the config folder")
    parser.add_argument("--keep", type=int, default=30, help="days of copies to keep, default 30")
    parser.add_argument("--markdown", help="also write one markdown file per memory into this folder")
    parser.add_argument("--from-worker", action="store_true", help="download the Worker's latest R2 backup instead of a fresh export")
    parser.add_argument("--now", action="store_true", help="with --from-worker, have the Worker take today's backup first")
    parser.add_argument("--quiet", action="store_true")


def export_all(settings) -> dict:
    """GET /export in pages of PAGE memories, joined into one document of the same shape. Each page starts after the cursor
    the page before gave, so a purge between two pages cannot shift one. Links and devices come with the last page."""
    doc, cursor = None, "start"
    while True:
        page = api.request("GET", "/export?" + urlencode({"cursor": cursor, "limit": PAGE}), timeout=120, settings=settings)
        check(page)
        if doc is None:
            doc = {**page, "entries": [], "versions": [], "questions": []}
        for key in ("entries", "versions", "questions"):
            doc[key].extend(page.get(key) or [])
        for key in ("links", "devices"):
            if key in page:
                doc[key] = page[key]
        cursor = page.get("next_cursor")
        if cursor is None:
            break
    doc["next_offset"] = None
    doc["next_cursor"] = None
    return doc


def from_worker(settings, now: bool):
    """The Worker's latest R2 backup, decoded and checked. Returns (document, day)."""
    if now:
        api.request("POST", "/backup/run", {}, timeout=120, settings=settings)
    latest = api.request("GET", "/backup", timeout=30, settings=settings).get("latest")
    if not isinstance(latest, dict) or not latest.get("day"):
        raise BackupError("the Worker has no backup yet. It runs at 01:00 UTC, or use --now.")
    raw = api.request_bytes("GET", "/backup/" + latest["day"], timeout=120, settings=settings)
    try:
        return check(json.loads(gzip.decompress(raw).decode("utf-8"))), latest["day"]
    except (OSError, ValueError) as e:
        raise BackupError(f"the Worker's backup file is not a valid gzip export: {e}")


def check(data):
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise BackupError("the export did not return an entries list")
    bad = [e.get("id") for e in data["entries"] if not isinstance(e, dict) or not e.get("id") or not isinstance(e.get("content"), str)]
    if bad:
        raise BackupError(f"the export has {len(bad)} entries without an id or content, refusing to back up")
    return data


def write_backup(data: dict, outdir: Path, keep: int, day: "str | None" = None):
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / f"anymem-{day or date.today().isoformat()}.json.gz"
    previous = [p for p in sorted(outdir.glob("anymem-*.json.gz")) if p != path]
    if previous:
        try:
            with gzip.open(previous[-1], "rt", encoding="utf-8") as f:
                before = len(json.load(f).get("entries", []))
            if before and len(data["entries"]) < before * 0.8:
                raise BackupError(f"the export has {len(data['entries'])} entries, the last backup had {before}, refusing to replace it", 2)
        except (OSError, ValueError):
            pass
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with gzip.open(os.fdopen(fd, "wb"), "wt", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    tmp.replace(path)
    cutoff = date.today() - timedelta(days=keep)
    pruned = 0
    for p in outdir.glob("anymem-*.json.gz"):
        m = re.match(r"anymem-(\d{4}-\d{2}-\d{2})\.json\.gz$", p.name)
        if m and datetime.strptime(m.group(1), "%Y-%m-%d").date() < cutoff:
            p.unlink()
            pruned += 1
    return path, pruned


def _write_private(path: Path, text: str) -> None:
    """Write a file only this user can read. The mode is set on the file that exists too, not only on a new one."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)


def write_markdown(data: dict, folder: Path):
    """One file per live memory (not trashed, not closed). Returns (files, rewritten). The memories are personal, so the folder is
    0700 and every file 0600, the same as the JSON export."""
    folder.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(folder, 0o700)  # the memories are personal, so a folder that was already there is tightened too
    except OSError:  # a folder this user does not own cannot be changed, and the files inside are still written 0600
        pass
    seen, written = set(), 0
    for e in data["entries"]:
        if e.get("deleted_at") or e.get("valid_until"):
            continue
        base = re.sub(r"[^A-Za-z0-9._-]+", "-", str(e.get("name") or "")).strip("-").lower()
        name = base or f"entry-{e['id'][:8]}"
        if name in seen:
            name = f"{name}-{e['id'][:8]}"
        seen.add(name)
        target = folder / f"{name}.md"
        text = e["content"] if e["content"].endswith("\n") else e["content"] + "\n"
        if not target.exists() or target.read_text(encoding="utf-8") != text:
            _write_private(target, text)
            written += 1
        else:
            os.chmod(target, 0o600)
    return len(seen), written


def run(ns):
    settings = config.load()
    if not settings.configured():
        print("not configured, run setup or connect", file=sys.stderr)
        return 1
    if ns.now and not ns.from_worker:
        print("anymem: --now only works with --from-worker", file=sys.stderr)
        return 2
    started = time.time()
    try:
        data, day = from_worker(settings, ns.now) if ns.from_worker else (export_all(settings), None)
        path, pruned = write_backup(data, Path(ns.dir) if ns.dir else config.config_dir() / "backups", ns.keep, day)
    except BackupError as e:
        print(f"anymem: {e}", file=sys.stderr)
        return e.code
    msg = f"backed up {len(data['entries'])} memories, {len(data.get('versions', []))} versions, {len(data.get('links', []))} links to {path} ({path.stat().st_size} bytes), pruned {pruned}"
    if ns.markdown:
        n, w = write_markdown(data, Path(ns.markdown))
        msg += f"; markdown {n} files in {ns.markdown}, {w} written"
    if not ns.quiet:
        print(msg + f" in {time.time() - started:.1f}s")
    return 0
