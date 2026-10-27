#!/usr/bin/env python3
"""The one entry script for Cline: `hook.py EVENT`, the plugin (plugin.js) pipes a JSON payload to stdin.

    session-start   print the always-on capsule
    prompt          print the memories recalled for the prompt
    capture         start a detached capture worker on the spool file (the end of a run)

Output for session-start and prompt is always one JSON line, {"keep": true or false, "additionalContext": "..."}, the
additionalContext only when there is text (see emit.py). keep says whether the capture policy lets plugin.js spool the
conversation text. Other events print nothing. Silent and exit 0 on any failure, including garbage input and an unconfigured
client: a session must never wait on or fail because of memory. Recall runs under the shared hook deadline (ANYMEM_HOOK_DEADLINE, 8 seconds when unset, and plugin.js sets 2 because Cline stops a
hook after 3 seconds) and the capsule call has its own network timeout (ANYMEM_HOOK_TIMEOUT, 2 from plugin.js). Capture only starts a
worker and returns.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("ANYMEM_PLUGIN_ROOT") or HERE.parent.parent)
CAPSULE_LIMIT = 9500
REPLY_EVENTS = ("session-start", "prompt")


def prune_spools() -> None:
    """Spool files of sessions the capture state has forgotten are deleted, so the cache folder stays small."""
    from hm import config
    import adapter_gate
    adapter_gate.prune(config.cache_dir() / "cline")


def keeps_text(raw) -> bool:
    """True when the capture policy allows this session's conversation text to be spooled: the same check zcode makes (hm.policy).
    Any problem answers False, so nothing is written."""
    try:
        sys.path.insert(0, str(HERE))
        sys.path.insert(0, str(ROOT / "hooks"))
        import _path  # noqa: F401  (puts client/ on sys.path)
        import payload
        from hm import policy
        p = payload.normalise(raw, "")
        return bool(p["session_id"]) and policy.allowed(p["session_id"], p["cwd"])[0]
    except Exception:
        return False


def handle(event: str, raw) -> str:
    """The context text for an event, "" for none. Capture returns "" after starting its worker."""
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(ROOT / "hooks"))
    import adapter_gate
    import payload
    p = payload.normalise(raw, event)
    name = p["hook_event_name"]
    if not name or adapter_gate.child():  # the extraction child must never recall or capture
        return ""
    if name == "SessionStart":
        import memory_capsule
        prune_spools()  # whatever the capsule setting, spools past their keep time go
        if adapter_gate.off("ANYMEM_CAPSULE") or not memory_capsule._settings().configured():
            return ""
        return (memory_capsule.block() or "")[:CAPSULE_LIMIT]
    if name == "UserPromptSubmit":
        if adapter_gate.off("ANYMEM_RECALL"):
            return ""
        import memory_recall
        return memory_recall.run(p)
    import memory_capture
    memory_capture.hook(p, "cline")
    return ""


def main(argv: list) -> int:
    os.environ["ANYMEM_HARNESS"] = "cline"  # the audit log and the Worker say which harness called, whatever the environment held
    try:
        event = argv[1] if len(argv) > 1 else ""
        try:
            raw = json.loads(sys.stdin.read() or "{}")
        except (ValueError, OSError):
            raw = {}
        text = handle(event, raw)
        if event in REPLY_EVENTS:  # plugin.js reads keep from these two replies, with or without text
            sys.path.insert(0, str(HERE))
            import emit
            sys.stdout.write(emit.reply(text, keeps_text(raw)))
            sys.stdout.flush()
    except BaseException:  # nothing may reach the session, not even an exit
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
