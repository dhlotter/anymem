#!/usr/bin/env python3
"""Runnable check for the doctor script. `python3 client/tests/test_doctor.py`, exits non-zero on failure.
No network: hm.api.request is replaced by a fake Worker, and the probe interval and window are injected with a no-op sleep."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
from datetime import date, timedelta
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api, offline  # noqa: E402
from hm.commands import doctor  # noqa: E402
_real_copies = doctor._copies_check
doctor._copies_check = lambda *a, **k: doctor.Check('plugin copies', 'info', 'not checked in these tests')  # the machine's own installed copies must not decide a test

failures = []
TOKEN = "sk-" + "a" * 24
URL = "https://worker.test"
PID = "probe-1"


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def noop(_seconds):
    pass


def capsule(filled):
    """The shape the v2 Worker returns for GET /prompt-capsules/core: a flat list of sections with their text."""
    return {"ok": True, "sections": [{"slot": s, "content": "text for " + s, "source_id": "e-" + s, "updated_at": 1} for s in filled], "etag": "e", "chars": 10, "cap": 9500}


def capsule_old(filled):
    """The old Worker's shape, kept readable for a week of rollback. The text is a JSON string in `text`."""
    body = {"schema": "prompt-capsule.v1", "kind": "core", "sections": [{"slot": s, "content": "text for " + s} for s in filled]}
    return {"text": json.dumps(body), "sections": [{"slot": s, "sourceEntryId": "e-" + s} for s in filled]}


class FakeWorker:
    """Stands in for api.request. A behaviour value is a dict to return or an exception to raise. `recall` may be a list,
    one entry per poll, and the last entry repeats."""

    def __init__(self, **behaviour):
        self.calls = []
        self.phrase = None
        self.polls = 0
        self.vpolls = 0
        self.queries = []
        self.b = {
            "health": {"ok": True, "version": "2.0.0", "schema_version": 4, "vectorize": {"ok": True, "dimensions": 384}},
            "count": {"count": 42},
            "capsule": capsule(["identity"]),
            "capture": None,
            "recall": "dense",
            "forget": {"ok": True},
            "vprobe": None,  # POST /vectorize-probe: None is the v2 Worker's answer, an ApiError 404 is the old Worker
            "vread": "filtered",  # GET /vectorize-probe: a mode, or a list with one mode per poll, the last repeating
            "backup": {"ok": True, "backups": [], "latest": {"day": date.today().isoformat(), "entries": 42, "size": 1000, "key": "k"}},
            "subjects": api.ApiError(404, "not found"),  # GET /subjects: an older Worker has no such route
            "stats": {"count": 42, "by_status": {"active": 40, "canonical": 2}, "unvectorized": 2, "unclassified": 5,
                      "capture": {"accepted": 3, "rejected": 1, "reasons": {"secret": 1}}, "last_run": {"job": "nightly", "ok": True, "summary": {}}},
        }
        self.b.update(behaviour)

    def _answer(self, value):
        if isinstance(value, Exception):
            raise value
        return value

    def __call__(self, method, path, body=None, timeout=30, settings=None):
        self.calls.append((method, path, body))
        if path == "/health":
            return self._answer(self.b["health"])
        if path == "/count":
            return self._answer(self.b["count"])
        if path == "/prompt-capsules/core":
            return self._answer(self.b["capsule"])
        if path == "/capture":
            self.phrase = body["content"].strip().splitlines()[-1]
            return self._answer(self.b["capture"] or {"ok": True, "id": PID})
        if path.startswith("/recall?"):
            self.polls += 1
            query = parse_qs(urlsplit(path).query)
            self.queries.append(query)
            assert query["query"][0] == self.phrase, "recall must search for the probe phrase"
            mode = self.b["recall"]
            if isinstance(mode, list):
                mode = mode[min(self.polls, len(mode)) - 1]
            if isinstance(mode, Exception):
                raise mode
            if mode == "dense":
                return {"ok": True, "results": [{"id": PID, "why": {"dense_rank": 1}}]}
            if mode == "null":
                return {"ok": True, "results": [{"id": PID, "why": {"dense_rank": None}}]}
            if mode == "text-why":
                return {"ok": True, "results": [{"id": PID, "why": "dense_rank 1"}]}
            if mode == "list-why":
                return {"ok": True, "results": [{"id": PID, "why": [1]}]}
            return {"ok": True, "results": []}
        if method == "POST" and path == "/vectorize-probe":
            return self._answer(self.b["vprobe"] if self.b["vprobe"] is not None else {"ok": True, "probe": "tok-1"})
        if path.startswith("/vectorize-probe?"):
            self.vpolls += 1
            assert parse_qs(urlsplit(path).query)["probe"] == ["tok-1"], "the read must carry the id the write returned"
            mode = self.b["vread"]
            if isinstance(mode, list):
                mode = mode[min(self.vpolls, len(mode)) - 1]
            if isinstance(mode, Exception):
                raise mode
            return {"ok": True, "filtered": mode == "filtered", "unfiltered": mode in ("filtered", "unfiltered")}
        if path == "/forget":
            return self._answer(self.b["forget"])
        if path == "/stats":
            return self._answer(self.b["stats"])
        if path == "/backup":
            return self._answer(self.b["backup"])
        if path == "/subjects":
            return self._answer(self.b["subjects"])
        raise AssertionError("unexpected call %s %s" % (method, path))

    def forgets(self):
        return [c for c in self.calls if c[0] == "POST" and c[1] == "/forget"]


