"""The Worker. Upload the modules and the dashboard assets, set the cron, and choose the address.

The modules are every .js file under worker/ except tests, dev tools, scripts and the dashboard folder. The dashboard folder
(worker/ui) goes up as static assets. Settings come from worker/wrangler.jsonc, so that file stays the one place they are written.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import re
from pathlib import Path

from . import cf

MAIN = "index.js"
SKIP_DIRS = ("test", "dev", "scripts", "ui", "node_modules")
SKIP_FILES = ("migrate.js",)
CRON = "0 1 * * *"
MODULE_TYPE = "application/javascript+module"
ASSET_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json"}


def read_config(root: Path) -> dict:
    """worker/wrangler.jsonc as a dict. Whole line comments are allowed in it, nothing else is."""
    text = (root / "worker" / "wrangler.jsonc").read_text(encoding="utf-8")
    text = "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))
    return json.loads(text)


def collect_modules(root: Path) -> dict:
    base = root / "worker"
    out = {}
    for f in sorted(base.rglob("*.js")):
        rel = f.relative_to(base)
        if rel.parts[0] in SKIP_DIRS or rel.name in SKIP_FILES:
            continue
        out[rel.as_posix()] = f.read_bytes()
    if MAIN not in out:
        raise cf.CfError(0, [], "worker/%s was not found, is this a full copy of the repo?" % MAIN)
    return out


def collect_assets(root: Path) -> dict:
    base = root / "worker" / "ui"
    return {"/" + f.relative_to(base).as_posix(): f.read_bytes() for f in sorted(base.rglob("*")) if f.is_file()}


def asset_hash(content: bytes, path: str) -> str:
    """32 hex characters, the SHA-256 of the base64 content plus the file extension, as Cloudflare's own example does."""
    ext = Path(path).suffix.lstrip(".")
    return hashlib.sha256((base64.b64encode(content).decode("ascii") + ext).encode("ascii")).hexdigest()[:32]


def upload_assets(client: cf.Client, script: str, assets: dict, say) -> str:
    """The completion token to put in the script upload."""
    manifest = {p: {"hash": asset_hash(c, p), "size": len(c)} for p, c in assets.items()}
    session = client.call("POST", client.acct("/workers/scripts/%s/assets-upload-session" % script), {"manifest": manifest},
                          default={"jwt": "<upload-token>", "buckets": []}, show="(%d files)" % len(manifest)) or {}
    token = session.get("jwt", "")
    by_hash = {m["hash"]: p for p, m in manifest.items()}
    for bucket in session.get("buckets") or []:
        parts = []
        for h in bucket:
            path = by_hash[h]
            ctype = ASSET_TYPES.get(Path(path).suffix, mimetypes.guess_type(path)[0] or "application/octet-stream")
            parts.append((h, h, ctype, base64.b64encode(assets[path])))
        reply = client.raw_multipart_with_token(client.acct("/workers/assets/upload?base64=true"), parts, token, "(%d files)" % len(parts))
        done = (reply.get("result") or {}).get("jwt")
        if done:
            token = done
    say("  %d dashboard files uploaded" % len(assets))
    return token


def vars_for(config: dict, access: "dict | None") -> dict:
    """Plain settings. Access values are never taken from the committed file, they come from the Access step or are left out."""
    out = {k: v for k, v in (config.get("vars") or {}).items() if not k.startswith("ACCESS_")}
    out["REQUIRE_ACCESS"] = "true" if access else "false"
    if access:
        out.update(ACCESS_TEAM_DOMAIN=access["team_domain"], ACCESS_AUD=access["aud"], ACCESS_SERVICE_COMMON_NAMES=access["common_name"],
                   ACCESS_ALLOWED_EMAILS=access["email"], ACCESS_TOKEN_EXPIRES=access["expires"])
    return out


