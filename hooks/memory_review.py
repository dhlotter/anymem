#!/usr/bin/env python3
"""
Review hook: the session's own model saves what it missed, instead of a separate model reading the transcript afterwards.

Wired to Stop in Claude Code. When enough has happened since the last review, the hook answers {"decision": "block"} with a
short request, so the agent takes one more turn: it looks back over the conversation it already holds, saves what meets the
save rules with the skill's remember script, or answers "nothing to save". The model is the one the person picked, it needs
no transcript read and no login of its own, and the conversation is already in its context, so the turn is short.

When it fires (all must hold):
  the session is attended         a headless `claude -p` or SDK run is skipped, its final answer is someone's output
  not a turn the review started   Claude Code sets stop_hook_active on the turn a Stop hook asked for, so it never loops
  capture is allowed              the same policy as capture (hm.policy: capture off, exclude_paths, exclude_sessions)
  at least 60 KB of new transcript and 20 minutes since the last review (the clock starts at the session's first Stop)
  at least 150 characters the person typed in that stretch

The end of session capture (memory_capture.py) still runs. It reads what the agent saved and only adds what is missing.

Environment:
  ANYMEM_REVIEW=0   turn it off

Never raises, prints nothing unless it asks for a review. stdlib only.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401
import memory_capsule  # noqa: E402  the install's scripts folder
import memory_capture as cap  # noqa: E402  the transcript reader, the log and the user text bar
from hm import cache_file, config, policy  # noqa: E402

STATE = config.cache_dir() / "review-state.json"
MIN_BYTES = 60_000
INTERVAL = 20 * 60

REQUEST = """anymem memory review. Before you stop, look back over this conversation since the last review. Save anything that meets the save rules in the memory capsule (a correction, a confirmed decision with its reason, a durable preference or constraint, where something lives outside the repo) and that you have not saved yet. Recall first and update instead of duplicating:
python3 {recall} "query"
python3 {remember} <<'EOF'
(frontmatter and one fact, as in the save rules)
EOF
If nothing qualifies, reply only: nothing to save. Do not repeat or summarise your previous answer."""


def attended() -> bool:
    """False for a headless run: `claude -p` and the SDK set CLAUDE_CODE_SESSION_ATTENDED=0 (seen on Claude Code 2.1.309)."""
    return os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") != "0" and not os.environ.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk")


def due(st: dict, size: int, now: float) -> bool:
    return size - int(st.get("offset", 0)) >= MIN_BYTES and now - float(st.get("ts", now)) >= INTERVAL


def request() -> str | None:
    """The review request with this install's script paths, or None when the scripts are missing (a request to run a script
    the agent cannot find only wastes a turn)."""
    remember, recall = memory_capsule.SCRIPTS / "remember.py", memory_capsule.SCRIPTS / "recall.py"
    if not (remember.is_file() and recall.is_file()):
        return None
    return REQUEST.format(recall=shlex.quote(str(recall)), remember=shlex.quote(str(remember)))


def hook(payload: dict, now: float | None = None) -> dict | None:
    """The Stop hook's answer, or None to let the session stop."""
    if os.environ.get("ANYMEM_REVIEW", "1") == "0" or os.environ.get("ANYMEM_CAPTURE_CHILD") or not attended():
        return None
    if payload.get("stop_hook_active") or payload.get("hook_event_name") not in (None, "Stop"):
        return None
    sid, tpath, cwd = str(payload.get("session_id") or ""), str(payload.get("transcript_path") or ""), str(payload.get("cwd") or "")
    if not sid or not tpath or not policy.allowed(sid, cwd)[0]:
        return None
    try:
        size = os.path.getsize(tpath)
    except OSError:
        return None
    now = time.time() if now is None else now
    with cache_file.locked(STATE):
        try:
            state = json.loads(STATE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        st = state.get(sid)
        if not isinstance(st, dict) or int(st.get("offset", 0)) > size:
            st = state[sid] = {"offset": size if st is None else 0, "ts": now}  # first sight: the clock and the offset start here
        fire = due(st, size, now)
        user_chars = 0
        if fire:
            _text, user_chars, _end = cap.condense(tpath, int(st["offset"]), cap.detect_format(tpath))
            fire = user_chars >= cap.MIN_USER_CHARS
            state[sid] = {"offset": size, "ts": now}  # a short stretch is skipped, not carried, so the next review starts fresh
        state = {k: v for k, v in state.items() if isinstance(v, dict) and float(v.get("ts", 0)) > now - 14 * 86400}
        try:
            cache_file.private_dir(STATE.parent)
            cache_file.write_text(STATE, json.dumps(state))
        except OSError:
            return None  # without the state a review would fire on every Stop
    text = request() if fire else None
    if user_chars:
        cap._log({"session": sid[:64], "event": "review", "result": "asked" if text else "skipped: too little user text" if not fire else "skipped: no scripts"})
    return {"decision": "block", "reason": text} if text else None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        answer = hook(payload) if isinstance(payload, dict) else None
        if answer:
            print(json.dumps(answer))
    except Exception:
        pass  # a review hook must never wedge a session


if __name__ == "__main__":
    main()
