#!/usr/bin/env python3
"""Runnable check for hm.policy. Config lives in a temporary folder, the environment is isolated."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import config, policy  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


root = Path(tempfile.mkdtemp()).resolve()
os.environ["ANYMEM_CONFIG_DIR"] = str(root / "cfg")
os.environ.pop("ANYMEM_CAPTURE", None)
work = root / "work"
(work / "secret-client" / "app").mkdir(parents=True)
(work / "open").mkdir()


def setcfg(**values):
    config.config_dir().mkdir(parents=True, exist_ok=True)
    config.config_file().write_text(json.dumps(values), encoding="utf-8")


check("no config file means capture is allowed", policy.allowed("abc", str(work)) == (True, ""))
setcfg(capture="proposals")
check("capture proposals is allowed", policy.allowed("abc", str(work))[0])
for off in ("off", "OFF ", False, "false"):
    setcfg(capture=off)
    ok, why = policy.allowed("abc", str(work))
    check("capture %r is off with a reason" % (off,), not ok and "off" in why)
setcfg(capture="everything")
ok, why = policy.allowed("abc", str(work))
check("an unknown mode fails closed", not ok and "not recognised" in why)

setcfg()
os.environ["ANYMEM_CAPTURE"] = "0"
ok, why = policy.allowed("abc", str(work))
check("ANYMEM_CAPTURE=0 means off", not ok and "ANYMEM_CAPTURE" in why)
os.environ["ANYMEM_CAPTURE"] = "1"
check("ANYMEM_CAPTURE=1 does not", policy.allowed("abc", str(work))[0])
os.environ.pop("ANYMEM_CAPTURE")

setcfg(exclude_paths=[str(work / "secret-client")])
check("exclude_paths covers the folder itself", not policy.allowed("s", str(work / "secret-client"))[0])
check("exclude_paths covers a sub folder", not policy.allowed("s", str(work / "secret-client" / "app"))[0])
check("exclude_paths does not cover a sibling", policy.allowed("s", str(work / "open"))[0])
check("a prefix must end at a folder boundary", policy.allowed("s", str(work / "secret-client-two"))[0])
check("a trailing slash in the pattern still matches", (setcfg(exclude_paths=[str(work / "secret-client") + "/"]), not policy.allowed("s", str(work / "secret-client" / "app"))[0])[1])
setcfg(exclude_paths=[str(work / "secret-*")])
check("a glob matches the folder and what is below it", not policy.allowed("s", str(work / "secret-client"))[0] and not policy.allowed("s", str(work / "secret-client" / "app"))[0])
check("a glob leaves other folders alone", policy.allowed("s", str(work / "open"))[0])
setcfg(exclude_paths=str(work / "open"))
check("a single string is accepted as a one item list", not policy.allowed("s", str(work / "open"))[0])
setcfg(exclude_paths=[str(work / "open")])
ok, why = policy.allowed("s", "")
check("with exclude_paths set and no cwd it fails closed", not ok and "unknown" in why)
setcfg()
check("with nothing excluded an empty cwd is fine", policy.allowed("s", "")[0])
setcfg(exclude_paths=[7, None, "", {"a": 1}])
check("junk entries are ignored", policy.allowed("s", str(work))[0])
link = root / "link"
os.symlink(str(work / "secret-client"), str(link))
setcfg(exclude_paths=[str(work / "secret-client")])
check("a symlinked folder is matched by its real path", not policy.allowed("s", str(link))[0])

setcfg(exclude_sessions=["5b7c0a2e", "tmp-"])
check("exclude_sessions matches by prefix", not policy.allowed("5b7c0a2e-1d3f-4a6b", str(work))[0] and not policy.allowed("tmp-run", str(work))[0])
check("other sessions are allowed", policy.allowed("9999", str(work))[0] and policy.allowed("", str(work))[0])
setcfg(exclude_sessions=[""])
check("an empty prefix excludes nothing", policy.allowed("9999", str(work))[0])
config.config_file().write_text("not json", encoding="utf-8")
check("a corrupt config file falls back to the default", policy.allowed("9999", str(work))[0])

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
