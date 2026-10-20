"""A small Cloudflare REST client on urllib.

    client = Client(token, account_id)
    client.call("GET", "/d1/database")            returns the `result` of the reply
    client.pages("GET", "/r2/buckets")            walks every page of a list

With dry_run on, nothing is sent. Every call is printed, reads return their `default`, and writes return `default` too.
The API token only ever lives in memory and in the Authorization header. It is never printed or stored.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid

DEFAULT_BASE = "https://api.cloudflare.com/client/v4"
USER_AGENT = "anymem-setup/2"


class CfError(Exception):
    """Cloudflare refused a call, or could not be reached. status is 0 when there was no reply."""

    def __init__(self, status: int, codes, message: str, method: str = "", path: str = ""):
        super().__init__("HTTP %s %s: %s" % (status, ",".join(str(c) for c in codes), message))
        self.status, self.codes, self.message, self.method, self.path = status, list(codes), message, method, path

    @property
    def not_found(self) -> bool:
        return self.status == 404

    @property
    def denied(self) -> bool:
        return self.status in (401, 403) or 10000 in self.codes


def clean(text: str, limit: int = 200) -> str:
    """One printable line, so a reply can never carry a control sequence to the terminal."""
    return "".join(ch if ch.isprintable() else " " for ch in str(text))[:limit]


class Client:
    def __init__(self, token: str, account_id: str, base: str = "", dry_run: bool = False, say=print, sleep=time.sleep):
        self.token = token
        self.account_id = account_id
        self.base = (base or os.environ.get("ANYMEM_CF_API") or DEFAULT_BASE).rstrip("/")
        self.dry_run = dry_run
        self.say = say
        self.sleep = sleep
        self.calls = 0

    def acct(self, path: str) -> str:
        return "/accounts/%s%s" % (self.account_id, path)

    def _send(self, method: str, path: str, data, content_type: str):
        headers = {"Authorization": "Bearer " + self.token, "User-Agent": USER_AGENT}
        if data is not None:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise CfError(0, [], "could not reach Cloudflare (%s)" % clean(getattr(e, "reason", e)), method, path) from None

    def _raw(self, method: str, path: str, data, content_type: str, show: str, default):
        self.calls += 1
        if self.dry_run:
            self.say("  %s %s%s" % (method, path, ("   " + show) if show else ""))
            return default
        status, raw = 0, b""
        for attempt in range(4):
            status, raw = self._send(method, path, data, content_type)
            if status == 429 or status >= 500:
                self.sleep(0.5 * (attempt + 1))
                continue
            break
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if status >= 400 or body.get("success") is False:
            errors = [e for e in (body.get("errors") or []) if isinstance(e, dict)]
            codes = [e.get("code") for e in errors if isinstance(e.get("code"), int)]
            message = "; ".join(clean(e.get("message", "")) for e in errors) or "no detail"
            raise CfError(status, codes, message, method, path)
        return body

    def call(self, method: str, path: str, body=None, default=None, show: str = ""):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        reply = self._raw(method, path, data, "application/json", show, None if self.dry_run else {})
        if self.dry_run:
            return default
        return reply.get("result", default)

    def pages(self, path: str, key: str = ""):
        """Every item of a paged list. `key` names the list inside the result when it is not the result itself."""
        out, page = [], 1
        while True:
            sep = "&" if "?" in path else "?"
            if self.dry_run:
                self.call("GET", "%s%spage=1&per_page=100" % (path, sep))
                return []
            reply = self._raw("GET", "%s%spage=%d&per_page=100" % (path, sep, page), None, "", "", {})
            result = reply.get("result")
            items = result.get(key, []) if key and isinstance(result, dict) else result
            items = items if isinstance(items, list) else []
            out += items
            info = reply.get("result_info") or {}
            if not items or page >= int(info.get("total_pages") or 1):
                return out
            page += 1

    def multipart(self, method: str, path: str, parts, show: str = "", default=None):
        """Each part is a tuple of field name, file name (or empty), content type and bytes. Returns the reply's `result`."""
        boundary = "anymem" + uuid.uuid4().hex
        chunks = []
        for name, filename, ctype, content in parts:
            disp = 'form-data; name="%s"' % re.sub(r'["\r\n]', "", name)
            if filename:
                disp += '; filename="%s"' % re.sub(r'["\r\n]', "", filename)
            chunks.append(("--%s\r\nContent-Disposition: %s\r\nContent-Type: %s\r\n\r\n" % (boundary, disp, ctype)).encode() + content + b"\r\n")
        chunks.append(("--%s--\r\n" % boundary).encode())
        reply = self._raw(method, path, b"".join(chunks), "multipart/form-data; boundary=" + boundary, show, None if self.dry_run else {})
        if self.dry_run:
            return default
        return reply.get("result", default)

    def raw_multipart_with_token(self, path: str, parts, token: str, show: str = ""):
        """The asset upload uses its own short lived token, not the API token. Returns the whole reply."""
        saved, self.token = self.token, token
        try:
            boundary = "anymem" + uuid.uuid4().hex
            chunks = []
            for name, filename, ctype, content in parts:
                chunks.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (boundary, name, filename, ctype)).encode() + content + b"\r\n")
            chunks.append(("--%s--\r\n" % boundary).encode())
            return self._raw("POST", path, b"".join(chunks), "multipart/form-data; boundary=" + boundary, show, {})
        finally:
            self.token = saved
