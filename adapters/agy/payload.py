"""Normalise an Antigravity CLI hook payload to the keys the shared hooks use.

agy sends camelCase JSON on stdin: conversationId, workspacePaths (a list), transcriptPath, artifactDirectoryPath, modelName,
and per event invocationNum and initialNumSteps (PreInvocation, PostInvocation) or executionNum, terminationReason, error and
fullyIdle (Stop). The person's prompt is NOT in the payload, it is read from the transcript.

Shared keys out: hook_event_name (SessionStart, UserPromptSubmit, PreCompact, SessionEnd or Stop), session_id, prompt,
transcript_path, cwd. Always strings.
"""
from __future__ import annotations

import transcript

KEYS = ("hook_event_name", "session_id", "prompt", "transcript_path", "cwd")


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def cwd_of(raw: dict) -> str:
    paths = raw.get("workspacePaths")
    if isinstance(paths, (list, tuple)):
        for p in paths:
            if isinstance(p, str) and p:
                return p
    return ""


def idle(raw: dict) -> bool:
    return raw.get("fullyIdle") is True


UNREAD = object()  # the default of `request`: nothing was read yet


def normalise(raw, event: str, request=UNREAD) -> dict:
    """`event` is the word the hooks file passes to hook.py: "prompt" (PreInvocation) or "capture" (Stop).

    `request` is the (step index, text) that transcript.last_user_request found, when the caller already read the transcript
    tail. The prompt comes from it, so one model call reads the tail once. Without it the tail is read here.

    A Stop with fullyIdle true ends a run, so it maps to SessionEnd, which captures at 8 KB of new transcript. A Stop that is
    not idle is a pause inside a run and stays Stop, which the capture hook only acts on after 60 KB and 20 minutes."""
    raw = raw if isinstance(raw, dict) else {}
    path = _text(raw.get("transcriptPath"))
    out = {"hook_event_name": "", "session_id": _text(raw.get("conversationId")), "prompt": "", "transcript_path": path, "cwd": cwd_of(raw)}
    if event == "prompt":
        out["hook_event_name"] = "UserPromptSubmit"
        if request is UNREAD:
            request = transcript.last_user_request(path) if path else None
        out["prompt"] = request[1] if request else ""
    elif event == "capture":
        out["hook_event_name"] = "SessionEnd" if idle(raw) else "Stop"
    return out
