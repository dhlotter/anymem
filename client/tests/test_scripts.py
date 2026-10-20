#!/usr/bin/env python3
"""The skill scripts, run as real processes against a local fake Worker (hm/testing/fake_worker.py) on 127.0.0.1.
`python3 client/tests/test_scripts.py`, exits non-zero on failure. No credentials, no network beyond localhost."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))
from hm.testing import fake_worker  # noqa: E402
from hm import audit  # noqa: E402

SCRIPTS = ROOT / "skills" / "anymem" / "scripts"
TOKEN = "tok-" + "z" * 20
ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
ID2 = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"
SECRET_TEXT = "my private sentence 8842"
failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


srv = fake_worker.start()
cache = tempfile.mkdtemp()
config = tempfile.mkdtemp()
BASE_ENV = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM_", "CLAUDE_"))}
ENV = {**BASE_ENV, "ANYMEM_URL": srv.url, "ANYMEM_TOKEN": TOKEN, "ANYMEM_CACHE_DIR": cache, "ANYMEM_CONFIG_DIR": config,
       "ANYMEM_PROJECT": "global", "ANYMEM_SESSION": "sess-1", "ANYMEM_HARNESS": "codex"}


def run(script, *args, stdin="", env=None):
    srv.requests.clear()
    srv.headers.clear()
    p = subprocess.run([sys.executable, str(SCRIPTS / f"{script}.py"), *args], input=stdin, capture_output=True, text=True, env={**ENV, **(env or {})}, timeout=60)
    return p.returncode, p.stdout, p.stderr


def last():
    return srv.requests[-1]


def query(path):
    return parse_qs(urlparse(path).query)


ENTRY = {"id": ID, "name": "tabs-over-spaces", "description": "d", "status": "active", "origin": "explicit", "project": "", "tags": ["x"], "recall_count": 2,
         "created_at": 1760000000000, "updated_at": 1760000000000, "content": "---\nname: tabs-over-spaces\n---\nUse tabs."}
LISTING = {"ok": True, "entries": [ENTRY, {**ENTRY, "id": ID2, "name": "other"}], "next_cursor": None}

# every job has its script, and the retired files are gone
JOBS = "recall remember get list append update status forget restore undo history link profile person usage backup devices doctor setup connect init install uninstall".split()
check("one script per job", all((SCRIPTS / f"{j}.py").exists() for j in JOBS))
check("the retired commands and files are gone", not any((ROOT / p).exists() for p in ("bin/anymem", "bin/mcp-headers", "bin/anymem-backup", "client/hm/commands/promote.py", "client/hm/commands/reject.py",
      "client/hm/commands/review.py", "client/hm/commands/_conflicts.py", "client/hm/commands/tidy.py")) and not (SCRIPTS / "promote.py").exists())
check("every script answers --help without a Worker", all(subprocess.run([sys.executable, str(SCRIPTS / f"{j}.py"), "--help"], capture_output=True, text=True, env=BASE_ENV, timeout=30).returncode == 0 for j in JOBS))

# recall
srv.replies["GET /recall"] = (200, {"ok": True, "results": [
    {"id": ID, "name": "tabs-over-spaces", "description": "the indent rule", "project": "", "content": "---\nname: x\n---\nUse tabs everywhere.", "relevant": True},
    {"id": ID2, "name": "weak-one", "description": "", "project": "demo", "content": "body", "relevant": False}]})
rc, out, err = run("recall", "what indent do I use")
q = query(last()[1])
check("recall sends the query, topK 5 and count=1, and no scope without a project", rc == 0 and q["query"] == ["what indent do I use"] and q["topK"] == ["5"] and q["count"] == ["1"] and "scope" not in q)
check("recall prints name, description and the opening of the text, and marks a weak match", "tabs-over-spaces" in out and "the indent rule" in out and "Use tabs everywhere." in out and "(weak match)" in out)
check("every call names the harness and the script in headers", srv.headers[-1]["x-anymem-script"] == "recall" and srv.headers[-1]["x-anymem-harness"] == "codex" and srv.headers[-1]["authorization"] == "Bearer " + TOKEN)
rc, out, err = run("recall", "q", "--limit", "9", env={"ANYMEM_PROJECT": "demo"})
q = query(last()[1])
check("in a project recall sends scope project:<slug>, and --limit sets topK", q["scope"] == ["project:demo"] and q["topK"] == ["9"])
rc, out, err = run("recall", "q", "--all", env={"ANYMEM_PROJECT": "demo"})
check("--all drops the scope", "scope" not in query(last()[1]))
rc, out, err = run("recall", "q", "--json")
check("--json prints the reply", json.loads(out)["results"][0]["id"] == ID)

# remember
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "tags": []})
rc, out, err = run("remember", "---\nname: a-note\ndescription: d\n---\nbody", "--tag", "alpha", "--project", "demo")
b = last()[2]
check("remember posts to /capture with source claude, harness, session, tags and project", rc == 0 and last()[1] == "/capture" and b["source"] == "claude" and b["harness"] == "codex"
      and b["session"] == "sess-1" and b["tags"] == ["alpha"] and b["project"] == "demo" and out.startswith("saved " + ID))
rc, out, err = run("remember", stdin="---\nname: from-stdin\n---\ntext")
check("remember reads standard input when there is no argument, no project means no project field", rc == 0 and "from-stdin" in last()[2]["content"] and "project" not in last()[2])
srv.replies["POST /capture"] = (200, {"ok": True, "duplicate": True, "matchId": ID2, "score": 0.97})
rc, out, err = run("remember", "x y z")
check("a duplicate is said plainly with the matching id", rc == 0 and "already stored as " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "warning": "similar", "matchId": ID2, "score": 0.9})
rc, out, err = run("remember", "x y z")
check("a similar warning names the other memory", "warning: similar to " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "replaced": {"id": ID2, "reason": "contradiction"}})
rc, out, err = run("remember", "x y z")
check("a replaced memory is announced with the undo hint", "It replaces memory " + ID2 in out and "undo.py " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "kept_both": {"id": ID2, "reason": "pinned"}})
rc, out, err = run("remember", "x y z")
check("kept_both says both stay and not to retry", "Both stay live" in out and "pinned" in out and "Do not retry" in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "canonical", "updated": True})
rc, out, err = run("remember", "x y z")
check("an in place update is said", "updated in place" in out)
srv.replies["POST /capture"] = (422, {"ok": False, "error": "no", "code": "refused", "reason": "blocked_topic"})
rc, out, err = run("remember", "x y z")
check("a refusal exits 2 and gives the reason", rc == 2 and "blocked_topic" in err)
srv.replies["POST /capture"] = (429, {"error": "slow", "code": "rate_limited", "retry_after": 120})
rc, out, err = run("remember", "x y z")
check("a rate limit exits 1 and gives the wait", rc == 1 and "120" in err)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID})
rc, out, err = run("remember", "the key is sk-" + "a1b2c3d4" * 4)
check("text that holds a secret is refused before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("remember", "keep <private>hidden part</private> visible part")
check("private text is removed before sending", "hidden part" not in last()[2]["content"] and "visible part" in last()[2]["content"])
rc, out, err = run("remember", "<private>all of it</private>")
check("a memory that is all private is not sent", rc == 2 and srv.requests == [])

# the read scripts
srv.replies["GET /list"] = (200, LISTING)
srv.replies["GET /entry"] = (200, {"ok": True, "entry": ENTRY})
COLD = {"ANYMEM_CACHE_DIR": tempfile.mkdtemp()}  # no ids printed earlier, so a prefix needs the scan
rc, out, err = run("get", ID[:8], env=COLD)
check("get resolves an id prefix through /list, then reads the entry", rc == 0 and [r[1].split("?")[0] for r in srv.requests] == ["/list", "/entry"] and query(last()[1])["id"] == [ID] and "Use tabs." in out)
rc, out, err = run("get", ID[:8])
check("a prefix of an id an earlier script printed needs no scan", rc == 0 and [r[1].split("?")[0] for r in srv.requests] == ["/entry"] and query(last()[1])["id"] == [ID])
rc, out, err = run("get", ID, "--version", "2")
check("get with a full id makes one call and passes version", [r[1].split("?")[0] for r in srv.requests] == ["/entry"] and query(last()[1])["version"] == ["2"])
rc, out, err = run("get", "ffffffff")
check("an id no memory has is a plain error", rc == 1 and "no memory with id ffffffff" in err)
srv.replies["GET /list"] = (200, {"ok": True, "entries": [{**ENTRY, "id": ID}, {**ENTRY, "id": ID[:8] + "-other"}], "next_cursor": None})
rc, out, err = run("get", ID[:8], env={"ANYMEM_CACHE_DIR": tempfile.mkdtemp()})
check("an id prefix that fits two memories asks for more of it", rc == 1 and "matches 2" in err)
srv.replies["GET /list"] = (200, LISTING)
rc, out, err = run("list", "--tag", "a", "--tag", "b", "--status", "canonical", "--origin", "capture", "--type", "user", "--project", "demo", "--days", "7", "--max-recalls", "0", "-n", "5")
q = query(last()[1])
check("list sends every filter", rc == 0 and q["tag"] == ["a", "b"] and q["status"] == ["canonical"] and q["origin"] == ["capture"] and q["type"] == ["user"] and q["project"] == ["demo"]
      and q["max_recalls"] == ["0"] and q["n"] == ["5"] and int(q["after"][0]) > 1_700_000_000_000)
check("list prints one line per memory with the full id", "tabs-over-spaces" in out and "other" in out and ID in out)
ids_file = Path(cache) / "ids.json"
check("the ids a script printed are kept locally, ids only, mode 0600", ID in json.loads(ids_file.read_text()) and stat.S_IMODE(ids_file.stat().st_mode) == 0o600 and "tabs" not in ids_file.read_text())
rc, out, err = run("list", "--deleted")
check("list --deleted reads the trash", query(last()[1])["deleted"] == ["1"])
srv.replies["GET /history"] = (200, {"ok": True, "id": ID, "versions": [{"seq": 2, "reason": "update", "at": 1760000000000, "summary": "content +12 chars"}]})
rc, out, err = run("history", ID)
check("history prints seq, reason and summary", rc == 0 and "2  " in out and "update" in out and "content +12 chars" in out)

# the write scripts
for script, args, path, body in (
    ("append", (ID, "more text"), "/append", {"id": ID, "addition": "more text"}),
    ("status", (ID, "deprecated"), "/status", {"id": ID, "status": "deprecated"}),
    ("forget", (ID,), "/forget", {"id": ID}),
    ("restore", (ID,), "/restore", {"id": ID}),
    ("undo", (ID,), "/undo", {"id": ID}),
    ("update", (ID, "new text"), "/update", {"id": ID, "content": "new text"}),
    ("link", (ID, ID2, "--type", "about_person"), "/link", {"source_id": ID, "target_id": ID2, "type": "about_person"}),
):
    srv.replies[f"POST {path}"] = (200, {"ok": True, "entry": ENTRY, "created": True})
    rc, out, err = run(script, *args)
    check(f"{script} posts {path} with the full id", rc == 0 and last()[1] == path and last()[2] == body)
rc, out, err = run("update", ID, "--tag", "a", "--tag", "b")
check("update with only --tag sends only tags", last()[2] == {"id": ID, "tags": ["a", "b"]})
rc, out, err = run("update", ID)
check("update with nothing to change is refused", rc == 2)
rc, out, err = run("append", ID, stdin="from stdin")
check("append reads standard input", last()[2]["addition"] == "from stdin")
rc, out, err = run("append", ID, "kept <private>hidden part</private> visible part")
check("append removes private text before sending", rc == 0 and "hidden part" not in last()[2]["addition"] and "visible part" in last()[2]["addition"])
rc, out, err = run("append", ID, "the key is sk-" + "a1b2c3d4" * 4)
check("append refuses text that holds a secret before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("update", ID, "keep <private>hidden part</private> visible part")
check("update removes private text before sending", rc == 0 and "hidden part" not in last()[2]["content"] and "visible part" in last()[2]["content"])
rc, out, err = run("update", ID, "<private>all of it</private>")
check("an update whose new text is all private sends nothing", rc == 2 and srv.requests == [])
rc, out, err = run("update", ID, "the key is sk-" + "a1b2c3d4" * 4)
check("update refuses text that holds a secret before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("status", ID, "draft")
check("status refuses the old draft value", rc == 2 and srv.requests == [])
srv.replies["POST /undo"] = (409, {"error": "nothing to undo", "code": "nothing_to_undo"})
rc, out, err = run("undo", ID)
check("a Worker error is one plain line and exit 1", rc == 1 and "nothing to undo" in err and "Traceback" not in err)

# profile and person read the v2 list shape
srv.replies["GET /list"] = (200, {"ok": True, "entries": [], "next_cursor": None})
rc, out, err = run("profile")
check("profile runs against a v2 list reply", rc == 0 and "no profile yet" in out)
rc, out, err = run("devices", "list")
srv.replies["GET /devices"] = (200, {"devices": [{"id": "d1", "label": "laptop", "created_at": 1, "last_used_at": None}]})
rc, out, err = run("devices", "list")
check("devices lists", rc == 0 and "laptop" in out)
rc, out, err = run("usage")
check("usage runs without a Worker call", rc == 0 and srv.requests == [])

# not configured
rc, out, err = run("recall", "q", env={"ANYMEM_URL": "", "ANYMEM_TOKEN": ""})
check("an unconfigured client says so on one line and exits 1", rc == 1 and "not configured" in err and "Traceback" not in err)

# the audit log
log = Path(cache) / "audit.log"
lines = [json.loads(x) for x in log.read_text().splitlines()]
check("the audit log has a JSON line per call, in a 0600 file", len(lines) > 30 and stat.S_IMODE(log.stat().st_mode) == 0o600)
first = next(x for x in lines if x["route"] == "/recall")
check("a line holds time, harness, script, route, ids, status and ms", set(first) >= {"ts", "harness", "script", "route", "ids", "status", "ms", "method", "session"}
      and first["harness"] == "codex" and first["script"] == "recall" and first["session"] == "sess-1" and first["status"] == 200 and ID in first["ids"])
raw = log.read_text()
check("no query string, no content and no secret is in the log", "what indent" not in raw and "?" not in raw and TOKEN not in raw and "Use tabs" not in raw and "private sentence" not in raw)
check("the failed call is logged with its status", any(x["route"] == "/undo" and x["status"] == 409 for x in lines))

# rotation
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
audit.MAX_BYTES = 2000
audit.set_origin("script", "rot", "s")
for i in range(80):
    audit.record("GET", "/recall?query=x", [ID], 200, i)
cur, old = audit.path(), audit.path().with_name("audit.log.1")
check("the log rotates at the size cap and keeps one older file", old.exists() and cur.stat().st_size <= 2200 and old.stat().st_size <= 2200 and stat.S_IMODE(old.stat().st_mode) == 0o600)
check("audit.record never raises, even when the folder cannot be written", audit.record("GET", "/x") is None)
prev_cache = os.environ.get("ANYMEM_CACHE_DIR")
os.environ["ANYMEM_CACHE_DIR"] = "/proc/none/never"
try:
    check("an unwritable cache folder is not an error", audit.record("GET", "/x") is None)
finally:
    if prev_cache is None:
        os.environ.pop("ANYMEM_CACHE_DIR", None)
    else:
        os.environ["ANYMEM_CACHE_DIR"] = prev_cache

# credential caching: the command runs once per session and the file is private
cred_dir = Path(tempfile.mkdtemp())
counter = cred_dir / "count.txt"
helper = cred_dir / "cred.py"
helper.write_text(f'import json,pathlib\np=pathlib.Path(r"{counter}")\np.write_text(str(int(p.read_text() if p.exists() else 0)+1))\nprint(json.dumps({{"url": "{srv.url}", "token": "{TOKEN}"}}))\n')
cfg = Path(tempfile.mkdtemp())
(cfg / "config.json").write_text(json.dumps({"credential_command": f"{sys.executable} {helper}"}))
CENV = {**BASE_ENV, "ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": tempfile.mkdtemp(), "ANYMEM_PROJECT": "global"}
srv.replies["GET /recall"] = (200, {"ok": True, "results": []})
outs = []
for _ in range(3):
    p = subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s1"}, timeout=60)
    outs.append(p)
check("three runs in one session call the credential command once", counter.read_text() == "1" and all(p.returncode == 0 for p in outs))
files = list((Path(CENV["ANYMEM_CACHE_DIR"]) / "credentials").glob("*.json"))
check("the cache file is mode 0600 in a 0700 folder and holds one entry", len(files) == 1 and stat.S_IMODE(files[0].stat().st_mode) == 0o600 and stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700)
check("the cached secret is never printed", all(TOKEN not in p.stdout + p.stderr for p in outs) and TOKEN not in (Path(CENV["ANYMEM_CACHE_DIR"]) / "audit.log").read_text())
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s2"}, timeout=60)
check("a new session asks again", counter.read_text() == "2" and len(list(files[0].parent.glob("*.json"))) == 2)
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s2", "ANYMEM_CRED_TTL": "0"}, timeout=60)
check("a TTL of 0 turns the cache off", counter.read_text() == "3")
old_time = os.path.getmtime(files[0]) - 5000
for f in files[0].parent.glob("*.json"):
    os.utime(f, (old_time, old_time))
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s3"}, timeout=60)
check("an expired entry is asked again and the old files are pruned", counter.read_text() == "4" and len(list(files[0].parent.glob("*.json"))) == 1)

srv.stop()
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
