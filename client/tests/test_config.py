#!/usr/bin/env python3
"""Runnable check for hm.config and hm.api. `python3 client/tests/test_config.py`, exits non-zero on failure.
No network: the REST helper's urlopen is replaced."""
from __future__ import annotations

import http.client
import http.server
import io
import json
import os
import stat
import sys
import tempfile
import threading
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api, config  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def fresh_env(**extra):
    for k in list(os.environ):
        if k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_")):
            del os.environ[k]
    tmp = tempfile.mkdtemp()
    os.environ["ANYMEM_CONFIG_DIR"] = tmp
    os.environ["ANYMEM_CACHE_DIR"] = tmp + "/cache"
    os.environ.update(extra)
    return Path(tmp)


# nothing configured
fresh_env()
s = config.load()
check("no config means not configured and nothing invented", not s.configured() and s.url == "" and s.missing() == ["url", "token"])

# environment beats file
d = fresh_env(ANYMEM_URL="https://env.example/", ANYMEM_TOKEN="env-token")
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "access_client_id": "id1", "access_client_secret": "sec1"}))
s = config.load()
check("environment wins over the file, a trailing slash is dropped", s.url == "https://env.example" and s.token == "env-token" and s.source["url"] == "env")
check("file fills what the environment lacks", s.access_client_id == "id1" and s.source["access_client_id"] == "file")
check("headers carry the bearer and both Access halves", s.headers() == {"Authorization": "Bearer env-token", "CF-Access-Client-Id": "id1", "CF-Access-Client-Secret": "sec1"})

# only one Access half is never sent
d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://x.example", "token": "t", "access_client_id": "only-id"}))
check("a lone Access half is not sent", "CF-Access-Client-Id" not in config.load(use_command=False).headers())
d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://x.example", "token": "t", "access_client_secret": "only-secret"}))
lone_secret = config.load(use_command=False).headers()
check("a lone Access secret is not sent either, and neither half is", "CF-Access-Client-Secret" not in lone_secret and "CF-Access-Client-Id" not in lone_secret)

# credential_command
check("a bare token line parses", config.parse_command_output("abc123\n") == {"token": "abc123"})
check("a JSON object with config names parses", config.parse_command_output(json.dumps({"url": "https://u.example", "token": "t"})) == {"url": "https://u.example", "token": "t"})
check("a secret manager object with env names and computed values parses",
      config.parse_command_output(json.dumps({"ANYMEM_TOKEN": {"computed": "tok", "raw": "x"}, "ANYMEM_ACCESS_CLIENT_ID": {"value": "cid"}})) == {"token": "tok", "access_client_id": "cid"})
check("empty output and multi line non JSON output give nothing, not a bogus token", config.parse_command_output("") == {} and config.parse_command_output("not json\nsecond") == {})

d = fresh_env()
cmd = f"{sys.executable} -c \"import json;print(json.dumps({{'token':'from-cmd','url':'https://c.example'}}))\""
(d / "config.json").write_text(json.dumps({"credential_command": cmd}))
s = config.load()
check("the credential command fills url and token", s.configured() and s.token == "from-cmd" and s.source["token"] == "command")

d = fresh_env(ANYMEM_URL="https://e.example", ANYMEM_TOKEN="t")
(d / "config.json").write_text(json.dumps({"credential_command": "echo SHOULD-NOT-RUN > " + str(d / "ran")}))
config.load()
check("the credential command does not run when env already has url and token", not (d / "ran").exists())

d = fresh_env()
(d / "config.json").write_text(json.dumps({"credential_command": "exit 3"}))
check("a failing credential command leaves things unconfigured, no exception", not config.load().configured())

# credential_command cache: one run serves many load() calls, across processes
def cred_setup(printed=None, **extra):
    """A temp env whose credential_command appends a line to a counter file and prints dummy credentials. Returns (dir, counter file, command)."""
    d = fresh_env(**extra)
    counter = d / "counter"
    script = d / "creds.py"
    script.write_text("import json, sys\nopen(sys.argv[1], 'a').write('x\\n')\nprint(json.dumps(%r))\n" % (printed or {"token": "cache-token", "url": "https://cache.example"}))
    cmd = f"{sys.executable} {script} {counter}"
    (d / "config.json").write_text(json.dumps({"credential_command": cmd}))
    return d, counter, cmd


