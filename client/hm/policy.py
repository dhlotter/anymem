"""Capture policy. It decides whether a session may be captured at all.

Read from the config file (hm.config.read_file) and the environment:

    "capture": "proposals"      the default. "off" turns capture off. Anything else is treated as off, so a typo never captures
    "exclude_paths": [...]      absolute path prefixes or globs, matched against the session cwd and its parent folders
    "exclude_sessions": [...]   session id prefixes
    ANYMEM_CAPTURE=0    off, whatever the file says

    allowed(session_id, cwd) -> (True, "")  or  (False, "plain reason")

The policy comes only from the config file and the environment, never from a transcript. stdlib only.
"""
from __future__ import annotations

import fnmatch
import os

from . import config

MODES_ON = ("proposals",)
MODES_OFF = ("off", "0", "false", "no", "none")
GLOB_CHARS = "*?["


def _as_list(value) -> list:
    if isinstance(value, str):
        value = [value]
    return [v.strip() for v in value if isinstance(v, str) and v.strip()] if isinstance(value, list) else []


def _ancestors(path: str) -> list:
    out, cur = [], path
    while True:
        out.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            return out
        cur = parent


def _excluded(cwd: str, patterns: list) -> str:
    """The first pattern that covers `cwd` (or a parent of it), or "". Both the given and the resolved path are tried."""
    paths = {os.path.normpath(cwd), os.path.normpath(os.path.realpath(cwd))}
    folders = [a for p in paths for a in _ancestors(p)]
    for pattern in patterns:
        pat = os.path.normpath(os.path.expanduser(pattern))
        if any(c in pat for c in GLOB_CHARS):
            if any(fnmatch.fnmatchcase(f, pat) for f in folders):
                return pattern
        elif pat in folders:
            return pattern
    return ""


def allowed(session_id: str, cwd: str) -> "tuple[bool, str]":
    if os.environ.get("ANYMEM_CAPTURE", "1").strip() == "0":
        return False, "ANYMEM_CAPTURE=0"
    cfg = config.read_file()
    mode = cfg.get("capture", "proposals")
    if mode is False:
        mode = "off"
    elif mode is True:
        mode = "proposals"
    mode = str(mode).strip().lower()
    if mode in MODES_OFF:
        return False, "capture is off in the config file"
    if mode not in MODES_ON:
        return False, "capture mode %r is not recognised, treated as off" % mode
    for prefix in _as_list(cfg.get("exclude_sessions")):
        if (session_id or "").startswith(prefix):
            return False, "session %s is excluded" % prefix
    paths = _as_list(cfg.get("exclude_paths"))
    if paths:
        if not cwd:
            return False, "exclude_paths is set and the session folder is unknown"
        hit = _excluded(cwd, paths)
        if hit:
            return False, "folder is excluded by %s" % hit
    return True, ""
