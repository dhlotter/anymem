#!/usr/bin/env python3
"""Runnable check for the resave script and offline.rewrite. No network."""
from __future__ import annotations

import io
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
from hm import api, offline  # noqa: E402
from hm.commands import resave  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def run(dry=False):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = resave.run(SimpleNamespace(dry_run=dry))
    return rc, out.getvalue(), err.getvalue()


check("nothing to resave is a clean exit", run()[0] == 0 and "nothing to resave" in run()[1])
offline.record_failure("capture", "network: timed out", {"name": "m1", "content": "---\nname: m1\n---\nbody one", "project": "proj-a",
                                                           "tags": ["auto-capture", "captured-by:codex", "session:1a2b3c4d", "status:draft"]})
offline.record_failure("capture", "HTTP 500", {"name": "m2", "content": "---\nname: m2\n---\nbody two"})
offline.record_failure("remember", "unrelated", {"name": "x"})
sent = []


def good(method, path, body=None, timeout=30, settings=None):
    sent.append((method, path, body))
    return {"ok": True}


api.request = good
rc, out, _ = run(dry=True)
check("dry run lists and sends nothing", rc == 0 and "m1" in out and "m2" in out and sent == [])
rc, out, _ = run()
check("resave posts each capture, with its project", rc == 0 and len(sent) == 2
      and sent[0][2]["project"] == "proj-a" and "project" not in sent[1][2])
check("resave saves active: no draft tag", all("status:draft" not in b["tags"] for _, _, b in sent))
check("resave keeps the origin tags of the source memory", sent[0][2]["tags"] == ["auto-capture", "captured-by:codex", "session:1a2b3c4d"])
check("a failure recorded without tags still resaves with auto-capture only", sent[1][2]["tags"] == ["auto-capture"])
check("only the unrelated failure is left afterwards", [f["kind"] for f in offline.failures()] == ["remember"])
offline.record_failure("capture", "again", {"name": "m3", "content": "---\nname: m3\n---\nb"})


def bad(method, path, body=None, timeout=30, settings=None):
    raise api.NetworkError("unreachable")


api.request = bad
rc, out, err = run()
check("a capture that still fails is kept and reported, exit 1", rc == 1 and "m3" in err and len(offline.failures()) == 2)
offline.record_failure("capture", "HTTP 422", {"name": "m4", "content": "---\nname: m4\n---\nbody four"})
offline.record_failure("capture", "HTTP 500", {"name": "m5", "content": "---\nname: m5\n---\nbody five"})


def refused(method, path, body=None, timeout=30, settings=None):
    if "body four" in body["content"]:
        raise api.ApiError(422, "refused", {"reason": "a screen refused it"})
    raise api.ApiError(500, "server down")


api.request = refused
rc, out, err = run()
check("a 422 is refused for good: dropped and said once, not kept", "dropped: m4 (refused, a screen refused it)" in err and "m4" not in " ".join(f["payload"].get("name", "") for f in offline.failures()))
check("another HTTP error is kept and reported, with the status", "still failing: m5 (HTTP 500: server down)" in err and "m5" in " ".join(f["payload"].get("name", "") for f in offline.failures()))
check("the kept captures are the ones still failing, and the exit is 1", rc == 1 and sorted(f["payload"]["name"] for f in offline.failures() if f["kind"] == "capture") == ["m3", "m5"])
offline.rewrite([])
check("rewrite with nothing removes the file", offline.failures() == [])


def answer(status):
    """Every write gets this HTTP status. Returns the function and the list of bodies it was sent."""
    calls = []

    def fn(method, path, body=None, timeout=30, settings=None):
        calls.append(body)
        raise api.ApiError(status, "refused", {"reason": "refused"})
    return fn, calls


def three(prefix):
    offline.clear()
    for n in (1, 2, 3):
        offline.record_failure("capture", "x", {"name": "%s%d" % (prefix, n), "content": "---\nname: %s%d\n---\nb" % (prefix, n)})


for status in (400, 413):
    api.request, calls = answer(status)
    three("bad%d" % status)
    rc, out, err = run()
    check("a %d capture is dropped and said, never kept for a retry" % status, rc == 0 and len(calls) == 3 and offline.failures() == [] and "dropped: bad%d1" % status in err)
# a 400 from something in front of the Worker (a gateway, a size limit) has no Worker body, so the memory is kept
def bare(method, path, body=None, timeout=30, settings=None):
    raise api.ApiError(413, "too large", None)


api.request = bare
three("gateway")
rc, out, err = run()
check("a 413 with no Worker body is kept for another try, not dropped", rc == 1 and len(offline.failures()) == 3)
api.request, calls = answer(429)
three("slow")
rc, out, err = run()
check("a 429 stops the resave: one attempt, and the rest stay for the next run", rc == 1 and len(calls) == 1 and [f["payload"]["name"] for f in offline.failures()] == ["slow1", "slow2", "slow3"] and "limiting" in err)
api.request, calls = answer(500)
three("flaky")
rc, out, err = run()
check("a 500 is kept and the resave goes on to the next capture", rc == 1 and len(calls) == 3 and len(offline.failures()) == 3)
offline.clear()
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