def fresh(configured=True):
    for k in list(os.environ):
        if k.startswith("ANYMEM_"):
            del os.environ[k]
    tmp = Path(tempfile.mkdtemp())
    os.environ["ANYMEM_CONFIG_DIR"] = str(tmp / "config")
    os.environ["ANYMEM_CACHE_DIR"] = str(tmp / "cache")
    if configured:
        os.environ["ANYMEM_URL"] = URL
        os.environ["ANYMEM_TOKEN"] = TOKEN
    return tmp


def go(worker, probe=False, as_json=False, configured=True):
    """Run the checks against the fake Worker. Returns (checks, exit code, printed output)."""
    fresh(configured)
    api.request = worker
    checks = doctor.diagnose(probe=probe, interval=10, window=90, sleep=noop)
    out = io.StringIO()
    with redirect_stdout(out):
        rc = doctor.emit(checks, as_json)
    return checks, rc, out.getvalue()


def go_with_url(worker, url, probe=False):
    """Like go(), but with the url set by hand, for urls urllib cannot parse."""
    fresh(True)
    os.environ["ANYMEM_URL"] = url
    api.request = worker
    checks = doctor.diagnose(probe=probe, interval=10, window=90, sleep=noop)
    out = io.StringIO()
    with redirect_stdout(out):
        rc = doctor.emit(checks, False)
    SCENARIOS.append(("bad url %r" % url, out.getvalue()))
    return checks, rc, out.getvalue()


def go_with_env(worker, env, probe=False):
    """Like go(), but with extra environment set by hand, for credentials that must be rejected before anything is sent."""
    fresh(True)
    os.environ.update(env)
    api.request = worker
    checks = doctor.diagnose(probe=probe, interval=10, window=90, sleep=noop)
    out = io.StringIO()
    with redirect_stdout(out):
        rc = doctor.emit(checks, False)
    SCENARIOS.append(("env %s" % ", ".join(sorted(env)), out.getvalue()))
    return checks, rc, out.getvalue()


def status(checks, name):
    return next(c for c in checks if c.name == name)


SCENARIOS = []
PLANTED = []  # the unusual credential values this file sets, for the no-secret-in-output check


def scenario(label, worker, **kw):
    checks, rc, out = go(worker, **kw)
    SCENARIOS.append((label, out))
    return checks, rc, out


