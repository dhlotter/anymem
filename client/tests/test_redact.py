#!/usr/bin/env python3
"""Runnable check for hm.redact. Every fake secret is built at runtime, none is written out as a literal."""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm.redact import redact  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def gone(kind, secret, text=None):
    """The secret is replaced by the marker for `kind` and nothing else about the sentence changes."""
    src = text if text is not None else "before %s after" % secret
    out, n, kinds = redact(src)
    return secret not in out and "[REDACTED:%s]" % kind in out and n >= 1 and kind in kinds and out.startswith("before") and out.endswith("after")


digits = "0123456789"
fakes = {
    "api_key": "sk-" + "a" * 24,
    "api_key_ant": "sk-" + "ant" + "-" + "api03" + "-" + "Zy9" * 8,
    "github_token": "ghp_" + "A1b2" * 7,
    "github_token2": "gho_" + "x" * 30,
    "github_token3": "ghs_" + "Q" * 25,
    "github_pat": "github_pat_" + "k9" * 15,
    "slack_token": "xox" + "b" + "-" + digits + "-" + "abcdefghij",
    "aws_key_id": "AKIA" + "ABCDEFGHIJKLMNOP",
    "google_key": "AIza" + "B1" * 18,
    "jwt": "eyJ" + "hbGciOiJIUzI1" + "." + "eyJzdWIiOiIxMjM0NTY3ODkw" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36",
    "bearer": "Bearer " + "Tt3" * 10,
    "basic_auth": "Basic " + "dXNlcjpwYXNzd29yZDEyMw",
}
for kind, secret in fakes.items():
    kind = kind.rstrip("0123456789").replace("_ant", "")
    if kind == "github_pat":
        kind = "github_token"
    check("detects " + kind + " " + secret[:4], gone(kind, secret))

pem_body = "\n".join("QUJD" * 16 for _ in range(4))
pem = "-----BEGIN " + "RSA PRIVATE KEY" + "-----\n" + pem_body + "\n-----END " + "RSA PRIVATE KEY" + "-----"
out, n, kinds = redact("before\n" + pem + "\nafter")
check("a PEM private key block is replaced including its body", "QUJD" not in out and "BEGIN" not in out and out == "before\n[REDACTED:private_key]\nafter" and kinds == ["private_key"])
trunc = "-----BEGIN " + "PRIVATE KEY" + "-----\n" + pem_body
out, n, kinds = redact("note: " + trunc)
check("a truncated PEM block with no END line is still removed", "QUJD" not in out and kinds == ["private_key"])

# KEY=VALUE and "key": "value": the name stays, the value goes
pw = "hunter" + "2" + "xyz"
for src, want in [
    ("PASSWORD=%s" % pw, "PASSWORD=[REDACTED:secret]"),
    ("export API_TOKEN=%s" % pw, "export API_TOKEN=[REDACTED:secret]"),
    ('"client_secret": "%s"' % pw, '"client_secret": "[REDACTED:secret]"'),
    ("{'passwd': '%s', 'x': 1}" % pw, "{'passwd': '[REDACTED:secret]', 'x': 1}"),
    ("api_key: %s" % pw, "api_key: [REDACTED:secret]"),
    ("apikey = %s" % pw, "apikey = [REDACTED:secret]"),
    ("db_credential=%s;" % pw, "db_credential=[REDACTED:secret];"),
    ("Authorization: %s" % pw, "Authorization: [REDACTED:secret]"),
]:
    out, n, kinds = redact(src)
    check("pair: " + src.split(pw)[0].strip()[:24], out == want and n == 1 and pw not in out)
out, n, _ = redact("Authorization: Bearer " + "Tt3" * 10)
check("an Authorization header with a bearer token is one redaction", out == "Authorization: [REDACTED:bearer]" and n == 1)
for plain in ["author: Some Person", "max_tokens: 4096", "token: true", "auth_mode = none", "password: " + "[REDACTED:secret]", "token = os.environ", 'secret: "$SECRET_FROM_ENV"']:
    check("pair left alone: " + plain[:30], redact(plain)[0] == plain)
check("a numeric password is still redacted", redact("password=123456")[0] == "password=[REDACTED:secret]")

