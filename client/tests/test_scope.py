#!/usr/bin/env python3
"""Runnable check for project scoping in the recall hook and the capsule cache age.

No network and no credentials: the Worker call and urlopen are replaced, every file lives in a temporary folder.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOOKS = Path(__file__).resolve().parent.parent.parent / "hooks"
sys.path.insert(0, str(HOOKS))
failures = []


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, str(HOOKS / file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


rec = load("memory_recall", "memory_recall.py")
mc = load("memory_capsule", "memory_capsule.py")
tmp = Path(tempfile.mkdtemp()).resolve()
os.environ["ANYMEM_CONFIG_DIR"] = str(tmp / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(tmp / "cache")
os.environ.pop("ANYMEM_PROJECT", None)
rec.SEEN = tmp / "seen.json"

# recall: a project A repo, a project B repo, and a folder that is no project
for n in ("proj-a", "proj-b"):
    subprocess.run(["git", "init", "-q", str(tmp / n)], check=True)
(tmp / "plain").mkdir()


def mem(i, *tags):
    return {"id": i, "content": f"---\nname: {i}\ndescription: d\n---\nbody", "tags": ["status:canonical", *tags]}


MEMS = [mem("mem-a", "project:proj-a"), mem("mem-b", "project:proj-b"), mem("mem-global")]
PROMPT = "how do we deploy the memory worker today"
n = [0]


def injected(cwd, results, session=None):
    """Names the hook injects for a session in `cwd`, when the Worker returns `results`."""
    n[0] += 1
    rec.recall = lambda q, p=None, s=None: results
    out = rec.run({"prompt": PROMPT, "session_id": session or f"s{n[0]}", "cwd": str(tmp / cwd)})
    return [ln[len("- <memory>"):].split(":")[0] for ln in out.splitlines() if ln.startswith("- <memory>")]


check("project A memory is injected in project A", "mem-a" in injected("proj-a", MEMS))
check("project A memory is never injected in project B", "mem-a" not in injected("proj-b", MEMS))
check("project B memory is never injected in project A", "mem-b" not in injected("proj-a", MEMS))
check("a global memory is injected everywhere", all("mem-global" in injected(c, MEMS) for c in ("proj-a", "proj-b", "plain")))
check("a session with no project gets only global memories", injected("plain", MEMS) == ["mem-global"])
os.environ["ANYMEM_PROJECT"] = "global"
check("ANYMEM_PROJECT=global means no project, even inside project A", injected("proj-a", MEMS) == ["mem-global"])
os.environ["ANYMEM_PROJECT"] = "proj-b"
check("ANYMEM_PROJECT forces a project", injected("plain", MEMS) == ["mem-b", "mem-global"])
os.environ.pop("ANYMEM_PROJECT")

# the request carries scope, count and the ids already shown, and a v2 reply is read by its own fields
asked = {}


def fake_request(method, path, timeout=None, **kw):
    asked["q"] = parse_qs(urlparse(path).query)
    return {"ok": True, "results": [
        {"id": "own-1", "name": "own-1", "description": "d", "content": "---\nname: own-1\ndescription: d\n---\nbody", "project": "proj-a", "relevant": True},
        {"id": "weak-1", "name": "weak-1", "description": "d", "content": "---\nname: weak-1\ndescription: d\n---\nbody", "project": "proj-a", "relevant": False},
        {"id": "glob-1", "name": "glob-1", "description": "d", "content": "---\nname: glob-1\ndescription: d\n---\nbody", "project": "", "relevant": True},
        {"id": "other-1", "name": "other-1", "description": "d", "content": "---\nname: other-1\ndescription: d\n---\nbody", "project": "proj-b", "relevant": True}]}


rec.api.request = fake_request
rec.recall = load("memory_recall_fresh", "memory_recall.py").recall  # the real recall, over the fake request
rec_run = rec.run({"prompt": PROMPT, "session_id": "v2", "cwd": str(tmp / "proj-a")})
got = [ln[len("- <memory>"):].split(":")[0] for ln in rec_run.splitlines() if ln.startswith("- <memory>")]
check("the request asks for scope project:<slug>, count=1 and topK 3", asked["q"]["scope"] == ["project:proj-a"] and asked["q"]["count"] == ["1"] and asked["q"]["topK"] == ["3"])
check("the hook injects what the Worker marks relevant, global ones included, and drops the weak and the foreign", got == ["own-1", "glob-1"])
rec.run({"prompt": PROMPT + " again please", "session_id": "v2", "cwd": str(tmp / "proj-a")})
check("a memory shown earlier in the session is sent back as exclude_ids", sorted(asked["q"]["exclude_ids"][0].split(",")) == ["glob-1", "own-1"])
rec.run({"prompt": PROMPT, "session_id": "v2-plain", "cwd": str(tmp / "plain")})
check("a session with no project sends no scope", "scope" not in asked["q"])
rec_plain = rec.run({"prompt": PROMPT, "session_id": "v2-plain2", "cwd": str(tmp / "plain")})
check("a session with no project injects only global memories", [ln[len("- <memory>"):].split(":")[0] for ln in rec_plain.splitlines() if ln.startswith("- <memory>")] == ["glob-1"])

# capsule: cache age line and the 9,500 cap
SECTIONS = [{"slot": "identity", "content": "Recall before answering."}, {"slot": "preferences", "content": "Draft in chat first."}]
BODY = {"ok": True, "sections": [{**x, "source_id": "m1", "updated_at": 1} for x in SECTIONS], "etag": "v1", "chars": 10, "cap": 9500}
BODY_OLD = {"sections": [{"slot": x["slot"]} for x in SECTIONS], "text": json.dumps({"sections": SECTIONS})}


class Resp:
    def __init__(self, body, etag='"v1"'):
        self._b = io.BytesIO(json.dumps(body).encode())
        self.headers = {"ETag": etag}

    def read(self, *a):
        return self._b.read(*a)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def offline_error(req, timeout=None):
    raise urllib.error.URLError("offline")


def fresh(name):
    mc.CACHE = tmp / name / "capsule.json"
    mc._settings = lambda: mc.config.Settings(url="https://worker.example", token="t")


fresh("age")
mc.api._OPENER.open = lambda req, timeout=None: Resp(BODY)
live = mc.block()
check("a live capsule adds no cache line", live is not None and "from cache" not in live)
check("the cache file records when it was fetched", abs(json.loads(mc.CACHE.read_text())["fetched_at"] - time.time()) < 5)


def not_modified(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", {}, None)


mc.api._OPENER.open = not_modified
out304 = mc.block()
check("a 304 is live, no cache line", out304 is not None and "from cache" not in out304)
mc.api._OPENER.open = offline_error
data = json.loads(mc.CACHE.read_text())
data["fetched_at"] = time.time() - 3 * 3600 - 30
mc.CACHE.write_text(json.dumps(data))
cached = mc.block() or ""
lines = cached.splitlines()
check("a cached capsule says how old it is, on the line under the heading", lines[0].startswith("## Memory capsule") and lines[1] == "(from cache, 3 hours old)")
check("the cached capsule still carries the rules", "### identity" in cached and "Draft in chat first." in cached)
del data["fetched_at"]
mc.CACHE.write_text(json.dumps(data))
os.utime(mc.CACHE, (time.time() - 2 * 86400, time.time() - 2 * 86400))
check("a cache from before fetched_at falls back to the file time", "(from cache, 2 days old)" in (mc.block() or ""))

fresh("cap")
big = [{"slot": s, "content": "x" * 6000} for s in mc.SLOT_ORDER]
mc.api._OPENER.open = lambda req, timeout=None: Resp({"ok": True, "sections": big})
check("a live capsule over the limit is cut to 9,500 characters", len(mc.block() or "") == 9500)
mc.api._OPENER.open = offline_error
check("a cached capsule with its age line is within 9,500 characters", 0 < len(mc.block() or "") <= 9500)
check("a small capsule is not cut", "…" not in mc.render(SECTIONS, "live"))
fresh("old")
mc.api._OPENER.open = lambda req, timeout=None: Resp(BODY_OLD)
check("the old Worker's capsule shape (a JSON string in text) is still read", "Recall before answering." in (mc.block() or ""))
twice = mc.render([{"slot": "preferences", "content": "First."}, {"slot": "preferences", "content": "Second."}, {"slot": "zeta", "content": "Extra."}, {"slot": "identity", "content": "Me."}], "live")
check("two sections of one slot share a heading, an unknown slot follows the four", twice.count("### preferences") == 1 and twice.index("First.") < twice.index("Second.") and twice.index("### identity") < twice.index("### preferences") < twice.index("### zeta"))

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