def runs(counter):
    return len(counter.read_text().split()) if counter.exists() else 0


def cache_files(d):
    return sorted((d / "cache" / "credentials").glob("*.json"))


d, counter, cmd = cred_setup()
first = config.load()
for _ in range(3):
    s = config.load()
check("the credential command runs once across several load() calls", runs(counter) == 1 and s.token == "cache-token" and s.url == "https://cache.example")
check("cached values keep the command source label", s.source["token"] == "command" and first.configured())
files = cache_files(d)
check("the cache entry is mode 0600 inside a 0700 folder",
      len(files) == 1 and stat.S_IMODE(os.stat(files[0]).st_mode) == 0o600 and stat.S_IMODE(os.stat(files[0].parent).st_mode) == 0o700)
check("no temp file is left behind", [p.name for p in files[0].parent.iterdir()] == [files[0].name])

old = time.time() - 16 * 60
os.utime(files[0], (old, old))
config.load()
check("an entry older than the default 15 minutes runs the command again", runs(counter) == 2)
config.load()
check("and the refreshed entry is reused", runs(counter) == 2)

d, counter, cmd = cred_setup(ANYMEM_CRED_TTL="60")
config.load()
f = cache_files(d)[0]
os.utime(f, (time.time() - 30, time.time() - 30))
config.load()
check("ANYMEM_CRED_TTL longer than the entry age keeps it", runs(counter) == 1)
os.utime(f, (time.time() - 90, time.time() - 90))
config.load()
check("ANYMEM_CRED_TTL shorter than the entry age reruns the command", runs(counter) == 2)

d, counter, cmd = cred_setup(ANYMEM_CRED_TTL="0")
for _ in range(3):
    config.load()
check("ANYMEM_CRED_TTL=0 runs the command every time and writes nothing", runs(counter) == 3 and cache_files(d) == [])

d, counter, cmd = cred_setup(ANYMEM_CRED_TTL="soon")
config.load()
config.load()
check("a bad ANYMEM_CRED_TTL falls back to the default", runs(counter) == 1)

d, counter, cmd = cred_setup()
config.load()
os.environ["ANYMEM_CRED_TTL"] = "0"
config.load()
check("turning the cache off also removes a stored entry", cache_files(d) == [])

d = fresh_env()
counter = d / "counter"
(d / "config.json").write_text(json.dumps({"credential_command": f"echo x >> {counter}; exit 3"}))
config.load()
config.load()
check("a failing command is never kept as values, and is not run again within FAIL_TTL", runs(counter) == 1 and cache_files(d) == [])

(d / "config.json").write_text(json.dumps({"credential_command": f"echo x >> {counter}"}))
n = runs(counter)
config.load()
config.load()
check("a command that prints nothing usable is never kept as values, and is not run again within FAIL_TTL", runs(counter) == n + 1 and cache_files(d) == [])

(d / "config.json").write_text(json.dumps({"credential_command": f"echo x >> {counter}; exec sleep 5"}))
n = runs(counter)
config.load(timeout=0.3)
config.load(timeout=0.3)
check("a timed out command is never kept as values, and is not run again within FAIL_TTL", runs(counter) == n + 1 and cache_files(d) == [])
saved_fail_ttl = config.FAIL_TTL
config.FAIL_TTL = 0  # the window is over: the next load runs the command again
config.load()
check("after FAIL_TTL a failed command runs again", runs(counter) == n + 2)
config.FAIL_TTL = saved_fail_ttl

d, counter, cmd = cred_setup()
config.load()
f = cache_files(d)[0]
for junk in ("{not json", "[]", json.dumps({"token": 5}), json.dumps({"token": "t", "extra": "x"}), ""):
    f.write_text(junk)
    n = runs(counter)
    s = config.load()
    check("a corrupt cache entry falls through to the command: " + repr(junk[:12]), runs(counter) == n + 1 and s.token == "cache-token")
f.unlink()
f.mkdir()  # unreadable as a file
n = runs(counter)
s = config.load()
check("an unreadable cache entry falls through to the command", runs(counter) == n + 1 and s.token == "cache-token")
f.rmdir()

d, counter, cmd = cred_setup()
config.load()
f = cache_files(d)[0]
os.chmod(f, 0o644)
n = runs(counter)
config.load()
check("an entry that others can read is not trusted, the command runs again and the entry is rewritten at 0600",
      runs(counter) == n + 1 and stat.S_IMODE(os.stat(f).st_mode) == 0o600)