# 1. green path, no probe: every check passes and the vector arm says it was not checked
w = FakeWorker()
checks, rc, out = scenario("green", w)
check("green path: every check passes", all(c.status in ("ok", "info") for c in checks))
check("green path: exit 0", rc == 0)
check("green path: verdict line", "verdict: all checks passed" in out)
check("green path: vector not checked without --probe", "vector search not checked, run doctor --probe" in out)
check("green path: no probe written without --probe", not any(c[1] == "/capture" for c in w.calls))
check("green path: count reported", status(checks, "auth").detail == "token accepted, 42 memories")

# 2. green path with --probe: the v2 Worker's vector probe, no memory written
w = FakeWorker()
checks, rc, out = scenario("probe ok", w, probe=True)
check("probe found through the filter: vector ok, exit 0", status(checks, "vector").status == "ok" and rc == 0)
check("probe writes no memory and trashes nothing, so no status:draft probe is left", not any(c[1] in ("/capture", "/forget") for c in w.calls))
check("green path: the /health version and schema are shown", "version 2.0.0, schema 4" in status(checks, "reachable").detail)

# 3. wrong token: /health answers, /count refuses
w = FakeWorker(count=api.ApiError(401, "unauthorized"))
checks, rc, out = scenario("wrong token", w)
auth = status(checks, "auth")
check("wrong token: auth fails with the fix", auth.status == "fail" and "token was rejected" in auth.detail and "connect" in auth.detail)
check("wrong token: capsule skipped", status(checks, "capsule").status == "skip")
check("wrong token: exit 1", rc == 1)

# 4. unreachable: the network fails on the first call, nothing else is attempted
w = FakeWorker(health=api.NetworkError("timed out"))
checks, rc, out = scenario("unreachable", w)
check("unreachable: reachable fails with the url and the cause", status(checks, "reachable").status == "fail" and "timed out" in status(checks, "reachable").detail)
check("unreachable: only /health was called", [c[1] for c in w.calls] == ["/health"])
check("unreachable: auth skipped", status(checks, "auth").status == "skip")
check("unreachable: exit 1 with no traceback", rc == 1 and "Traceback" not in out)

# 5. empty capsule is a warning, not a failure
w = FakeWorker(capsule=capsule([]))
checks, rc, out = scenario("empty capsule", w)
check("empty capsule: warning", status(checks, "capsule").status == "warn")
check("empty capsule: exit 0", rc == 0)
check("empty capsule: verdict says warnings", "passing with 1 warning" in out)

# 6. unsaved failures are listed with the count and the newest reason
fresh(True)
offline.record_failure("capture", "network: timed out", {"name": "a", "content": "first"})
offline.record_failure("capture", "HTTP 500: internal error", {"name": "b", "content": "second"})
api.request = FakeWorker()
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
unsaved = status(checks, "unsaved")
check("unsaved: warning with the count", unsaved.status == "warn" and "2 unsaved memories" in unsaved.detail)
check("unsaved: newest reason shown", "HTTP 500: internal error" in unsaved.detail and "network: timed out" not in unsaved.detail)
with redirect_stdout(io.StringIO()):
    unsaved_rc = doctor.emit(checks, False)
check("unsaved: exit 0 (a warning)", unsaved_rc == 0)

# 7. /health fields: a vector index with the wrong size is a warning that names the fix, an old Worker's bare /health is still reachable
w = FakeWorker(health={"ok": True, "version": "2.0.0", "schema_version": 4, "vectorize": {"ok": False, "dimensions": 768}})
checks, rc, out = scenario("vectorize wrong size", w)
check("health: vectorize not ok warns with the dimensions found, exit 0", status(checks, "reachable").status == "warn" and "768" in status(checks, "reachable").detail and rc == 0)
checks, rc, out = scenario("old health", FakeWorker(health={"ok": True}))
check("health: an old Worker's bare reply is reachable and ok", status(checks, "reachable").status == "ok" and "version" not in status(checks, "reachable").detail)

