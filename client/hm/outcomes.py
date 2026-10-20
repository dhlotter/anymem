"""What the recall hook did with each prompt, kept until the next request to the Worker and sent in one header.

The Worker cannot see this. It answers a recall and never learns whether the hook then added memories to the prompt or found
nothing worth adding, because that choice is made on this machine. So the hook notes its choice here, one word per line, and the
next request this machine makes to the Worker carries the totals in the X-Anymem-Outcomes header, for example `injected=2,quiet=5`.
The Worker adds them to a daily counter per harness. No prompt, no memory and no id is ever written or sent, only the three words.

    injected   the hook added at least one recalled memory to the prompt
    quiet      the search ran and nothing was good enough to add
    failed     the search could not run (a timeout, an error, no time left), so it says nothing about the store

A file per harness holds the pending words, so two harnesses on one machine never send each other's. `take` moves the file aside
in one step, so a hook that records while a request is on its way starts a new file and nothing is counted twice. The words go
back only when the Worker cannot have read them: no connection, or a login it refused before it read the header (401, 403).
Any other answer counts them. So does a timeout (the Worker may have counted them after the hook stopped waiting) and a server
error (it may have failed after the count). A hook the harness kills mid request leaves its words in a file named for its pid,
and the next `take` drops those, since nothing counts them. Each header carries at most the Worker's cap per word.
Nothing here ever raises, a counter must not break a hook or a script.
"""
from __future__ import annotations

import os
import socket

from . import cache_file, config, harnesses

HEADER = "X-Anymem-Outcomes"
KINDS = ("injected", "quiet", "failed")
MAX_PENDING = 2000  # words one request carries, the oldest are dropped past this
WORKER_MAX = 1000   # the most one word may count in a header, the Worker's own cap (worker/outcomes.js, MAX_COUNT)
MAX_FILE = 16_384   # bytes a pending file may reach, past this nothing more is noted until a request clears it
NO_REPLY = -1       # settle() status for a request that was sent and got no answer in time
REFUSED = (401, 403)  # the Worker turns these away before it reads the header


def _path(harness: str):
    return config.cache_dir() / ("recall-outcomes-%s.log" % (harnesses.clean(harness) or "unknown"))


def timed_out(exc: BaseException) -> bool:
    """True when a request failed on a timeout, so it may have been sent and read. Used by hm/api.py."""
    return isinstance(getattr(exc, "reason", exc), (TimeoutError, socket.timeout))


def record(kind: str, harness: str) -> None:
    """Note one decision. An unknown word is ignored."""
    if kind not in KINDS:
        return
    try:
        p = _path(harness)
        cache_file.private_dir(p.parent)
        if p.exists() and p.stat().st_size > MAX_FILE:
            return
        with cache_file.open_append(p) as f:
            f.write(kind + "\n")
    except Exception:
        pass


class Taken:
    """Words moved out of the pending file, with the header that carries them."""

    def __init__(self, path, words: list):
        self.path, self.words = path, words
        counts = {k: min(words.count(k), WORKER_MAX) for k in KINDS if k in words}
        self.header = ",".join("%s=%d" % (k, n) for k, n in counts.items())


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:  # it exists, but it is not ours to signal
        return True
    return True


def _drop_orphans(p) -> None:
    """Remove the words a dead process took and never settled (`<name>.<pid>`). Nothing counts them, so they go."""
    prefix = p.name + "."
    for name in os.listdir(p.parent):
        pid = name[len(prefix):]
        if name.startswith(prefix) and pid.isdigit() and not _alive(int(pid)):
            os.unlink(p.parent / name)


def take(harness: str) -> "Taken | None":
    """Move this harness's pending words aside and return them, or None when there are none."""
    try:
        p = _path(harness)
        try:
            _drop_orphans(p)
        except OSError:
            pass
        if not p.exists():
            return None
        mine = p.with_name("%s.%d" % (p.name, os.getpid()))
        os.replace(p, mine)
        words = [w for w in mine.read_text(encoding="utf-8").split() if w in KINDS][-MAX_PENDING:]
        if not words:
            mine.unlink()
            return None
        return Taken(mine, words)
    except Exception:
        return None


def settle(taken: "Taken | None", status: int, harness: str) -> None:
    """After the request. `status` is the HTTP status, 0 when the request never got out, or NO_REPLY when it was sent and no
    answer came in time. The words go back only for 0 and REFUSED, see the module notes. Anything else counts them."""
    if taken is None:
        return
    try:
        if status and status not in REFUSED:
            taken.path.unlink()
            return
        p = _path(harness)
        cache_file.private_dir(p.parent)
        with cache_file.open_append(p) as f:
            f.write("".join(w + "\n" for w in taken.words))
        taken.path.unlink()
    except Exception:
        pass
