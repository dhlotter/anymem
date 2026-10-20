"""The starting files `install.py --new NAME` writes. Not a command (no COMMAND).

A new adapter is a folder in ~/.config/anymem/adapters/NAME, found by `install.py` the same way the built in ones are
(contract: adapters/README.md). Every function below is a working stub: the folder loads, shows in --list as not found, and its
own test passes, so the author fills in one function at a time instead of starting from a blank page."""
from __future__ import annotations

import re
from pathlib import Path

NAME_RE = re.compile(r"[a-z][a-z0-9_-]{1,30}")  # used with fullmatch, so a trailing newline does not pass

ADAPTER = '''"""Anymem adapter for %(title)s. Contract: adapters/README.md in the Anymem repo."""
from __future__ import annotations

import payload  # noqa: F401  siblings are imported at the top, a lazy import inside a function fails

NAME = "%(name)s"
TITLE = "%(title)s"


def detect() -> dict:
    """Read only. found is True when the harness is installed on this machine."""
    return {"found": False, "version": "", "config_path": "", "notes": ["not written yet: fill in detect() in adapter.py"]}


def plan(options) -> list:
    """Plain sentences saying exactly what install() would change."""
    return ["nothing yet, install() is not written"]


def install(options) -> dict:
    """Write ONLY Anymem's own entries into the harness config. Refuse a config file that is not valid."""
    raise NotImplementedError("install() is not written yet, see adapters/README.md")


def check() -> dict:
    """ok is True only when the wiring is in place. pending lists things only the person can do next."""
    return {"ok": False, "problems": ["install() is not written yet"], "pending": []}


def uninstall() -> dict:
    """Remove only Anymem's own entries and leave everything else byte identical."""
    return {"changed": []}
'''

PAYLOAD = '''"""Turn the harness's hook payload into {hook_event_name, session_id, prompt, transcript_path, cwd}."""
from __future__ import annotations


def normalise(raw: dict) -> dict:
    return {
        "hook_event_name": raw.get("hook_event_name", ""),
        "session_id": raw.get("session_id", ""),
        "prompt": raw.get("prompt", ""),
        "transcript_path": raw.get("transcript_path", ""),
        "cwd": raw.get("cwd", ""),
    }
'''

TEST = '''#!/usr/bin/env python3
"""Offline check that this adapter honours the contract. Add recorded payloads under fixtures/ as you learn them."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter  # noqa: E402

assert adapter.NAME == "%(name)s"
info = adapter.detect()
assert set(info) >= {"found", "version", "config_path", "notes"}
assert isinstance(adapter.plan(None), list)
assert set(adapter.check()) >= {"ok", "problems"}
assert "changed" in adapter.uninstall()
print("ok")
'''


def title_for(name: str) -> str:
    return name.replace("-", " ").replace("_", " ").title()


def create(root: Path, name: str) -> list:
    """Write the three starter files under root/name and return their paths. The caller has already checked the name is free."""
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "fixtures").mkdir()
    values = {"name": name, "title": title_for(name)}
    written = []
    for filename, template in (("adapter.py", ADAPTER), ("payload.py", PAYLOAD), ("test_adapter.py", TEST)):
        path = folder / filename
        path.write_text(template % values if "%(" in template else template, encoding="utf-8")
        written.append(str(path))
    return written
