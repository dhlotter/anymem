"""A tiny fake Worker for tests and live harness checks. No credentials, no network beyond 127.0.0.1.

    from hm.testing import fake_worker
    srv = fake_worker.start(recall=[{"id": "a1", "content": "---\\nname: m\\ndescription: d\\n---\\nbody", "tags": ["status:canonical"]}],
                            capsule=[{"slot": "identity", "content": "rules"}])
    # point the client at it: ANYMEM_URL=srv.url, ANYMEM_TOKEN=any non empty string
    srv.requests      # list of (method, path, body) the server saw, in order
    srv.headers       # the request headers of each of those, as dicts with lower case names
    srv.replies["POST /capture"] = (422, {"ok": False, "code": "refused", "reason": "secret"})   # a canned answer for "METHOD /path", checked first
    srv.stop()

Routes: GET /health, /count, /recall (returns the configured results with a why block), /prompt-capsules/core (the configured
capsule in the v2 shape the real Worker sends: flat sections with their text; `legacy=True` sends the old shape, a JSON string in
`text`, to test the fallback), POST /capture (stored in srv.captured, returns an id), POST /extract (returns the configured
proposals), POST /forget, /status, and the links: POST /link (kept in srv.links, the closed type list is checked, `supersedes` and
`derived_from` are refused), POST /unlink (a removed system link is added to srv.rejections) and GET /links?id=ID (each link
seen from that memory, the other end named from srv.names). Subjects: POST /subject and /subject/update, GET /subjects and
/subject?slug=SLUG|id=ID (kept in srv.subjects, members read from the `about` links in srv.links), GET /devices (srv.devices) and
POST /devices/private. A /recall reply carries `subjects` only when start(subjects=[...]) was given them, as the real Worker does
with SUBJECTS on. Any request without an Authorization bearer header gets 401.
"""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class FakeWorker:
    def __init__(self, recall=None, capsule=None, proposals=None, legacy=False, subjects=None):
        self.recall_results = recall or []
        self.capsule_sections = capsule or []
        self.proposals = proposals or []
        self.legacy = legacy
        self.recall_subjects = subjects  # the `subjects` of a recall reply, None leaves the key out
        self.subjects: list = []  # {id, slug, kind, status, scope, name, aliases, fields, brief, updated_at}
        self.clock = 0
        self.devices: list = []  # {id, label, created_at, last_used_at, allow_private}
        self.requests: list = []
        self.headers: list = []
        self.replies: dict = {}
        self.captured: list = []
        self.links: list = []  # {source_id, target_id, type, made_by, confidence, created_at}; a test may add made_by "system" rows
        self.rejections: list = []  # (source_id, target_id, type) of each system link that was unlinked
        self.names: dict = {}  # memory id to name, for GET /links
        self.url = ""
        self._server = None
        self._thread = None

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()


KINDS = ("person", "pet", "asset", "project", "area", "topic")
FIELD_KEYS = {"person": ("relationship", "known_as", "work", "contact", "birthday"), "pet": ("name", "species", "breed", "born", "vet", "status", "health_note"),
              "asset": ("type", "name", "identifier", "acquired", "status", "value_note"), "project": ("what", "status", "owner", "repo"),
              "area": ("what", "status"), "topic": ("what",)}
USER_TYPES = ("about", "part_of", "owns", "affects", "decided", "contradicts", "about_person", "related")


def _refusal(code: str, error: str, status: int = 400):
    return status, {"ok": False, "error": error, "code": code}


def _subject_shape(state: FakeWorker, row: dict, full: bool = False) -> dict:
    members = [{"id": l["source_id"], "name": state.names.get(l["source_id"], ""), "updated_at": l["created_at"]}
               for l in sorted(state.links, key=lambda l: -l["created_at"]) if l["target_id"] == row["id"] and l["type"] == "about"]
    out = {k: row[k] for k in ("id", "slug", "kind", "status", "scope", "name", "aliases", "fields", "updated_at")}
    out["member_count"] = len(members)
    return {**out, "brief": row["brief"], "members": members} if full else out


def _merged_fields(kind: str, current: dict, given, at: int):
    """The fields after a change (a null removes a key), or a refusal when a key is not one of the kind's."""
    fields = dict(current)
    for key, value in (given or {}).items():
        if key not in FIELD_KEYS[kind]:
            return _refusal("bad_field", f"{key} is not a field of a {kind}. Use {', '.join(FIELD_KEYS[kind])}.")
        if value is None:
            fields.pop(key, None)
        else:
            fields[key] = {"value": str(value), "confirmed_at": at, "source": "user"}
    return fields


