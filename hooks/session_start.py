#!/usr/bin/env python3
"""
SessionStart hook for the anymem plugin: adds the always-on memory capsule to the session's context.

The capsule is the four hand written sections the Worker serves (identity, preferences, constraints, principles), built by
memory_capsule.block(). Output is the Claude Code hook JSON, `hookSpecificOutput.additionalContext`, capped at 9,500 characters
because Claude Code only shows a hook's output in full below roughly 10,000.

It also tells the scripts which session this is. Claude Code lets a SessionStart hook append exports to the file named in
CLAUDE_ENV_FILE, so later commands run with ANYMEM_SESSION and ANYMEM_HARNESS set. The audit log and the Worker's own audit
table then say which session a write came from, and the capture hook uses it to find what the agent already saved.

Silent and exit 0 when the client is not configured, or when there is nothing to show (no capsule and no status line). A session
must never wait on or fail because of memory.

context() is the one place a session start is built, and every harness calls it (Claude Code here, Codex in adapters/codex),
so each one gets the same status lines. The whole call has one deadline (ANYMEM_HOOK_DEADLINE, default 8 seconds, under the
10 second limit Claude Code gives a SessionStart hook). The capsule step (settings and the Worker) gets CAPSULE_CAP seconds at
most, inside the same bounded call, so a stalled DNS lookup cannot hold the hook past its kill. The status lines come after
it and get only what is left, and are dropped when less than a quarter second remains. The capsule gives up its tail to make
room for the lines, so a new user with no capsule still sees a pending profile change.
"""
from __future__ import annotations

import json
import os
import re
import select
import sys
import threading
import time
from urllib.parse import urlencode

import _path  # noqa: F401  (puts client/ on sys.path)
import memory_capsule
from hm import api, audit, harnesses, injection, shapes

LIMIT = memory_capsule.MAX_CHARS  # the same cap the capsule block is cut to


WEEK = 7 * 24 * 3600
DEADLINE_DEFAULT = 8.0  # seconds for the whole hook, under the 10 second limit Claude Code gives a SessionStart hook
CAPSULE_CAP = 6.0       # the capsule step (settings, then the Worker), so the status lines keep at least two seconds
RECENT_CAP = 3.0        # the weekly line's Worker call
PENDING_CAP = 3.0       # the pending profile change call
MIN_CALL = 0.25         # an extra with less time left than this is skipped, not started
_budget: dict = {}      # set by main(): "end" (a time.monotonic() value). Empty outside main(), where calls are not capped


def _deadline() -> float:
    try:
        v = float(os.environ.get("ANYMEM_HOOK_DEADLINE", DEADLINE_DEFAULT))
    except ValueError:
        return DEADLINE_DEFAULT
    return v if v > 0 else DEADLINE_DEFAULT


def _left(cap: float) -> float:
    """What one extra call may take: its own cap, never more than what is left of the hook's deadline."""
    end = _budget.get("end")
    return cap if end is None else max(0.0, min(cap, end - time.monotonic()))