# 8. the old capsule shape is still read, and an empty flat capsule is a warning
checks, rc, out = scenario("old capsule", FakeWorker(capsule=capsule_old(["identity", "preferences"])))
check("capsule: the old Worker's JSON string shape is read", status(checks, "capsule").status == "ok" and "2 of 4" in status(checks, "capsule").detail)
checks, rc, out = scenario("capsule v2", FakeWorker(capsule=capsule(["identity", "preferences", "principles"])))
check("capsule: the flat v2 shape is read", status(checks, "capsule").status == "ok" and "3 of 4" in status(checks, "capsule").detail)
checks, rc, out = scenario("capsule odd", FakeWorker(capsule={"ok": True}))
check("capsule: a reply with no sections at all is a failure", status(checks, "capsule").status == "fail")

# 11. --json prints one valid JSON object with the same verdict
w = FakeWorker()
checks, rc, out = scenario("json", w, as_json=True)
parsed = json.loads(out)
check("json: valid JSON object", isinstance(parsed, dict) and parsed["verdict"] == "pass")
check("json: each check has name, status and detail", all({"name", "status", "detail"} <= set(c) for c in parsed["checks"]))
check("json: exit 0", rc == 0)

# 12. unconfigured: exit 1 with the setup hint, no network call, no traceback
w = FakeWorker()
checks, rc, out = scenario("unconfigured", w, configured=False)
check("unconfigured: config fails with the setup hint", status(checks, "config").status == "fail"
      and "run setup or connect" in status(checks, "config").detail)
check("unconfigured: no network call", w.calls == [])
check("unconfigured: exit 1, no traceback", rc == 1 and "Traceback" not in out)

# 12b. the config line says where the address came from
w = FakeWorker()
checks, rc, out = scenario("config source env", w)
check("config line: url and token from the environment", "url from the environment; token from the environment" in status(checks, "config").detail)
fresh(False)
tmp = Path(os.environ["ANYMEM_CONFIG_DIR"])
tmp.mkdir(parents=True)
(tmp / "config.json").write_text(json.dumps({"url": URL, "token": TOKEN}))
api.request = FakeWorker()
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
check("config line: url and token from config.json", "url from config.json; token from config.json" in status(checks, "config").detail)
(tmp / "config.json").write_text(json.dumps({"url": URL, "token": TOKEN, "credential_command": sys.executable + " -c \"import json;print(json.dumps({'ANYMEM_URL': '" + URL + "'}))\""}))
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
check("config line: a url from the credential command is named as such", "url from the credential command; token from config.json" in status(checks, "config").detail)

# 13. the run entry point returns the same exit codes, and no secret reaches any output
fresh(True)
api.request = FakeWorker()
out = io.StringIO()
with redirect_stdout(out):
    rc = doctor.run(SimpleNamespace(probe=True, json_out=False), interval=10, window=90, sleep=noop)
SCENARIOS.append(("run entry", out.getvalue()))
check("run entry point: exit 0 on a green probe", rc == 0)

# 14. a url urllib cannot parse: config fails with the fix, nothing is sent, no traceback, even with --probe
for bad in ("garbage", "https://worker .test", "https://[::1", "https://worker.test:abc"):
    w = FakeWorker()
    checks, rc, out = go_with_url(w, bad, probe=True)
    config_check = status(checks, "config")
    check("bad url %r: config fails with the fix" % bad, config_check.status == "fail" and "must start with https://" in config_check.detail)
    check("bad url %r: no request is sent" % bad, w.calls == [])
    check("bad url %r: exit 1, no traceback, verdict printed" % bad, rc == 1 and "Traceback" not in out and "verdict: " in out)

# 16. a Worker or proxy error that echoes a secret: every detail is scrubbed before it prints
w = FakeWorker(count=api.ApiError(500, "upstream echoed " + TOKEN))
checks, rc, out = scenario("token echoed by count", w)
check("echoed token in an HTTP error: auth detail redacted", TOKEN not in status(checks, "auth").detail
      and "[redacted]" in status(checks, "auth").detail)

