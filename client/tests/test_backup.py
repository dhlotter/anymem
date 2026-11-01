#!/usr/bin/env python3
"""Runnable check for the backup script (client/hm/commands/backup.py). `python3 client/tests/test_backup.py`, exits non-zero on failure.
No network: hm.api is replaced by a fake Worker that serves /export, /backup, /backup/<day> and /backup/run."""
from __future__ import annotations

import argparse
import contextlib
import gzip
import io
import json
import os
import stat
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))
from hm import api, config  # noqa: E402
from hm.commands import backup  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


DAY = (date.today() - timedelta(days=3)).isoformat()  # relative, so the 30 day retention never prunes the test copies
E = lambda i, **kw: {"id": f"e{i}", "name": f"mem-{i}", "content": f"---\nname: mem-{i}\n---\ntext {i}", "tags": [], **kw}
PAYLOAD = {"ok": True, "format": 2, "entries": [E(1), E(2)], "versions": [], "questions": [], "links": [], "devices": []}


class Worker:
    def __init__(self, latest=True, file=None, entries=None, page=None):
        self.calls = []
        self.latest = latest
        self.file = file if file is not None else gzip.compress(json.dumps(PAYLOAD).encode())
        self.entries = entries or [E(1), E(2)]

    def request(self, method, path, body=None, timeout=30, settings=None):
        self.calls.append((method, path))
        if path == "/backup/run":
            return {"ok": True}
        if path == "/backup":
            return {"ok": True, "latest": {"day": DAY, "entries": 2} if self.latest else None}
        if path.startswith("/export?"):
            q = dict(p.split("=") for p in path.split("?")[1].split("&"))
            # the fake's cursor is the position as text, "start" for the first page
            off, lim = (0 if q["cursor"] == "start" else int(q["cursor"])) if "cursor" in q else int(q["offset"]), int(q["limit"])
            chunk = self.entries[off:off + lim]
            end = off + lim >= len(self.entries)
            return {"ok": True, "format": 2, "entries": chunk, "versions": [{"memory_id": c["id"], "seq": 1} for c in chunk], "questions": [],
                    "next_offset": None, "next_cursor": None if end else str(off + lim),
                    **({"links": [{"source_id": "e1", "target_id": "e2"}], "devices": []} if end else {})}
        raise AssertionError(path)

    def request_bytes(self, method, path, body=None, timeout=30, settings=None):
        self.calls.append((method, path))
        assert path == "/backup/" + DAY, path
        return self.file


def run(w, *args):
    out = Path(tempfile.mkdtemp())
    p = argparse.ArgumentParser()
    backup.register(p)
    ns = p.parse_args(["--dir", str(out), *args])
    settings = config.Settings(url="https://w.test", token="t" * 24)
    err, so = io.StringIO(), io.StringIO()
    with mock.patch.object(api, "request", w.request), mock.patch.object(api, "request_bytes", w.request_bytes), \
            mock.patch.object(config, "load", lambda *a, **k: settings), contextlib.redirect_stderr(err), contextlib.redirect_stdout(so):
        code = backup.run(ns)
    return code or 0, out, err.getvalue(), so.getvalue()


w = Worker()
code, out, err, _ = run(w, "--from-worker")
target = out / ("anymem-%s.json.gz" % DAY)
check("--from-worker saves the Worker's latest backup named by its own date", code == 0 and target.exists())
check("the saved file is the Worker's export, restorable as is", json.loads(gzip.decompress(target.read_bytes()))["entries"][1]["id"] == "e2")
check("the file is mode 0600", stat.S_IMODE(target.stat().st_mode) == 0o600)
check("no run is asked for without --now", ("POST", "/backup/run") not in w.calls)

w = Worker()
code, out, err, _ = run(w, "--from-worker", "--now")
check("--now has the Worker take today's backup before the download", code == 0 and w.calls[0] == ("POST", "/backup/run"))

code, out, err, _ = run(Worker(), "--now")
check("--now alone is refused", code == 2 and "--from-worker" in err)

code, out, err, _ = run(Worker(latest=False), "--from-worker")
check("no backup yet is a plain failure with the fix", code == 1 and "no backup yet" in err and not list(out.glob("*.gz")))

code, out, err, _ = run(Worker(file=b"not gzip"), "--from-worker")
check("a corrupt file is refused and nothing is written", code == 1 and "not a valid gzip export" in err and not list(out.glob("*.gz")))

bad = gzip.compress(json.dumps({"ok": True, "entries": [{"id": "e1"}]}).encode())
code, out, err, _ = run(Worker(file=bad), "--from-worker")
check("an export with an entry missing content is refused", code == 1 and "without an id or content" in err and not list(out.glob("*.gz")))

# a fresh export is paged and joined
many = [E(i) for i in range(2300)]
w = Worker(entries=many)
code, out, err, text = run(w)
files = list(out.glob("anymem-*.json.gz"))
doc = json.loads(gzip.decompress(files[0].read_bytes())) if files else {}
check("a fresh export follows next_cursor page by page", code == 0 and len(doc.get("entries", [])) == 2300 and [c[1] for c in w.calls if c[1].startswith("/export")] == ["/export?cursor=start&limit=1000", "/export?cursor=1000&limit=1000", "/export?cursor=2000&limit=1000"])
check("the joined export carries the versions of every page and the links of the last", len(doc["versions"]) == 2300 and doc["links"] and doc["next_offset"] is None)
check("the summary line counts memories, versions and links", "2300 memories, 2300 versions, 1 links" in text)

# a copy far smaller than the last one is refused, the old one stays
out2 = Path(tempfile.mkdtemp())
day1, day2 = ((date.today() - timedelta(days=n)).isoformat() for n in (2, 1))
first = backup.write_backup({**PAYLOAD, "entries": [E(i) for i in range(10)]}, out2, 30, day1)[0]
try:
    backup.write_backup({**PAYLOAD, "entries": [E(1)]}, out2, 30, day2)
    refused = None
except backup.BackupError as e:
    refused = e
check("a copy more than 20 percent smaller is refused with exit code 2", refused is not None and refused.code == 2 and not (out2 / f"anymem-{day2}.json.gz").exists() and first.exists())

# markdown copy: live memories only, named by name
md = Path(tempfile.mkdtemp())
n, wrote = backup.write_markdown({"entries": [E(1), E(2, deleted_at=5), E(3, valid_until=9), E(4, name="")]}, md)
check("markdown writes live memories only, and names an unnamed one by its id", n == 2 and sorted(p.name for p in md.glob("*.md")) == ["entry-e4.md", "mem-1.md"] and wrote == 2)
n, wrote = backup.write_markdown({"entries": [E(1), E(4, name="")]}, md)
check("a second markdown run rewrites nothing", wrote == 0)

# the markdown copy holds personal memories: a private folder and private files, also for files written before (#123)
_md2 = Path(tempfile.mkdtemp()) / "md"
_md2.mkdir(mode=0o755)
(_md2 / "mem-1.md").write_text("old copy\n", encoding="utf-8")
os.chmod(_md2 / "mem-1.md", 0o644)
backup.write_markdown({"entries": [E(1), E(2)]}, _md2)
check("the markdown folder is 0700 and every file in it is 0600", stat.S_IMODE(os.stat(_md2).st_mode) == 0o700 and all(stat.S_IMODE(os.stat(p).st_mode) == 0o600 for p in _md2.glob("*.md")) and len(list(_md2.glob("*.md"))) == 2)

sys.exit(1 if failures else 0)
