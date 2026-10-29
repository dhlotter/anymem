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


def _drop_project_folder(folder: str) -> None:
    """Claude Code keeps a ~/.claude/projects/<folder path, every non-alphanumeric as "-"> entry for any folder it starts in, and
    the throwaway folder is never used again, so 60 to 90 empty entries a day pile up. Remove ours, but only while it is empty or
    holds nothing except a `memory` link (a harness may wire one in), never a folder that has a session in it."""
    root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    slug = "".join(c if c.isalnum() and c.isascii() else "-" for c in os.path.realpath(folder))
    entry = os.path.join(root, "projects", slug)
    try:
        if set(os.listdir(entry)) <= {"memory"}:
            shutil.rmtree(entry)
    except OSError:
        pass


def run(exe: str, prompt: str, model: str, timeout: float) -> subprocess.CompletedProcess:
    """`claude -p` with the prompt on stdin. Raises what subprocess.run raises (OSError, TimeoutExpired); the folder is removed either way."""
    folder = tempfile.mkdtemp(prefix=PRIVATE_PREFIX)  # 0700, a name nobody else can predict
    try:
        return subprocess.run([exe, "-p", "--model", model, "--setting-sources", "", "--no-session-persistence", "--output-format", "text"],
                              input=prompt, capture_output=True, text=True, cwd=folder, timeout=timeout,
                              env={**os.environ, "ANYMEM_CAPTURE_CHILD": "1"})
    finally:
        _drop_project_folder(folder)
        shutil.rmtree(folder, ignore_errors=True)
