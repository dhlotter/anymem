"""`connect.py <url>`: point this machine at a Worker that already exists, after proving the token works."""
from __future__ import annotations

import argparse
import getpass
import re
import secrets
import sys

from hm import api, config, scripts, share

COMMAND = "connect"
HELP = "point this machine at an existing Anymem Worker (checks the token before saving anything)"


class _Refused(argparse.Action):
    """A secret flag that is refused. The value is never stored, and argparse's error does not echo it."""

    def __call__(self, parser, namespace, values, option_string=None):
        parser.error("%s is refused, the secret never goes on the command line. Use the file option, or pipe a connection string in." % option_string)


def register(parser):
    parser.add_argument("url", nargs="?", default="", help="the Worker address. A connection string is never taken from the command line: left out, it is read from standard input (`pbpaste | python3 connect.py`) or asked for without echo")
    parser.add_argument("--token", action=_Refused, nargs="?", help=argparse.SUPPRESS)
    parser.add_argument("--access-client-secret", action=_Refused, nargs="?", help=argparse.SUPPRESS)
    parser.add_argument("--token-file", default="", dest="token_file", help="a file holding the Worker's token (its first line), so the token never goes on the command line")
    parser.add_argument("--access-client-id", default="", dest="access_client_id", help="Cloudflare Access service token id, only if Access is in front")
    parser.add_argument("--access-client-secret-file", default="", dest="access_client_secret_file", help="a file holding the Cloudflare Access service token secret (its first line)")


