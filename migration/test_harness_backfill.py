#!/usr/bin/env python3
"""Runnable check for migration/harness_backfill.py. `python3 migration/test_harness_backfill.py`, exits non-zero on failure.
No network. The Worker is a small fake that answers the two routes the script uses, the way worker/admin/routes.js does."""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness_backfill as hb  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))
    if not cond:
        failures.append(name)


def mem(i, tags=(), harness="", name=None, origin="import"):
    return {"id": f"{i:08d}-0000-4000-8000-000000000000", "name": name if name is not None else f"memory-{i}", "origin": origin, "harness": harness, "tags": list(tags)}


class FakeHttp:
    """GET /list?harness=none pages of 2, POST /admin/harness that never replaces and refuses an unknown name."""

    def __init__(self, memories, fail_ids=()):
        self.memories = {m["id"]: dict(m) for m in memories}
        self.calls = []
        self.fail_ids = set(fail_ids)

    def call(self, method, path, body=None, tries=4):
        self.calls.append((method, path, body))
        route = path.split("?")[0]
        if method == "GET" and route == "/list":
            assert "harness=none" in path, path
            blanks = [m for m in self.memories.values() if not m["harness"]]
            start = int(path.split("cursor=")[1]) if "cursor=" in path else 0
            page = blanks[start:start + 2]
            nxt = str(start + 2) if start + 2 < len(blanks) else None
            return {"ok": True, "entries": page, "next_cursor": nxt}
        if method == "POST" and route == "/admin/harness":
            if body["id"] in self.fail_ids:
                raise RuntimeError("POST /admin/harness answered HTTP 500")
            m = self.memories[body["id"]]
            if m["harness"]:
                return {"ok": True, "id": m["id"], "harness": m["harness"], "changed": False}
            m["harness"] = body["harness"]
            return {"ok": True, "id": m["id"], "harness": m["harness"], "changed": True}
        raise AssertionError((method, path))


# evidence from tags
check("captured-by with a known id is evidence", hb.evidence(["auto-capture", "captured-by:codex"]) == (["codex"], ["captured-by:codex"]))
check("captured-by with an alias is evidence for its id", hb.evidence(["captured-by:claude-code"])[0] == ["claude"])
check("a harness tag is evidence too, whatever its case", hb.evidence(["Harness:KILO"])[0] == ["kilo"])
check("captured-by with a name nobody knows is not evidence", hb.evidence(["captured-by:hermes"]) == ([], []))
check("a session tag that is a known name is evidence", hb.evidence(["session:zcode"])[0] == ["zcode"])
check("a session tag that starts with a name and a separator is evidence", hb.evidence(["session:agy-1a2b3c"])[0] == ["agy"] and hb.evidence(["session:dsh_9"])[0] == ["dsh"] and hb.evidence(["session:codex:7"])[0] == ["codex"])
check("a plain session id is not evidence", hb.evidence(["session:1a2b3c4d"]) == ([], []))
check("a session id that merely begins with the letters of a name is not evidence", hb.evidence(["session:kilometre-2", "session:claudette"]) == ([], []))
check("an alias in a session tag is evidence for its id", hb.evidence(["session:antigravity-1"])[0] == ["agy"])
check("two tags for one harness count once", hb.evidence(["captured-by:codex", "session:codex-3"])[0] == ["codex"])
check("two harnesses are a conflict", hb.evidence(["captured-by:codex", "session:kilo-3"])[0] == ["codex", "kilo"])
check("no tags and bad input are no evidence", hb.evidence([]) == ([], []) and hb.evidence(None) == ([], []))

memories = [
    mem(1, ["captured-by:codex"], origin="capture"),
    mem(2, ["captured-by:claude-code", "plain"], origin="import"),
    mem(3, ["captured-by:codex", "session:kilo-1"], origin="capture"),
    mem(4, ["session:1a2b3c4d"], origin="explicit"),
    mem(5, [], origin="import"),
    mem(6, ["session:zcode-77"], origin="capture"),
    mem(7, ["captured-by:codex"], harness="codex", origin="capture"),
]

