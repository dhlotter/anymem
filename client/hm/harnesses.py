"""The harness names, in one place for the client.

An id is what the client sends in the X-Anymem-Harness header and in the harness field of a save. worker/harnesses.js holds the same
list for the Worker (it is the source of the labels the dashboard shows), and a test in each language fails when the two differ.
To add a harness, add a row here and there, then run both test suites.

Two more rules live here so every entry point agrees.

1. An adapter's hook assigns ANYMEM_HARNESS itself, as its first line of work (it runs before client/ is on the path, so it
   cannot import this file), so a variable left over in the environment cannot change the name. A test reads every adapter's
   hook and checks that the id it assigns is in IDS. The shared Claude Code entry points use `default_to`, which an adapter
   that runs the same code keeps from overriding.
2. `hint` and `read_hint` carry the name to the skill scripts. Only Claude Code writes ANYMEM_HARNESS into the shell its agent
   uses. For the other harnesses a hook leaves a small note in the cache folder, and a script run without the variable reads it.
   The note says which harness ran a hook last on this machine, so it is a best guess, never newer than HINT_TTL.
"""
from __future__ import annotations

import json
import os
import re
import time

IDS = ("claude", "codex", "agy", "dsh", "kilo", "zcode")
ALIASES = {"claude-code": "claude", "antigravity": "agy"}
HINT_TTL = 4 * 3600  # seconds a note stays valid
HINT_REFRESH = 300   # a hook rewrites an unchanged note at most this often
_LABEL = re.compile(r"[^A-Za-z0-9._:-]")


def clean(value) -> str:
    """The name as the Worker keeps it: letters, digits and ._:- only, 64 characters at most."""
    return _LABEL.sub("", str(value or "").strip())[:64]


def resolve(name) -> str:
    """The id for a known name or alias, compared without regard to case. Any other name is kept as written, cleaned."""
    text = clean(name)
    low = text.lower()
    return low if low in IDS else ALIASES.get(low, text)


def default_to(name: str) -> str:
    """Name this process's harness only when nothing else has. The shared entry points for Claude Code use it, so an adapter
    that runs the same code and assigned its own name first keeps it."""
    if name in IDS:
        os.environ.setdefault("ANYMEM_HARNESS", name)
    return os.environ.get("ANYMEM_HARNESS", "")


def _hint_path():
    from . import config
    return config.cache_dir() / "harness-hint.json"


def hint(name: str, now: "float | None" = None) -> None:
    """Leave a note that `name` is the harness in use. Rewritten only when it changed or is old. Never raises."""
    try:
        at = time.time() if now is None else now
        current = read_hint(at)
        p = _hint_path()
        if current == name:
            if at - p.stat().st_mtime < HINT_REFRESH:
                return
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"harness": name, "ts": at}), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(p)
    except Exception:
        pass


def read_hint(now: "float | None" = None) -> str:
    """The harness a hook last named on this machine, or "" when there is no note or it is older than HINT_TTL."""
    try:
        data = json.loads(_hint_path().read_text(encoding="utf-8"))
        at = time.time() if now is None else now
        name = resolve(data.get("harness"))
        return name if name and 0 <= at - float(data.get("ts")) <= HINT_TTL else ""
    except Exception:
        return ""
