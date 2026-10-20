#!/usr/bin/env python3
"""Runnable check for the connect script. No network. `python3 client/tests/test_connect.py`, exits non-zero on failure."""
from __future__ import annotations

import argparse
import contextlib
import io
import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))

for key in list(os.environ):
    if key.startswith("ANYMEM_") or key.startswith("CLOUDFLARE_"):
        del os.environ[key]

from hm import api, config  # noqa: E402
from hm.commands import connect  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def args(**kw):
    """The arguments connect.run gets from its parser: every option at its default unless the test sets it."""
    return argparse.Namespace(**{"url": "", "token": "", "access_client_id": "", "access_client_secret": "", "token_file": "", "access_client_secret_file": "", **kw})


class Env:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ.update(ANYMEM_CONFIG_DIR=str(self.tmp / "cfg"), ANYMEM_CACHE_DIR=str(self.tmp / "cache"))


def capture(fn, *a, **kw):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = fn(*a, **kw)
    return rc, out.getvalue(), err.getvalue()


def mode(path) -> int:
    return stat.S_IMODE(os.stat(str(path)).st_mode)


def worker_reply(good_token, health_shape=True):
    """A stand in for the real Worker: refuses any token but good_token with 401, answers /health and /count in its real shape."""
    def reply(method, path, body=None, timeout=30.0, settings=None):
        if settings.token != good_token:
            raise api.ApiError(401, "unauthorized")
        if path == "/health":
            if not health_shape:
                raise api.ApiError(404, "not found")
            return {"ok": True, "version": "3.0.0", "vectorize": {"ok": True}, "team": False}
        return {"count": 1}
    return reply


# ----------------------------------------------------------------------- connect
e = Env()


def reject(method, path, body=None, timeout=30.0, settings=None):
    raise api.ApiError(401, "unauthorized")


secret = "sk-" + "a" * 24
with mock.patch.object(api, "request", reject):
    rc, out, err = capture(connect.run, args(url="https://w.example", token=secret, access_client_id="", access_client_secret=""))
check("connect refuses a wrong token and writes nothing", rc == 1 and not config.config_file().exists() and "rejected that token" in err and "Nothing was saved" in err)
check("connect never prints the token", secret not in out + err)


def unreachable(method, path, body=None, timeout=30.0, settings=None):
    raise api.NetworkError("connection refused")


with mock.patch.object(api, "request", unreachable):
    rc, out, err = capture(connect.run, args(url="https://w.example", token=secret, access_client_id="", access_client_secret=""))
check("connect writes nothing when the Worker cannot be reached", rc == 1 and not config.config_file().exists() and "could not reach" in err)
rc, out, err = capture(connect.run, args(url="ftp://nope", token=secret, access_client_id="", access_client_secret=""))
check("connect refuses something that is not a Worker address", rc == 1 and not config.config_file().exists())
rc, out, err = capture(connect.run, args(url="https://w.example", token=secret, access_client_id="id-only", access_client_secret=""))
check("connect refuses half an Access pair", rc == 1 and not config.config_file().exists())
paths = []


def accept(method, path, body=None, timeout=30.0, settings=None):
    paths.append((path, dict(settings.headers())))
    return worker_reply(secret)(method, path, body, timeout, settings)


with mock.patch.object(api, "request", accept), mock.patch("getpass.getpass", return_value=secret):
    rc, out, err = capture(connect.run, args(url="https://w.example/", token="", access_client_id="cid", access_client_secret="csecret"))
cfg = config.read_file()
check("connect with the right token checks /health, prompts hidden, then writes the config at 0600",
      rc == 0 and paths[0][0] == "/health" and cfg == {"url": "https://w.example", "token": secret, "access_client_id": "cid", "access_client_secret": "csecret"} and mode(config.config_file()) == 0o600)
check("connect sends the Access headers when given and prints no secret", paths[0][1].get("CF-Access-Client-Id") == "cid" and secret not in out + err and "csecret" not in out + err)


