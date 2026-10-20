#!/usr/bin/env python3
"""Runnable check for the devices script. No network: hm.api.request is replaced by a fake Worker."""
from __future__ import annotations

import io
import os
import stat
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
CONFIG = Path(tempfile.mkdtemp())  # the secret files land here, never in the real config folder
os.environ["ANYMEM_CONFIG_DIR"] = str(CONFIG)
from hm import api, share  # noqa: E402
from hm.commands import devices  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


# Built at runtime, never a literal in the file.
TOKEN = "dt" + "_" + "a" * 43
STORE = [
    {"id": "dev-aaaa1111-0000", "label": "laptop", "created_at": 1_790_000_000_000, "last_used_at": 1_790_000_600_000},
    {"id": "dev-aaaa2222-0000", "label": "desktop", "created_at": 1_790_100_000_000, "last_used_at": None},
    {"id": "dev-bbbb3333-0000", "label": "phone", "created_at": 1_790_200_000_000, "last_used_at": None},
]
calls = []


def fake(method, path, body=None, timeout=30, settings=None):
    calls.append((method, path, body))
    if (method, path) == ("GET", "/devices"):
        return {"ok": True, "devices": STORE}
    if (method, path) == ("POST", "/devices"):
        return {"ok": True, "device": {"id": "dev-new", "label": body["label"]}, "token": TOKEN}
    if (method, path) == ("POST", "/devices/revoke"):
        return {"ok": True}
    raise AssertionError("unexpected call %s %s" % (method, path))


api.request = fake


def capture(fn, *a):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = fn(*a)
    return rc, out.getvalue(), err.getvalue()


def ns(action, **kw):
    return SimpleNamespace(devices_action=action, **kw)


rc, out, _ = capture(devices.run, ns("list"))
check("list prints id, label, created and last used", rc == 0 and "dev-aaaa1111-0000" in out and "laptop" in out and "never" in out and "2026" in out)
check("list asks the Worker once", calls == [("GET", "/devices", None)])

del calls[:]
rc, out, _ = capture(devices.run, ns("add", label="work mac"))
secret_files = list(CONFIG.glob("device-*.txt"))
check("add posts the label and never prints the token", rc == 0 and calls == [("POST", "/devices", {"label": "work mac"})] and TOKEN not in out)
check("add writes the token to one new file that only the user can read",
      len(secret_files) == 1 and secret_files[0].read_text(encoding="utf-8").strip() == TOKEN and stat.S_IMODE(secret_files[0].stat().st_mode) == 0o600)
check("add prints the path of that file", len(secret_files) == 1 and str(secret_files[0]) in out)

os.environ["ANYMEM_URL"] = "https://worker.invalid"
del calls[:]
rc, out, _ = capture(devices.run, ns("add", label="phone", share=True))
share_files = [p for p in CONFIG.glob("device-*.txt") if p not in secret_files]
share_text = share_files[0].read_text(encoding="utf-8").strip() if len(share_files) == 1 else ""
check("add --share writes one connection string to a new 0600 file and prints none of it",
      rc == 0 and share_text.startswith(share.PREFIX) and stat.S_IMODE(share_files[0].stat().st_mode) == 0o600 and TOKEN not in out and share_text not in out)
check("the connection string in that file holds the Worker address and the new token",
      (share.decode(share_text) or {}).get("url") == "https://worker.invalid" and (share.decode(share_text) or {}).get("token") == TOKEN)
del os.environ["ANYMEM_URL"]

del calls[:]
rc, out, _ = capture(devices.run, ns("revoke", id="dev-bbbb"))
check("revoke resolves a unique prefix and posts the full id",
      rc == 0 and calls[-1] == ("POST", "/devices/revoke", {"id": "dev-bbbb3333-0000"}) and "revoked dev-bbbb3333-0000" in out)

del calls[:]
rc, _, err = capture(devices.run, ns("revoke", id="dev-aaaa"))
check("revoke refuses an ambiguous prefix and revokes nothing", rc == 1 and "matches 2 devices" in err and all(c[1] != "/devices/revoke" for c in calls))

rc, _, err = capture(devices.run, ns("revoke", id="dev-zzzz"))
check("revoke reports an unknown id", rc == 1 and "no device" in err)

api.request = lambda *a, **k: (_ for _ in ()).throw(api.ApiError(403, "Forbidden"))
rc, _, err = capture(devices.run, ns("list"))
check("a refused request is one plain line on stderr and exit 1", rc == 1 and "Forbidden" in err and "Traceback" not in err)

api.request = lambda *a, **k: (_ for _ in ()).throw(api.NotConfigured("not set up"))
rc, _, err = capture(devices.run, ns("add", label="x"))
check("unconfigured is one plain line", rc == 1 and "not set up" in err)

api.request = lambda *a, **k: {"ok": True, "devices": [{"id": "dev-x", "label": "evil\x1b[31m\nname", "created_at": 1_790_000_000_000, "last_used_at": None}]}
rc, out, _ = capture(devices.run, ns("list"))
check("list never passes a control or escape character to the terminal", rc == 0 and "\x1b" not in out and out.count("\n") == 1 and "evil" in out)

check("the command declares its word and a run function", devices.COMMAND == "devices" and callable(devices.run))

print("%d failed" % len(failures) if failures else "all passed")
sys.exit(1 if failures else 0)