def _subjects_route(state: FakeWorker, method: str, path: str, query: dict, b: dict):
    """The subject routes, or None when the path is not one of them."""
    state.clock += 1  # a time that only has to grow, so the newest updated sorts first
    at = state.clock
    found = lambda: next((r for r in state.subjects if (b.get("id") and r["id"] == b["id"]) or (b.get("slug") and r["slug"] == b["slug"])), None)
    if path == "/subject" and method == "POST":
        slug, kind = b.get("slug"), b.get("kind")
        if not isinstance(slug, str) or not 2 <= len(slug) <= 40 or not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug):
            return _refusal("bad_slug", "slug must be 2 to 40 characters: lowercase letters and digits, with single dashes between them.")
        if kind not in KINDS:
            return _refusal("bad_kind", "kind must be one of " + ", ".join(KINDS) + ".")
        if not isinstance(b.get("name"), str) or not 1 <= len(b["name"].strip()) <= 80:
            return _refusal("bad_name", "name must be 1 to 80 characters.")
        fields = _merged_fields(kind, {}, b.get("fields"), at)
        if isinstance(fields, tuple):
            return fields
        if any(r["slug"] == slug for r in state.subjects):
            return _refusal("subject_exists", "A subject with that slug exists.", 409)
        row = {"id": f"card-{len(state.subjects) + 1:04d}-0000-0000-0000-000000000000", "slug": slug, "kind": kind, "status": "active", "scope": b.get("scope") or "shared",
               "name": b["name"].strip(), "aliases": [str(a).lower() for a in b.get("aliases") or []], "fields": fields, "brief": b.get("brief") or "", "updated_at": at}
        state.subjects.append(row)
        return 200, {"ok": True, "subject": _subject_shape(state, row, True)}
    if path == "/subject/update" and method == "POST":
        row = found()
        if not row:
            return _refusal("not_found", "No subject with that id or slug.", 404)
        if not any(k in b for k in ("name", "brief", "fields", "aliases", "scope", "status")):
            return _refusal("bad_request", "Send at least one of name, brief, fields, aliases, scope, status.")
        if b.get("status", "active") not in ("active", "retired"):
            return _refusal("bad_status", "status must be active or retired.")
        if b.get("scope", "shared") not in ("shared", "private"):
            return _refusal("bad_scope", "scope must be shared or private.")
        fields = _merged_fields(row["kind"], row["fields"], b.get("fields"), at)
        if isinstance(fields, tuple):
            return fields
        row.update(fields=fields, updated_at=at, **{k: b[k] for k in ("name", "brief", "scope", "status") if k in b})
        if "aliases" in b:
            row["aliases"] = [str(a).lower() for a in b["aliases"]]  # replaces the list, like the real Worker
        return 200, {"ok": True, "subject": _subject_shape(state, row, True)}
    if path == "/subjects" and method == "GET":
        rows = [r for r in state.subjects if all(not query.get(k) or r[k] == query[k][0] for k in ("kind", "status", "scope"))]
        needle = (query.get("q") or [""])[0].lower()
        rows = [r for r in rows if not needle or any(needle in t.lower() for t in (r["slug"], r["name"], *r["aliases"]))]
        return 200, {"ok": True, "subjects": [_subject_shape(state, r) for r in sorted(rows, key=lambda r: -r["updated_at"])]}
    if path == "/subject" and method == "GET":
        row = next((r for r in state.subjects if r["slug"] in query.get("slug", []) or r["id"] in query.get("id", [])), None)
        return (200, {"ok": True, "subject": _subject_shape(state, row, True)}) if row else _refusal("not_found", "No such subject.", 404)
    if path == "/devices" and method == "GET":
        return 200, {"ok": True, "devices": state.devices}
    if path == "/devices/private" and method == "POST":
        row = next((d for d in state.devices if d["id"] == b.get("id")), None)
        if not row:
            return _refusal("not_found", "No such device.", 404)
        if not isinstance(b.get("allow_private"), bool):
            return _refusal("bad_request", "allow_private must be true or false.")
        row["allow_private"] = b["allow_private"]
        return 200, {"ok": True, "id": row["id"], "allow_private": row["allow_private"]}
    return None


