"""A small stateful fake of the Cloudflare REST API, on a local port, for the installer tests. No network, no real account.

    with FakeCloudflare() as cf:
        os.environ["ANYMEM_CF_API"] = cf.url
        ...
        cf.state["d1"], cf.calls

It implements only what setup and uninstall call. D1 queries run on real SQLite, so the migrations are proven to apply.
Failure injection  cf.fail("POST", r"/d1/database$", 403, [10000], "Authentication error", times=1).
Denied reads       cf.deny(r"/vectorize/") answers 403 code 10000 to every call whose path matches.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

ACCOUNT = "acc00000000000000000000000000001"
SECRET_TEXT = "never-seen-secret"


def parse_multipart(body: bytes, content_type: str) -> list:
    boundary = re.search(r"boundary=(\S+)", content_type).group(1).encode()
    parts = []
    for chunk in body.split(b"--" + boundary):
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        head, _, content = chunk.partition(b"\r\n\r\n")
        headers = head.decode("utf-8", "replace")
        name = re.search(r'name="([^"]*)"', headers).group(1)
        filename = re.search(r'filename="([^"]*)"', headers)
        ctype = re.search(r"Content-Type: (.*)", headers)
        parts.append({"name": name, "filename": filename.group(1) if filename else "", "type": ctype.group(1).strip() if ctype else "", "content": content})
    return parts


class FakeCloudflare:
    def __init__(self, subdomain: str = "trialbox", zones=("example.com",), zero_trust: bool = True, metadata_lag: int = 0):
        self.state = {"d1": {}, "vectorize": {}, "r2": {}, "scripts": {}, "assets": {}, "subdomain": subdomain, "domains": {}, "zones": list(zones),
                      "access_apps": {}, "service_tokens": {}, "policies": {}, "org": "team.cloudflareaccess.com" if zero_trust else "", "jwts": set()}
        self.calls = []        # (method, path) in order
        self.bodies = []       # the raw request bodies, for the test that proves no secret leaks
        self.denied = []
        self.failures = []
        self.metadata_lag = metadata_lag
        self.max_per_page = 100  # the most items a list reply gives per page, tests lower it to force a walk over pages
        self.lock = threading.Lock()
        self.token_seen = set()
        self.seq = 0

    def next_id(self, prefix: str) -> str:
        """A new id that no earlier object in this fake had, even after a delete."""
        self.seq += 1
        return "%s%d" % (prefix, self.seq)

    def __enter__(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def handle_any(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                status, payload = fake.dispatch(self.command, self.path, body, self.headers)
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PUT = do_DELETE = handle_any

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/client/v4" % self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    # ---------------------------------------------------------------- control
    def fail(self, method, pattern, status, codes, message, times=1):
        self.failures.append([method, re.compile(pattern), status, codes, message, times])

    def deny(self, pattern):
        self.denied.append(re.compile(pattern))

    def count(self, method, pattern) -> int:
        return len([1 for m, p in self.calls if m == method and re.search(pattern, p)])

    def writes(self) -> list:
        return [(m, p) for m, p in self.calls if m != "GET"]

    # --------------------------------------------------------------- dispatch
    def dispatch(self, method, raw_path, body, headers):
        with self.lock:
            url = urlsplit(raw_path)
            path = url.path[len("/client/v4"):]
            query = parse_qs(url.query)
            self.calls.append((method, path))
            self.bodies.append(body)
            for f in self.failures:
                if f[0] == method and f[1].search(path) and f[5] > 0:
                    f[5] -= 1
                    return f[2], self.err(f[3], f[4])
            if any(d.search(path) for d in self.denied):
                return 403, self.err([10000], "Authentication error")
            auth = headers.get("Authorization", "")
            self.token_seen.add(auth)
            if not auth.startswith("Bearer ") or len(auth) < 12:
                return 401, self.err([9109], "Invalid access token")
            ctype = headers.get("Content-Type", "")
            data = json.loads(body) if body and "json" in ctype else None
            try:
                return self.route(method, path, query, data, body, ctype, auth)
            except KeyError as e:
                return 400, self.err([1000], "bad request, missing %s" % e)

    @staticmethod
    def err(codes, message):
        return {"success": False, "errors": [{"code": c, "message": message} for c in codes], "messages": [], "result": None}

    @staticmethod
    def ok(result, status=200, **extra):
        return status, {"success": True, "errors": [], "messages": [], "result": result, **extra}

    def page(self, items, query):
        """A list reply the way Cloudflare pages one: at most max_per_page items, and result_info says how many pages there are."""
        size = min(int(query.get("per_page", [self.max_per_page])[0]), self.max_per_page)
        number = int(query.get("page", ["1"])[0])
        total = max(1, -(-len(items) // size))
        info = {"page": number, "per_page": size, "count": len(items[(number - 1) * size:number * size]), "total_count": len(items), "total_pages": total}
        return self.ok(items[(number - 1) * size:number * size], result_info=info)

    def not_found(self, what="not found"):
        return 404, self.err([10000 + 7], what)

    def route(self, method, path, query, data, body, ctype, auth):
        S = self.state
        if path == "/accounts":
            return self.ok([{"id": ACCOUNT, "name": "Trial account"}], result_info={"total_pages": 1})
        m = re.fullmatch(r"/accounts/(\w+)(/.*)", path)
        if not m:
            if path == "/zones":
                name = query.get("name", [""])[0]
                return self.ok([{"id": "zone-" + z, "name": z} for z in S["zones"] if z == name])
            return self.not_found()
        if m.group(1) != ACCOUNT:
            return 403, self.err([10000], "Authentication error")
        sub = m.group(2)

        # ----- D1
        if sub == "/d1/database" and method == "GET":
            name = query.get("name", [""])[0]
            return self.ok([{"uuid": v["uuid"], "name": k} for k, v in S["d1"].items() if not name or k == name], result_info={"total_pages": 1})
        if sub == "/d1/database" and method == "POST":
            if data["name"] in S["d1"]:
                return 400, self.err([7502], "A database with that name already exists")
            uuid = hashlib.md5(data["name"].encode()).hexdigest()
            db = sqlite3.connect(":memory:", check_same_thread=False)
            S["d1"][data["name"]] = {"uuid": uuid, "db": db}
            return self.ok({"uuid": uuid, "name": data["name"]}, 200)
        m2 = re.fullmatch(r"/d1/database/(\w+)(/query)?", sub)
        if m2:
            entry = next((v for v in S["d1"].values() if v["uuid"] == m2.group(1)), None)
            if not entry:
                return self.not_found("database not found")
            if method == "DELETE":
                S["d1"] = {k: v for k, v in S["d1"].items() if v is not entry}
                return self.ok({})
            sql = data["sql"]
            try:
                if re.match(r"\s*SELECT", sql, re.I):
                    cur = entry["db"].execute(sql)
                    cols = [c[0] for c in cur.description]
                    return self.ok([{"results": [dict(zip(cols, r)) for r in cur.fetchall()], "success": True}])
                entry["db"].executescript(sql)
                return self.ok([{"results": [], "success": True}])
            except sqlite3.Error as e:
                return 400, self.err([7500], "SQL error: %s" % e)

        # ----- Vectorize
        if sub == "/vectorize/v2/indexes" and method == "GET":
            return self.ok([{"name": k, "config": v["config"]} for k, v in S["vectorize"].items()])
        if sub == "/vectorize/v2/indexes" and method == "POST":
            if data["name"] in S["vectorize"]:
                return 409, self.err([3002], "index already exists")
            S["vectorize"][data["name"]] = {"config": data["config"], "meta": [], "pending": [], "vectors": 0}
            return self.ok({"name": data["name"], "config": data["config"]})
        m2 = re.fullmatch(r"/vectorize/v2/indexes/([\w-]+)(?:/(metadata_index/(?:list|create)))?", sub)
        if m2:
            idx = S["vectorize"].get(m2.group(1))
            if idx is None:
                return self.not_found("index not found")
            if method == "DELETE":
                del S["vectorize"][m2.group(1)]
                return self.ok({"mutationId": "m1"})
            if m2.group(2) == "metadata_index/create":
                idx["pending"].append([data["propertyName"], data["indexType"], self.metadata_lag])
                if self.metadata_lag == 0:
                    self._settle(idx)
                return self.ok({"mutationId": "m2"})
            if m2.group(2) == "metadata_index/list":
                for p in idx["pending"]:
                    p[2] -= 1
                self._settle(idx)
                return self.ok({"metadataIndexes": [{"propertyName": n, "indexType": t} for n, t in idx["meta"]]})

        # ----- R2
        if sub == "/r2/buckets" and method == "GET":
            part = query.get("name_contains", [""])[0]
            return self.ok({"buckets": [{"name": k} for k in S["r2"] if part in k]})
        if sub == "/r2/buckets" and method == "POST":
            if data["name"] in S["r2"]:
                return 409, self.err([10004], "bucket already exists")
            S["r2"][data["name"]] = {"rules": [], "objects": 0}
            return self.ok({"name": data["name"]})
        m2 = re.fullmatch(r"/r2/buckets/([\w-]+)(/lifecycle)?", sub)
        if m2:
            b = S["r2"].get(m2.group(1))
            if b is None:
                return self.not_found("bucket not found")
            if method == "DELETE":
                if b["objects"]:
                    return 409, self.err([10008], "bucket is not empty")
                del S["r2"][m2.group(1)]
                return self.ok({})
            if method == "PUT":
                b["rules"] = data["rules"]
                return self.ok({})
            return self.ok({"rules": b["rules"]})

        # ----- Workers
        if sub == "/workers/scripts" and method == "GET":
            return self.ok([{"id": k} for k in S["scripts"]])
        if sub == "/workers/subdomain":
            if method == "PUT":
                S["subdomain"] = data["subdomain"]
            if not S["subdomain"]:
                return self.not_found("no subdomain")
            return self.ok({"subdomain": S["subdomain"]})
        if sub == "/workers/domains" and method == "GET":
            host = query.get("hostname", [""])[0]
            return self.ok([{"hostname": h, "service": v["service"]} for h, v in S["domains"].items() if h == host])
        if sub == "/workers/domains" and method == "PUT":
            # the attach call has no field that takes a hostname over from another Worker
            if data["hostname"] in S["domains"] and S["domains"][data["hostname"]]["service"] != data["service"]:
                return 409, self.err([100117], "hostname already in use")
            S["domains"][data["hostname"]] = data
            return self.ok(data)
        if sub == "/workers/assets/upload":
            token = auth[len("Bearer "):]
            if token not in S["jwts"]:
                return 401, self.err([10000], "bad upload token")
            for p in parse_multipart(body, ctype):
                content = base64.b64decode(p["content"])
                paths = [k for man in S["manifests"].values() for k, v in man.items() if v["hash"] == p["name"]]
                ext = paths[0].rsplit(".", 1)[-1] if paths and "." in paths[0] else ""
                if not paths or hashlib.sha256((p["content"].decode() + ext).encode()).hexdigest()[:32] != p["name"]:
                    return 400, self.err([10001], "asset content does not match its hash")
                S["assets"][p["name"]] = content
            done = "done-" + hashlib.md5(token.encode()).hexdigest()
            S["jwts"].add(done)
            return self.ok({"jwt": done}, 201)
        m2 = re.fullmatch(r"/workers/scripts/([\w-]+)(?:/(assets-upload-session|settings|schedules|subdomain))?", sub)
        if m2:
            name, what = m2.group(1), m2.group(2)
            if what == "assets-upload-session":
                manifest = data["manifest"]
                for p, info in manifest.items():
                    if not re.fullmatch(r"[0-9a-f]{32}", info["hash"]) or not p.startswith("/"):
                        return 400, self.err([10001], "bad manifest")
                need = sorted({i["hash"] for i in manifest.values() if i["hash"] not in S["assets"]})
                jwt = "upload-" + hashlib.md5(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
                S["jwts"].add(jwt)
                S.setdefault("manifests", {})[name] = manifest
                return self.ok({"jwt": jwt, "buckets": [need] if need else []})
            if what == "settings":
                return self.ok({}) if name in S["scripts"] else self.not_found("script not found")
            if what == "schedules" and method == "PUT":
                if name not in S["scripts"]:
                    return self.not_found()
                S["scripts"][name]["crons"] = data
                return self.ok({"schedules": data})
            if what == "subdomain":
                if name not in S["scripts"]:
                    return self.not_found()
                S["scripts"][name]["workers_dev"] = data["enabled"]
                return self.ok(data)
            if method == "PUT":
                parts = {p["name"]: p for p in parse_multipart(body, ctype)}
                meta = json.loads(parts.pop("metadata")["content"])
                if meta["main_module"] not in parts:
                    return 400, self.err([10021], "main module %s is not among the modules" % meta["main_module"])
                jwt = (meta.get("assets") or {}).get("jwt", "")
                if jwt not in S["jwts"] or not jwt.startswith(("done-", "upload-")):
                    return 400, self.err([10021], "assets completion token is not valid")
                if any(not p["type"].startswith("application/javascript") for p in parts.values()):
                    return 400, self.err([10021], "modules need a JavaScript module content type")
                old = S["scripts"].get(name, {})
                secret = next((b["text"] for b in meta["bindings"] if b["type"] == "secret_text"), None)
                if secret is None:
                    if "secret_text" not in meta.get("keep_bindings", []) or "secret" not in old:
                        return 400, self.err([10021], "AUTH_TOKEN was not supplied and there is none to keep")
                    secret = old["secret"]
                S["scripts"][name] = {"meta": meta, "modules": sorted(parts), "secret": secret, "crons": old.get("crons", []), "workers_dev": old.get("workers_dev", False)}
                return self.ok({"id": name})
            if method == "DELETE":
                if name not in S["scripts"]:
                    return self.not_found()
                del S["scripts"][name]
                return self.ok({})

        # ----- Access
        if sub == "/access/organizations":
            if not S["org"]:
                return self.not_found("no organization")
            return self.ok({"auth_domain": S["org"]})
        if sub == "/access/service_tokens" and method == "GET":
            return self.page([{"id": k, "name": v["name"], "client_id": v["client_id"], "expires_at": v["expires_at"]} for k, v in S["service_tokens"].items()], query)
        if sub == "/access/service_tokens" and method == "POST":
            tid = self.next_id("tok")
            # the real client id is 32 hex characters and ".access", and the common name the Worker checks is that same value
            S["service_tokens"][tid] = {"name": data["name"], "client_id": hashlib.md5(tid.encode()).hexdigest() + ".access", "expires_at": "2027-10-17T00:00:00Z"}
            return self.ok({"id": tid, "client_id": S["service_tokens"][tid]["client_id"], "client_secret": SECRET_TEXT, "expires_at": "2027-10-17T00:00:00Z", "name": data["name"]})
        m2 = re.fullmatch(r"/access/service_tokens/(\w+)", sub)
        if m2 and method == "DELETE":
            return self.ok({}) if S["service_tokens"].pop(m2.group(1), None) else self.not_found()
        if sub == "/access/apps" and method == "GET":
            return self.page([{"id": k, "name": v["name"], "domain": v["domain"], "aud": v["aud"]} for k, v in S["access_apps"].items()], query)
        if sub == "/access/apps" and method == "POST":
            aid = "app%d" % (len(S["access_apps"]) + 1)
            S["access_apps"][aid] = {**data, "aud": "aud" + aid}
            S["policies"][aid] = []
            return self.ok({"id": aid, "aud": "aud" + aid, **data})
        if method == "PUT" and re.fullmatch(r"/access/apps/\w+", sub):
            aid = sub.rsplit("/", 1)[1]
            if aid not in S["access_apps"]:
                return self.not_found()
            S["access_apps"][aid].update(data)
            return self.ok({"id": aid, **S["access_apps"][aid]})
        m2 = re.fullmatch(r"/access/apps/(\w+)/policies/(\w+)", sub)
        if m2 and method == "PUT":
            pol = next((p for p in S["policies"].get(m2.group(1), []) if p["id"] == m2.group(2)), None)
            if pol is None:
                return self.not_found("policy not found")
            pol.update(data)
            return self.ok(pol)
        m2 = re.fullmatch(r"/access/apps/(\w+)(/policies)?", sub)
        if m2:
            aid = m2.group(1)
            if aid not in S["access_apps"]:
                return self.not_found()
            if method == "DELETE":
                del S["access_apps"][aid]
                return self.ok({})
            if m2.group(2):
                if method == "POST":
                    pol = {**data, "id": self.next_id("pol")}
                    S["policies"][aid].append(pol)
                    return self.ok(pol)
                return self.ok(S["policies"][aid])
        return self.not_found("no such route in the fake: %s %s" % (method, sub))

    @staticmethod
    def _settle(idx):
        for p in list(idx["pending"]):
            if p[2] <= 0:
                idx["meta"].append((p[0], p[1]))
                idx["pending"].remove(p)
