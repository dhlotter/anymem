"""`uninstall.py`. Removes what setup recorded in deploy.json and nothing else.

Order is the reverse of creation. The R2 bucket holds the backups, so it is kept unless the person asks for it with
include_backups, and a bucket that still holds objects is never emptied by this code. Every name is checked against the
recorded prefix before a delete, so a hand edited deploy.json cannot point it at an unrelated resource.
"""
from __future__ import annotations

from hm import deploy, scripts

from . import cf

LABELS = {"worker": "Worker", "access": "Access application", "vectorize": "Vectorize index", "d1": "D1 database", "r2": "R2 backup bucket"}


def _name(state: dict, kind: str) -> str:
    entry = state.get(kind)
    value = entry.get("name") if isinstance(entry, dict) else ""
    return value if isinstance(value, str) else ""


def plan(state: dict, include_backups: bool = False) -> list:
    """(kind, name) in deletion order, only what deploy.json recorded and only names that start with the recorded prefix."""
    prefix = state.get("name") if isinstance(state.get("name"), str) else ""
    out = []
    for kind in ("worker", "access", "vectorize", "d1") + (("r2",) if include_backups else ()):
        name = _name(state, kind)
        if name and prefix and name.startswith(prefix):
            out.append((kind, name))
    return out


def unfinished_note(state: dict) -> str:
    pending = state.get("pending") if isinstance(state.get("pending"), list) else []
    items = [k for k in pending if k in LABELS and not _name(state, k)]
    if not items:
        return ""
    return ("A setup run stopped part way through creating: %s. They may exist in your Cloudflare account without being recorded, so uninstall will not delete them. "
            "Check the Cloudflare dashboard and remove them there if you do not want them." % ", ".join(LABELS[k] for k in items))


def _gone(err: cf.CfError) -> bool:
    return err.not_found


def delete(client: cf.Client, state: dict, kind: str, name: str) -> None:
    acct = client.acct
    if kind == "worker":
        client.call("DELETE", acct("/workers/scripts/%s?force=true" % name))
    elif kind == "access":
        if state["access"].get("app_id"):
            try:
                client.call("DELETE", acct("/access/apps/%s" % state["access"]["app_id"]))
            except cf.CfError as e:
                if not _gone(e):
                    raise
        if state["access"].get("token_id"):
            try:
                client.call("DELETE", acct("/access/service_tokens/%s" % state["access"]["token_id"]))
            except cf.CfError as e:
                if not _gone(e):
                    raise
    elif kind == "vectorize":
        client.call("DELETE", acct("/vectorize/v2/indexes/%s" % name))
    elif kind == "d1":
        client.call("DELETE", acct("/d1/database/%s" % state["d1"]["id"]))
    elif kind == "r2":
        client.call("DELETE", acct("/r2/buckets/%s" % name))


def delete_resources(client: cf.Client, include_backups: bool, say) -> int:
    state = deploy.load_state()
    done = 0
    for kind, name in plan(state, include_backups):
        try:
            delete(client, state, kind, name)
            say("Deleted %s %s" % (LABELS[kind], name))
        except cf.CfError as e:
            if not _gone(e):
                say("Could not delete %s %s (%s). Deleted so far is already removed from deploy.json, run `%s` again to continue." % (LABELS[kind], name, e.message, scripts.cmd("uninstall", "--delete-resources")))
                return 1
            say("Deleted %s %s (it was already gone)" % (LABELS[kind], name))
        state.pop(kind, None)
        if kind == "vectorize":
            state.pop("metadata_indexes", None)
        deploy.save_state(state)
        done += 1
    kept = _name(state, "r2")
    if kept:
        say("Kept R2 bucket %s, it holds your nightly backups. Add --include-backups to delete it too (it must be empty first), or delete it in the Cloudflare dashboard." % kept)
    note = unfinished_note(state)
    if note:
        say(note)
    if not kept and not note:
        try:
            deploy.state_file().unlink()
        except OSError:
            pass
    say("Your local config was left in place, delete it yourself if you do not need it.")
    return 0
