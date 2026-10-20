#!/usr/bin/env python3
"""What the recall hook did with each prompt, noted locally and sent on the next request. `python3 client/tests/test_outcomes.py`,
exits non-zero on failure. No network beyond 127.0.0.1 (the fake Worker), every folder is a temp folder."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT / "hooks"))

TMP = Path(tempfile.mkdtemp(prefix="hm-outcomes-"))
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["HOME"] = str(TMP / "home")
os.environ["ANYMEM_PROJECT"] = "global"
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")) and key not in ("ANYMEM_CACHE_DIR", "ANYMEM_CONFIG_DIR", "ANYMEM_PROJECT"):
        del os.environ[key]

from hm import api, outcomes  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures: list = []
TOKEN = "test-token-" + "0000"
REFUSED_LOGIN = (401, 403)


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else (f"  [{detail}]" if detail else "")))
    if not cond:
        failures.append(name)


def pending(harness: str) -> list:
    p = outcomes._path(harness)
    return p.read_text(encoding="utf-8").split() if p.exists() else []


# 1. The words, the header, the files.
check("with nothing noted there is nothing to take", outcomes.take("codex") is None)
for kind in ("injected", "quiet", "quiet", "failed", "quiet", "bogus", ""):
    outcomes.record(kind, "codex")
outcomes.record("injected", "kilo")
check("an unknown word is ignored", pending("codex") == ["injected", "quiet", "quiet", "failed", "quiet"], str(pending("codex")))
check("each harness has its own file", pending("kilo") == ["injected"])
check("the file is private", (outcomes._path("codex").stat().st_mode & 0o777) == 0o600)
t = outcomes.take("codex")
check("take returns the totals as a header value, in a fixed order", t is not None and t.header == "injected=1,quiet=3,failed=1", getattr(t, "header", ""))
check("take moves the file aside, so a new decision starts a new file", not outcomes._path("codex").exists())
outcomes.record("quiet", "codex")
check("a decision noted while a request is on its way is kept for the next one", pending("codex") == ["quiet"])
outcomes.settle(t, 200, "codex")
check("a request the Worker read removes what it carried and nothing else", pending("codex") == ["quiet"] and not t.path.exists())
check("another harness's words were never touched", pending("kilo") == ["injected"])

t = outcomes.take("codex")
outcomes.settle(t, 0, "codex")
check("no connection puts the words back", pending("codex") == ["quiet"] and not t.path.exists())
for status in REFUSED_LOGIN:
    t = outcomes.take("codex")
    outcomes.settle(t, status, "codex")
    check(f"HTTP {status} puts the words back, the Worker refused before it read the header", pending("codex") == ["quiet"])
for status in (500, 502, outcomes.NO_REPLY, 200, 400, 404, 409, 422, 429):
    outcomes.record("injected", "codex")
    t = outcomes.take("codex")
    outcomes.settle(t, status, "codex")
    check(f"{'no answer in time' if status == outcomes.NO_REPLY else 'HTTP ' + str(status)} counts the words, they are not put back", pending("codex") == [] and not t.path.exists(), str(pending("codex")))
    outcomes.record("quiet", "codex")
outcomes.settle(None, 200, "codex")
check("settling nothing is fine", True)

outcomes.record("quiet", "")
check("a blank harness has a file of its own", outcomes._path("").name == "recall-outcomes-unknown.log" and outcomes.take("") is not None)

big = outcomes._path("big")
big.write_text("quiet\n" * 5000, encoding="utf-8")
outcomes.record("quiet", "big")
check("a file past its size cap takes no more words", len(pending("big")) == 5000)
t = outcomes.take("big")
check("one request carries at most 2000 words", t is not None and sum(t.words.count(k) for k in outcomes.KINDS) == 2000)
check("the header holds at most the Worker's 1000 for one word", t is not None and t.header == "quiet=1000", str(getattr(t, "header", "")))
outcomes.settle(t, 200, "big")

bad = outcomes._path("junk")
bad.write_text("not\na word\n", encoding="utf-8")
check("a file with no valid word gives nothing and is removed", outcomes.take("junk") is None and not bad.exists())

# 2. The header rides on the next request to the Worker.
srv = fake_worker.start()
os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"] = srv.url, TOKEN
os.environ["ANYMEM_HARNESS"] = "zcode"
api.request("GET", "/health")
check("a request with nothing waiting carries no header", "x-anymem-outcomes" not in srv.headers[-1])
outcomes.record("injected", "zcode")
outcomes.record("quiet", "zcode")
outcomes.record("quiet", "dsh")
api.request("GET", "/health")
check("the next request carries the totals of its own harness", srv.headers[-1].get("x-anymem-outcomes") == "injected=1,quiet=1", str(srv.headers[-1]))
check("and what it carried is gone, what belongs to another harness is not", pending("zcode") == [] and pending("dsh") == ["quiet"])
api.request("GET", "/health")
check("the request after that carries nothing", "x-anymem-outcomes" not in srv.headers[-1])
outcomes.record("quiet", "zcode")
srv.replies["GET /health"] = (500, {"ok": False})
try:
    api.request("GET", "/health")
except api.ApiError:
    pass
check("a server error counts the words, the Worker may have counted them before it failed", pending("zcode") == [])
outcomes.record("quiet", "zcode")
srv.replies["GET /health"] = (404, {"ok": False})
try:
    api.request("GET", "/health")
except api.ApiError:
    pass
check("the words went with the next request, and a 404 counts as read", pending("zcode") == [] and srv.headers[-1].get("x-anymem-outcomes") == "quiet=1")
srv.stop()
outcomes.record("failed", "zcode")
try:
    api.request("GET", "/health")
except api.NetworkError:
    pass
check("a network failure puts the words back", pending("zcode") == ["failed"])

# a timeout: the request may have been read, so the words are counted and not put back (a retry would count them twice)
real_open = api._OPENER.open


def timing_out(*args, **kwargs):
    raise socket.timeout("timed out")


api._OPENER.open = timing_out
try:
    api.request("GET", "/health")
except api.NetworkError:
    pass
finally:
    api._OPENER.open = real_open
check("a request that timed out counts its words, it does not put them back", pending("zcode") == [])

# a hook the harness killed mid request leaves its words in a file named for its pid: nothing counts them, so the next take drops them
dead = subprocess.Popen([sys.executable, "-c", "pass"])
dead.wait()
orphan = outcomes._path("zcode").with_name(outcomes._path("zcode").name + "." + str(dead.pid))
orphan.write_text("quiet\n", encoding="utf-8")
outcomes.record("injected", "zcode")
taken = outcomes.take("zcode")
check("words left by a dead process are dropped, and not sent with the next request", not orphan.exists() and taken is not None and taken.words == ["injected"])
outcomes.settle(taken, 200, "zcode")
del os.environ["ANYMEM_HARNESS"], os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"]

# 3. The recall hook notes its decision.
import memory_recall as rec  # noqa: E402

os.environ["ANYMEM_HARNESS"] = "claude"
for p in outcomes._path("claude").parent.glob("recall-outcomes-*"):
    p.unlink()
GOOD = {"id": "a1", "content": "---\nname: n\ndescription: d\n---\nbody", "tags": [], "relevant": True, "project": ""}
PROMPT = "What did we decide about the restore window for the trash?"


def decide(results=None, error=None, prompt=PROMPT):
    def fake(method, path, body=None, timeout=30.0, settings=None):
        if path.startswith("/recall"):
            if error:
                raise error
            return {"ok": True, "results": results or []}
        return {"ok": True, "entries": []}

    real = rec.api.request
    rec.api.request = fake
    try:
        rec.run({"prompt": prompt, "session_id": "s1", "cwd": str(TMP)})
    finally:
        rec.api.request = real
    got = pending("claude")
    outcomes._path("claude").unlink(missing_ok=True)
    return got


check("a prompt that gets a relevant memory is noted injected", decide([GOOD]) == ["injected"])
check("a search that finds nothing good enough is noted quiet", decide([]) == ["quiet"])
check("a hit that is not relevant is noted quiet", decide([{**GOOD, "id": "a2", "relevant": False}]) == ["quiet"])
check("a memory this session already saw leaves the next prompt quiet", decide([GOOD]) == ["quiet"])
check("a network error is noted failed, not quiet", decide(error=api.NetworkError("down")) == ["failed"])
check("an API error is noted failed", decide(error=api.ApiError(500, "boom")) == ["failed"])
check("a client with no Worker notes nothing", decide(error=api.NotConfigured("no url")) == [])
check("a short prompt notes nothing, no search ran", decide([GOOD], prompt="ok thanks") == [])
check("a slash command notes nothing", decide([GOOD], prompt="/compact now please run it") == [])
check("a prompt the harness wrote notes nothing", decide([GOOD], prompt="<task-notification>background job finished with no errors today</task-notification>") == [])

# 4. End to end, two prompts through the real hook script against the fake Worker.
srv = fake_worker.start(recall=[])
cache = TMP / "e2e"
env = {k: v for k, v in os.environ.items() if not k.startswith("ANYMEM_")}
env.update(ANYMEM_URL=srv.url, ANYMEM_TOKEN=TOKEN, ANYMEM_CACHE_DIR=str(cache), ANYMEM_CONFIG_DIR=str(cache / "cfg"), HOME=str(cache / "home"), ANYMEM_PROJECT="global")
data = json.dumps({"prompt": PROMPT, "session_id": "s9", "cwd": str(TMP)})
for _ in range(2):
    subprocess.run([sys.executable, str(ROOT / "hooks" / "memory_recall.py")], input=data, capture_output=True, text=True, env=env, timeout=60)
recalls = [h for (m, p, _), h in zip(srv.requests, srv.headers) if p.startswith("/recall")]
check("the first prompt's request carries nothing, there was nothing to report", len(recalls) == 2 and "x-anymem-outcomes" not in recalls[0], str(recalls[:1]))
check("the second prompt's request reports the first one as quiet", recalls[1].get("x-anymem-outcomes") == "quiet=1", str(recalls[1]))
left = (cache / "recall-outcomes-claude.log").read_text(encoding="utf-8").split()
check("and the second decision waits for the third request", left == ["quiet"], str(left))
check("the request never carries a prompt, an id or any text", all(k.startswith(("x-anymem", "user-agent", "host", "accept", "authorization", "connection", "content", "cf-")) for k in recalls[1]) and PROMPT not in json.dumps(recalls[1]))
srv.stop()

print()
print(f"{len(failures)} failed" if failures else "ok")
sys.exit(1 if failures else 0)
