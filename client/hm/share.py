"""A connection string: everything a new machine needs to join this memory, in one paste.

`devices.py add LABEL --share` makes one, `connect.py` takes one. It is the Worker address, the new
device's token and, when Cloudflare Access is in front, the Access pair, packed as `hm1.` plus url safe base64 of a small JSON.
It is a secret and is shown once: send it through a password manager or a one time secret link, never chat or email. It is not
encryption, only a way to carry four values as one."""
from __future__ import annotations

import base64
import json

PREFIX = "hm1."
KEYS = ("url", "token", "access_client_id", "access_client_secret")


def encode(url: str, token: str, access_client_id: str = "", access_client_secret: str = "") -> str:
    body = {"url": url, "token": token}
    if access_client_id and access_client_secret:
        body.update(access_client_id=access_client_id, access_client_secret=access_client_secret)
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    return PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode(text: str) -> "dict | None":
    """The four values from a connection string, or None when it is not one. Whitespace and line breaks from a paste are ignored."""
    s = "".join(str(text or "").split())
    if not s.startswith(PREFIX):
        return None
    payload = s[len(PREFIX):]
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
    except (ValueError, UnicodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("url"), str) or not isinstance(data.get("token"), str) or not data["url"] or not data["token"]:
        return None
    out = {k: str(data.get(k) or "") for k in KEYS}
    if bool(out["access_client_id"]) != bool(out["access_client_secret"]):
        return None
    return out