# the dry run
http = FakeHttp(memories)
out = io.StringIO()
code = hb.main([], http=http, say=lambda s="": print(s, file=out))
text = out.getvalue()
check("the default is a dry run, exit 0", code == 0 and "Dry run. Nothing was changed. Run again with --apply to set 3 harnesses." in text, text)
check("a dry run only reads", all(method == "GET" for method, _, _ in http.calls) and all(not m["harness"] for k, m in http.memories.items() if k[:8] in ("00000001", "00000002", "00000006")))
check("the list is paged through every page", [c[1] for c in http.calls if c[0] == "GET"] == ["/list?harness=none&n=500", "/list?harness=none&n=500&cursor=2", "/list?harness=none&n=500&cursor=4"], str(http.calls))
check("the report counts all six blank memories and sorts them", "6 open memories have no harness." in text and "3 have evidence of one harness" in text and "1 point at more than one harness" in text and "2 have no evidence and stay blank (explicit 1, import 1)" in text, text)
check("the report names the harness and the tag that said so", "codex 1" in text and "claude 1" in text and "zcode 1" in text and "captured-by:claude-code" in text)
check("the report shows 8 characters of an id and a name, never a whole memory", "00000001  memory-1" in text and "0000000-0000" not in text)

# the sorted list as JSON
out = io.StringIO()
hb.main(["--json"], http=FakeHttp(memories), say=lambda s="": print(s, file=out))
doc = json.loads(out.getvalue().rsplit("Dry run", 1)[0])
check("--json prints the three groups", [len(doc[k]) for k in ("fill", "conflict", "none")] == [3, 1, 2] and doc["conflict"][0]["harnesses"] == ["codex", "kilo"])

# --apply
http = FakeHttp(memories)
out = io.StringIO()
code = hb.main(["--apply"], http=http, say=lambda s="": print(s, file=out))
posts = [(b["id"][:8], b["harness"]) for m, p, b in http.calls if m == "POST"]
check("--apply sets only the memories with one clear harness", code == 0 and posts == [("00000001", "codex"), ("00000002", "claude"), ("00000006", "zcode")], str(posts))
check("the conflict and the memories with no evidence are untouched", all(not http.memories[k]["harness"] for k in http.memories if k[:8] in ("00000003", "00000004", "00000005")))
check("it reports what changed", "Applied. 3 changed, 0 already set, 0 failed." in out.getvalue(), out.getvalue())
out = io.StringIO()
again = hb.main(["--apply"], http=http, say=lambda s="": print(s, file=out))
check("a second run finds nothing left to fill in", again == 0 and "have evidence of one harness and can be filled in" in out.getvalue() and "Applied. 0 changed, 0 already set, 0 failed." in out.getvalue(), out.getvalue())
check("the fake route never replaces a harness", http.call("POST", "/admin/harness", {"id": memories[6]["id"], "harness": "kilo"})["harness"] == "codex")

# a failure is counted, reported and does not stop the rest
http = FakeHttp(memories, fail_ids={memories[0]["id"]})
out = io.StringIO()
code = hb.main(["--apply"], http=http, say=lambda s="": print(s, file=out))
check("a failed call is reported, the others still go, and the exit code says so", code == 1 and "Applied. 2 changed, 0 already set, 1 failed." in out.getvalue() and "failed 00000001" in out.getvalue(), out.getvalue())

# nothing to do
out = io.StringIO()
hb.main([], http=FakeHttp([mem(1, [], harness="codex")]), say=lambda s="": print(s, file=out))
check("with no blank memory it says there is nothing to fill in", "0 open memories have no harness." in out.getvalue() and "nothing to fill in" in out.getvalue(), out.getvalue())

# the address and token come from the environment, and a missing one is a plain message
for key in ("TARGET_URL", "TARGET_TOKEN"):
    os.environ.pop(key, None)
try:
    hb.target()
    check("no address and token is refused", False)
except SystemExit as e:
    check("no address and token is refused with a plain message", "TARGET_URL" in str(e) and "TARGET_TOKEN" in str(e))
os.environ["TARGET_URL"], os.environ["TARGET_TOKEN"] = "https://worker.invalid", "t" * 12
h = hb.target()
check("the Worker is the one in TARGET_URL, with the token as a bearer and a script label, and no Access header without an id",
      h.base == "https://worker.invalid" and h.headers["Authorization"] == "Bearer " + "t" * 12 and h.headers["X-Anymem-Script"] == "harness_backfill" and "CF-Access-Client-Id" not in h.headers)
os.environ["TARGET_ACCESS_CLIENT_ID"], os.environ["TARGET_ACCESS_CLIENT_SECRET"] = "id.access", "s" * 8
check("an Access service token is sent when both halves are set", hb.target().headers["CF-Access-Client-Id"] == "id.access")
check("the token never appears in the module's own text", "t" * 12 not in Path(hb.__file__).read_text())

print()
print(f"{len(failures)} failed" if failures else "all passed")
sys.exit(1 if failures else 0)
