"""`uninstall.py`, remove what `setup` created. Lists by default, deletes only when told twice."""
from __future__ import annotations

import os
import sys

from hm import adapter_roots  # noqa: E402

ROOT = adapter_roots.PLUGIN_ROOT
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hm import deploy, scripts  # noqa: E402

COMMAND = "uninstall"
HELP = "show what setup created, and with --delete-resources delete it (asks you to type delete)"


def register(parser):
    parser.add_argument("--delete-resources", action="store_true", dest="delete_resources", help="really delete the resources listed in deploy.json")
    parser.add_argument("--include-backups", action="store_true", dest="include_backups", help="also delete the R2 backup bucket (it must be empty)")
    parser.add_argument("--yes", action="store_true", help="with --delete-resources, skip typing the word delete")


def run(ns):
    from setup import cf, preflight, teardown
    state = deploy.load_state()
    items = teardown.plan(state, ns.include_backups)
    note = teardown.unfinished_note(state)
    if not items:
        print(note or "Nothing to remove: %s lists no resources." % deploy.state_file())
        return 0
    print("setup recorded these resources in %s:" % deploy.state_file())
    for kind, name in items:
        print("  %-20s %s" % (teardown.LABELS[kind], name))
    if state.get("r2") and not ns.include_backups:
        print("  The R2 backup bucket %s is kept unless you add --include-backups." % state["r2"].get("name"))
    if note:
        print(note)
    if not ns.delete_resources:
        print("Nothing was deleted. To delete them all, including every memory stored in them, run `%s`." % scripts.cmd("uninstall", "--delete-resources"))
        return 0
    if not ns.yes:
        try:
            typed = input("This permanently deletes the resources above and the memories in them. Type delete to continue: ").strip()
        except EOFError:
            typed = ""
        if typed != "delete":
            print("Stopped. Nothing was deleted.")
            return 1
    token = preflight.get_token()
    if not token:
        print("No API token given. Nothing was deleted. `%s` lists the permissions it needs." % scripts.cmd("setup", "--scopes"))
        return 1
    account = state.get("account_id") or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not account:
        print("deploy.json has no account id and CLOUDFLARE_ACCOUNT_ID is not set. Nothing was deleted.")
        return 1
    return teardown.delete_resources(cf.Client(token, account), ns.include_backups, print)
