"""One REST helper for the Worker, used by the scripts, the hooks and the adapters.

    from hm import api
    api.request("GET", "/recall?query=x&topK=3")                 -> parsed JSON
    api.request("POST", "/capture", {"content": "..."})

Raises NotConfigured when there is no URL or token (or the URL is not https, see config.url_problem), ApiError for an HTTP error
status, NetworkError for a timeout, a connection failure or a reply that cannot be read. Hooks catch all three and stay silent, the
scripts turn them into one plain line.

Every call is noted in the local audit log (hm/audit.py: route, ids, status and time, never text) and carries the
X-Anymem-Harness and X-Anymem-Script headers, so the Worker's own audit table says who asked. A call also carries
X-Anymem-Outcomes when the recall hook has decisions waiting (hm/outcomes.py). A redirect is never followed: it would
send the token and the Access pair to another address, so the 3xx answer is an ApiError.
"""
from __future__ import annotations

import http.client
import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

from . import audit, config, outcomes, scripts, shapes

USER_AGENT = "anymem-client/1"


class NotConfigured(Exception):
    pass


class ApiError(Exception):
    def __init__(self, status: int, message: str, body: "dict | None" = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.body = body or {}  # the parsed error reply: code, reason, retry_after


class NetworkError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow a redirect, so the bearer and the Access secret never reach a host the user did not configure."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _body_ids(path: str, body) -> list:
    ids = []
    if isinstance(body, dict):
        ids += [str(body[k]) for k in ("id", "source_id", "target_id") if isinstance(body.get(k), str)]
    for part in path.partition("?")[2].split("&"):
        key, _, value = part.partition("=")
        if key == "id" and value:
            ids.append(value)
    return ids


def _reply_ids(raw: bytes) -> list:
    try:
        return shapes.ids_of(json.loads(raw.decode("utf-8"))) if raw[:1] in (b"{", b"[") and len(raw) < 2_000_000 else []
    except ValueError:
        return []


def _send(method: str, path: str, body=None, timeout: float = 30.0, settings: "config.Settings | None" = None, headers: "dict | None" = None):
    """(raw reply body, reply headers). The one place a request leaves the client."""
    s = settings or config.load()
    if not s.configured():
        raise NotConfigured("anymem is not configured (missing %s). Run `%s` or `%s`." % (", ".join(s.missing()), scripts.cmd("setup"), scripts.cmd("connect")))
    problem = config.url_problem(s.url)
    if problem:
        raise NotConfigured("the Worker address is not usable (%s), nothing was sent. Run `%s` again." % (problem, scripts.cmd("connect")))
    all_headers = {"User-Agent": USER_AGENT, **s.headers(), **audit.headers(), **(headers or {})}
    harness = audit.harness()
    sent = outcomes.take(harness)  # what the recall hook decided since the last request, see hm/outcomes.py
    if sent:
        all_headers[outcomes.HEADER] = sent.header
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(s.url + path, data=data, headers=all_headers, method=method)
    started = time.monotonic()
    status, raw, reply_headers, counted = 0, b"", {}, 0  # counted: the status the outcome words are settled by, see hm/outcomes.py
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            status = counted = getattr(resp, "status", 200)
            raw = resp.read()
            reply_headers = getattr(resp, "headers", {})
    except urllib.error.HTTPError as e:
        status = counted = e.code
        try:
            detail = e.read().decode("utf-8", "replace")[:2000]
        except Exception:  # an error object with no body (a 304, or one built without a stream) has nothing to read
            detail = ""
        parsed = None
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error") or detail
        except (ValueError, AttributeError):
            pass
        if e.code in (401, 403) and "command" in s.source.values():
            config.drop_credential_cache()  # the cached values may be stale: the next call runs the command again, no retry here
        raise ApiError(e.code, str(detail)[:300], parsed if isinstance(parsed, dict) else None) from None
    except (urllib.error.URLError, OSError) as e:
        if outcomes.timed_out(e):
            counted = outcomes.NO_REPLY  # sent, and no answer came in time: the Worker may have counted the words
        raise NetworkError(str(getattr(e, "reason", e))) from None
    except ValueError as e:  # urllib cannot send this address or header (InvalidURL, UnicodeEncodeError); only the type is named, the message may echo the value
        raise NetworkError("the request cannot be sent with this address or token (%s)" % type(e).__name__) from None
    except http.client.HTTPException as e:  # the reply was cut short while it was read
        raise NetworkError("the reply was cut short (%s)" % type(e).__name__) from None
    finally:
        outcomes.settle(sent, counted, harness)
        audit.record(method, path, _body_ids(path, body) + (_reply_ids(raw) if raw else []), status, round((time.monotonic() - started) * 1000))
    return raw, reply_headers


def request_bytes(method: str, path: str, body=None, timeout: float = 30.0, settings: "config.Settings | None" = None) -> bytes:
    """The raw response body: the one call for a file download (a backup). `request` parses it as JSON."""
    return _send(method, path, body, timeout, settings)[0]


def request_with_headers(method: str, path: str, body=None, timeout: float = 30.0, settings: "config.Settings | None" = None, headers: "dict | None" = None) -> tuple:
    """(parsed JSON, reply headers) for a call that needs a header back, such as the capsule's ETag, and may send one, such as If-None-Match."""
    raw, reply_headers = _send(method, path, body, timeout, settings, headers)
    return _parse(raw), reply_headers


def _parse(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        raise NetworkError("the Worker returned something that is not JSON") from None


def request(method: str, path: str, body=None, timeout: float = 30.0, settings: "config.Settings | None" = None):
    return _parse(request_bytes(method, path, body, timeout, settings))


def list_all(query: dict, timeout: float = 30.0) -> list:
    """Every memory a /list query matches. The Worker answers a page at a time with next_cursor, so a store larger than one page is
    read to the end. A record past the first page is found like any other."""
    out, cursor = [], None
    while True:
        reply = request("GET", "/list?" + urlencode({**query, **({"cursor": cursor} if cursor else {})}), timeout=timeout)
        out += shapes.entries(reply)
        cursor = reply.get("next_cursor") if isinstance(reply, dict) else None
        if not cursor:
            return out