w = FakeWorker(health=api.NetworkError("proxy said " + TOKEN))
checks, rc, out = scenario("token echoed by health", w)
check("echoed token in a network error: reachable detail redacted", TOKEN not in status(checks, "reachable").detail)

w = FakeWorker(vprobe=api.ApiError(500, "boom " + TOKEN))
checks, rc, out = scenario("token echoed by the probe", w, probe=True)
check("echoed token in the probe error: vector detail redacted", TOKEN not in status(checks, "vector").detail and "[redacted]" in status(checks, "vector").detail)

# the Access service token secret is scrubbed the same way
fresh(True)
ACCESS_SECRET = "cf-secret-" + "b" * 16
os.environ["ANYMEM_ACCESS_CLIENT_ID"] = "cf-id"
os.environ["ANYMEM_ACCESS_CLIENT_SECRET"] = ACCESS_SECRET
api.request = FakeWorker(count=api.ApiError(500, "refused for " + ACCESS_SECRET))
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
out = io.StringIO()
with redirect_stdout(out):
    doctor.emit(checks, False)
SCENARIOS.append(("access secret echoed", out.getvalue()))
check("echoed Access secret: scrubbed from the auth line", ACCESS_SECRET not in out.getvalue()
      and "[redacted]" in status(checks, "auth").detail)

# 17. a credential that cannot go into an HTTP header (a line break, or a character outside latin-1): config fails before
# any request, the fix is printed, and the value is never printed
BAD_LINE = "abc\ndef-line-secret"
BAD_EURO = "eur-euro-secret€"
BAD_ELLIPSIS = "cf-id-ellipsis-secret…"
PLANTED += ["line-secret", "euro-secret", "ellipsis-secret"]
UNSENDABLE = (
    ("token with a line break", {"ANYMEM_TOKEN": BAD_LINE}, "line-secret"),
    ("token with a euro sign", {"ANYMEM_TOKEN": BAD_EURO}, "euro-secret"),
    ("access secret with a line break", {"ANYMEM_ACCESS_CLIENT_ID": "cf-id",
                                         "ANYMEM_ACCESS_CLIENT_SECRET": BAD_LINE}, "line-secret"),
    ("access client id with an ellipsis", {"ANYMEM_ACCESS_CLIENT_ID": BAD_ELLIPSIS,
                                           "ANYMEM_ACCESS_CLIENT_SECRET": "cf-secret-" + "4" * 16}, "ellipsis-secret"),
)
for label, env, tail in UNSENDABLE:
    w = FakeWorker()
    checks, rc, out = go_with_env(w, env, probe=True)
    config_check = status(checks, "config")
    check("unsendable %s: config fails with the fix" % label, config_check.status == "fail"
          and "cannot be sent" in config_check.detail and "connect again" in config_check.detail)
    check("unsendable %s: no request is sent, even with --probe" % label, w.calls == [])
    check("unsendable %s: the value is not printed, exit 1, verdict printed" % label,
          rc == 1 and "verdict: " in out and tail not in out and "Traceback" not in out)

