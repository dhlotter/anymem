"""What the person needs, checked before anything is created.

The API token comes from the environment (CLOUDFLARE_API_TOKEN) or is typed without echo. It is never written anywhere.
"""
from __future__ import annotations

import os
import shutil
import sys

from hm import scripts

from . import cf

TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens"

SCOPES = (
    "Account: Workers Scripts Edit, D1 Edit, Vectorize Edit, Workers R2 Storage Edit. Choose your one account, not all accounts.",
    "Zone: Workers Routes Edit and DNS Edit, only for a custom domain, and only on the zone that holds it (Include: Specific zone).",
    "Account: Access Apps and Policies Edit, and Access Service Tokens Edit, only for Access.",
    "Account: Access Organizations, Identity Providers, and Groups Read, only for Access (it reads the Zero Trust team name).",
)

# One cheap read per scope, so a token that lacks a scope is named before anything is created.
SCOPE_PROBES = (
    ("Workers Scripts Edit", "/workers/scripts"),
    ("D1 Edit", "/d1/database"),
    ("Vectorize Edit", "/vectorize/v2/indexes"),
    ("Workers R2 Storage Edit", "/r2/buckets"),
)


class Problem(Exception):
    """A plain message for the person. Nothing was created."""


def scope_lines() -> list:
    lines = ["Create an API token at %s (Create Token, then Custom token) with these permissions:" % TOKEN_URL]
    lines += ["  %d. %s" % (n, s) for n, s in enumerate(SCOPES, 1)]
    lines.append("The token is used for this run only and is never stored on disk.")
    return lines


def python_ok(version=None) -> bool:
    return tuple((version or sys.version_info)[:2]) >= (3, 9)


def needs_lines(harnesses) -> list:
    """The checklist printed before acting. harnesses is a list of (name, found)."""
    git = shutil.which("git")
    found = [n for n, ok in harnesses if ok]
    lines = ["What you need, and what is here:"]
    lines.append("  1. Python 3.9 or newer: %s (%d.%d)" % ("ok" if python_ok() else "too old, install a newer one", *sys.version_info[:2]))
    lines.append("  2. git: %s" % ("found" if git else "not found. Only needed to fetch or update the repo, setup does not use it"))
    lines.append("  3. A Cloudflare account and an API token: checked next")
    lines.append("  4. Harnesses on this machine: %s" % (", ".join(found) if found else "none found yet (install one, then run `%s`)" % scripts.cmd("install", "--all")))
    lines.append("  5. Node.js: not needed. The Worker is plain JavaScript and setup uploads it through the Cloudflare API.")
    return lines


def get_token(env=None, getpass=None) -> str:
    env = os.environ if env is None else env
    token = env.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token
    if getpass is None:
        import getpass as _g
        getpass = _g.getpass
    try:
        return getpass("Cloudflare API token (input is hidden, never saved): ").strip()
    except (EOFError, KeyboardInterrupt):
        return ""


def pick_account(client: cf.Client, wanted: str) -> str:
    """The account id to use. Given, or the only one the token can see."""
    if wanted:
        return wanted
    try:
        accounts = client.pages("/accounts")
    except cf.CfError as e:
        if e.status == 401:
            raise Problem("Cloudflare says this API token is not valid (%s). Create a new one: %s" % (e.message, TOKEN_URL)) from None
        if e.status == 0:
            raise Problem(e.message + ". Check you are online, then run setup again.") from None
        raise Problem("Cloudflare would not list the accounts this token can use (%s). Set CLOUDFLARE_ACCOUNT_ID to the account id, "
                      "or give the token access to the account." % e.message) from None
    ids = [a for a in accounts if isinstance(a, dict) and a.get("id")]
    if len(ids) == 1:
        return ids[0]["id"]
    if not ids:
        raise Problem("This token can see no Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID, and check the token's account access.")
    raise Problem("This token can see %d accounts. Set CLOUDFLARE_ACCOUNT_ID to the one you want: %s." % (len(ids), ", ".join("%s (%s)" % (a["id"], cf.clean(a.get("name", ""), 40)) for a in ids)))


def check_scopes(client: cf.Client) -> None:
    """One read per scope. Names every scope the token lacks, or a bad token, before anything is created."""
    missing = []
    for label, path in SCOPE_PROBES:
        try:
            client.call("GET", client.acct(path))
        except cf.CfError as e:
            if e.status == 401:
                raise Problem("Cloudflare says this API token is not valid (%s). Create a new one: %s" % (e.message, TOKEN_URL)) from None
            if e.denied:
                missing.append(label)
            elif e.status != 0 and not e.not_found:
                raise Problem("Cloudflare answered a check on %s with an error (%s). Try again in a minute." % (path, e.message)) from None
            elif e.status == 0:
                raise Problem(e.message + ". Check you are online, then run setup again.") from None
    if missing:
        raise Problem("The API token is missing: %s. Nothing was created. %s" % (", ".join(missing), " ".join(scope_lines()[:1] + ["Add the missing permission, or make a new token."])))
