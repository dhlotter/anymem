#!/usr/bin/env python3
"""The one entry script for Codex hooks: `hook.py EVENT`, the Codex payload on stdin.

    session-start   prints the session start as SessionStart context: the memory capsule, then the status lines
    prompt          prints the memories recalled for the prompt as UserPromptSubmit context
    capture         starts a detached capture worker (wire it to Stop and SessionEnd), reading Codex's rollout format, and on
                    Stop prints the in session review request when one is due (hooks/memory_review.py)

The shared hooks in hooks/ already speak Codex's protocol, so the plugin's own hooks file can call them directly and
nothing here is required. This script adds what is specific to Codex: it skips the internal session Codex runs for its own
memory feature (see payload.is_internal), and it passes the "codex" transcript format to the capture worker.

Never raises, never writes to stderr, and exits 0 with no output on any failure, so a hook cannot wedge a Codex session.
Recall runs under the shared hook deadline (8 seconds by default, ANYMEM_HOOK_DEADLINE), its own call is capped at 6 seconds, and capture only starts a detached worker and returns.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for entry in (str(HERE), str(ROOT / "hooks")):
    if entry not in sys.path:
        sys.path.insert(0, entry)

EVENT_FOR = {"session-start": "SessionStart", "prompt": "UserPromptSubmit", "capture": ""}


def _off(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default) == "0"


def handle(arg: str, raw) -> str:
    """The text to print for `arg` given the decoded payload, or '' for nothing. Capture prints nothing and starts a worker."""
    import payload
    import emit
    payload_in = payload.normalise(raw)
    if arg not in EVENT_FOR or payload.is_internal(raw) or os.environ.get("ANYMEM_CAPTURE_CHILD"):
        return ""
    if arg == "capture":
        if _off("ANYMEM_CAPTURE"):
            return ""
        import memory_capture
        memory_capture.hook(payload_in, "codex")
        if payload_in["hook_event_name"] != "Stop":
            return ""
        import memory_review  # the same Stop hook, so the hooks file and Codex's trust in it stay as they are
        answer = memory_review.hook({**payload_in, "stop_hook_active": bool(raw.get("stop_hook_active")) if isinstance(raw, dict) else False})
        return json.dumps(answer) + "\n" if answer else ""
    if arg == "session-start":
        import session_start  # the same session start as Claude Code: capsule, then the status lines
        return emit.render("SessionStart", session_start.context())
    if _off("ANYMEM_RECALL"):
        return ""
    import memory_recall
    return emit.render("UserPromptSubmit", memory_recall.run(payload_in))


def main(argv=None, stdin=None, stdout=None) -> int:
    os.environ["ANYMEM_HARNESS"] = "codex"  # the audit log and the Worker say which harness called, whatever the environment held
    argv = sys.argv[1:] if argv is None else argv
    real_err = sys.stderr
    sys.stderr = io.StringIO()  # nothing a hook says on stderr reaches the user's terminal
    try:
        data = (stdin or sys.stdin).read()
        try:
            raw = json.loads(data) if data.strip() else {}
        except ValueError:
            raw = {}
        text = handle(argv[0] if argv else "", raw)
        if text:
            (stdout or sys.stdout).write(text)
    except BaseException:  # noqa: BLE001  a hook must never raise
        pass
    finally:
        sys.stderr = real_err
    return 0


if __name__ == "__main__":
    sys.exit(main())