# 17b. the nightly backup from GET /backup: ok when recent, skip on 403, warn when off (404), missing, stale or unreachable
w = FakeWorker()
checks, rc, out = scenario("backup ok", w)
check("backup: a recent backup is ok with its date and count", status(checks, "backup").status == "ok" and "42 memories" in status(checks, "backup").detail and rc == 0)
old = (date.today() - timedelta(days=5)).isoformat()
w = FakeWorker(backup={"ok": True, "backups": [], "latest": {"day": old, "entries": 40}})
checks, rc, out = scenario("backup stale", w)
check("backup: older than 2 days warns with the age and a fix", status(checks, "backup").status == "warn" and "5 days old" in status(checks, "backup").detail and "Fix:" in status(checks, "backup").detail and rc == 0)
w = FakeWorker(backup={"ok": True, "backups": [], "latest": None})
checks, rc, out = scenario("backup none yet", w)
check("backup: none yet warns, not fails", status(checks, "backup").status == "warn" and "no nightly backup yet" in status(checks, "backup").detail and rc == 0)
w = FakeWorker(backup=api.ApiError(403, "forbidden"))
checks, rc, out = scenario("backup 403", w)
check("backup HTTP 403: skip with the admin hint", status(checks, "backup").status == "skip" and "admin token" in status(checks, "backup").detail and rc == 0)
w = FakeWorker(backup=api.ApiError(404, "No BACKUP_BUCKET binding"))
checks, rc, out = scenario("backup 404", w)
check("backup HTTP 404: warns that backups are off with the fix", status(checks, "backup").status == "warn" and "BACKUP_BUCKET" in status(checks, "backup").detail and rc == 0)
w = FakeWorker(backup=api.NetworkError("boom"))
checks, rc, out = scenario("backup network", w)
check("backup network error: warning, exit 0", status(checks, "backup").status == "warn" and rc == 0)

# 18. usage counts from GET /stats: info with the counts, skip on 403 or 404 (the route is admin only), warn on anything else
w = FakeWorker()
checks, rc, out = scenario("usage counts", w)
check("usage: counts, today's capture and the last nightly job shown as info", status(checks, "usage").status == "info"
      and status(checks, "usage").detail == "42 memories, 2 not vectorized, 5 not classified; capture today 3 saved, 1 refused; last nightly job ok")
w = FakeWorker(stats={"count": 42, "last_run": {"job": "nightly", "ok": False}})
checks, rc, out = scenario("usage last run failed", w)
check("usage: a failed nightly job is a warning that points at the dashboard, exit 0", status(checks, "usage").status == "warn" and "FAILED" in status(checks, "usage").detail and rc == 0)
w = FakeWorker(stats={"count": 7})
checks, rc, out = scenario("usage old shape", w)
check("usage: an old Worker's /stats still reads", status(checks, "usage").status == "info" and status(checks, "usage").detail == "7 memories, 0 not vectorized, 0 not classified")
check("usage: exit 0", rc == 0)
for code in (403, 404):
    w = FakeWorker(stats=api.ApiError(code, "admin only"))
    checks, rc, out = scenario("usage %d" % code, w)
    check("usage HTTP %d: skip with the admin hint, not a failure, exit 0" % code,
          status(checks, "usage").status == "skip" and "admin token" in status(checks, "usage").detail and rc == 0)
w = FakeWorker(stats=api.ApiError(500, "boom"))
checks, rc, out = scenario("usage 500", w)
check("usage HTTP 500: warning, exit 0", status(checks, "usage").status == "warn" and rc == 0)
w = FakeWorker(stats=api.NetworkError("connection reset"))
checks, rc, out = scenario("usage network", w)
check("usage network error: warning, exit 0", status(checks, "usage").status == "warn" and rc == 0)
w = FakeWorker(stats=["not", "a", "dict"])
checks, rc, out = scenario("usage odd shape", w)
check("usage unexpected shape: warning, no crash", status(checks, "usage").status == "warn" and rc == 0)
w = FakeWorker(health=api.NetworkError("timed out"))
checks, rc, out = scenario("usage skipped when unreachable", w)
check("usage skipped when unreachable: no /stats call", status(checks, "usage").status == "skip" and not any(c[1] == "/stats" for c in w.calls))

# 19. subjects from GET /subjects: one info line with the counts, and no line at all when the Worker does not answer
w = FakeWorker(subjects={"ok": True, "subjects": [{"slug": "pip", "status": "active", "scope": "private"}, {"slug": "corolla", "status": "active", "scope": "shared"},
                                                   {"slug": "old-cat", "status": "retired", "scope": "private"}]})
checks, rc, out = scenario("subjects", w)
check("subjects: one info line with the active and the private count, exit 0", status(checks, "subjects").status == "info" and status(checks, "subjects").detail == "2 active, 2 private"
      and "info  subjects       2 active, 2 private" in out and rc == 0)