def _within(seconds: float, fn):
    """fn() given `seconds` at most. A socket timeout does not cover a stalled DNS lookup, so the call runs in a daemon thread
    that is left behind when time runs out. Raises what fn raised, and api.NetworkError when it was late."""
    box: dict = {}

    def work():
        try:
            box["value"] = fn()
        except Exception as e:  # handed to the caller below
            box["error"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(seconds)
    if "error" in box:
        raise box["error"]
    if "value" not in box:
        raise api.NetworkError("no answer inside the hook's deadline")
    return box["value"]


def recent_line(now: float | None = None) -> str:
    """One line saying how many memories automatic capture saved in the last week, with the undo command. "" when there are
    none, when the Worker is slow or away, or when the client is not set up. Never raises: a session must not wait on this."""
    wait = _left(RECENT_CAP)
    if wait < MIN_CALL:
        return ""
    after = int(((now if now is not None else time.time()) - WEEK) * 1000)
    try:
        settings = memory_capsule._settings()
        rows = shapes.entries(_within(wait, lambda: api.request(
            "GET", "/list?" + urlencode({"tag": "auto-capture", "after": after, "n": 50}), timeout=wait, settings=settings)))
    except Exception:
        return ""
    live = [r for r in rows if r.get("status") != "pending" and "status:draft" not in (r.get("tags") or [])]
    if not live:
        return ""
    names = []
    for r in live[:3]:
        m = re.search(r"^name:\s*(\S+)", str(r.get("content", "")), re.M)
        names.append(m.group(1) if m else str(r.get("id", ""))[:8])
    more = "" if len(live) <= 3 else f" and {len(live) - 3} more"
    return (f"Memory: {len(live)} new memor{'y' if len(live) == 1 else 'ies'} saved automatically in the last 7 days "
            f"(latest: {', '.join(names)}{more}). To remove one run the anymem skill's forget script on its id. "
            f"To list them run the list script with --tag auto-capture. Nothing needs reviewing.")


def pending_line() -> str:
    """One line when capture heard the person state a new value for something already in their profile. "" otherwise."""
    wait = _left(PENDING_CAP)
    if wait < MIN_CALL:
        return ""
    try:
        from hm.commands import profile as hm_profile
        settings = memory_capsule._settings()
        rows = _within(wait, lambda: hm_profile.pending_rows(timeout=wait, settings=settings))
    except Exception:
        return ""
    bits = [f"{hm_profile.FIELDS[k][0].lower()} to \"{hm_profile.pending_value(r)}\"" for r in rows for k in [hm_profile.pending_field(r)] if k in hm_profile.FIELDS]
    if not bits:
        return ""
    return ("Profile: you said " + "; ".join(bits) + ". If that is right run the anymem skill's profile script with accept <field>, "
            "otherwise with dismiss <field>. Nothing changes until you do.")


def health_line() -> str:
    """A warning when the last monthly recall check said the store is getting harder to search. "" otherwise."""
    try:
        from hm.commands import recall_check
        st = recall_check.read_state()
    except Exception:
        return ""
    if st.get("status") != "warn":
        return ""
    return f"Memory health: {st.get('why', 'recall is getting worse')}. Open the dashboard health page, then forget what is stale."


def export_session(session: str) -> None:
    """Append the session and harness exports to CLAUDE_ENV_FILE when Claude Code gave one. Never raises."""
    path = os.environ.get("CLAUDE_ENV_FILE")
    if not path or not session:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"export ANYMEM_SESSION={audit._label(session)}\nexport ANYMEM_HARNESS=claude\n")
    except OSError:
        pass


def read_session() -> str:
    """The session id from the hook's JSON on standard input. Waits half a second at most for it, so a caller that leaves
    standard input open and empty (a test, a harness that sends nothing) cannot hold the session up."""
    try:
        if sys.stdin and not sys.stdin.isatty() and select.select([sys.stdin], [], [], 0.5)[0]:
            data = json.load(sys.stdin)
            return str(data.get("session_id", "")) if isinstance(data, dict) else ""
    except (ValueError, OSError, TypeError):
        pass
    return ""


def capsule_step():
    """The capsule text ('' when there is none), or None when the client is not configured. Runs inside _within."""
    if not memory_capsule._settings().configured():
        return None
    return memory_capsule.block() or ""


def cached_capsule() -> str:
    """The last good capsule from the cache, or '' when there is none or the capsule is switched off."""
    if os.environ.get("ANYMEM_CAPSULE", "1") == "0":
        return ""
    cached = memory_capsule._read_cache()
    return memory_capsule.render(cached["sections"], "cache", memory_capsule._cache_time(cached)) if cached else ""


def compose(capsule: str, lines: list) -> str:
    """The capsule, then the status lines, at most LIMIT characters. The lines always fit: the capsule gives up its tail first."""
    tail = "\n\n".join(lines)
    if not tail:
        return capsule[:LIMIT]
    if not capsule:
        return tail[:LIMIT]
    return capsule[:max(0, LIMIT - len(tail) - 2)].rstrip() + "\n\n" + tail


def context() -> str:
    """What a session starts with, for every harness: the capsule, then the status lines. "" when the client is not configured
    or there is nothing to show. Its own deadline, and it never raises. When the capsule step is late or fails, nothing is
    shown: a Worker that does not answer in time gets no status lines either."""
    _budget.clear()
    _budget["end"] = time.monotonic() + _deadline()
    try:
        try:
            capsule = _within(_left(CAPSULE_CAP), capsule_step)
        except api.NetworkError:  # the Worker was late: the last good copy is still better than no rules at all
            return cached_capsule()[:LIMIT]
        if capsule is None:
            return ""
        lines = [line for line in (recent_line(), pending_line(), health_line()) if line]
        return compose(capsule, lines)
    except Exception:
        return ""
    finally:
        _budget.clear()


def main() -> int:
    harnesses.default_to("claude")
    session = read_session()
    export_session(session)
    audit.set_origin("hook", "session_start", session)
    text = context()
    if not text:
        return 0
    injection.record(k="start", chars=len(text))
    payload = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}
    sys.stdout.write(json.dumps(payload) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
