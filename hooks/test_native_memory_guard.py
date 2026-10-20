#!/usr/bin/env python3
"""Runnable check for native_memory_guard.py. `python3 test_native_memory_guard.py`, exits non-zero on failure.

Loads the guard with importlib straight off its absolute path and feeds full PreToolUse payloads through its handler,
check(), so each case reads as the exact payload the harness would deliver. The stdin cases (malformed payload, the deny
output contract) run the hook as a subprocess the way the harness does. No network, no credentials, no real memory
folder: every path is a made up one under /fake-home.

The allow cases matter as much as the deny cases. A guard that blocks reads, or a sibling folder, gets switched off.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).resolve().parent / "native_memory_guard.py"
MEM = "/fake-home/.claude/projects/-demo/memory"
MEM_FILE = MEM + "/m.md"

spec = importlib.util.spec_from_file_location("native_memory_guard", str(HOOK))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

CASES = [
    # (expected, tool, tool_input, why)
    ("deny", "Write", {"file_path": MEM_FILE, "content": "x"}, "Write into the native memory folder"),
    ("deny", "Edit", {"file_path": MEM_FILE, "new_string": "x"}, "Edit into the native memory folder"),
    ("deny", "MultiEdit", {"file_path": MEM_FILE, "edits": []}, "MultiEdit into the native memory folder"),
    ("deny", "write", {"file_path": MEM_FILE, "content": "x"}, "lowercase write dialect still denies"),
    ("deny", "edit", {"file_path": MEM_FILE, "new_string": "x"}, "lowercase edit dialect still denies"),
    ("deny", "multiedit", {"file_path": MEM_FILE, "edits": []}, "lowercase multiedit dialect still denies"),
    ("allow", "Write", {"file_path": MEM + "-old/m.md", "content": "x"},
     "a sibling folder named memory-old is not the memory folder"),
    ("allow", "Write", {"file_path": "/fake-home/.claude/projects/-demo/notes.md", "content": "x"},
     "a file beside the memory folder is not in it"),
    ("allow", "Write", {"file_path": "/tmp/x.md", "content": "x"}, "outside any memory folder nothing changes"),
    ("allow", "Read", {"file_path": MEM_FILE}, "reads are never blocked"),

    ("deny", "Bash", {"command": "echo hi > " + MEM_FILE}, "a shell redirect into the memory folder"),
    ("deny", "Bash", {"command": "printf 'fact' >> " + MEM_FILE}, "an append redirect into the memory folder"),
    ("deny", "Bash", {"command": "echo x | tee " + MEM_FILE}, "tee into the memory folder"),
    ("deny", "Bash", {"command": "mv /tmp/f " + MEM_FILE}, "mv into the memory folder"),
    ("deny", "Bash", {"command": "cp /tmp/f " + MEM_FILE}, "cp with the memory folder as destination"),
    ("deny", "Bash", {"command": "rm " + MEM_FILE}, "rm inside the memory folder"),
    ("deny", "Bash", {"command": "mkdir -p " + MEM + "/sub"}, "mkdir inside the memory folder"),
    ("deny", "bash", {"command": "echo x > " + MEM_FILE}, "lowercase bash dialect still denies"),
    ("deny", "exec_command", {"cmd": "echo x > " + MEM_FILE}, "exec_command dialect reads the cmd field"),
    ("allow", "Bash", {"command": "cat " + MEM_FILE}, "reading the memory folder is never blocked"),
    ("allow", "Bash", {"command": "cat " + MEM_FILE + " > /tmp/out.md"},
     "a read whose redirect goes outside the folder"),
    ("allow", "Bash", {"command": "grep -rn topic " + MEM + "/ | tee /tmp/hits.txt"},
     "a grep of the folder piped to tee outside it"),
    ("allow", "Bash", {"command": "cp " + MEM_FILE + " /tmp/copy.md"},
     "cp reading from the folder, destination outside it"),
    ("allow", "Bash", {"command": "rm /tmp/x && cat " + MEM_FILE}, "rm outside the folder, cat inside it"),
    ("allow", "Bash", {"command": "echo x > " + MEM + "-old/m.md"},
     "a redirect into a sibling folder named memory-old"),
    ("allow", "Bash", {"command": "echo x > /tmp/confirm.txt"}, "a write outside the folder, no memory path at all"),
]


def check_with(env_value, tool, tool_input):
    """Run check() with ANYMEM_NATIVE set to env_value (None removes it)."""
    if env_value is None:
        os.environ.pop("ANYMEM_NATIVE", None)
    else:
        os.environ["ANYMEM_NATIVE"] = env_value
    return guard.check({"tool_name": tool, "tool_input": tool_input})


def hook_subprocess(stdin_text, env_value="block"):
    env = dict(os.environ)
    if env_value is None:
        env.pop("ANYMEM_NATIVE", None)
    else:
        env["ANYMEM_NATIVE"] = env_value
    return subprocess.run([sys.executable, str(HOOK)], input=stdin_text, capture_output=True, text=True, env=env)


def main():
    failures = []
    passed = 0

    def record(ok, label):
        nonlocal passed
        if ok:
            passed += 1
            print(f"PASS: {label}")
        else:
            failures.append(label)

    for expected, tool, tool_input, why in CASES:
        got = "deny" if check_with("block", tool, tool_input) else "allow"
        record(got == expected, f"{why} (expected {expected}, got {got}: {tool} {tool_input!r})")

    # Off by default: every denying case passes while the variable is unset.
    for expected, tool, tool_input, why in CASES:
        if expected == "deny":
            record(check_with(None, tool, tool_input) is None, f"off by default, not denied: {why}")

    # The deny output contract, through the real stdin path.
    payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": MEM_FILE, "content": "x"}})
    out = hook_subprocess(payload)
    try:
        reply = json.loads(out.stdout)["hookSpecificOutput"]
        ok = out.returncode == 0 and reply["hookEventName"] == "PreToolUse" and reply["permissionDecision"] == "deny" \
            and "remember script" in reply["permissionDecisionReason"]
    except (ValueError, KeyError, TypeError):
        ok = False
    record(ok, "a denial prints hookSpecificOutput with permissionDecision deny, exit 0")

    # Off by default through the real stdin path as well.
    out = hook_subprocess(payload, env_value=None)
    record(out.returncode == 0 and out.stdout == "", "off by default, the hook prints nothing on stdin")

    # A malformed payload must never wedge a session: silent, exit 0, even with the gate on.
    for label, text in (("truncated JSON", '{"garbage"'), ("empty stdin", ""), ("a JSON list", "[1, 2]")):
        out = hook_subprocess(text)
        record(out.returncode == 0 and '"deny"' not in out.stdout, f"malformed payload ({label}) allows silently, exit 0")

    print(f"{passed} passed, {len(failures)} failed")
    if failures:
        for f in failures:
            print("  FAIL: " + f)
        sys.exit(1)


if __name__ == "__main__":
    main()
