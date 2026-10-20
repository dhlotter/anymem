"""Offline behaviour. A failed save is never dropped silently.

Reads fall back to cached data and say how old it is. Writes are online only in v1: when one fails, the client records it
here, prints one plain line, and `doctor.py` lists what is still unsaved. Nothing is retried in the background.

    record_failure("capture", "network: timed out", {"name": "some-memory", "content": "..."})
    failures()      -> list of dicts, oldest first
    clear()         -> removes the file (used after a successful resave)
    age_label(ts)   -> "3 minutes old" for the capsule cache line

The file is ~/.cache/anymem/failed.jsonl, mode 0600, because a failed capture holds the memory text.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from . import cache_file, config

MAX_RECORDS = 200


def path():
    return config.cache_dir() / "failed.jsonl"


def record_failure(kind: str, reason: str, payload: dict | None = None) -> None:
    """Append one failure. Never raises: recording a failure must not itself break a hook."""
    try:
        p = path()
        cache_file.private_dir(p.parent)
        rec = {"ts": int(time.time()), "kind": kind, "reason": str(reason)[:300], "payload": payload or {}}
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with cache_file.locked(p):
            with cache_file.open_append(p) as f:
                f.write(line)
            lines = p.read_text(encoding="utf-8").splitlines()
            if len(lines) > MAX_RECORDS:
                cache_file.write_text(p, "\n".join(lines[-MAX_RECORDS:]) + "\n")
    except OSError:
        pass


def sandbox_dir() -> Path:
    """Where DeepSeek Harness hooks keep their cache. DSH refuses hook writes under the home folder, so its hooks work in a
    private folder in the temp area (see adapters/dsh/hook.py). A failed save from there is recorded in that folder."""
    return Path(tempfile.gettempdir()) / ("anymem-%d" % os.getuid())


def fold_sandbox() -> None:
    """Move any failed saves recorded in the DSH temp folder into the main failure file, so doctor and resave see them.
    Only when the cache folder is the default one (an override, as tests use, is left alone). The temp folder is shared with
    every local user, so it is read only when it is this user's and no one else can write to it, and the file is this user's,
    private and not a link (the same rule as the credential cache). Never raises."""
    if os.environ.get("ANYMEM_CACHE_DIR"):
        return
    try:
        folder = sandbox_dir()
        src = folder / "failed.jsonl"
        if folder.is_symlink() or not folder.is_dir() or not config.owned_privately(folder, 0o022):
            return
        if src.is_symlink() or not src.is_file() or not config.owned_privately(src, 0o077):
            return
        if src.resolve() == path().resolve():
            return
        text = src.read_text(encoding="utf-8")
        p = path()
        cache_file.private_dir(p.parent)
        with cache_file.locked(p):
            with cache_file.open_append(p) as f:
                f.write(text if text.endswith("\n") or not text else text + "\n")
        src.unlink()
    except OSError:
        pass


def failures() -> list:
    fold_sandbox()
    try:
        out = []
        for line in path().read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out
    except OSError:
        return []


def rewrite(records: list) -> None:
    """Replace the failure file with exactly these records. An empty list removes the file. A record another process
    appends while this runs is lost, so a resave uses discard() instead."""
    if not records:
        clear()
        return
    try:
        p = path()
        cache_file.private_dir(p.parent)
        with cache_file.locked(p):
            cache_file.write_text(p, "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n")
    except OSError:
        pass


def discard(done: list) -> None:
    """Remove these records (matched by content, one file line each) and keep every other line, including records that
    were appended since `done` was read. An empty result removes the file."""
    gone = [json.dumps(r, sort_keys=True) for r in done]
    try:
        p = path()
        with cache_file.locked(p):
            keep = []
            for line in p.read_text(encoding="utf-8").splitlines():
                try:
                    key = json.dumps(json.loads(line), sort_keys=True)
                except ValueError:
                    keep.append(line)
                    continue
                if key in gone:
                    gone.remove(key)
                else:
                    keep.append(line)
            if keep:
                cache_file.write_text(p, "\n".join(keep) + "\n")
            else:
                p.unlink()
    except OSError:
        pass


def clear() -> None:
    try:
        path().unlink()
    except OSError:
        pass


def age_label(ts: float, now: float | None = None) -> str:
    seconds = max(0, int((now if now is not None else time.time()) - ts))
    if seconds < 90:
        return "just now"
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds >= size:
            n = seconds // size
            return f"{n} {unit}{'s' if n != 1 else ''} old"
    return "just now"
