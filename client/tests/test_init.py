#!/usr/bin/env python3
"""Runnable check for the init script. `python3 client/tests/test_init.py`, exits non-zero on failure.
Every step command and every tool is replaced by a recorder, so nothing is created, installed or sent."""
from __future__ import annotations

import io
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import config, deploy  # noqa: E402
from hm.commands import init  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def ns(**over):
    base = dict(connect="", name="anymem", domain="", yes=False, dry_run=False, create=False, plan="", access=False, email="")
    base.update(over)
    return SimpleNamespace(**base)


def go(namespace, configured, answers=(), rcs=None):
    """Run init with everything faked. Returns (exit code, the child commands run, their stdin, printed text)."""
    calls, stdins, answers = [], [], list(answers)
    rcs = rcs or {}

    def fake_cli(args, stdin=None):
        calls.append(list(args))
        stdins.append(stdin)
        return rcs.get(args[0], 0)

    init.run_cli = fake_cli
    config.load = lambda *a, **k: SimpleNamespace(configured=lambda: configured)
    init.input = lambda prompt="": answers.pop(0)
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = init.run(namespace)
    return rc, calls, stdins, buf.getvalue()


rc, calls, _, out = go(ns(), configured=True)
check("a machine that already has a store skips the store step", rc == 0 and [c[0] for c in calls] == ["install", "install", "doctor"] and "skipped" in out)
check("it lists, then installs into every harness found", calls[0] == ["install", "--list"] and calls[1] == ["install", "--all"])

rc, calls, _, _ = go(ns(yes=True), configured=True)
check("--yes is passed on to install --all", calls[1] == ["install", "--all", "--yes"])

rc, calls, stdins, _ = go(ns(connect="hm1.abc"), configured=False)
check("--connect hands the string to connect on stdin, not on the command line", calls[0] == ["connect"] and stdins[0] == "hm1.abc" and "hm1.abc" not in " ".join(sum(calls, [])))
check("after a successful connect it goes on to the harnesses and the check", [c[0] for c in calls] == ["connect", "install", "install", "doctor"])

rc, calls, _, out = go(ns(yes=True), configured=False)
check("--yes with nothing configured and no --connect refuses and runs nothing", rc == 1 and calls == [] and "--connect STRING" in out)

rc, calls, _, out = go(ns(name="mine", domain="memory.example.com"), configured=False, answers=["1"])
check("choice 1 runs setup with the name and domain", calls[0] == ["setup", "--name", "mine", "--domain", "memory.example.com"] and rc == 0)

rc, calls, _, _ = go(ns(name="t", access=True, email="me@example.com", plan="paid"), configured=False, answers=["1"])
check("choice 1 passes Access, the email and the plan to setup", calls[0] == ["setup", "--name", "t", "--access", "--email", "me@example.com", "--plan", "paid"])

rc, calls, _, _ = go(ns(create=True, yes=True, name="t", plan="free"), configured=False)
check("--create with --yes makes a store without asking and passes --yes on", calls[0] == ["setup", "--name", "t", "--plan", "free", "--yes"] and [c[0] for c in calls][1:] == ["install", "install", "doctor"])

rc, calls, stdins, _ = go(ns(), configured=False, answers=["2", "hm1.pasted"])
check("choice 2 pastes a string into connect", calls[0] == ["connect"] and stdins[0] == "hm1.pasted")

rc, calls, _, out = go(ns(), configured=False, answers=["x"])
check("any other answer stops and changes nothing", rc == 1 and calls == [] and "Nothing was changed" in out)

rc, calls, _, out = go(ns(), configured=False, answers=["2", ""])
check("an empty connection string stops with a message", rc == 1 and calls == [] and "No connection string" in out)

rc, calls, _, out = go(ns(), configured=False, answers=["2", "hm1.x"], rcs={"connect": 1})
check("a failed store step stops before touching any harness", rc == 1 and [c[0] for c in calls] == ["connect"])

rc, calls, _, out = go(ns(), configured=True, rcs={"doctor": 1})
check("a failing doctor makes init exit 1 but still prints the next steps", rc == 1 and "Next steps only you can do" in out)

rc, calls, _, out = go(ns(dry_run=True), configured=False)
check("--dry-run prints the plan and runs nothing", rc == 0 and calls == [] and "Dry run" in out and "1. Store" in out)

check("init no longer needs Node: no bundle or node helpers are left", not hasattr(init, "ensure_server_bundle") and not hasattr(init, "node_major"))

check("every step init runs has a launcher script", all((init.SCRIPTS / (n + ".py")).is_file() for n in ("setup", "connect", "install", "doctor")))

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
