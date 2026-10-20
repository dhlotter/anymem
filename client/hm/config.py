"""Where the Worker URL and credentials come from, for every client piece (scripts, hooks, adapters).

Lookup order, per value, first one that has it wins (the address has one extra rule, see the end of this list):
  1. environment: ANYMEM_URL, ANYMEM_TOKEN, ANYMEM_ACCESS_CLIENT_ID, ANYMEM_ACCESS_CLIENT_SECRET
  2. the config file ~/.config/anymem/config.json (mode 0600), keys: url, token, access_client_id, access_client_secret
  3. the Claude Code plugin options CLAUDE_PLUGIN_OPTION_URL and CLAUDE_PLUGIN_OPTION_TOKEN (set with `claude plugin configure`),
     so hooks started by the plugin find what the user entered there. The file wins when both are set.
  4. the optional `credential_command` in that file: any command that prints the values, which is how a secret manager plugs
     in without this code knowing about it. It may print a JSON object or a single line holding just the token. In a JSON
     object a value is either a string or an object with a "computed" or "value" string, and a key is either one of the
     config names above or its environment variable name.
  For the address only, a url in the credential_command output beats the config file and the plugin option. The order for
  the address is then the environment, the credential command, the config file, the plugin option. That lets a secret manager
  hold the address next to the token, so a changed hostname is one edit and not one per machine.

The one thing this module writes is the credential_command cache: a command can be slow (a secret manager), and every hook
and script call is its own process, so the printed values are kept for ANYMEM_CRED_TTL seconds (default 900, 0 turns the cache
off) in <cache dir>/credentials/<hash of the command and the session>.json. That file holds the secret in plain text, mode 0600 in a 0700
folder, and is dropped when the Worker answers 401 or 403. No default URL exists: an unconfigured client says so plainly.
ANYMEM_CONFIG_DIR and ANYMEM_CACHE_DIR relocate the two folders (tests, containers).
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ENV = {
    "url": "ANYMEM_URL",
    "token": "ANYMEM_TOKEN",
    "access_client_id": "ANYMEM_ACCESS_CLIENT_ID",
    "access_client_secret": "ANYMEM_ACCESS_CLIENT_SECRET",
}
KEYS = tuple(ENV)
DEFAULT_CRED_TTL = 900.0  # seconds a credential_command result is reused, ANYMEM_CRED_TTL overrides, 0 disables
FAIL_TTL = 60.0  # seconds a failed or empty credential_command run is not tried again, so a slow or locked secret manager costs one wait a minute
PLUGIN_OPTIONS = {"url": "CLAUDE_PLUGIN_OPTION_URL", "token": "CLAUDE_PLUGIN_OPTION_TOKEN"}


def config_dir() -> Path:
    return Path(os.environ.get("ANYMEM_CONFIG_DIR") or Path.home() / ".config" / "anymem")


def cache_dir() -> Path:
    return Path(os.environ.get("ANYMEM_CACHE_DIR") or Path.home() / ".cache" / "anymem")


def config_file() -> Path:
    return config_dir() / "config.json"


LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def url_problem(url: str) -> str:
    """Why this Worker address must not receive the token, or "" when it may. Plain http is only accepted for this machine."""
    if any(ch.isspace() for ch in url):
        return "it contains a space"
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError for a port that is not a number
    except ValueError as e:
        return str(e)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "it has no http:// or https:// scheme and host"
    if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS:
        return "plain http would send the token in the clear, use https://"
    return ""


@dataclass
class Settings:
    url: str = ""
    token: str = ""
    access_client_id: str = ""
    access_client_secret: str = ""
    source: dict = field(default_factory=dict)  # key -> "env" | "file" | "command", for `doctor`

    def configured(self) -> bool:
        return bool(self.url and self.token)

    def missing(self) -> list:
        return [k for k in ("url", "token") if not getattr(self, k)]

    def headers(self) -> dict:
        """Authorization plus, when both halves exist, the Cloudflare Access service token pair."""
        h = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        if self.access_client_id and self.access_client_secret:
            h["CF-Access-Client-Id"] = self.access_client_id
            h["CF-Access-Client-Secret"] = self.access_client_secret
        return h


def read_file() -> dict:
    """The config file as a dict, {} when it is absent or unreadable. Never raises."""
    try:
        data = json.loads(config_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _as_text(v) -> str:
    if isinstance(v, dict):
        v = v.get("computed") if v.get("computed") is not None else v.get("value")
    return v.strip() if isinstance(v, str) else ""


def parse_command_output(text: str) -> dict:
    """Values printed by a credential_command: a JSON object, or one bare line which is the token."""
    text = (text or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        lines = [x.strip() for x in text.splitlines() if x.strip()]
        return {"token": lines[0]} if len(lines) == 1 else {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, env in ENV.items():
        raw = data.get(key, data.get(env))
        val = _as_text(raw)
        if val:
            out[key] = val
    return out


def run_credential_command(command: str, timeout: float = 8.0) -> dict:
    try:
        proc = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return {}
    return parse_command_output(proc.stdout) if proc.returncode == 0 else {}


def cred_ttl() -> float:
    """Seconds a credential_command result may be reused. 0 or less means never cache, a bad value means the default."""
    raw = os.environ.get("ANYMEM_CRED_TTL")
    if raw is None or not raw.strip():
        return DEFAULT_CRED_TTL
    try:
        ttl = float(raw)
    except ValueError:
        return DEFAULT_CRED_TTL
    return ttl if ttl == ttl else DEFAULT_CRED_TTL  # NaN falls back too


def _cred_cache_file(command: str) -> Path:
    """One file per command and session, keyed by ANYMEM_SESSION (the session start hook sets it for Claude Code). A harness that sets
    no session shares one file per command across its sessions until the TTL ends."""
    key = command + "\0" + os.environ.get("ANYMEM_SESSION", "")
    return cache_dir() / "credentials" / (hashlib.sha256(key.encode("utf-8")).hexdigest()[:32] + ".json")


def _prune_cred_cache(ttl: float) -> None:
    """Delete cache files of finished sessions, so none outlives its expiry by much. Never raises."""
    try:
        for f in (cache_dir() / "credentials").glob("*"):
            if time.time() - f.stat().st_mtime > ttl:
                f.unlink()
    except OSError:
        pass


def drop_credential_cache(command: "str | None" = None) -> None:
    """Forget the cached result, and any recorded failure, for `command` (default: the one in the config file). Never raises."""
    try:
        if command is None:
            command = read_file().get("credential_command")
        if isinstance(command, str) and command.strip():
            _cred_cache_file(command).unlink(missing_ok=True)
            _fail_marker(command).unlink(missing_ok=True)
    except OSError:
        pass


def _fail_marker(command: str) -> Path:
    """An empty file next to the cache entry, its age says when the last run for this command and session failed."""
    return _cred_cache_file(command).with_suffix(".failed")


def _recently_failed(command: str) -> bool:
    try:
        return time.time() - _fail_marker(command).stat().st_mtime < FAIL_TTL
    except OSError:
        return False


def _set_fail_marker(command: str, failed: bool) -> None:
    """Record or clear a failed run. The marker holds no secret, so a plain empty file is fine. Never raises."""
    try:
        marker = _fail_marker(command)
        if failed:
            marker.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(marker.parent, 0o700)
            marker.touch()
        else:
            marker.unlink()
    except OSError:
        pass


def owned_privately(path: Path, forbidden_bits: int) -> bool:
    """True when `path` belongs to this user and has none of `forbidden_bits` set in its mode (POSIX only, elsewhere always True)."""
    if not hasattr(os, "geteuid"):
        return True
    st = path.stat()
    return st.st_uid == os.geteuid() and not st.st_mode & forbidden_bits


def _read_cred_cache(command: str, ttl: float) -> dict:
    """The cached values, or {} when there is no entry, it is expired, or it is unreadable or malformed."""
    path = _cred_cache_file(command)
    try:
        if not owned_privately(path.parent, 0o022) or not owned_privately(path, 0o077):
            return {}  # someone else owns it or can write it: do not trust what it says
        age = time.time() - path.stat().st_mtime
        if age < 0 or age > ttl:
            path.unlink()
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {k: v.strip() for k, v in data.items() if k in KEYS and isinstance(v, str) and v.strip()}
    return out if len(out) == len(data) else {}


def _write_cred_cache(command: str, values: dict) -> None:
    """Best effort. The file is created with mode 0600 from the first byte, then moved into place, so it is never world readable."""
    path = _cred_cache_file(command)
    tmp = path.with_name(f".{secrets.token_hex(8)}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(values))
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def cached_credential_command(command: str, timeout: float = 8.0) -> dict:
    """run_credential_command, reused across processes for cred_ttl() seconds. Failed, timed out and empty runs are never kept as
    values, but each one is remembered for FAIL_TTL seconds, so every hook of a session does not wait for a locked secret manager."""
    ttl = cred_ttl()
    if ttl <= 0:
        drop_credential_cache(command)
        return run_credential_command(command, timeout)
    values = _read_cred_cache(command, ttl)
    if values:
        return values
    if _recently_failed(command):
        return {}
    values = run_credential_command(command, timeout)
    if values:
        _prune_cred_cache(ttl)
        _write_cred_cache(command, values)
    _set_fail_marker(command, not values)
    return values


def load(timeout: float = 8.0, use_command: bool = True) -> Settings:
    """Resolve every value. The credential command runs when url or token is still missing after env and file, when the address did
    not come from the environment (the command may hold a newer one), or when exactly one Access half is set."""
    s = Settings()
    f = read_file()
    for key, env in ENV.items():
        candidates = [("env", os.environ.get(env, "")), ("file", f.get(key, ""))]
        if key in PLUGIN_OPTIONS:
            candidates.append(("plugin", os.environ.get(PLUGIN_OPTIONS[key], "")))
        for where, val in candidates:
            if isinstance(val, str) and val.strip():
                setattr(s, key, val.strip().rstrip("/") if key == "url" else val.strip())
                s.source[key] = where
                break
    command = f.get("credential_command")
    # The command also runs when the address did not come from the environment, because the command may hold a newer one.
    if use_command and isinstance(command, str) and command.strip() and (not s.configured() or s.source.get("url") != "env" or (bool(s.access_client_id) != bool(s.access_client_secret))):
        for key, val in cached_credential_command(command, timeout).items():
            if key == "url":
                url = val.rstrip("/")  # a url that is only slashes gives nothing, so it never blanks the one the user has
                if url and s.source.get("url") != "env":
                    s.url = url
                    s.source["url"] = "command"
            elif not getattr(s, key):
                setattr(s, key, val)
                s.source[key] = "command"
    return s


def write_file(values: dict) -> Path:
    """Merge `values` into the config file (mode 0600, directory 0700). Used by `setup` and `connect` only."""
    d = config_dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    merged = {**read_file(), **{k: v for k, v in values.items() if v not in (None, "")}}
    tmp = config_file().with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(config_file())
    return config_file()
