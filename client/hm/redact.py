"""Local secret and path filter. Runs before any transcript leaves the machine.

    clean, count, kinds = redact(text)

`clean` is `text` with every secret replaced by "[REDACTED:kind]", `count` is how many replacements were made and `kinds` is
the sorted list of distinct kinds. Nothing but counts and kind names is ever safe to log, never the secret itself.

What it covers, in this order:
  1. well known token shapes: PEM private key blocks, sk- keys, GitHub tokens, Slack tokens, AWS key ids, Google API keys,
     JWTs (three dotted parts), Bearer and Basic credentials
  2. KEY=VALUE and "key": "value" pairs whose name contains secret, token, password, passwd, apikey, api_key, auth or
     credential: the VALUE is replaced, the name stays
  3. any bare run of 32 or more letters and digits that mixes both, unless it is a git sha written after the word commit.
     Base64 runs that contain + or / (an AWS style secret key) count too when they mix upper case, lower case and digits.
     A run glued to an underscore or hyphen (npm_<token>, session_<hex>, <token>-tail) is caught when it is hex or mixes
     upper case, lower case and digits. Hyphenated slugs, dates, underscore names and runs of only letters or only digits
     are NOT secrets
  4. absolute macOS and Linux home folders (the user's own name in the path) become ~/ (privacy, not secrecy)

Idempotent: redacting the output again changes nothing and counts nothing. stdlib only, linear time on every pattern.
"""
from __future__ import annotations

import re

_OPEN = r"(?<![A-Za-z0-9])"

# (kind, pattern). Specific shapes first, so a kind says what the thing was.
SHAPES = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)")),
    ("api_key", re.compile(_OPEN + r"sk-[A-Za-z0-9_-]{16,}")),
    ("github_token", re.compile(_OPEN + r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("api_key", re.compile(_OPEN + r"(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("api_key", re.compile(_OPEN + r"(?:npm|hf)_[A-Za-z0-9]{30,}")),
    ("api_key", re.compile(_OPEN + r"glpat-[A-Za-z0-9_-]{16,}")),
    ("url_credentials", re.compile(r"(?<=://)(?!\[REDACTED)[^\s/:@\"'<>]{1,64}:[^\s/@\"'<>]{1,128}(?=@)")),
    ("slack_token", re.compile(_OPEN + r"xox[abprs]-[A-Za-z0-9-]{10,}")),
    ("aws_key_id", re.compile(_OPEN + r"AKIA[0-9A-Z]{12,}")),
    ("google_key", re.compile(_OPEN + r"AIza[0-9A-Za-z_-]{25,}")),
    ("jwt", re.compile(_OPEN + r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}")),
    ("basic_auth", re.compile(r"\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}")),
]

# Name lengths are bounded so a long run of identifier characters cannot make the scan quadratic.
# "auth" must not match "author" but must match "authorization".
_NAME = r"[A-Za-z0-9_.-]{0,40}(?:secret|token|password|passwd|api[_-]?key|auth(?!or(?!iz))|credential)[A-Za-z0-9_.-]{0,40}"
KV = re.compile(
    r"(?<![A-Za-z0-9_.-])(?P<name>" + _NAME + r")(?P<q>[\"']?)(?P<sep>[ \t]*[:=][ \t]*)"
    r"(?:\"(?P<dq>[^\"\n]{4,})\"|'(?P<sq>[^'\n]{4,})'"
    r"|(?P<bare>(?!\$|\[REDACTED|Bearer\b|Basic\b|os\.environ|process\.env|getenv)[^\s\"'`,;)\]}]{4,}))",
    re.I,
)
_PLAIN_WORDS = {"true", "false", "null", "none", "undefined", "string", "required", "optional"}
_STRONG_NAME = re.compile(r"password|passwd|secret|credential", re.I)

# Pass one: base64 style runs that contain + or /. Pass two: plain letter and digit runs, judged by what touches them.
B64 = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}")
LONG = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])")
_UPPER, _LOWER, _DIGIT, _HEX = (re.compile(p) for p in (r"[A-Z]", r"[a-z]", r"\d", r"[0-9a-fA-F]+\Z"))
_COMMIT = re.compile(r"commit\s*[:#]?\s*$", re.I)

HOME = re.compile(r"(?<![\w~.])/(?:Users|home)/[^/\s\"'`<>:,;)\]}]+(?P<end>/|(?=[\s\"'`<>:,;)\]}]|$))")


def _marker(kind: str) -> str:
    return f"[REDACTED:{kind}]"


def redact(text: str) -> "tuple[str, int, list]":
    """(clean text, number of replacements, sorted distinct kinds). See the module docstring."""
    if not text:
        return text or "", 0, []
    hits = {}

    def bump(kind: str) -> None:
        hits[kind] = hits.get(kind, 0) + 1

    for kind, rx in SHAPES:
        def shape(m, kind=kind):
            bump(kind)
            return _marker(kind)
        text = rx.sub(shape, text)

    def pair(m):
        quote = '"' if m.group("dq") is not None else "'" if m.group("sq") is not None else ""
        val = m.group("dq") if quote == '"' else m.group("sq") if quote == "'" else m.group("bare")
        low = val.lower()
        if val.startswith(("[REDACTED", "$")) or low in _PLAIN_WORDS:
            return m.group(0)
        if val.isdigit() and not _STRONG_NAME.search(m.group("name")):
            return m.group(0)  # max_tokens: 4096 and friends
        bump("secret")
        return m.group("name") + m.group("q") + m.group("sep") + quote + _marker("secret") + quote
    text = KV.sub(pair, text)

    def b64(m):
        s = m.group(0)
        if not (("+" in s or "/" in s) and _UPPER.search(s) and _LOWER.search(s) and _DIGIT.search(s)):
            return s
        bump("long_token")
        return _marker("long_token")
    text = B64.sub(b64, text)

    def run(m):
        s = m.group(0)
        if not (_DIGIT.search(s) and re.search(r"[A-Za-z]", s)):
            return s
        before = m.string[m.start() - 1:m.start()] if m.start() else ""
        after = m.string[m.end():m.end() + 1]
        if before in ("_", "-") or after in ("_", "-"):
            # glued to a prefix or suffix: slugs and names stay, tokens do not
            if not (_HEX.match(s) or (_UPPER.search(s) and _LOWER.search(s))):
                return s
        if _COMMIT.search(m.string[max(0, m.start() - 16):m.start()]):
            return s
        bump("long_token")
        return _marker("long_token")
    text = LONG.sub(run, text)

    def home(m):
        bump("home_path")
        return "~/" if m.group("end") == "/" else "~"
    text = HOME.sub(home, text)

    return text, sum(hits.values()), sorted(hits)