w = FakeWorker(subjects={"ok": True, "subjects": []})
checks, rc, out = scenario("subjects none", w)
check("subjects: a Worker with none says 0 active, 0 private", status(checks, "subjects").detail == "0 active, 0 private")
for label, answer in (("older Worker", api.ApiError(404, "not found")), ("token may not read", api.ApiError(403, "forbidden")), ("error", api.ApiError(500, "boom")),
                      ("network", api.NetworkError("reset")), ("odd shape", ["not", "a", "dict"]), ("no list", {"ok": True})):
    w = FakeWorker(subjects=answer)
    checks, rc, out = scenario("subjects " + label, w)
    check("subjects (%s): no line at all and exit 0" % label, not any(c.name == "subjects" for c in checks) and "subjects" not in out and rc == 0)
w = FakeWorker(health=api.NetworkError("timed out"), subjects={"ok": True, "subjects": []})
checks, rc, out = scenario("subjects skipped when unreachable", w)
check("subjects: not asked when the Worker is unreachable", not any(c.name == "subjects" for c in checks) and not any(c[1] == "/subjects" for c in w.calls))

# a one-letter token is too short to scrub: the fix text must come out intact
fresh(True)
os.environ["ANYMEM_URL"] = "garbage"
os.environ["ANYMEM_TOKEN"] = "x"
api.request = FakeWorker()
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
check("short token: the fix text is printed intact", "Fix: the url must start with https://" in status(checks, "config").detail
      and "[redacted]" not in status(checks, "config").detail)

# the vector probe: no memory is written, so there is nothing to trash and no duplicate check to trip
w = FakeWorker(vprobe=None)
checks, rc, out = scenario("vector probe ok", w, probe=True)
check("vector probe: found through the filter is ok and exits 0", status(checks, "vector").status == "ok" and rc == 0)
check("vector probe: no memory is written and nothing is trashed", not any(c[1] in ("/capture", "/forget") for c in w.calls))
check("vector probe: no probe cleanup line, there is nothing to clean up", not any(c.name == "probe cleanup" for c in checks))
w = FakeWorker(vprobe=None, vread=["none", "none", "filtered"])
checks, rc, out = scenario("vector probe slow", w, probe=True)
check("vector probe: polls until the vector is searchable", status(checks, "vector").status == "ok" and w.vpolls == 3)
w = FakeWorker(vprobe=None, vread="unfiltered")
checks, rc, out = scenario("vector probe unfiltered only", w, probe=True)
check("vector probe: found without the filter only gives the metadata index fix",
      status(checks, "vector").status == "fail" and status(checks, "vector").detail == doctor.VECTOR_FIX and "project" in doctor.VECTOR_FIX and "workspace_id" not in doctor.VECTOR_FIX and rc == 1)
w = FakeWorker(vprobe=None, vread="none")
checks, rc, out = scenario("vector probe never found", w, probe=True)
check("vector probe: found nowhere is a warning, exit 0, and does not blame the metadata index",
      status(checks, "vector").status == "warn" and "not searchable" in status(checks, "vector").detail
      and "metadata index" not in status(checks, "vector").detail and rc == 0)
w = FakeWorker(vprobe=api.ApiError(500, "embedder down"))
checks, rc, out = scenario("vector probe start fails", w, probe=True)
check("vector probe: a failed start is a failure with the reason, no fallback to the memory probe",
      status(checks, "vector").status == "fail" and "embedder down" in status(checks, "vector").detail and not any(c[1] == "/capture" for c in w.calls))
w = FakeWorker(vprobe=None, vread=api.NetworkError("connection reset"))
checks, rc, out = scenario("vector probe read fails", w, probe=True)
check("vector probe: a failed read is a failure with the reason",
      status(checks, "vector").status == "fail" and "connection reset" in status(checks, "vector").detail)
