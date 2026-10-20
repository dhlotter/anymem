#!/usr/bin/env python3
"""
PreToolUse hook: once the shared anymem store is the memory, Claude Code's own auto memory folder
(~/.claude/projects/<project>/memory/) is closed to writes.

Off until ANYMEM_NATIVE is set to "block". While it is unset every call passes and the hook stays silent, so
wiring this hook alone changes nothing. With "block" it denies:

  - Write, Edit and MultiEdit whose file_path sits inside such a folder,
  - Bash commands that write into one: a redirect (> or >>) whose target is in the folder, tee, mv, rm or mkdir
    touching it, or cp whose destination is in it.

Reads are never blocked. A denial tells the model to call the anymem skill's remember script instead, the one write path that
reaches the database.

Tool name dialects: Claude Code says Write, Edit, MultiEdit and Bash. Other harnesses say write, edit, multiedit, bash
and exec_command. All of them normalise to the Claude spelling, because a guard that does not recognise a harness's tool
name allows everything, silently. The shell command is read from "command", or from "cmd" for exec_command.

Shell check: the command is cut at pipes, separators and && / ||, and each piece is judged on its own. So
`grep ... memory/ | tee out.txt` passes, the tee in the second piece never touches the folder. A piece writes into the
folder when a redirect targets it, or when its first word is a write command with the folder in it. A write hidden
behind python -c or a subshell is invisible here, the same limit the other guards carry.

Output contract: a denial prints hookSpecificOutput with permissionDecision "deny" on stdout and exits 0. Anything else
exits 0 silently. A malformed payload never wedges a session. Reads the PreToolUse payload on stdin, stdlib only.
`native_memory_guard.py selfcheck` runs the built-in asserts.
"""
from __future__ import annotations

import json
import os
import re
import sys

# A Claude Code auto memory folder, and anything inside it. The end anchor, or a slash right after "memory", keeps a
# sibling such as .../memory-old out of scope.
NATIVE_RE = re.compile(r"/\.claude/projects/[^/]+/memory(?:/|$)")
SPLIT_RE = re.compile(r"\|\||&&|[;|&\n]")
REDIRECT_RE = re.compile(r">>?\s*(\S+)")
WRITE_WORDS = ("tee", "mv", "rm", "mkdir")  # every path on the line counts as a write target
FILE_WRITERS = ("Write", "Edit", "MultiEdit")

DIALECT = {
    "bash": "Bash",
    "exec_command": "Bash",
    "write": "Write",
    "edit": "Edit",
    "multiedit": "MultiEdit",
}

DENY = (
    "This writes into Claude Code's own memory folder ({where}). Memory lives in the shared anymem store now: "
    "run the anymem skill's remember script with the fact (frontmatter name, description, metadata.type, then the body), or "
    "its append or update script to change an existing one. Files here never reach the database."
)


def enabled() -> bool:
    return os.environ.get("ANYMEM_NATIVE", "").strip().lower() == "block"


def canonical(name) -> str:
    return DIALECT.get(name, name) if isinstance(name, str) else ""


def segment_writes(seg: str) -> bool:
    """One piece of a shell command, already cut from the rest. True when it writes into a memory folder."""
    if not NATIVE_RE.search(seg):
        return False
    if any(NATIVE_RE.search(target) for target in REDIRECT_RE.findall(seg)):
        return True
    words = seg.split()
    if not words:
        return False
    head = words[0].rsplit("/", 1)[-1]
    if head == "cp":  # cp reads its sources, only the destination is written
        return bool(NATIVE_RE.search(words[-1]))
    return head in WRITE_WORDS


def shell_writes_native(cmd: str) -> bool:
    return any(segment_writes(seg) for seg in SPLIT_RE.split(cmd))


def check(payload):
    """One PreToolUse payload in, a verdict out: the denial text, or None to allow. main() wraps this in the stdin and
    exit plumbing, and the selfcheck drives it directly. A payload whose shape cannot be read is one this gate stays
    out of."""
    if not enabled() or not isinstance(payload, dict):
        return None
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        return None

    tool = canonical(payload.get("tool_name"))
    if tool in FILE_WRITERS:
        path = ti.get("file_path")
        if isinstance(path, str) and NATIVE_RE.search(path):
            return DENY.format(where=path)
        return None

    if tool == "Bash":
        cmd = ti.get("command", ti.get("cmd"))
        if isinstance(cmd, str) and shell_writes_native(cmd):
            return DENY.format(where=cmd.strip()[:160])
    return None


def allow():
    sys.exit(0)


def deny(reason):
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, sys.stdout)
    sys.exit(0)


def selfcheck():
    """Pins the cases this gate exists for, and the ones it must not touch. A gate that fires on reads gets switched off
    within a day, so the false positives matter as much as the true ones."""
    native = "/fake-home/.claude/projects/-demo/memory/m.md"

    # Off by default: nothing passes while the variable is unset.
    os.environ.pop("ANYMEM_NATIVE", None)
    assert check({"tool_name": "Write", "tool_input": {"file_path": native}}) is None

    os.environ["ANYMEM_NATIVE"] = "block"
    assert check({"tool_name": "Write", "tool_input": {"file_path": native}})
    assert check({"tool_name": "Edit", "tool_input": {"file_path": native}})
    assert check({"tool_name": "MultiEdit", "tool_input": {"file_path": native}})
    assert check({"tool_name": "Bash", "tool_input": {"command": "echo x > " + native}})
    assert check({"tool_name": "Bash", "tool_input": {"command": "echo x | tee " + native}})

    # Reads and the folder's neighbours pass.
    assert check({"tool_name": "Read", "tool_input": {"file_path": native}}) is None
    assert check({"tool_name": "Bash", "tool_input": {"command": "cat " + native}}) is None
    assert check({"tool_name": "Write", "tool_input": {"file_path": "/fake-home/.claude/projects/-demo/notes.md"}}) is None
    assert check({"tool_name": "Write", "tool_input": {"file_path": native.replace("/memory/", "/memory-old/")}}) is None

    # Dialects: lowercase names reach the same branch.
    assert check({"tool_name": "write", "tool_input": {"file_path": native}})
    assert check({"tool_name": "edit", "tool_input": {"file_path": native}})
    assert check({"tool_name": "multiedit", "tool_input": {"file_path": native}})
    assert check({"tool_name": "bash", "tool_input": {"command": "echo x > " + native}})
    assert check({"tool_name": "exec_command", "tool_input": {"cmd": "echo x > " + native}})

    # A payload whose shape cannot be read is one this gate stays out of.
    assert check(None) is None
    assert check({"tool_name": "Bash", "tool_input": None}) is None
    assert check({"tool_name": "Bash", "tool_input": {"command": 42}}) is None

    os.environ.pop("ANYMEM_NATIVE", None)
    print("selfcheck ok")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "selfcheck":
        selfcheck()
        return

    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()  # never wedge a session on a malformed payload

    reason = check(payload)
    if reason:
        deny(reason)

    allow()


if __name__ == "__main__":
    main()
