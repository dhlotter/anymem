#!/usr/bin/env python3
"""The one entry script the Antigravity CLI hooks call: `python3 hook.py EVENT`, with the harness payload on stdin.

    prompt    PreInvocation. On the first call of a conversation, injects the memory capsule. On any call whose newest user message
              has not been recalled for yet, injects the memories closest to it. A tool loop makes many model calls for one user
              message, so the last handled message is remembered per conversation and the later calls print nothing.
    capture   Stop. When fullyIdle is true the run is over, so the shared capture hook decides whether enough new transcript
              exists and starts a detached worker. It never waits for it.
    check     Prints "ok" after importing everything, so `install.py --check` can prove the wiring. No network.

Silent by contract: it never prints to stderr, never raises, and exits 0 with no output on any failure or when the client is not
configured. The shared logic (capsule, recall gating, capture, redaction, scoping) lives in hooks/ and client/, this file only
translates. Python 3.9, stdlib only.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FORMAT = "agy"
STATE_KEEP = 40


def _imports() -> None:
    for p in (str(ROOT / "hooks"), str(HERE)):
        if p not in sys.path:
            sys.path.insert(0, p)


def _state_file():
    from hm import config
    return config.cache_dir() / "agy-state.json"


def _read_state() -> dict:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> None:
    try:
        path = _state_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        for key in sorted(state, key=lambda k: state[k].get("ts", 0))[:-STATE_KEEP]:
            del state[key]
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(path)
    except (OSError, AttributeError, TypeError):
        pass


def _message_key(found, prompt: str) -> str:
    """Identifies the user message being answered, `found` is its (step index, text) from the transcript or None. The step index
    is part of it, so the same words typed again later still count as new."""
    step = found[0] if found else -1
    return f"{step}:{hashlib.sha1(prompt.encode('utf-8', 'replace')).hexdigest()[:16]}"


def handle_prompt(raw: dict) -> str:
    """The stdout text for a PreInvocation hook ("" for nothing)."""
    import adapter_gate
    import emit
    import memory_capsule
    import memory_recall
    import payload as hm_payload
    import transcript
    if adapter_gate.child():
        return ""
    if not memory_capsule._settings().configured():
        return ""
    path = raw.get("transcriptPath") if isinstance(raw.get("transcriptPath"), str) else ""
    request = transcript.last_user_request(path) if path else None  # the one read of the transcript tail for this call
    p = hm_payload.normalise(raw, "prompt", request)
    cid = p["session_id"]
    if not cid:
        return ""
    state = _read_state()
    entry = state.get(cid) if isinstance(state.get(cid), dict) else None
    blocks = []
    if entry is None:  # first call we see for this conversation (invocationNum 0 on a normal start)
        capsule = memory_capsule.block()
        if capsule:
            blocks.append(capsule)
    key = _message_key(request, p["prompt"]) if p["prompt"] else ""
    if key and (entry or {}).get("last") != key and not adapter_gate.off("ANYMEM_RECALL"):
        recalled = memory_recall.run(p)
        if recalled:
            blocks.append(recalled)
    state[cid] = {"last": key or (entry or {}).get("last", ""), "ts": time.time()}
    _write_state(state)
    return emit.render(*blocks)


def handle_capture(raw: dict) -> None:
    import adapter_gate
    import memory_capture
    import payload as hm_payload
    if adapter_gate.child() or adapter_gate.off("ANYMEM_CAPTURE"):
        return
    if not hm_payload.idle(raw):
        return  # a pause inside a run, not its end
    import memory_capsule
    if not memory_capsule._settings().configured():
        return
    memory_capture.hook(hm_payload.normalise(raw, "capture"), FORMAT)


def main(argv: list, stdin=None, stdout=None) -> int:
    os.environ["ANYMEM_HARNESS"] = "agy"  # the audit log and the Worker say which harness called, whatever the environment held
    event = argv[0] if argv else ""
    stdout = stdout or sys.stdout
    try:
        _imports()
        if event == "check":
            import emit, memory_capsule, memory_capture, memory_recall, payload, transcript  # noqa: F401,E401
            stdout.write("ok\n")
            return 0
        if event not in ("prompt", "capture"):
            return 0
        raw = json.load(stdin or sys.stdin)
        if not isinstance(raw, dict):
            return 0
        if event == "prompt":
            text = handle_prompt(raw)
            if text:
                stdout.write(text)
        else:
            handle_capture(raw)
    except BaseException:  # a memory hook must never wedge or fail a model call
        pass
    try:
        stdout.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
