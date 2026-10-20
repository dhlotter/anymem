"""`init.py`: the first run in one command. Safe to rerun, it skips whatever is already done.

    1. Store: if this machine has no Worker address and token yet, create a store in your own Cloudflare account (`setup`) or
       connect to one that exists (`connect`). A machine that is already pointed at a Worker skips this step.
    2. Harnesses: list what is installed on this machine, then wire each one found (`install --all`).
    3. Check: `doctor`, then the next steps only you can do (restart open sessions, approve hooks).

Each step is the existing command run as a child, so it asks its own questions and keeps its own safety rules. --dry-run prints
the plan and runs nothing. --yes passes through to every step that asks "go ahead?"."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from hm import config, deploy, scripts

COMMAND = "init"
HELP = "first run: create or connect a store, wire every harness found, then check (safe to rerun)"

SCRIPTS = deploy.plugin_root() / "skills" / "anymem" / "scripts"


def register(parser):
    parser.add_argument("--connect", default="", metavar="STRING", help="connect to an existing store with this connection string instead of creating one")
    parser.add_argument("--create", action="store_true", help="create a new store without asking which (works with --yes)")
    parser.add_argument("--plan", default="", help="your Cloudflare plan, free or paid, passed to setup")
    parser.add_argument("--name", default=deploy.DEFAULT_NAME, help="name prefix for the new store's resources (default: %(default)s)")
    parser.add_argument("--domain", default="", help="custom domain for a new store, for example memory.example.com")
    parser.add_argument("--access", action="store_true", help="put Cloudflare Access in front of a new store (recommended), needs --email")
    parser.add_argument("--email", default="", help="the email you log in with in a browser, for the Access allow rule")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation in any step")
    parser.add_argument("--dry-run", action="store_true", dest="dry_run", help="print the plan and run nothing")


def run_cli(args, stdin=None) -> int:
    """One skill script as a child that shares this terminal. args[0] names the script. stdin carries a secret without putting it on the command line."""
    return subprocess.run([sys.executable, str(SCRIPTS / (args[0] + ".py")), *args[1:]], input=stdin, text=True if stdin is not None else None).returncode


def plan(configured: bool, ns) -> list:
    steps = []
    if configured:
        steps.append("Store: already pointed at a Worker, skipped.")
    elif ns.connect:
        steps.append("Store: connect to the existing Worker named in your connection string.")
    else:
        steps.append("Store: ask whether to create a new store in your Cloudflare account or connect to an existing one.")
    steps.append("Harnesses: list what is installed here, then wire each one found (" + scripts.cmd("install", "--all") + ").")
    steps.append("Check: " + scripts.cmd("doctor") + ", then the next steps only you can do.")
    return steps


def store_step(ns) -> int:
    if ns.connect:
        return run_cli(["connect"], stdin=ns.connect)
    if ns.yes and not ns.create:
        print("Nothing is configured here and --yes cannot choose for you. Add --connect STRING to connect, --create to make a new store, or run " + scripts.cmd("init") + " without --yes.")
        return 1
    if ns.create:
        choice = "1"
    else:
        print("This machine is not connected to a store yet.")
        print("  1. Create a new store in my own Cloudflare account")
        print("  2. Connect to a store that already exists (I have a connection string)")
        try:
            choice = input("Pick 1 or 2 (anything else stops): ").strip()
        except EOFError:
            choice = ""
    if choice == "1":
        args = ["setup", "--name", ns.name]
        if ns.domain:
            args += ["--domain", ns.domain]
        if ns.access:
            args += ["--access", "--email", ns.email]
        if ns.plan:
            args += ["--plan", ns.plan]
        if ns.yes:
            args.append("--yes")
        return run_cli(args)
    if choice == "2":
        try:
            string = input("Paste the connection string: ").strip()
        except EOFError:
            string = ""
        if not string:
            print("No connection string given. Nothing was changed.")
            return 1
        return run_cli(["connect"], stdin=string)
    print("Stopped. Nothing was changed.")
    return 1


def run(ns):
    configured = config.load().configured()
    print("Anymem first run")
    for i, line in enumerate(plan(configured, ns), 1):
        print(f"  {i}. {line}")
    if ns.dry_run:
        print("Dry run, nothing was run.")
        return 0
    if not configured:
        if store_step(ns) != 0:
            return 1
    print("\nHarnesses on this machine:")
    run_cli(["install", "--list"])
    print()
    rc = run_cli(["install", "--all"] + (["--yes"] if ns.yes else []))
    print("\nChecking everything:")
    doctor_rc = run_cli(["doctor"])
    print("\nNext steps only you can do:")
    print("  1. Restart any harness session that was already open, so it loads the hooks.")
    print("  2. If a harness asks you to approve the new hooks (Codex does), approve them once.")
    print("  3. Add a harness we do not ship with: " + scripts.cmd("install", "--new NAME"))
    return 0 if rc == 0 and doctor_rc == 0 else 1