w = FakeWorker(vprobe={"ok": True})
checks, rc, out = scenario("vector probe no token", w, probe=True)
check("vector probe: a reply without an id is a failure", status(checks, "vector").status == "fail" and "did not return an id" in status(checks, "vector").detail)
w = FakeWorker(vprobe=api.ApiError(404, "not found"))
checks, rc, out = scenario("old worker", w, probe=True)
check("old Worker: a 404 on the probe route is a skip, no memory probe is written", status(checks, "vector").status == "skip" and not any(c[1] == "/capture" for c in w.calls) and rc == 0)
w = FakeWorker(vprobe=None)
checks, rc, out = scenario("vector probe repeated", w, probe=True)
checks, rc, out = scenario("vector probe repeated again", w, probe=True)
check("vector probe: a second run on the same Worker passes too", status(checks, "vector").status == "ok" and rc == 0)

# a leftover old variable fails loudly and names the new one
fresh(False)
os.environ["HARNESS_MEMORY_URL"] = URL
api.request = FakeWorker()
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
check("old variables: config fails and names ANYMEM_URL and ANYMEM_TOKEN",
      status(checks, "config").status == "fail" and "ANYMEM_URL" in status(checks, "config").detail and "not read" in status(checks, "config").detail)
fresh(False)
os.environ.pop("HARNESS_MEMORY_URL", None)  # fresh() only clears ANYMEM_*, the old name is not its business
checks = doctor.diagnose(probe=False, interval=10, window=90, sleep=noop)
check("no old variables: the config message does not mention them", "HARNESS_MEMORY" not in status(checks, "config").detail)

leaks = [label for label, text in SCENARIOS if any(v in text for v in [TOKEN] + PLANTED) or "Bearer" in text]
check("no secret appears in any output: %s" % (leaks or "none"), not leaks)

# plugin copies: a stale cached copy of the hooks is a warning, a matching one is ok
import pathlib, shutil
_home = pathlib.Path(tempfile.mkdtemp())
_hooks = _home / ".claude/plugins/cache/anymem/anymem/1.0.1/hooks"
_hooks.mkdir(parents=True)
for _f in doctor.HOOK_FILES:
    shutil.copy(pathlib.Path(doctor.__file__).resolve().parents[3] / "hooks" / _f, _hooks / _f)
check("plugin copies: a copy identical to the repo is ok", _real_copies(home=_home).status == "ok")
(_hooks / "memory_capture.py").write_text("an older copy")
_c = _real_copies(home=_home)
check("plugin copies: a differing copy warns and names the tool and the fix", _c.status == "warn" and "Claude Code" in _c.detail and "plugin update" in _c.detail)
_skill = _hooks.parent / "skills/anymem"
_skill.mkdir(parents=True)
_repo_skill = pathlib.Path(doctor.__file__).resolve().parents[3] / doctor.SKILL_FILE
(_hooks / "memory_capture.py").write_bytes((pathlib.Path(doctor.__file__).resolve().parents[3] / "hooks/memory_capture.py").read_bytes())
shutil.copy(_repo_skill, _skill / "SKILL.md")
check("plugin copies: hooks and skill both identical is ok", _real_copies(home=_home).status == "ok")
(_skill / "SKILL.md").write_text("an older skill")
_c = _real_copies(home=_home)
check("plugin copies: a stale skill alone warns", _c.status == "warn" and "skill" in _c.detail)
check("plugin copies: no installed copies is info, not a failure", _real_copies(home=pathlib.Path(tempfile.mkdtemp())).status == "info")

import argparse
_parser = argparse.ArgumentParser()
doctor.register(_parser)
_help = next(x.help for x in _parser._actions if "--probe" in x.option_strings)
check("probe help states the real wait and that no memory is written", doctor.PROBE_WINDOW == 180.0 and "3 minutes" in _help and "not a memory" in _help)

if failures:
    print("%d doctor check(s) failed: %s" % (len(failures), ", ".join(failures)))
    sys.exit(1)
print("all doctor checks passed")
