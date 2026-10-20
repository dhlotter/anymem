#!/usr/bin/env python3
"""The one entry point for every ZCode hook: `python3 hook.py EVENT`, the payload on stdin.

    session-start   SessionStart: the memory capsule goes into the session's context
    prompt          UserPromptSubmit: the memories closest to the prompt go into the context, and the prompt is kept for capture
    capture         Stop: the reply is kept, and a capture worker is started when enough new conversation has built up

The logic lives in the shared hooks (hooks/memory_capsule.py, memory_recall.py, memory_capture.py). This file only normalises
the payload, calls them and prints in ZCode's protocol (see emit.py).

Why it keeps its own copy of the conversation: the transcript ZCode hands a hook is a temporary file that holds one message
(the prompt for UserPromptSubmit, the reply for Stop) and is deleted when the hook returns. A capture reading that file would
never see more than a few hundred bytes. So each prompt and each reply is appended to a per session file in the cache
folder (mode 0600, same layout as ZCode's own records), and that file is what capture reads (transcript.py). Nothing is
written when the capture policy is off or the session or folder is excluded.

ZCode sends no PreCompact and no SessionEnd, so a finished turn (Stop) is treated as the end of a session segment: capture
becomes due after 8 KB of new conversation, the same bar a session end has. Stop's own bar (60 KB and 20 minutes apart)
would leave nearly every ZCode session uncaptured.

Silent by design: it never raises, never prints to stderr, and exits 0 on any failure, so a session is never held up by
memory. Recall runs under the shared hook deadline (8 seconds by default, ANYMEM_HOOK_DEADLINE), its own call is capped at 6 seconds, and capture only starts a detached worker.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for folder in (str(ROOT / "hooks"), str(HERE)):
    if folder not in sys.path:
        sys.path.insert(0, folder)

import adapter_gate  # noqa: E402
import payload  # noqa: E402
import emit  # noqa: E402

FORMAT = "zcode"                # transcript reader name, adapters/zcode/transcript.py
CAPTURE_EVENT = "SessionEnd"    # what a finished ZCode turn counts as, see the module note
BUFFER_MAX_BYTES = 4_000_000    # a session's file rotates aside past this, see rotate()
RECORD_MAX_CHARS = 20_000       # one prompt or reply, capture only uses the first 2,500 anyway


def buffer_path(session_id: str) -> Path:
    import _path  # noqa: F401  (puts client/ on sys.path)
    from hm import config
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[:60]
    return config.cache_dir() / "zcode-sessions" / f"{safe}.jsonl"


def allowed(p: dict) -> bool:
    """False when capture is off, or this session or folder is excluded (hm.policy)."""
    import _path  # noqa: F401
    from hm import policy
    return bool(p["session_id"]) and policy.allowed(p["session_id"], p["cwd"])[0]


def rotate(path: Path, session_id: str) -> None:
    """A session file past BUFFER_MAX_BYTES moves aside to <session>.full.jsonl, replacing the one before, and a new file starts.
    Capture keeps a byte offset into the old file. memory_capture starts that session again at 0 when the file is shorter than
    the offset, and the rotation goes to the capture log, so nothing is dropped without a word."""
    import memory_capture
    size = path.stat().st_size
    os.replace(str(path), str(path.parent / (path.stem + ".full.jsonl")))
    memory_capture._log({"event": "zcode-buffer-rotated", "session": session_id[:8], "bytes": size})


def keep_turn(p: dict, role: str, text: str) -> "Path | None":
    """Append one turn to this session's file. None when nothing was kept. Raises OSError when the cache cannot be written, the
    callers decide what that costs."""
    text = (text or "").strip()
    if not text or not allowed(p):
        return None
    path = buffer_path(p["session_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > BUFFER_MAX_BYTES:
        rotate(path, p["session_id"])
    record = {"message": {"role": role, "content": [{"type": "text", "text": text[:RECORD_MAX_CHARS]}]}}
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return path


def on_session_start(p: dict) -> str:
    import memory_capsule
    if not memory_capsule._settings().configured():
        return ""
    return memory_capsule.block() or ""


def on_prompt(p: dict) -> str:
    try:
        keep_turn(p, "user", p["prompt"])
    except OSError:  # an unwritable cache costs the copy of this turn, never the recall for it
        pass
    if adapter_gate.off("ANYMEM_RECALL"):
        return ""
    import memory_recall
    return memory_recall.run(p)


def on_capture(p: dict) -> str:
    try:
        path = keep_turn(p, "assistant", p["last_assistant_message"]) or buffer_path(p["session_id"])
    except OSError:  # capture can still read what the earlier turns kept
        path = buffer_path(p["session_id"])
    if not allowed(p) or not path.exists():
        return ""
    import memory_capture
    memory_capture.hook({"hook_event_name": CAPTURE_EVENT, "session_id": p["session_id"],
                         "transcript_path": str(path), "cwd": p["cwd"]}, FORMAT)
    adapter_gate.prune(path.parent)
    return ""


HANDLERS = {
    "session-start": ("SessionStart", on_session_start),
    "prompt": ("UserPromptSubmit", on_prompt),
    "capture": ("Stop", on_capture),
}


def run(word: str, raw_stdin: str) -> str:
    """The text to print for this event (empty for none). Raises on a failure, main() swallows it."""
    if word == "check":  # "ok" only after every shared module loads, the adapter's check runs this word
        import memory_capsule, memory_capture, memory_recall  # noqa: E401,F401
        return "ok\n"
    if word not in HANDLERS or adapter_gate.child():
        return ""
    try:
        raw = json.loads(raw_stdin or "{}")
    except ValueError:
        raw = {}
    event, handler = HANDLERS[word]
    return emit.context(event, handler(payload.normalize(raw, word)))


def main(argv: list) -> int:
    os.environ["ANYMEM_HARNESS"] = "zcode"  # the audit log and the Worker say which harness called, whatever the environment held
    real_out = sys.stdout
    try:
        sys.stderr = open(os.devnull, "w")
        sys.stdout = io.StringIO()  # anything a shared hook prints by accident never reaches ZCode
        word = argv[1] if len(argv) > 1 else ""
        out = run(word, sys.stdin.read())
    except BaseException:
        out = ""
    finally:
        sys.stdout = real_out
    if out:
        try:
            real_out.write(out)
            real_out.flush()
        except (OSError, ValueError):
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