os.chmod(f.parent, 0o770)
n = runs(counter)
config.load()
check("an entry in a folder others can write to is not trusted", runs(counter) == n + 1 and stat.S_IMODE(os.stat(f.parent).st_mode) == 0o700)

d, counter, cmd = cred_setup()
config.load()
(d / "config.json").write_text(json.dumps({"credential_command": cmd + " #other"}))
s = config.load()
check("changing the command bypasses the old entry (the cache is keyed by a hash of the command)", runs(counter) == 2 and len(cache_files(d)) == 2 and s.token == "cache-token")
check("the command text is not in the cache file name", all(p.stem not in cmd for p in cache_files(d)))

d, counter, cmd = cred_setup()
config.load()
config.drop_credential_cache()
config.load()
check("drop_credential_cache makes the next load run the command", runs(counter) == 2)
config.drop_credential_cache()
config.drop_credential_cache()
check("dropping an absent entry is harmless", True)
_cmd = config.read_file().get("credential_command")
config._fail_marker(_cmd).write_text("1", encoding="utf-8")
config._cred_cache_file(_cmd).unlink(missing_ok=True)
config.drop_credential_cache()
check("a recorded failure is cleared even when there is no cache file to drop", not config._fail_marker(_cmd).exists())

d, counter, cmd = cred_setup(ANYMEM_URL="https://e.example", ANYMEM_TOKEN="t")
config.load()
check("nothing is cached when env already has url and token", runs(counter) == 0 and cache_files(d) == [])

# plugin options (hooks started by the Claude Code plugin): after env and file, before credential_command
d = fresh_env(CLAUDE_PLUGIN_OPTION_URL="https://plug.example/", CLAUDE_PLUGIN_OPTION_TOKEN="plug-token")
s = config.load(use_command=False)
check("plugin options fill url and token when env and file are empty, source label plugin",
      s.configured() and s.url == "https://plug.example" and s.token == "plug-token" and s.source["token"] == "plugin" and s.source["url"] == "plugin")

d = fresh_env(ANYMEM_TOKEN="env-token", CLAUDE_PLUGIN_OPTION_TOKEN="plug-token", CLAUDE_PLUGIN_OPTION_URL="https://plug.example")
s = config.load(use_command=False)
check("environment beats plugin options", s.token == "env-token" and s.source["token"] == "env" and s.url == "https://plug.example")

d = fresh_env(CLAUDE_PLUGIN_OPTION_URL="https://plug.example", CLAUDE_PLUGIN_OPTION_TOKEN="plug-token")
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token"}))
s = config.load(use_command=False)
check("the config file beats plugin options", s.url == "https://file.example" and s.token == "file-token" and s.source["url"] == "file")

d = fresh_env(CLAUDE_PLUGIN_OPTION_URL="   ", CLAUDE_PLUGIN_OPTION_TOKEN="")
check("blank plugin options count as unset", not config.load(use_command=False).configured())

# the address from the credential command output, ANYMEM_URL
def url_cmd(url="https://cmd.example/", token="cmd-token"):
    return f"{sys.executable} -c \"import json;print(json.dumps({{'ANYMEM_URL':'{url}','ANYMEM_TOKEN':'{token}'}}))\""


d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": url_cmd()}))
s = config.load()
check("the command url beats the config file url, a trailing slash is dropped", s.url == "https://cmd.example" and s.source["url"] == "command")
check("the token still comes from the config file when both have one", s.token == "file-token" and s.source["token"] == "file")

# no token anywhere, so the command really runs while ANYMEM_URL is set
d = fresh_env(ANYMEM_URL="https://env.example")
(d / "config.json").write_text(json.dumps({"credential_command": url_cmd()}))
s = config.load()
check("the environment url beats the command url while the command runs", s.url == "https://env.example" and s.source["url"] == "env")
check("the token comes from the command in that run", s.token == "cmd-token" and s.source["token"] == "command" and s.configured())

