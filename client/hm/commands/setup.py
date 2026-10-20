"""`setup.py`, create the store in your own Cloudflare account through the Cloudflare API. No Node, no Wrangler."""
from __future__ import annotations

import os
import sys

from hm import adapter_roots  # noqa: E402

ROOT = adapter_roots.PLUGIN_ROOT
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hm import deploy  # noqa: E402

COMMAND = "setup"
HELP = "create Anymem in your own Cloudflare account (safe to rerun, never deletes anything)"


def register(parser):
    parser.add_argument("--name", default=deploy.DEFAULT_NAME, help="name prefix for every resource (default: %(default)s)")
    parser.add_argument("--domain", default="", help="custom domain for the Worker, for example memory.example.com (default: a workers.dev address)")
    parser.add_argument("--subdomain", default="", help="the account's workers.dev name, only needed when the account has none yet")
    parser.add_argument("--access", action="store_true", help="put Cloudflare Access in front (recommended), needs --email")
    parser.add_argument("--no-access", action="store_true", dest="no_access", help="turn Cloudflare Access off on a store that has it (the only way to drop it, setup prints a warning)")
    parser.add_argument("--email", default="", help="the email you log in with in a browser, for the Access allow rule")
    parser.add_argument("--plan", default="", help="your Cloudflare plan, free or paid (asked when left out)")
    parser.add_argument("--account-id", default="", dest="account_id", help="the Cloudflare account id (default: CLOUDFLARE_ACCOUNT_ID, else the only account the token sees)")
    parser.add_argument("--rotate-access", action="store_true", dest="rotate_access", help="with --access, replace the Access service token: the old one is deleted and every connection string made before stops passing Access")
    parser.add_argument("--second-machine", action="store_true", dest="second_machine", help="also make a connection string for a second machine (one device token and the Access pair), written to a 0600 file")
    parser.add_argument("--scopes", action="store_true", help="print the API token permissions setup needs and stop")
    parser.add_argument("--dry-run", action="store_true", dest="dry_run", help="print every API call, send nothing")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation or the plan")


def harnesses():
    from hm.commands import install
    found = []
    for name, (module, _) in install.load_adapters().items():
        if module is None:
            continue
        info = install.detect_one(name, module)
        if info is not None:
            found.append((name, bool(info.get("found"))))
    return found


def run(ns):
    from setup import preflight, run as runner
    if ns.scopes:
        for line in preflight.scope_lines():
            print(line)
        return 0
    opts = runner.Options(name=ns.name, domain=ns.domain, subdomain=ns.subdomain, access=ns.access, no_access=ns.no_access, email=ns.email, plan=ns.plan, dry_run=ns.dry_run,
                          yes=ns.yes, rotate_access=ns.rotate_access, second_machine=ns.second_machine, account_id=ns.account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip(),
                          harnesses=harnesses)
    if not ns.yes and not ns.dry_run:
        opts.confirm = _confirm
    return runner.run_setup(opts)


def _confirm() -> bool:
    try:
        return input("Go ahead? [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False
