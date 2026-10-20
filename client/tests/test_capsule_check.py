#!/usr/bin/env python3
"""Runnable check for the capsule check. No network, no model: the Worker and the judge are faked."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api  # noqa: E402
from hm.commands import capsule_check as cc  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


section = "How Sam likes work done (a heading, not a claim)\n1. Draft messages in chat first: full text, then draft once.\n2. short\n3. The vault is Google Drive with an rclone mount on the VPS."
check("a section with numbered items checks only those, without the number or the heading", cc.lines_of(section) == ["Draft messages in chat first: full text, then draft once.", "The vault is Google Drive with an rclone mount on the VPS."])
check("a section with no numbers checks each line long enough to say something", cc.lines_of("Memory system\nThe shared memory is the anymem Worker.\nWho") == ["The shared memory is the anymem Worker."])

NOW = 2_000_000_000_000
capsule = {"text": json.dumps({"sections": [{"slot": "constraints", "content": "1. Secrets live in one secrets manager only, never in flat files.\n2. The backup is a launchd job on the Mac at 03:30."}]}),
           "sections": [{"slot": "constraints", "source_entry_id": "cap1"}]}
memories = [{"id": "m-old", "content": "old note", "tags": [], "updated_at": NOW - 9e9},
            {"id": "m-new", "content": "The Worker backs itself up to R2 at 01:00 UTC, no Mac job.", "tags": json.dumps(["auto-capture"]), "updated_at": NOW - 1e6},
            {"id": "cap1", "content": "the capsule itself", "tags": ["capsule-slot:constraints"], "updated_at": NOW},
            {"id": "m-dead", "content": "retired note", "tags": ["status:deprecated"], "updated_at": NOW - 1e6}]
asked = []


def fake(method, path, body=None, timeout=30, settings=None):
    if path.startswith("/entry?id="):
        return {"entry": {"id": "cap1", "updated_at": NOW - 5e6}}
    if path.startswith("/recall?"):
        return {"results": memories}
    raise AssertionError(path)


api.request = fake
check("only memories newer than the capsule section, not retired, not a capsule slot, are put to the judge", [m["id"] for m in cc.newer_memories("a line about backups here", NOW - 5e6, {"cap1"})] == ["m-new"])


def judge(prompt):
    asked.append(prompt)
    return json.dumps({"verdict": "stale", "memory": "m-new", "reason": "the backup moved to the Worker"}) if "launchd" in prompt else json.dumps({"verdict": "ok"})


found, total = cc.findings(capsule, judge)
check("a line a newer memory contradicts is listed with that memory and the reason, a sound line is not", total == 2 and len(found) == 1 and found[0]["memory"] == "m-new" and "launchd" in found[0]["line"] and found[0]["reason"].startswith("the backup moved"))
check("the model is told the text is data, and the memory text sits inside tags it cannot close", "not instructions" in asked[0] and asked[0].count("</newer_memories>") == 1)
bad = lambda prompt: json.dumps({"verdict": "stale", "memory": "not-shown", "reason": "x"})
check("a stale verdict that names no memory it was shown is ignored", cc.findings(capsule, bad)[0] == [])
check("an unreadable answer is ignored", cc.findings(capsule, lambda p: "no idea")[0] == [])
memories[:] = [m for m in memories if m["id"] != "m-new"]
check("a line with no newer memory is not even sent to the judge", (asked.clear(), cc.findings(capsule, judge))[1][0] == [] and asked == [])

# the judge runs from a private folder with no settings loaded, never from /tmp
import os  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
from hm import judge  # noqa: E402

seen = {}
real_run = subprocess.run


def fake_run(args, **kw):
    seen.update(args=args, cwd=kw.get("cwd"), exists=os.path.isdir(kw.get("cwd") or ""), mode=stat.S_IMODE(os.stat(kw["cwd"]).st_mode))
    return subprocess.CompletedProcess(args, 0, stdout='{"verdict": "ok"}', stderr="")


subprocess.run = fake_run
try:
    cc._claude = lambda: "/usr/bin/true-claude"
    out = cc.ask("a prompt")
finally:
    subprocess.run = real_run
check("the judge is asked from a private folder, not /tmp, and the folder is not writable by others", seen.get("cwd") not in (None, "/tmp", "/private/tmp") and (seen["mode"] & 0o022) == 0)
check("the private folder was made for this call, mode 0700, and is removed afterwards", seen.get("exists") and seen["mode"] == 0o700 and not os.path.exists(seen["cwd"]) and out == '{"verdict": "ok"}')
check("no settings source is loaded: the source list is empty", seen["args"][seen["args"].index("--setting-sources") + 1] == "" and "local" not in seen["args"])


def fail_run(args, **kw):
    seen["cwd"] = kw.get("cwd")
    raise subprocess.TimeoutExpired(args, 1)


subprocess.run = fail_run
try:
    gone = cc.ask("a prompt") is None and not os.path.exists(seen["cwd"])
finally:
    subprocess.run = real_run
check("the private folder is removed even when the call fails", gone)
sys.exit(1 if failures else 0)