for slashes in ("/", "//"):
    d = fresh_env()
    (d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": url_cmd(slashes)}))
    s = config.load()
    check("a command url of %r keeps the config file url" % slashes, s.url == "https://file.example" and s.source["url"] == "file" and s.configured())
    d = fresh_env(CLAUDE_PLUGIN_OPTION_URL="https://plug.example", CLAUDE_PLUGIN_OPTION_TOKEN="plug-token")
    (d / "config.json").write_text(json.dumps({"credential_command": url_cmd(slashes)}))
    s = config.load()
    check("a command url of %r keeps the plugin option url" % slashes, s.url == "https://plug.example" and s.source["url"] == "plugin")
    d = fresh_env()
    (d / "config.json").write_text(json.dumps({"credential_command": url_cmd(slashes)}))
    s = config.load()
    check("a command url of %r with no other url leaves the address unset" % slashes, s.url == "" and "url" not in s.source)

d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": f"{sys.executable} -c \"import json;print(json.dumps({{'ANYMEM_TOKEN':'cmd-token'}}))\""}))
s = config.load()
check("a command without a url leaves the config file url alone", s.url == "https://file.example" and s.source["url"] == "file")

d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": "exit 3"}))
s = config.load()
check("a failing command falls back to the config file url", s.url == "https://file.example" and s.source["url"] == "file" and s.configured())

d = fresh_env(CLAUDE_PLUGIN_OPTION_URL="https://plug.example", CLAUDE_PLUGIN_OPTION_TOKEN="plug-token")
(d / "config.json").write_text(json.dumps({"credential_command": url_cmd()}))
s = config.load()
check("the command url beats the plugin option url", s.url == "https://cmd.example" and s.source["url"] == "command" and s.token == "plug-token")

d = fresh_env()
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": url_cmd()}))
check("use_command off leaves the config file url", config.load(use_command=False).url == "https://file.example")

d, counter, cmd = cred_setup()
(d / "config.json").write_text(json.dumps({"url": "https://file.example", "token": "file-token", "credential_command": cmd}))
config.load()
config.load()
check("the command url is cached like the rest, one run for two loads", runs(counter) == 1)

d = fresh_env(ANYMEM_URL="https://e.example", ANYMEM_TOKEN="t")
(d / "config.json").write_text(json.dumps({"credential_command": "echo SHOULD-NOT-RUN > " + str(d / "ran")}))
config.load()
check("the command does not run when env has the url and the token", not (d / "ran").exists())

# write_file
d = fresh_env()
p = config.write_file({"url": "https://w.example", "token": "secret", "empty": ""})
mode = stat.S_IMODE(os.stat(p).st_mode)
check("write_file makes the file mode 0600 and skips empty values", mode == 0o600 and "empty" not in json.loads(p.read_text()))
config.write_file({"token": "newer"})
check("write_file merges and keeps earlier keys", json.loads(p.read_text()) == {"url": "https://w.example", "token": "newer"})

# api
d = fresh_env(ANYMEM_URL="https://api.example", ANYMEM_TOKEN="tok")
seen = {}


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(req, timeout=0):
    seen["url"], seen["method"], seen["headers"], seen["data"], seen["timeout"] = req.full_url, req.get_method(), dict(req.header_items()), req.data, timeout
    return Resp(b'{"ok": true}')


api._OPENER.open = fake_urlopen
out = api.request("POST", "/capture", {"content": "hi"}, timeout=7)
check("request sends method, auth, JSON body and timeout", out == {"ok": True} and seen["method"] == "POST" and seen["headers"]["Authorization"] == "Bearer tok"
      and json.loads(seen["data"]) == {"content": "hi"} and seen["timeout"] == 7 and seen["url"] == "https://api.example/capture")

fresh_env()
try:
    api.request("GET", "/count")
    check("an unconfigured client raises NotConfigured", False)
except api.NotConfigured as e:
    check("an unconfigured client raises NotConfigured and says how to fix it", "setup" in str(e))

fresh_env(ANYMEM_URL="https://api.example", ANYMEM_TOKEN="tok")


def http_error(req, timeout=0):
    raise urllib.error.HTTPError(req.full_url, 401, "no", {}, io.BytesIO(b'{"error": "bad token"}'))


api._OPENER.open = http_error
try:
    api.request("GET", "/count")
    check("a 401 raises ApiError", False)
except api.ApiError as e:
    check("a 401 raises ApiError with the status and the Worker's message", e.status == 401 and "bad token" in e.message)


def timeout_err(req, timeout=0):
    raise urllib.error.URLError("timed out")


api._OPENER.open = timeout_err
try:
    api.request("GET", "/count")
    check("a network failure raises NetworkError", False)