def _handler(state: FakeWorker):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # silence
            pass

        def _send(self, code: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return None
            try:
                return json.loads(self.rfile.read(n))
            except ValueError:
                return None

        def _route(self, method: str) -> None:
            body = self._body() if method == "POST" else None
            state.requests.append((method, self.path, body))
            state.headers.append({k.lower(): v for k, v in self.headers.items()})
            if not (self.headers.get("Authorization") or "").startswith("Bearer ") or len(self.headers.get("Authorization", "")) < 8:
                return self._send(401, {"ok": False, "error": "unauthorized"})
            path = self.path.split("?")[0]
            canned = state.replies.get(f"{method} {path}")
            if canned:
                return self._send(*canned)
            if path == "/health":
                return self._send(200, {"ok": True, "version": "fake"})
            if path == "/count":
                return self._send(200, {"count": len(state.recall_results)})
            if path == "/recall":
                results = []
                for i, r in enumerate(state.recall_results, 1):
                    results.append({"score": 100 - i, "why": {"dense_rank": i, "dense_score": r.get("dense_score", 0.8), "keyword_terms": []}, **r})
                reply = {"ok": True, "results": results, "receipt": "fake"}
                if state.recall_subjects is not None:
                    reply["subjects"] = state.recall_subjects
                return self._send(200, reply)
            if path == "/prompt-capsules/core":
                if state.legacy:
                    text = json.dumps({"schema": "prompt-capsule.v1", "sections": state.capsule_sections})
                    return self._send(200, {"sections": [{"slot": s.get("slot")} for s in state.capsule_sections], "text": text})
                sections = [{"slot": s.get("slot"), "content": s.get("content", ""), "source_id": "m-%d" % i, "updated_at": 1} for i, s in enumerate(state.capsule_sections)]
                return self._send(200, {"ok": True, "sections": sections, "etag": "\"fake\"", "chars": sum(len(s["content"]) for s in sections), "cap": 9500})
            if path == "/capture" and method == "POST":
                state.captured.append(body)
                return self._send(200, {"ok": True, "id": f"fake-{len(state.captured):04d}-0000-0000-0000-000000000000", "tags": (body or {}).get("tags", [])})
            if path == "/extract" and method == "POST":
                return self._send(200, {"ok": True, "proposals": state.proposals, "model": "fake"})
            if path in ("/forget", "/status") and method == "POST":
                return self._send(200, {"ok": True})
            if path == "/link" and method == "POST":
                b = body or {}
                if b.get("type") in ("supersedes", "derived_from"):
                    return self._send(400, {"ok": False, "error": "That link type is written by the system.", "code": "reserved_link_type"})
                if b.get("type") not in USER_TYPES:
                    return self._send(400, {"ok": False, "error": "Link type must be one of: " + ", ".join(USER_TYPES), "code": "bad_link_type"})
                key = (b.get("source_id"), b.get("target_id"), b.get("type"))
                created = not any((l["source_id"], l["target_id"], l["type"]) == key for l in state.links)
                if created:
                    state.links.append({"source_id": key[0], "target_id": key[1], "type": key[2], "made_by": "user", "confidence": None, "created_at": len(state.links) + 1})
                return self._send(200, {"ok": True, "created": created})
            if path == "/unlink" and method == "POST":
                b = body or {}
                key = (b.get("source_id"), b.get("target_id"), b.get("type"))
                found = [l for l in state.links if (l["source_id"], l["target_id"], l["type"]) == key]
                for l in found:
                    state.links.remove(l)
                    if l["made_by"] == "system":
                        state.rejections.append(key)
                return self._send(200, {"ok": True, "removed": bool(found)})
            if path == "/links" and method == "GET":
                mid = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                rows = []
                for l in sorted(state.links, key=lambda l: -l["created_at"]):
                    if mid not in (l["source_id"], l["target_id"]):
                        continue
                    out = l["source_id"] == mid
                    other = l["target_id"] if out else l["source_id"]
                    rows.append({"type": l["type"], "direction": "out" if out else "in", "other_id": other, "other_name": state.names.get(other, ""),
                                 "made_by": l["made_by"], "confidence": l["confidence"], "created_at": l["created_at"]})
                return self._send(200, {"ok": True, "id": mid, "links": sorted(rows, key=lambda r: r["type"])})  # stable: newest first inside a type
            answer = _subjects_route(state, method, path, parse_qs(urlparse(self.path).query), body or {})
            if answer:
                return self._send(*answer)
            return self._send(404, {"ok": False, "error": "not found"})

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return H


def start(recall=None, capsule=None, proposals=None, port: int = 0, legacy: bool = False, subjects=None) -> FakeWorker:
    state = FakeWorker(recall, capsule, proposals, legacy, subjects)
    server = ThreadingHTTPServer(("127.0.0.1", port), _handler(state))
    state._server = server
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    state._thread = threading.Thread(target=server.serve_forever, daemon=True)
    state._thread.start()
    return state
