#!/usr/bin/env python3
"""Runs every Python test in the repo (client/tests, hooks, adapters, migration) as its own process and reports one line each.
Exits non-zero if any fails. Run it as `python3 client/tests/run_all.py`."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
tests = sorted([*ROOT.glob("client/tests/test_*.py"), *ROOT.glob("hooks/test_*.py"), *ROOT.glob("adapters/*/test_*.py"), *ROOT.glob("migration/test_*.py")])


# A stub `claude` that fails loudly. It comes first on PATH, so a test that reaches the real claude command (a paid model call) fails
# instead of running it. A test that needs "no claude command" must say so by mocking the lookup, not by relying on PATH.
STUB_TMP = tempfile.TemporaryDirectory()
STUB_DIR = STUB_TMP.name
STUB = os.path.join(STUB_DIR, "claude")
with open(STUB, "w") as f:
    f.write("#!/bin/sh\necho 'a test called the real claude command, which run_all.py forbids' >&2\nexit 97\n")
os.chmod(STUB, 0o755)


def clean_env(home: str) -> dict:
    """The environment a test gets: no inherited Worker settings, a temporary HOME, so no real config.json or cache is read,
    and the claude stub first on PATH."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_"))}
    env["HOME"] = home
    env["PATH"] = STUB_DIR + os.pathsep + env.get("PATH", "")
    return env


bad = 0
for t in tests:
    with tempfile.TemporaryDirectory() as home:
        p = subprocess.run([sys.executable, str(t)], capture_output=True, text=True, cwd=str(ROOT), timeout=300, env=clean_env(home))
    last = (p.stdout.strip().splitlines() or [""])[-1]
    print(f"{'ok  ' if p.returncode == 0 else 'FAIL'} {t.relative_to(ROOT)}  {last[:70]}")
    if p.returncode != 0:
        bad += 1
        print((p.stdout + p.stderr)[-600:])
print(f"{len(tests) - bad}/{len(tests)} test files passed")
sys.exit(1 if bad else 0)