except api.NetworkError:
    check("a network failure raises NetworkError", True)

# a 401 or 403 on cached credentials drops the entry, once, with no retry
for code in (401, 403, 500):
    d, counter, cmd = cred_setup()
    config.load()
    calls = []

    def refused(req, timeout=0, code=code):
        calls.append(code)
        raise urllib.error.HTTPError(req.full_url, code, "no", {}, io.BytesIO(b'{"error": "nope"}'))

    api._OPENER.open = refused
    try:
        api.request("GET", "/count")
    except api.ApiError:
        pass
    check(f"HTTP {code} with command credentials: one attempt, entry " + ("kept" if code == 500 else "dropped"),
          calls == [code] and (len(cache_files(d)) == 1) == (code == 500))
    config.load()
    check(f"HTTP {code}: the next call " + ("reuses the cache" if code == 500 else "runs the command again"), runs(counter) == (1 if code == 500 else 2))

d, counter, cmd = cred_setup()
config.load()
api._OPENER.open = fake_urlopen
for _ in range(3):
    api.request("GET", "/count")
check("three API calls through api.request run the credential command once", runs(counter) == 1)

d = fresh_env(ANYMEM_URL="https://api.example", ANYMEM_TOKEN="tok")
(d / "config.json").write_text(json.dumps({"credential_command": "echo nope"}))
os.makedirs(d / "cache" / "credentials")
keep = d / "cache" / "credentials" / "keep.json"
keep.write_text("{}")
api._OPENER.open = http_error
try:
    api.request("GET", "/count")
except api.ApiError:
    pass
check("a 401 on env credentials leaves the cache alone", keep.exists())

# ------------------------------------------------------------ the address and the reply (no redirects, https only, errors mapped)
api._OPENER.__dict__.pop("open", None)  # the stubs above replaced the opener's open: the real one again for the redirect check
check("url_problem: https anywhere, plain http only on this machine",
      config.url_problem("https://w.example") == "" and config.url_problem("http://localhost:8787") == "" and config.url_problem("http://127.0.0.1:9") == ""
      and config.url_problem("http://w.example") != "" and config.url_problem("ftp://w.example") != "" and config.url_problem("https://w example") != "")

sent = []


def record(req, timeout=0):
    sent.append(req.full_url)
    return Resp(b'{"ok": true}')


fresh_env(ANYMEM_URL="http://w.example", ANYMEM_TOKEN="tok")
api._OPENER.open = record
try:
    api.request("GET", "/count")
    check("plain http to a remote host is refused before anything is sent", False)
except api.NotConfigured as e:
    check("plain http to a remote host is refused before anything is sent", sent == [] and "https" in str(e))


api._OPENER.__dict__.pop("open", None)  # the real opener again


class Redirecting(http.server.BaseHTTPRequestHandler):
    landed = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/start":
            self.send_response(302)
            self.send_header("Location", "/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        Redirecting.landed.append(self.headers.get("Authorization"))
        body = b'{"count": 1}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirecting)
threading.Thread(target=server.serve_forever, daemon=True).start()
fresh_env(ANYMEM_URL="http://127.0.0.1:%d" % server.server_address[1], ANYMEM_TOKEN="tok-redirect")
try:
    api.request("GET", "/start")
    check("a redirect is not followed, so the token never reaches the address it names", False)
except api.ApiError as e:
    check("a redirect is not followed, so the token never reaches the address it names", e.status == 302 and Redirecting.landed == [])
server.shutdown()


def cannot_send(req, timeout=0):
    raise ValueError("token-echo-xyz")


def cut_short(req, timeout=0):
    raise http.client.IncompleteRead(b"part")


fresh_env(ANYMEM_URL="https://api.example", ANYMEM_TOKEN="tok")
for name, fake in (("a value urllib cannot send", cannot_send), ("a reply cut short", cut_short)):
    api._OPENER.open = fake
    try:
        api.request("POST", "/capture", {"content": "x"})
        check(name + " becomes NetworkError", False)
    except api.NetworkError as e:
        check(name + " becomes NetworkError, and the message names only the type", "token-echo" not in str(e) and ("ValueError" in str(e) or "IncompleteRead" in str(e)))
    except Exception as e:  # any other exception is a crash the caller does not expect
        check(name + " becomes NetworkError", False)

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