with mock.patch.object(api, "request", worker_reply(secret, health_shape=False)):
    rc, out, err = capture(connect.run, args(url="https://w2.example", token=secret, access_client_id="", access_client_secret=""))
check("connect falls back to /count when /health is missing", rc == 0 and config.read_file()["url"] == "https://w2.example")


def open_door(method, path, body=None, timeout=30.0, settings=None):
    return {"ok": True}  # not a Worker: answers 200 to everything, token or not


with mock.patch.object(api, "request", open_door):
    rc, out, err = capture(connect.run, args(url="https://w3.example", token=secret, access_client_id="", access_client_secret=""))
check("connect refuses a server that answers 200 without the Worker's shape and saves nothing", rc == 1 and "not the way a Anymem Worker" in err and "Nothing was saved" in err
      and config.read_file().get("url") == "https://w2.example")


def no_auth_worker(method, path, body=None, timeout=30.0, settings=None):
    return {"ok": True, "version": "3.0.0", "vectorize": {"ok": True}} if path == "/health" else {"count": 2}  # right shape, never checks the token


with mock.patch.object(api, "request", no_auth_worker):
    rc, out, err = capture(connect.run, args(url="https://w4.example", token=secret, access_client_id="", access_client_secret=""))
check("connect refuses a server with the right shape that accepts any token", rc == 1 and "accepted a made up token" in err and config.read_file().get("url") == "https://w2.example" and secret not in out + err)


# ------------------------------------------------------------ the secrets never come from the command line (#41)
parser = argparse.ArgumentParser()
connect.register(parser)
with contextlib.redirect_stderr(io.StringIO()):
    try:
        parser.parse_args(["https://w.example", "--token", secret])
        check("connect has no --token flag, so a token on the command line is an error", False)
    except SystemExit:
        check("connect has no --token flag, so a token on the command line is an error", True)

before = config.read_file()
rc, out, err = capture(connect.run, args(url="hm1." + "b" * 60))
check("a connection string given as the argument is refused and nothing is saved", rc == 1 and config.read_file() == before and "Pipe it in" in err)

tokdir = Path(tempfile.mkdtemp())
tokfile = tokdir / "token"
tokfile.write_text(secret + "\n", encoding="utf-8")
os.chmod(tokfile, 0o600)
with mock.patch.object(api, "request", worker_reply(secret)):
    rc, out, err = capture(connect.run, args(url="https://w.example", token_file=str(tokfile)))
check("connect reads the token from a file and saves it", rc == 0 and config.read_file()["token"] == secret and secret not in out + err)

rc, out, err = capture(connect.run, args(url="https://w.example", token_file=str(tokdir / "missing")))
check("a token file that cannot be read stops the connect, and the message does not print the path", rc == 1 and "could not read the file" in err and "missing" not in err and "Nothing was saved" in err)

accfile = tokdir / "access"
accfile.write_text("csecret\n", encoding="utf-8")
with mock.patch.object(api, "request", worker_reply(secret)):
    rc, out, err = capture(connect.run, args(url="https://w.example", token=secret, access_client_id="cid", access_client_secret_file=str(accfile)))
check("the Access secret comes from a file, and is saved and never printed", rc == 0 and config.read_file().get("access_client_secret") == "csecret" and "csecret" not in out + err)

with mock.patch("getpass.getpass", side_effect=EOFError):
    rc, out, err = capture(connect.run, args(url="https://w.example"))
check("with no terminal the message points at the file option, not at a flag that takes the secret", rc == 1 and "--token-file" in err and "Pass --token," not in err)

os.environ["ANYMEM_TOKEN"] = "env-token-value"
with mock.patch.object(api, "request", worker_reply(secret)):
    rc, out, err = capture(connect.run, args(url="https://w.example", token=secret))
del os.environ["ANYMEM_TOKEN"]
check("connect warns when the environment still overrides the token it just saved, and prints neither value", rc == 0 and "token comes from the environment" in err and "env-token-value" not in out + err and secret not in out + err)

print("ok" if not failures else "%d failed" % len(failures))
sys.exit(1 if failures else 0)
