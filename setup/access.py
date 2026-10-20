"""Cloudflare Access in front of the address. Optional and recommended.

Three things are made. A service token for machines, an Access application on the address, and two policies on it.
One policy lets the service token through, the other lets the person's email through in a browser.
The service token secret is shown by Cloudflare once and is saved to the local config only.
"""
from __future__ import annotations

from . import cf
from .resources import NameTaken, mark_pending, record


class AccessUnavailable(Exception):
    pass


def org_domain(client: cf.Client) -> str:
    """The Zero Trust team host. Without one, Zero Trust has not been set up on the account."""
    try:
        got = client.call("GET", client.acct("/access/organizations"), default={"auth_domain": "<team>.cloudflareaccess.com"}) or {}
    except cf.CfError as e:
        if e.denied or e.not_found:
            raise AccessUnavailable("Access is not set up for this account, or the API token lacks the Account permission "
                                    "\"Access: Organizations, Identity Providers, and Groups Read\" (%s). Add that permission, or open Zero Trust in the "
                                    "Cloudflare dashboard once to pick a team name, then run setup again" % e.message) from None
        raise
    if not got.get("auth_domain"):
        raise AccessUnavailable("Zero Trust has no team name yet. Open Zero Trust in the Cloudflare dashboard once to pick one (the free plan is enough), then run setup again")
    return got["auth_domain"]


def ensure_service_token(client: cf.Client, state: dict, name: str, save, say, config_has_secret: bool, save_secret, rotate: bool = False) -> dict:
    """{id, client_id, client_secret or "", expires}. The secret is empty when the token already existed.
    The pair goes to the local config through save_secret the moment Cloudflare shows it, so a later failure cannot lose it.
    rotate deletes the token this store made and makes a new one. Every connection string made before that stops working."""
    tokens = client.pages(client.acct("/access/service_tokens"))
    found = next((t for t in tokens if isinstance(t, dict) and t.get("name") == name), None)
    mine = (state.get("access") or {}).get("token_id")
    if found and found.get("id") != mine and "access" not in state.get("pending", []):
        raise NameTaken("Access service token", name)
    if found and rotate:
        say("  rotating Access service token %s, connection strings made before this stop working" % name)
        client.call("DELETE", client.acct("/access/service_tokens/%s" % found["id"]))
        found = None
    if found:
        if not config_has_secret:
            raise cf.CfError(0, [], "the Access service token %s exists but its secret is not on this machine, and Cloudflare shows it once. Delete it in Zero Trust, then run setup again" % name)
        say("  Access service token %s already there" % name)
        return {"id": found["id"], "client_id": found["client_id"], "client_secret": "", "expires": str(found.get("expires_at", ""))[:10]}
    mark_pending(state, "access", save)
    say("  creating Access service token %s" % name)
    made = client.call("POST", client.acct("/access/service_tokens"), {"name": name, "duration": "8760h"},
                       default={"id": "<token-id>", "client_id": "<client-id>", "client_secret": "<secret>", "expires_at": ""}, show="(secret kept in memory)") or {}
    save_secret({"access_client_id": made["client_id"], "access_client_secret": made["client_secret"]})
    return {"id": made["id"], "client_id": made["client_id"], "client_secret": made["client_secret"], "expires": str(made.get("expires_at", ""))[:10]}


def ensure_app(client: cf.Client, state: dict, name: str, hostname: str, save, say) -> dict:
    """The application this store recorded, moved to the current hostname if that changed. An application with the same name or
    hostname that this store did not record is refused, never adopted, so a rerun cannot take over or later delete someone else's."""
    apps = [a for a in client.pages(client.acct("/access/apps")) if isinstance(a, dict)]
    mine = (state.get("access") or {}).get("app_id")
    found = next((a for a in apps if mine and a.get("id") == mine), None)
    if found is None:
        other = next((a for a in apps if a.get("name") == name or a.get("domain") == hostname), None)
        # a create whose reply was lost leaves the application behind, with access still pending. It has our name and sits on our address,
        # so it is ours. Anything else with our name or address is someone else's.
        ours = other is not None and "access" in state.get("pending", []) and other.get("name") == name and other.get("domain") == hostname
        if other is not None and not ours:
            raise NameTaken("Access application", name)
        if ours:
            found, mine = other, other.get("id")
            if mine and not client.dry_run:
                state["access"] = {**(state.get("access") or {}), "app_id": mine}
                save(state)
    body = {"name": name, "domain": hostname, "type": "self_hosted", "session_duration": "24h", "app_launcher_visible": False}
    if found:
        if found.get("domain") == hostname:
            say("  Access application %s already there" % name)
            return found
        say("  Access application %s moved to %s" % (name, hostname))
        return client.call("PUT", client.acct("/access/apps/%s" % mine), body, default=found) or found
    say("  creating Access application %s on %s" % (name, hostname))
    app = client.call("POST", client.acct("/access/apps"), body, default={"id": "<app-id>", "aud": "<aud>"}) or {}
    if app.get("id") and not client.dry_run:
        # saved at once, so a rerun after a failure later on finds this application by its id and does not refuse it
        state["access"] = {**(state.get("access") or {}), "app_id": app["id"]}
        save(state)
    return app


def ensure_policies(client: cf.Client, app_id: str, token_id: str, email: str, say) -> None:
    have = client.call("GET", client.acct("/access/apps/%s/policies" % app_id), default=[]) or []
    by_name = {p.get("name"): p for p in have if isinstance(p, dict)}
    wanted = (
        {"name": "machines (service token)", "decision": "non_identity", "precedence": 1, "include": [{"service_token": {"token_id": token_id}}]},
        {"name": "owner (browser login)", "decision": "allow", "precedence": 2, "include": [{"email": {"email": email}}]},
    )
    for policy in wanted:
        old = by_name.get(policy["name"])
        if old is None:
            client.call("POST", client.acct("/access/apps/%s/policies" % app_id), policy)
            say("  policy %s created" % policy["name"])
        elif old.get("include") == policy["include"] and old.get("decision") == policy["decision"]:
            say("  policy %s already there" % policy["name"])
        else:
            # the name matches but the rule does not, e.g. the service token was recreated or --email changed
            client.call("PUT", client.acct("/access/apps/%s/policies/%s" % (app_id, old["id"])), policy)
            say("  policy %s updated to the current token or email" % policy["name"])


def provision(client: cf.Client, state: dict, name: str, hostname: str, email: str, save, say, config_has_secret: bool, save_secret, rotate: bool = False) -> dict:
    """Everything the Worker and the local config need from Access."""
    team = org_domain(client)
    token = ensure_service_token(client, state, name + "-machines", save, say, config_has_secret, save_secret, rotate)
    app = ensure_app(client, state, name, hostname, save, say)
    ensure_policies(client, app["id"], token["id"], email, say)
    record(state, "access", name, save, app_id=app["id"], token_id=token["id"], hostname=hostname, aud=app.get("aud", ""),
           client_id=token["client_id"], expires=token["expires"], team_domain=team, email=email)
    return {"team_domain": team, "aud": app.get("aud", ""), "common_name": token["client_id"], "email": email,
            "expires": token["expires"], "client_id": token["client_id"], "client_secret": token["client_secret"]}
