#!/usr/bin/env python3
"""Runnable check for hm.offline."""
from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import offline  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
check("no file means no failures", offline.failures() == [])
offline.record_failure("capture", "network: timed out", {"name": "m1"})
offline.record_failure("remember", "HTTP 401: bad token")
f = offline.failures()
check("failures come back oldest first with their payload", [x["kind"] for x in f] == ["capture", "remember"] and f[0]["payload"] == {"name": "m1"})
check("the failure file is private (0600)", stat.S_IMODE(os.stat(offline.path()).st_mode) == 0o600)
for i in range(offline.MAX_RECORDS + 20):
    offline.record_failure("capture", f"r{i}")
check("the file is capped, newest records kept", len(offline.failures()) == offline.MAX_RECORDS and offline.failures()[-1]["reason"] == f"r{offline.MAX_RECORDS + 19}")
offline.clear()
check("clear removes the file", offline.failures() == [])
check("a corrupt line is skipped, not fatal", (offline.path().parent.mkdir(parents=True, exist_ok=True) or offline.path().write_text('{"ok":1}\nnot json\n') or True) and len(offline.failures()) == 1)
check("age labels", offline.age_label(1000, 1030) == "just now" and offline.age_label(0, 600) == "10 minutes old" and offline.age_label(0, 7200) == "2 hours old" and offline.age_label(0, 86400) == "1 day old")
os.environ["ANYMEM_CACHE_DIR"] = "/proc/definitely/not/writable"
offline.record_failure("capture", "must not raise")
check("recording into an unwritable folder never raises", True)

# a failed save recorded in the DSH temp folder is folded into the main file
import json as _json
_tmp = tempfile.mkdtemp()
_main = Path(tempfile.mkdtemp())
del os.environ["ANYMEM_CACHE_DIR"]
offline.tempfile.gettempdir = lambda: _tmp
offline.config.cache_dir = lambda: _main
_box = Path(_tmp) / ("anymem-%d" % os.getuid())
_box.mkdir(mode=0o700)
(_box / "failed.jsonl").write_text(_json.dumps({"ts": 1, "kind": "capture", "reason": "sandbox", "payload": {"name": "from-dsh"}}) + "\n")
os.chmod(_box / "failed.jsonl", 0o600)
check("a failed save from the DSH temp folder shows up in failures()", [r["payload"]["name"] for r in offline.failures()] == ["from-dsh"])
check("and the temp folder copy is removed so it is not counted twice", not (_box / "failed.jsonl").exists() and len(offline.failures()) == 1)

# the temp folder is shared with every local user, so a planted file is read only when the folder and the file are private (#39)
_src = _box / "failed.jsonl"
_planted = _json.dumps({"ts": 1, "kind": "capture", "reason": "planted", "payload": {"name": "planted"}}) + "\n"


def _names_after_plant(folder_mode, file_mode=0o600, link=None):
    offline.clear()
    if _src.is_symlink() or _src.exists():
        _src.unlink()
    os.chmod(_box, folder_mode)
    if link is None:
        _src.write_text(_planted)
        os.chmod(_src, file_mode)
    else:
        link.write_text(_planted)
        os.chmod(link, 0o600)
        _src.symlink_to(link)
    names = [r["payload"]["name"] for r in offline.failures()]
    return names


check("a temp folder that others can write to is not read", _names_after_plant(0o777) == [] and _src.exists())
check("a planted file others can read is not read", _names_after_plant(0o700, 0o644) == [] and _src.exists())
check("a link in the temp folder is not followed", _names_after_plant(0o700, link=_main / "elsewhere.jsonl") == [] and _src.is_symlink())
check("this user's private file in a private folder is folded in", _names_after_plant(0o700) == ["planted"] and not _src.exists())
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