def metadata(config: dict, names: dict, d1_id: str, asset_token: str, settings: dict, auth_token: str) -> dict:
    meta = {
        "main_module": MAIN,
        "compatibility_date": config["compatibility_date"],
        "bindings": [
            {"type": "d1", "name": "DB", "id": d1_id},
            {"type": "vectorize", "name": "VECTORIZE", "index_name": names["vectorize"]},
            {"type": "ai", "name": "AI"},
            {"type": "r2_bucket", "name": "BACKUP_BUCKET", "bucket_name": names["r2"]},
            {"type": "assets", "name": "ASSETS"},
        ] + [{"type": "plain_text", "name": k, "text": str(v)} for k, v in sorted(settings.items())],
        "assets": {"jwt": asset_token, "config": {"html_handling": "none", "not_found_handling": "none", "run_worker_first": True}},
    }
    if auth_token:
        meta["bindings"].append({"type": "secret_text", "name": "AUTH_TOKEN", "text": auth_token})
    else:
        meta["keep_bindings"] = ["secret_text"]  # a rerun keeps the token that is already there
    return meta


def upload_script(client: cf.Client, script: str, modules: dict, meta: dict, say) -> None:
    parts = [("metadata", "", "application/json", json.dumps(meta).encode("utf-8"))]
    parts += [(name, name, MODULE_TYPE, content) for name, content in sorted(modules.items())]
    client.multipart("PUT", client.acct("/workers/scripts/" + script), parts, show="(%d modules, bindings DB VECTORIZE AI BACKUP_BUCKET ASSETS, secret AUTH_TOKEN hidden)" % len(modules))
    say("  Worker %s uploaded (%d modules)" % (script, len(modules)))


def script_exists(client: cf.Client, script: str) -> bool:
    try:
        client.call("GET", client.acct("/workers/scripts/%s/settings" % script))
        return True
    except cf.CfError as e:
        if e.not_found:
            return False
        raise


def set_cron(client: cf.Client, script: str, say) -> None:
    client.call("PUT", client.acct("/workers/scripts/%s/schedules" % script), [{"cron": CRON}])
    say("  cron trigger set (%s, 01:00 UTC every day)" % CRON)


# -------------------------------------------------------------------- address

def account_subdomain(client: cf.Client, wanted: str = "") -> str:
    try:
        got = client.call("GET", client.acct("/workers/subdomain"), default={"subdomain": "<your-subdomain>"}) or {}
    except cf.CfError as e:
        if not e.not_found:
            raise
        got = {}
    if got.get("subdomain"):
        return got["subdomain"]
    if not wanted:
        raise cf.CfError(0, [], "this account has no workers.dev name yet. Choose one with --subdomain NAME (letters, digits, hyphens), or open Workers in the Cloudflare dashboard once")
    return (client.call("PUT", client.acct("/workers/subdomain"), {"subdomain": wanted}, default={"subdomain": wanted}) or {}).get("subdomain", wanted)


def set_workers_dev(client: cf.Client, script: str, enabled: bool) -> None:
    client.call("POST", client.acct("/workers/scripts/%s/subdomain" % script), {"enabled": enabled, "previews_enabled": False})


def find_zone(client: cf.Client, domain: str) -> dict:
    labels = domain.split(".")
    for i in range(len(labels) - 1):
        candidate = ".".join(labels[i:])
        zones = client.call("GET", "/zones?name=%s&account.id=%s" % (candidate, client.account_id), default=[{"id": "<zone-id>", "name": candidate}]) or []
        hit = next((z for z in zones if z.get("name") == candidate), None)
        if hit:
            return hit
    raise cf.CfError(0, [], "%s is not in a zone on this Cloudflare account" % domain)


def attach_domain(client: cf.Client, script: str, domain: str, say) -> None:
    """Attach the hostname to this Worker. The attach call cannot take a hostname over from another Worker (it has no field for that),
    so a hostname held by another Worker is refused and left as it is."""
    zone = find_zone(client, domain)
    existing = client.call("GET", client.acct("/workers/domains?hostname=" + domain), default=[]) or []
    other = [d for d in existing if isinstance(d, dict) and d.get("hostname") == domain and d.get("service") != script]
    if other:
        raise cf.CfError(0, [], "%s is already attached to the Worker %s. Remove the custom domain from that Worker first (Cloudflare dashboard), then run setup again" % (domain, other[0].get("service")))
    body = {"hostname": domain, "service": script, "zone_id": zone["id"], "zone_name": zone["name"]}
    client.call("PUT", client.acct("/workers/domains"), body)
    say("  custom domain %s attached" % domain)


def hostname_for(script: str, subdomain: str, domain: str) -> str:
    return domain or "%s.%s.workers.dev" % (script, subdomain)


def valid_domain(domain: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?", domain)) and "." in domain
