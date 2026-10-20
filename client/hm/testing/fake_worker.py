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
proposals), POST /forget, /status. Any request without an Authorization bearer header gets 401.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeWorker:
    def __init__(self, recall=None, capsule=None, proposals=None, legacy=False):
        self.recall_results = recall or []
        self.capsule_sections = capsule or []
        self.proposals = proposals or []
        self.legacy = legacy
        self.requests: list = []
        self.headers: list = []
        self.replies: dict = {}
        self.captured: list = []
        self.url = ""
        self._server = None
        self._thread = None

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()


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
                return self._send(200, {"ok": True, "results": results, "receipt": "fake"})
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
            return self._send(404, {"ok": False, "error": "not found"})

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return H


def start(recall=None, capsule=None, proposals=None, port: int = 0, legacy: bool = False) -> FakeWorker:
    state = FakeWorker(recall, capsule, proposals, legacy)
    server = ThreadingHTTPServer(("127.0.0.1", port), _handler(state))
    state._server = server
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    state._thread = threading.Thread(target=server.serve_forever, daemon=True)
    state._thread.start()
    return state
