"""`devices.py list | add LABEL | revoke ID | allow-private ID on|off`: per device tokens (admin token required)."""
from __future__ import annotations

import os
import secrets
import sys
from datetime import datetime, timezone

from hm import api, config, share

COMMAND = "devices"
HELP = "list, add and revoke per device tokens, and choose which may see private subjects (needs the admin token)"


def register(parser):
    sub = parser.add_subparsers(dest="devices_action", metavar="ACTION", required=True)
    sub.add_parser("list", help="show every device: id, label, created, last used")
    add = sub.add_parser("add", help="create a device token, written to a 0600 file, never printed")
    add.add_argument("label", metavar="LABEL", help="a name you will recognise, such as the machine's name")
    add.add_argument("--share", action="store_true", help="write one connection string with the address, this token and the Access pair to the file, for connect on the new machine")
    revoke = sub.add_parser("revoke", help="stop a device token working immediately")
    revoke.add_argument("id", metavar="ID", help="the device id from `devices list` (a unique prefix is enough)")
    private = sub.add_parser("allow-private", help="let a device see private subjects (on) or keep them from it (off). A device is on until set off")
    private.add_argument("id", metavar="ID", help="the device id from `devices list` (a unique prefix is enough)")
    private.add_argument("state", metavar="on|off", choices=("on", "off"))


def _clean(text):
    """Printable only: a label from the server must never carry a control or escape sequence to the terminal. Newlines are
    replaced too (skill.clean keeps them), so a label cannot print a fake line."""
    return "".join(ch if ch.isprintable() else "?" for ch in str(text))


def _when(ms):
    if not ms:
        return "never"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _list():
    devices = api.request("GET", "/devices").get("devices", [])
    if not devices:
        print("no devices yet. Add one with `devices.py add LABEL`.")
        return 0
    for d in devices:
        print("%s  %-20s created %s  last used %s%s" % (_clean(d["id"]), _clean(d["label"]), _when(d.get("created_at")), _when(d.get("last_used_at")),
                                                      "  private subjects off" if d.get("allow_private") is False else ""))
    return 0


def _secret_file(text):
    """Write a secret to a new file that only this user can read, in the config folder, and return its path. The name is random
    and the file is created exclusively, so an earlier secret is never overwritten."""
    folder = config.config_dir()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / ("device-%s.txt" % secrets.token_hex(4))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return path


def _add(label, shared=False):
    body = api.request("POST", "/devices", {"label": label})
    print("device %s created (%s)" % (_clean(body["device"]["id"]), _clean(body["device"]["label"])))
    if shared:
        s = config.load()
        path = _secret_file(share.encode(s.url, body["token"], s.access_client_id, s.access_client_secret))
        print("connection string written to %s (mode 0600, readable only by you). It is not printed here." % path)
        print("To copy it on this machine: pbcopy < %s   (Linux: xclip -selection clipboard < %s)" % (path, path))
        print("Move it to the new machine through a password manager or a one time secret link, never chat or email, then run   pbpaste | connect.py   there.")
        print("Delete the file once it has moved.")
    else:
        path = _secret_file(body["token"])
        print("token written to %s (mode 0600, readable only by you). It is not printed here." % path)
        print("Move the token into a password manager, then delete the file.")
    return 0


def _resolve(prefix):
    devices = api.request("GET", "/devices").get("devices", [])
    exact = [d["id"] for d in devices if d["id"] == prefix]
    matches = exact or [d["id"] for d in devices if d["id"].startswith(prefix)]
    if len(matches) == 1:
        return matches[0]
    raise api.ApiError(404 if not matches else 400, "no device with id %s" % prefix if not matches else "id %s matches %d devices, give more of it" % (prefix, len(matches)))


def _revoke(prefix):
    device_id = _resolve(prefix)
    api.request("POST", "/devices/revoke", {"id": device_id})
    print("revoked %s, that token stops working now" % device_id)
    print("The Access pair in the connection strings is shared by every device of this store, so it still passes Access until `setup.py --access --email EMAIL --rotate-access` replaces it. That also breaks the other connection strings.")
    return 0


def _allow_private(prefix, state):
    device_id = _resolve(prefix)
    api.request("POST", "/devices/private", {"id": device_id, "allow_private": state == "on"})
    print("%s %s see private subjects" % (device_id, "may now" if state == "on" else "can no longer"))
    return 0


def run(ns):
    try:
        if ns.devices_action == "list":
            return _list()
        if ns.devices_action == "add":
            return _add(ns.label, getattr(ns, "share", False))
        if ns.devices_action == "allow-private":
            return _allow_private(ns.id, ns.state)
        return _revoke(ns.id)
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 1
