"""One question to the local `claude` command, asked from a private folder with no settings loaded.

Capture (hooks/memory_capture.py) and capsule-check (hm.commands.capsule_check) both ask a small model through `claude -p`. A print
run skips the workspace trust dialog, so the folder it starts in decides which project settings and hooks it would load. Starting it
in /tmp let anything that could write there plant .claude/settings.local.json, whose hooks would run as the user with the transcript
on stdin. So the child gets a folder made for this one call (mode 0700, removed afterwards) and an empty source list, which loads no
user, project or local settings at all. stdlib only."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

PRIVATE_PREFIX = "anymem-claude-"


def run(exe: str, prompt: str, model: str, timeout: float) -> subprocess.CompletedProcess:
    """`claude -p` with the prompt on stdin. Raises what subprocess.run raises (OSError, TimeoutExpired); the folder is removed either way."""
    folder = tempfile.mkdtemp(prefix=PRIVATE_PREFIX)  # 0700, a name nobody else can predict
    try:
        return subprocess.run([exe, "-p", "--model", model, "--setting-sources", "", "--no-session-persistence", "--output-format", "text"],
                              input=prompt, capture_output=True, text=True, cwd=folder, timeout=timeout,
                              env={**os.environ, "ANYMEM_CAPTURE_CHILD": "1"})
    finally:
        shutil.rmtree(folder, ignore_errors=True)
