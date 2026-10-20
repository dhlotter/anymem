#!/usr/bin/env python3
"""The cache folder helper: private folders and files whatever the umask, unique temp names, and a lock for read, change,
write cycles. `python3 client/tests/test_cache_file.py`, exits non-zero on failure. Every folder is a temp folder."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))

TMP = Path(tempfile.mkdtemp(prefix="hm-cache-file-"))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["HOME"] = str(TMP / "home")
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")) and key not in ("ANYMEM_CACHE_DIR", "ANYMEM_CONFIG_DIR"):
        del os.environ[key]

from hm import cache_file, offline  # noqa: E402

failures: list = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else (f"  [{detail}]" if detail else "")))
    if not cond:
        failures.append(name)


def mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


os.umask(0)  # the worst case: a umask that would leave files world readable if nothing set the mode

folder = TMP / "private"
cache_file.private_dir(folder)
check("private_dir makes the folder mode 0700 under a permissive umask", mode(folder) == 0o700, oct(mode(folder)))
os.chmod(folder, 0o755)
cache_file.private_dir(folder)
check("private_dir tightens a folder that already exists", mode(folder) == 0o700, oct(mode(folder)))

fresh = folder / "fresh.log"
with cache_file.open_append(fresh) as f:
    f.write("one\n")
check("open_append creates the file mode 0600", mode(fresh) == 0o600, oct(mode(fresh)))

loose = folder / "loose.log"
loose.write_text("old\n")
os.chmod(loose, 0o644)
with cache_file.open_append(loose) as f:
    f.write("new\n")
check("open_append sets 0600 on a file an older version left at 0644", mode(loose) == 0o600, oct(mode(loose)))

doc = folder / "doc.json"
cache_file.write_text(doc, json.dumps({"a": 1}))
check("write_text creates the file mode 0600", mode(doc) == 0o600, oct(mode(doc)))
cache_file.write_text(doc, json.dumps({"a": 2}))
check("write_text replaces the content", json.loads(doc.read_text()) == {"a": 2})
check("write_text leaves no temp file behind", sorted(p.name for p in folder.iterdir()) == sorted(["fresh.log", "loose.log", "doc.json"]),
      str(sorted(p.name for p in folder.iterdir())))

# two writers at once: each gets a temp name of its own, so neither fails and the file holds one whole value
errors: list = []


def writer(n: int) -> None:
    try:
        for i in range(60):
            cache_file.write_text(folder / "race.json", json.dumps({"who": n, "i": i}))
    except Exception as e:  # collected for the check below
        errors.append(repr(e))


threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("parallel write_text calls do not fail", not errors, str(errors[:2]))
last = json.loads((folder / "race.json").read_text())  # raises if a write was cut short
check("the file holds one whole value after parallel writes", last["who"] in range(4) and last["i"] in range(60), str(last))

# read, change, write under the lock: without it, threads overwrite each other's increments
counter = folder / "counter.json"
cache_file.write_text(counter, json.dumps({"n": 0}))


def bump() -> None:
    for _ in range(25):
        with cache_file.locked(counter):
            n = json.loads(counter.read_text())["n"]
            time.sleep(0.001)  # widen the window in which an unlocked writer would lose an increment
            cache_file.write_text(counter, json.dumps({"n": n + 1}))


threads = [threading.Thread(target=bump) for _ in range(4)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("locked read, change, write keeps every increment (4 writers x 25)", json.loads(counter.read_text())["n"] == 100,
      str(json.loads(counter.read_text())))

# the failure file, the one that holds memory text: private from the first byte and safe to discard from
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache2")
offline.record_failure("capture", "network: timed out", {"name": "a", "content": "x"})
cache = Path(os.environ["ANYMEM_CACHE_DIR"])
check("the cache folder is mode 0700 under a permissive umask", mode(cache) == 0o700, oct(mode(cache)))
check("the failure file is mode 0600", mode(offline.path()) == 0o600, oct(mode(offline.path())))

offline.record_failure("capture", "network: timed out", {"name": "b", "content": "y"})
seen = offline.failures()
offline.record_failure("capture", "network: timed out", {"name": "c", "content": "z"})  # recorded while a resave runs
offline.discard([seen[0]])
left = [f["payload"]["name"] for f in offline.failures()]
check("discard removes what was handled and keeps a record recorded meanwhile", left == ["b", "c"], str(left))
offline.discard(offline.failures())
check("discard of everything removes the file", not offline.path().exists())

# the injection log, written on every prompt, is private from its first byte too
from hm import injection  # noqa: E402
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache3")
injection.record(k="start", chars=10)
inj = Path(os.environ["ANYMEM_CACHE_DIR"]) / "injection.log"
check("the injection log is mode 0600 in a 0700 folder under a permissive umask", mode(inj) == 0o600 and mode(inj.parent) == 0o700, f"{oct(mode(inj))} {oct(mode(inj.parent))}")

# a filesystem where flock fails (NFS, FUSE) must not make every hook wait out the whole lock window
import errno  # noqa: E402
import fcntl  # noqa: E402
import time  # noqa: E402

_real_flock = fcntl.flock


def _no_lock(fd, how):
    raise OSError(errno.ENOLCK, "no locks available")


fcntl.flock = _no_lock
_t = time.monotonic()
with cache_file.locked(TMP / "nolock.json"):
    pass
_took = time.monotonic() - _t
fcntl.flock = _real_flock
check("a filesystem that cannot lock is not waited on", _took < 0.5, "%.2f s" % _took)

print()
print(f"{len(failures)} failed" if failures else "ok")
sys.exit(1 if failures else 0)
