"""The checks every adapter's hook.py makes before it does memory work, and the clean up of its per session files.

One place, so the adapters cannot drift apart: an environment switch is read the same way in every harness, and a session file
is kept for the same time in every harness.

    child()          this process is the extraction child of a capture, which must never recall or capture
    off(name)        the environment switch `name` is set to 0 (ANYMEM_RECALL, ANYMEM_CAPTURE or ANYMEM_CAPSULE)
    prune(folder)    per session files in `folder` that nobody has touched for SESSION_KEEP_SECONDS are deleted

The capture policy (hm.policy) is checked by the shared capture hook itself, so the adapters do not repeat it.
stdlib only.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

SESSION_KEEP_SECONDS = 14 * 86400  # the capture state forgets a session at the same age


def child() -> bool:
    """True inside the extraction child that a capture starts, so the child never recalls or captures again."""
    return bool(os.environ.get("ANYMEM_CAPTURE_CHILD"))


def off(name: str) -> bool:
    """True when the environment switch `name` is set to 0. Unset means on."""
    return os.environ.get(name, "1") == "0"


def prune(folder: Path, pattern: str = "*.jsonl") -> None:
    """Deletes the session files in `folder` that nobody has touched for SESSION_KEEP_SECONDS."""
    cutoff = time.time() - SESSION_KEEP_SECONDS
    for item in folder.glob(pattern):
        try:
            if item.stat().st_mtime < cutoff:
                item.unlink()
        except OSError:
            pass
