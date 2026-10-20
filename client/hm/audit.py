"""The local audit log: one JSON line per Worker call, in <cache dir>/audit.log.

A line holds the time, the harness, who called (a script or a hook), the method and route (no query string), the memory ids
involved, the HTTP status (0 when there was no answer) and the milliseconds. It never holds memory text, a prompt, a token or
a header. The file is mode 0600 and is rotated at a size cap: the old file is kept once as audit.log.1, so the log is
never larger than about twice the cap. Writing it can never raise, a log must not break a script or a hook.

    audit.set_origin("script", "recall")          what runs now, set once by a script's launcher or a hook
    audit.record("GET", "/recall?query=x", ids=[...], status=200, ms=412)

The harness comes from ANYMEM_HARNESS, else from the note a hook left in the cache folder (hm/harnesses.py), else it is blank.
It used to default to Claude Code, which put the explicit saves of every other harness under that name. The session comes from
ANYMEM_SESSION. The same names go to the Worker in the X-Anymem-Harness and X-Anymem-Script headers, so its own audit table can
be matched to this one.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time

from . import cache_file, config, harnesses

MAX_BYTES = 512 * 1024
_origin: dict = {"kind": "script", "name": "unknown", "session": ""}
_LABEL = re.compile(r"[^A-Za-z0-9._:-]")


def path():
    return config.cache_dir() / "audit.log"


def _label(value: str) -> str:
    return _LABEL.sub("", str(value or ""))[:64]


def set_origin(kind: str, name: str, session: str = "") -> None:
    """kind is script or hook. `session` falls back to ANYMEM_SESSION."""
    _origin.update(kind=kind, name=_label(name) or "unknown", session=_label(session))
    if kind == "hook":  # a hook knows which harness is running, so a script run later in the same shell can learn it
        named = harnesses.resolve(os.environ.get("ANYMEM_HARNESS", ""))
        if named in harnesses.IDS:
            harnesses.hint(named)


def harness() -> str:
    return harnesses.resolve(os.environ.get("ANYMEM_HARNESS", "")) or harnesses.read_hint()


def session() -> str:
    return _origin["session"] or _label(os.environ.get("ANYMEM_SESSION", ""))


def session_tag(sid: str) -> str:
    """The short session tag a capture carries: 12 hex digits of the SHA-256 of the whole id, "" for no id. The id is hashed,
    not cut, because a Codex id starts with a timestamp that sessions started together share."""
    return hashlib.sha256(str(sid).encode("utf-8")).hexdigest()[:12] if sid else ""


def script_label() -> str:
    """The value of the X-Anymem-Script header: the script name, or hook:<name>."""
    return _origin["name"] if _origin["kind"] == "script" else f"hook:{_origin['name']}"


def headers() -> dict:
    return {"X-Anymem-Harness": harness(), "X-Anymem-Script": script_label()}


def record(method: str, route: str, ids=(), status: int = 0, ms: int = 0) -> None:
    try:
        p = path()
        cache_file.private_dir(p.parent)
        line = {"ts": round(time.time(), 3), "harness": harness(), _origin["kind"]: _origin["name"], "session": session(),
                "method": method, "route": route.split("?")[0], "ids": [str(i)[:64] for i in list(ids)[:50]], "status": status, "ms": ms}
        if p.exists() and p.stat().st_size > MAX_BYTES:
            os.replace(p, p.with_name(p.name + ".1"))
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, separators=(",", ":")) + "\n")
    except Exception:
        pass


def read(session_id: str = "", routes: tuple = ()) -> list:
    """The lines of the current file, optionally for one session and a set of routes. Bad lines are skipped."""
    out = []
    try:
        for raw in path().read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if isinstance(d, dict) and (not session_id or d.get("session") == session_id) and (not routes or d.get("route") in routes):
                out.append(d)
    except OSError:
        pass
    return out