# bare long runs
hexrun = "9f8e7d6c5b4a" * 3 + "1b2c"
check("a bare run of 40 hex characters is redacted", gone("long_token", hexrun))
b64 = "Zm9vYmFy" * 6 + "QUJD"
check("a bare base64 run is redacted", gone("long_token", b64))
check("a git sha after the word commit is kept", redact("commit " + hexrun)[0] == "commit " + hexrun and redact("Commit: " + hexrun)[0] == "Commit: " + hexrun)
for keep in [
    "memory-model-2026-10-07-push-small-pull-live",
    "released on 2026-10-07T12:30:00Z by the build",
    "a1b2c3d4 and 0123456789 and abc123def456",
    "a" * 40,
    "7" * 40,
    "test_policy_exclude_sessions_prefix_matching2_ok",
    "client/hm/commands/install_adapters_for_codex2.py",
    "5b7c0a2e-1d3f-4a6b-9c8d-0e1f2a3b4c5d",
    "the capture worker reads the transcript from where the last capture stopped",
]:
    check("not a secret: " + keep[:34], redact(keep)[0] == keep and redact(keep)[1] == 0)

# base64 with + and /, and tokens glued to a prefix or suffix
aws = "wJalrXUtnFEMI" + "/" + "K7MDENG" + "/" + "bPxRfiCYEXAMPLEKEY"
out, n, kinds = redact("secretkey " + aws)
check("a bare AWS style secret key with slashes is redacted", aws not in out and "long_token" in kinds)
b44 = "Qm9z" * 4 + "+" + "dGhl" * 5 + "/" + "Zm9v" + "="
check("a 44 char base64 string with + and / is redacted", gone("long_token", b44))
mixed40 = "aB3dE5fG7h" * 4
check("npm_ prefix token is redacted", gone("api_key", "npm_" + mixed40[:36]))
check("hf_ prefix token is redacted", gone("api_key", "hf_" + mixed40[:36]))
check("a mixed run followed by a hyphen suffix is redacted", gone("long_token", mixed40 + "-tail"))
check("session_ plus 40 hex is redacted", gone("long_token", "session_" + hexrun))
check("a stripe style live key is redacted", gone("api_key", "sk_" + "live" + "_" + mixed40[:24]))
check("a gitlab token is redacted", gone("api_key", "glpat" + "-" + mixed40[:20]))
out, n, kinds = redact("db at postgres://" + "app:" + pw + "@host/db ok")
check("URL credentials are redacted, host kept", pw not in out and "@host/db ok" in out and kinds == ["url_credentials"])
check("URL without credentials is untouched", redact("see https://example.com:8080/a@b")[0] == "see https://example.com:8080/a@b")
for keep in ["src/components/layout/navigation/header/main", "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z", "prefix_" + "a" * 40 + "_suffix", "slug-" + "7" * 40 + "-x"]:
    check("still not a secret: " + keep[:30], redact(keep)[0] == keep)

# home paths
home ="/" + "Users" + "/alice/work/proj/file.py"
check("macOS home becomes ~/", redact("see " + home)[0] == "see ~/work/proj/file.py")
check("Linux home becomes ~/", redact("in /" + "home" + "/bob/.config/x")[0] == "in ~/.config/x")
check("a bare home folder becomes ~", redact('cwd="/' + 'Users' + '/alice" now')[0] == 'cwd="~" now')
check("a url path with /home/ in it is untouched", redact("https://example.com/home/page/x")[0] == "https://example.com/home/page/x")
check("home paths count and are named", redact("see " + home)[1:] == (1, ["home_path"]))

# idempotent
mix = "\n".join(["token: " + fakes["api_key"], hexrun, "password=" + pw, home, "Authorization: Bearer " + "Tt3" * 10, pem, "commit " + hexrun, "ok " + fakes["jwt"]])
once, n1, k1 = redact(mix)
twice, n2, k2 = redact(once)
check("redacting twice changes nothing and counts nothing", once == twice and n2 == 0 and k2 == [] and n1 >= 7)
check("no fake secret survives the mix, only the commit sha does", not any(x in once for x in (fakes["api_key"], pw, fakes["jwt"], "QUJD", "/" + "Users")) and once.count(hexrun) == 1)
check("empty and None-like input", redact("") == ("", 0, []) and redact(None) == ("", 0, []))

# speed on 30 KB, worst shapes included
filler = ("A normal sentence about the deploy, with a slug like memory-model-2026-10-07 and a path client/hm/api.py. " * 300)[:30000]
nasty = ("token" * 6000, "a-" * 15000, "A1" * 15000, "password=" + "x" * 29000, "api_key" + "_" * 29000, ("-----BEGIN " + "PRIVATE KEY-----") * 1000)
for label, blob in [("prose", filler)] + [("nasty %d" % i, b) for i, b in enumerate(nasty)] + [("mixed", (filler[:10000] + fakes["api_key"] + " " + hexrun + " password=" + pw + " ") * 3)]:
    t0 = time.perf_counter()
    redact(blob)
    ms = (time.perf_counter() - t0) * 1000
    check("30 KB %s in %.0f ms (under 200)" % (label, ms), ms < 200)

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
