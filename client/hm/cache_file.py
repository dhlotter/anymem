"""Files in the cache folder, written so that parallel sessions and a private mode hold.

    cache_file.private_dir(path)        the folder and its parents, mode 0700
    cache_file.open_append(path)        a text handle for appending, mode 0600 from the first byte
    cache_file.write_text(path, text)   replace a file whole: a temp name of its own, mode 0600, then one rename
    with cache_file.locked(path): ...   hold path's lock for a read, change, write cycle

A file made by an older version can have a looser mode, so every open sets 0600 again. The lock is a sidecar file
named after the path, held with flock where the platform has it. A lock that cannot be taken within LOCK_WAIT seconds
is skipped, so a hook never blocks on another session. Both helpers leave OSError to the caller, as open() would.
"""
from __future__ import annotations

import os
import secrets
import time
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # no flock on this platform: the writes are as safe as they were before this module
    fcntl = None

LOCK_WAIT = 2.0  # seconds a lock is waited for before the caller carries on without it


def private_dir(path: Path) -> Path:
    """Create `path` and its parents, and make `path` itself mode 0700. Returns `path`."""
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _open(path: Path, flags: int) -> int:
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)  # a file that already existed keeps its mode otherwise
    except (AttributeError, OSError):
        pass
    return fd


def open_append(path: Path):
    """A text handle for appending to `path`. Use it in a with statement."""
    return os.fdopen(_open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND), "a", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    """Replace `path` with `text`. The temp file has a name of its own, so two writers never share one, and it is
    renamed over `path` in one step, so a reader sees the old file or the new one, never a part of either."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with os.fdopen(_open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL), "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _take(fd: int) -> None:
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:  # another session holds it
            if time.monotonic() >= deadline:
                return
            time.sleep(0.02)
        except OSError:  # this filesystem cannot lock (NFS, FUSE): waiting would never help, so go on without the lock
            return


@contextmanager
def locked(path: Path):
    """Hold the lock for `path` while the body runs. Writers of one file take turns, so none of them overwrites a change
    another one made after it read the file. Waits LOCK_WAIT seconds at most, then runs the body without the lock.
    Locks are not reentrant: do not take the same lock twice in one call chain."""
    try:
        fd = _open(path.with_name(path.name + ".lock"), os.O_WRONLY | os.O_CREAT)
    except OSError:
        fd = None
    try:
        if fd is not None and fcntl is not None:
            _take(fd)
        yield
    finally:
        if fd is not None:
            os.close(fd)  # closing the file releases its flock