def _secret_from_file(path: str) -> "tuple[str, str]":
    """(first non-empty line of the file, "") or ("", reason). The secret and the path are never printed."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    return line.strip(), ""
    except (OSError, UnicodeError):
        return "", "could not read the file"  # the path is not printed: a mistyped secret would land in the transcript
    return "", "the file holds no value"


def _clean_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if re.match(r"https://[^/\s]+$", url) or re.match(r"http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", url):
        return url
    return ""


def _worker_shaped(path: str, data) -> bool:
    """What our Worker answers: /health has a version string and a vectorize object, /count has an integer count."""
    if not isinstance(data, dict):
        return False
    if path == "/health":
        return isinstance(data.get("version"), str) and isinstance(data.get("vectorize"), dict)
    count = data.get("count")
    return isinstance(count, int) and not isinstance(count, bool)


def _accepts_any_token(url: str, path: str, settings) -> str:
    """Ask again with a made up token. Our Worker refuses it, so a 2xx here means this address does not check tokens at all and is
    not a Anymem Worker (or has no lock on it). Returns "" when the address behaves, else the reason to give up."""
    bogus = config.Settings(url=settings.url, token="not-the-token-" + secrets.token_hex(8),
                            access_client_id=settings.access_client_id, access_client_secret=settings.access_client_secret)
    try:
        api.request("GET", path, timeout=20, settings=bogus)
    except api.ApiError as e:
        if e.status in (401, 403):
            return ""
        return "the Worker at %s answered a wrong token with HTTP %d instead of refusing it" % (url, e.status)
    except api.NetworkError as e:
        return "could not finish checking %s (%s)" % (url, e)
    return "the address %s accepted a made up token, so it does not check tokens and cannot be a Anymem Worker" % url


def _from_string(ns):
    """Fill the address, token and Access pair from a connection string given as the argument, on standard input, or typed. Returns an
    error line, or "" when there is nothing wrong. Values given as flags win over the string."""
    raw = ns.url or ""
    if not raw and not ns.token and not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
    if not raw and not ns.token:
        try:
            raw = getpass.getpass("Paste the connection string, or type the Worker address (input is hidden): ").strip()
        except (EOFError, KeyboardInterrupt):
            return "Nothing to connect with (no terminal to ask on). Pipe the connection string in: pbpaste | " + scripts.cmd("connect")
    if raw.startswith(share.PREFIX):
        got = share.decode(raw)
        if not got:
            return "That connection string is damaged or incomplete. Copy it again from where it was shared, all of it."
        ns.url = got["url"]
        ns.token = ns.token or got["token"]
        if not ns.access_client_id:
            ns.access_client_id, ns.access_client_secret = got["access_client_id"], got["access_client_secret"]
    else:
        ns.url = raw
    return ""


SOURCE_WORD = {"env": "the environment", "plugin": "the plugin options", "command": "the credential command", "file": "the config file"}


def _shadowed(saved: dict) -> list:
    """One warning per value this machine will use that is not the one just saved. The environment, the plugin options and the
    credential command are read before the file, so one of them wins without a word otherwise. Only key names are printed."""
    now = config.load()
    return ["%s comes from %s, not from the value just saved, so this machine keeps using that one. Unset it, or change it there." % (key, SOURCE_WORD.get(now.source.get(key), "somewhere else"))
            for key, value in saved.items() if getattr(now, key) != value]


def run(ns):
    if (ns.url or "").startswith(share.PREFIX):  # the argument list is visible to ps and the shell history, so the string goes in on standard input
        print("A connection string holds the token, so it is not taken from the command line. Pipe it in instead: pbpaste | connect.py. Nothing was saved.", file=sys.stderr)
        return 1
    if ns.token_file:
        ns.token, problem = _secret_from_file(ns.token_file)
        if problem:
            print("Not connected: %s. Nothing was saved." % problem, file=sys.stderr)
            return 1
    if ns.access_client_secret_file:
        ns.access_client_secret, problem = _secret_from_file(ns.access_client_secret_file)
        if problem:
            print("Not connected: %s. Nothing was saved." % problem, file=sys.stderr)
            return 1
    if not ns.url or not ns.token:
        problem = _from_string(ns)
        if problem:
            print(problem, file=sys.stderr)
            return 1
    url = _clean_url(ns.url)
    if not url:
        print("That does not look like a Worker address. Use the form https://your-worker.your-name.workers.dev", file=sys.stderr)
        return 1
    token = ns.token
    if not token:
        try:
            token = getpass.getpass("Token (input is hidden): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("No token given (no terminal to ask on). Pipe the connection string in, or pass --token-file FILE, or set ANYMEM_TOKEN. Nothing was saved.", file=sys.stderr)
            return 1
    if not token:
        print("No token given, nothing was saved.", file=sys.stderr)
        return 1
    if bool(ns.access_client_id) != bool(ns.access_client_secret):
        print("Give both --access-client-id and --access-client-secret-file, or neither. Nothing was saved.", file=sys.stderr)
        return 1
    settings = config.Settings(url=url, token=token, access_client_id=ns.access_client_id, access_client_secret=ns.access_client_secret)
    problem = ""
    proven = ""
    for path in ("/health", "/count"):
        try:
            data = api.request("GET", path, timeout=20, settings=settings)
        except api.ApiError as e:
            if e.status in (401, 403):
                problem = "the Worker at %s rejected that token (HTTP %d)" % (url, e.status)
                break
            problem = "the Worker at %s answered %s with HTTP %d" % (url, path, e.status)
            continue
        except api.NetworkError as e:
            problem = "could not reach %s (%s)" % (url, e)
            break
        if _worker_shaped(path, data):
            problem, proven = "", path
        else:
            problem = "the address %s answered %s, but not the way a Anymem Worker does" % (url, path)
        break
    if proven:
        problem = _accepts_any_token(url, proven, settings)
    if problem:
        print("Not connected: %s. Nothing was saved." % problem, file=sys.stderr)
        return 1
    if not ns.access_client_id:  # connecting without Access: an older pair would be sent to a Worker that does not want it
        stale = config.read_file()
        if stale.get("access_client_id") or stale.get("access_client_secret"):
            cleaned = {k: v for k, v in stale.items() if k not in ("access_client_id", "access_client_secret")}
            config.config_file().write_text(__import__("json").dumps(cleaned, indent=2) + "\n", encoding="utf-8")
    saved = {"url": url, "token": token, "access_client_id": ns.access_client_id, "access_client_secret": ns.access_client_secret}
    path = config.write_file(saved)
    print("Connected to %s. Saved to %s (the token is stored there and never printed)." % (url, path))
    for warning in _shadowed(saved):
        print("Warning: " + warning, file=sys.stderr)
    return 0
