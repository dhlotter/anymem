#!/usr/bin/env python3
"""Runnable check for connection strings: `devices add --share` makes one, `connect` takes one. No network."""
from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

os.environ["ANYMEM_CONFIG_DIR"] = tempfile.mkdtemp()
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api, config, share  # noqa: E402
from hm.commands import connect, devices  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


s = share.encode("https://w.example", "tok-123", "id-1", "sec-1")
check("a connection string round trips with the Access pair", s.startswith("hm1.") and share.decode(s) == {"url": "https://w.example", "token": "tok-123", "access_client_id": "id-1", "access_client_secret": "sec-1"})
check("without Access it carries just the address and token", share.decode(share.encode("https://w.example", "tok"))["access_client_id"] == "")
check("line breaks and spaces from a paste are ignored", share.decode(s[:20] + "\n  " + s[20:] + "\n") is not None)
check("damaged, partial or foreign text is not a connection string", all(share.decode(x) is None for x in ("", "hello", "hm1.", "hm1.!!!", s[:-6], "https://w.example")))
half = share.PREFIX + __import__("base64").urlsafe_b64encode(b'{"url":"https://w","token":"t","access_client_id":"only"}').decode().rstrip("=")
check("an Access id without its secret is refused", share.decode(half) is None)

# devices add --share writes one string to a new 0600 file and prints none of it; the plain form writes the token to a file too
api.request = lambda method, path, body=None, timeout=30, settings=None: {"ok": True, "device": {"id": "dev-1", "label": "work"}, "token": "new-token-9"}
config.write_file({"url": "https://w.example", "token": "admin", "access_client_id": "id-1", "access_client_secret": "sec-1"})
before = set(config.config_dir().glob("device-*.txt"))
buf = io.StringIO()
with redirect_stdout(buf):
    devices._add("work", True)
made = [p for p in config.config_dir().glob("device-*.txt") if p not in before]
got = share.decode(made[0].read_text(encoding="utf-8")) if len(made) == 1 else None
check("devices add --share writes a string with this Worker, the new token and the Access pair to a file, and prints none of it",
      got == {"url": "https://w.example", "token": "new-token-9", "access_client_id": "id-1", "access_client_secret": "sec-1"} and "hm1." not in buf.getvalue() and "new-token-9" not in buf.getvalue())
buf = io.StringIO()
with redirect_stdout(buf):
    devices._add("work", False)
check("without --share the token goes to a file and is not printed", "new-token-9" not in buf.getvalue() and "hm1." not in buf.getvalue())

# connect accepts the string as the argument, on standard input, and refuses a damaged one
seen = {}


def worker(method, path, body=None, timeout=30, settings=None):
    seen["settings"] = settings
    if settings.token.startswith("not-the-token"):
        raise api.ApiError(401, "no")
    return {"version": "4.0.0", "vectorize": {}} if path == "/health" else {"count": 3}


def run(url, stdin=None, **kw):
    config.config_file().unlink(missing_ok=True)
    ns = argparse.Namespace(url=url, token=kw.get("token", ""), access_client_id="", access_client_secret="", token_file="", access_client_secret_file="")
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(api, "request", worker), redirect_stdout(out), redirect_stderr(err), \
            mock.patch.object(sys, "stdin", io.StringIO(stdin or "") if stdin is not None else sys.stdin):
        if stdin is not None:
            sys.stdin.isatty = lambda: False
        rc = connect.run(ns)
    return rc, out.getvalue() + err.getvalue()


rc, text = run(s)
check("a connection string given as the argument is refused, so the token never goes on the command line", rc == 1 and not config.config_file().exists() and "tok-123" not in text and "sec-1" not in text)
rc, text = run("", stdin=s + "\n")
saved = config.read_file()
check("connect reads the string from standard input: pbpaste | connect.py, saving address, token and Access pair", rc == 0 and saved["url"] == "https://w.example" and saved["token"] == "tok-123" and saved["access_client_id"] == "id-1")
check("connect never prints the token or the secret", "tok-123" not in text and "sec-1" not in text)
rc, text = run("", stdin="hm1.garbage\n")
check("a damaged string connects nothing and writes nothing", rc == 1 and "damaged or incomplete" in text and not config.config_file().exists())
rc, text = run("", stdin="")
check("an empty pipe is a plain error, not a hang or a crash", rc == 1 and not config.config_file().exists())

sys.exit(1 if failures else 0)
