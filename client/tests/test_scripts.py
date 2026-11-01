#!/usr/bin/env python3
"""The skill scripts, run as real processes against a local fake Worker (hm/testing/fake_worker.py) on 127.0.0.1.
`python3 client/tests/test_scripts.py`, exits non-zero on failure. No credentials, no network beyond localhost."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))
from hm.testing import fake_worker  # noqa: E402
from hm import audit  # noqa: E402

SCRIPTS = ROOT / "skills" / "anymem" / "scripts"
TOKEN = "tok-" + "z" * 20
ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
ID2 = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"
SECRET_TEXT = "my private sentence 8842"
failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


srv = fake_worker.start()
cache = tempfile.mkdtemp()
config = tempfile.mkdtemp()
BASE_ENV = {k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM_", "CLAUDE_"))}
ENV = {**BASE_ENV, "ANYMEM_URL": srv.url, "ANYMEM_TOKEN": TOKEN, "ANYMEM_CACHE_DIR": cache, "ANYMEM_CONFIG_DIR": config,
       "ANYMEM_PROJECT": "global", "ANYMEM_SESSION": "sess-1", "ANYMEM_HARNESS": "codex"}


def run(script, *args, stdin="", env=None):
    srv.requests.clear()
    srv.headers.clear()
    p = subprocess.run([sys.executable, str(SCRIPTS / f"{script}.py"), *args], input=stdin, capture_output=True, text=True, env={**ENV, **(env or {})}, timeout=60)
    return p.returncode, p.stdout, p.stderr


def last():
    return srv.requests[-1]


def query(path):
    return parse_qs(urlparse(path).query)


ENTRY = {"id": ID, "name": "tabs-over-spaces", "description": "d", "status": "active", "origin": "explicit", "project": "", "tags": ["x"], "recall_count": 2,
         "created_at": 1760000000000, "updated_at": 1760000000000, "content": "---\nname: tabs-over-spaces\n---\nUse tabs."}
LISTING = {"ok": True, "entries": [ENTRY, {**ENTRY, "id": ID2, "name": "other"}], "next_cursor": None}

# every job has its script, and the retired files are gone
JOBS = "recall remember get list append update status forget restore undo history link unlink links subject profile person usage backup devices doctor setup connect init install uninstall".split()
check("one script per job", all((SCRIPTS / f"{j}.py").exists() for j in JOBS))
check("the retired commands and files are gone", not any((ROOT / p).exists() for p in ("bin/anymem", "bin/mcp-headers", "bin/anymem-backup", "client/hm/commands/promote.py", "client/hm/commands/reject.py",
      "client/hm/commands/review.py", "client/hm/commands/_conflicts.py", "client/hm/commands/tidy.py")) and not (SCRIPTS / "promote.py").exists())
check("every script answers --help without a Worker", all(subprocess.run([sys.executable, str(SCRIPTS / f"{j}.py"), "--help"], capture_output=True, text=True, env=BASE_ENV, timeout=30).returncode == 0 for j in JOBS))

# recall
srv.replies["GET /recall"] = (200, {"ok": True, "results": [
    {"id": ID, "name": "tabs-over-spaces", "description": "the indent rule", "project": "", "content": "---\nname: x\n---\nUse tabs everywhere.", "relevant": True},
    {"id": ID2, "name": "weak-one", "description": "", "project": "demo", "content": "body", "relevant": False}]})
rc, out, err = run("recall", "what indent do I use")
q = query(last()[1])
check("recall sends the query, topK 5 and count=1, and no scope without a project", rc == 0 and q["query"] == ["what indent do I use"] and q["topK"] == ["5"] and q["count"] == ["1"] and "scope" not in q)
check("recall prints name, description and the opening of the text, and marks a weak match", "tabs-over-spaces" in out and "the indent rule" in out and "Use tabs everywhere." in out and "(weak match)" in out)
check("every call names the harness and the script in headers", srv.headers[-1]["x-anymem-script"] == "recall" and srv.headers[-1]["x-anymem-harness"] == "codex" and srv.headers[-1]["authorization"] == "Bearer " + TOKEN)
rc, out, err = run("recall", "q", "--limit", "9", env={"ANYMEM_PROJECT": "demo"})
q = query(last()[1])
check("in a project recall sends scope project:<slug>, and --limit sets topK", q["scope"] == ["project:demo"] and q["topK"] == ["9"])
rc, out, err = run("recall", "q", "--all", env={"ANYMEM_PROJECT": "demo"})
check("--all drops the scope", "scope" not in query(last()[1]))
rc, out, err = run("recall", "q", "--json")
check("--json prints the reply", json.loads(out)["results"][0]["id"] == ID)
# recall with subjects: a card prints above the memories, the rest of the output is what it was
PLAIN_REPLY = srv.replies["GET /recall"]
rc, plain, err = run("recall", "what indent do I use")
PIP_CARD = {"id": "c1", "slug": "pip", "name": "Pip", "kind": "pet", "brief": "Pip is a beagle.\nHe is afraid of thunder.", "via": [ID], "fields": {}}
srv.replies["GET /recall"] = (200, {**PLAIN_REPLY[1], "subjects": [PIP_CARD]})
rc, out, err = run("recall", "what indent do I use")
check("recall prints a card above the memories as one <memory> line", rc == 0 and out.startswith("- <memory>[card] Pip (pet): Pip is a beagle. He is afraid of thunder.</memory>\n1. "))
check("a reply without subjects prints exactly the memories, as it always did", plain == f"1. {ID}  tabs-over-spaces\n   the indent rule\n   --- name: x --- Use tabs everywhere.\n2. {ID2}  weak-one  (project demo)  (weak match)\n   body\n")
check("what follows the card is exactly what a reply without subjects prints", out.split("</memory>\n", 1)[1] == plain and plain.startswith("1. "))
srv.replies["GET /recall"] = (200, {**PLAIN_REPLY[1], "subjects": [{**PIP_CARD, "via": [ID2]}]})
rc, out, err = run("recall", "what indent do I use")
check("a card reached only through a weak match is not printed", "[card]" not in out and "(weak match)" in out)
srv.replies["GET /recall"] = (200, {"ok": True, "results": [], "subjects": [PIP_CARD]})
rc, out, err = run("recall", "nothing")
check("no results, no card", out.strip() == "no memories found")
srv.replies["GET /recall"] = (200, {**PLAIN_REPLY[1], "subjects": [PIP_CARD]})
rc, out, err = run("recall", "q", "--json")
check("--json still prints the reply as it came, subjects included", json.loads(out)["subjects"][0]["slug"] == "pip")
srv.replies["GET /recall"] = PLAIN_REPLY

# remember
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "tags": []})
rc, out, err = run("remember", "---\nname: a-note\ndescription: d\n---\nbody", "--tag", "alpha", "--project", "demo")
b = last()[2]
check("remember posts to /capture with source claude, harness, session, tags and project", rc == 0 and last()[1] == "/capture" and b["source"] == "claude" and b["harness"] == "codex"
      and b["session"] == "sess-1" and b["tags"] == ["alpha"] and b["project"] == "demo" and out.startswith("saved " + ID))
rc, out, err = run("remember", stdin="---\nname: from-stdin\n---\ntext")
check("remember reads standard input when there is no argument, no project means no project field", rc == 0 and "from-stdin" in last()[2]["content"] and "project" not in last()[2])
srv.replies["POST /capture"] = (200, {"ok": True, "duplicate": True, "matchId": ID2, "score": 0.97})
rc, out, err = run("remember", "x y z")
check("a duplicate is said plainly with the matching id", rc == 0 and "already stored as " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "warning": "similar", "matchId": ID2, "score": 0.9})
rc, out, err = run("remember", "x y z")
check("a similar warning names the other memory", "warning: similar to " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "replaced": {"id": ID2, "reason": "contradiction"}})
rc, out, err = run("remember", "x y z")
check("a replaced memory is announced with the undo hint", "It replaces memory " + ID2 in out and "undo.py " + ID2 in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "active", "kept_both": {"id": ID2, "reason": "pinned"}})
rc, out, err = run("remember", "x y z")
check("kept_both says both stay and not to retry", "Both stay live" in out and "pinned" in out and "Do not retry" in out)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID, "status": "canonical", "updated": True})
rc, out, err = run("remember", "x y z")
check("an in place update is said", "updated in place" in out)
srv.replies["POST /capture"] = (422, {"ok": False, "error": "no", "code": "refused", "reason": "blocked_topic"})
rc, out, err = run("remember", "x y z")
check("a refusal exits 2 and gives the reason", rc == 2 and "blocked_topic" in err)
srv.replies["POST /capture"] = (429, {"error": "slow", "code": "rate_limited", "retry_after": 120})
rc, out, err = run("remember", "x y z")
check("a rate limit exits 1 and gives the wait", rc == 1 and "120" in err)
srv.replies["POST /capture"] = (200, {"ok": True, "id": ID})
rc, out, err = run("remember", "the key is sk-" + "a1b2c3d4" * 4)
check("text that holds a secret is refused before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("remember", "keep <private>hidden part</private> visible part")
check("private text is removed before sending", "hidden part" not in last()[2]["content"] and "visible part" in last()[2]["content"])
rc, out, err = run("remember", "<private>all of it</private>")
check("a memory that is all private is not sent", rc == 2 and srv.requests == [])

# the read scripts
srv.replies["GET /list"] = (200, LISTING)
srv.replies["GET /entry"] = (200, {"ok": True, "entry": ENTRY})
COLD = {"ANYMEM_CACHE_DIR": tempfile.mkdtemp()}  # no ids printed earlier, so a prefix needs the scan
rc, out, err = run("get", ID[:8], env=COLD)
check("get resolves an id prefix through /list, then reads the entry", rc == 0 and [r[1].split("?")[0] for r in srv.requests] == ["/list", "/entry"] and query(last()[1])["id"] == [ID] and "Use tabs." in out)
rc, out, err = run("get", ID[:8])
check("a prefix of an id an earlier script printed needs no scan", rc == 0 and [r[1].split("?")[0] for r in srv.requests] == ["/entry"] and query(last()[1])["id"] == [ID])
rc, out, err = run("get", ID, "--version", "2")
check("get with a full id makes one call and passes version", [r[1].split("?")[0] for r in srv.requests] == ["/entry"] and query(last()[1])["version"] == ["2"])
rc, out, err = run("get", "ffffffff")
check("an id no memory has is a plain error", rc == 1 and "no memory with id ffffffff" in err)
srv.replies["GET /list"] = (200, {"ok": True, "entries": [{**ENTRY, "id": ID}, {**ENTRY, "id": ID[:8] + "-other"}], "next_cursor": None})
rc, out, err = run("get", ID[:8], env={"ANYMEM_CACHE_DIR": tempfile.mkdtemp()})
check("an id prefix that fits two memories asks for more of it", rc == 1 and "matches 2" in err)
srv.replies["GET /list"] = (200, LISTING)
rc, out, err = run("list", "--tag", "a", "--tag", "b", "--status", "canonical", "--origin", "capture", "--type", "user", "--project", "demo", "--days", "7", "--min-recalls", "10", "--max-recalls", "0", "-n", "5")
q = query(last()[1])
check("list sends every filter", rc == 0 and q["tag"] == ["a", "b"] and q["status"] == ["canonical"] and q["origin"] == ["capture"] and q["type"] == ["user"] and q["project"] == ["demo"]
      and q["min_recalls"] == ["10"] and q["max_recalls"] == ["0"] and q["n"] == ["5"] and int(q["after"][0]) > 1_700_000_000_000)
check("list prints one line per memory with the full id", "tabs-over-spaces" in out and "other" in out and ID in out)
ids_file = Path(cache) / "ids.json"
check("the ids a script printed are kept locally, ids only, mode 0600", ID in json.loads(ids_file.read_text()) and stat.S_IMODE(ids_file.stat().st_mode) == 0o600 and "tabs" not in ids_file.read_text())
rc, out, err = run("list", "--deleted")
check("list --deleted reads the trash", query(last()[1])["deleted"] == ["1"])
srv.replies["GET /history"] = (200, {"ok": True, "id": ID, "versions": [{"seq": 2, "reason": "update", "at": 1760000000000, "summary": "content +12 chars"}]})
rc, out, err = run("history", ID)
check("history prints seq, reason and summary", rc == 0 and "2  " in out and "update" in out and "content +12 chars" in out)

# the write scripts
for script, args, path, body in (
    ("append", (ID, "more text"), "/append", {"id": ID, "addition": "more text"}),
    ("status", (ID, "deprecated"), "/status", {"id": ID, "status": "deprecated"}),
    ("forget", (ID,), "/forget", {"id": ID}),
    ("restore", (ID,), "/restore", {"id": ID}),
    ("undo", (ID,), "/undo", {"id": ID}),
    ("update", (ID, "new text"), "/update", {"id": ID, "content": "new text"}),
    ("link", (ID, ID2, "--type", "about_person"), "/link", {"source_id": ID, "target_id": ID2, "type": "about_person"}),
):
    srv.replies[f"POST {path}"] = (200, {"ok": True, "entry": ENTRY, "created": True})
    rc, out, err = run(script, *args)
    check(f"{script} posts {path} with the full id", rc == 0 and last()[1] == path and last()[2] == body)
# links: the fake Worker keeps them, so the three scripts are checked against each other
ID3 = "5a5a5a5a-1111-4222-8333-444455556666"
srv.replies.pop("POST /link")
srv.names.update({ID: "pip-the-dog", ID2: "the-corolla", ID3: "project-alpha"})
rc, out, err = run("link", ID, ID2)
check("link with no type sends related", rc == 0 and last()[2] == {"source_id": ID, "target_id": ID2, "type": "related"} and out.strip() == "linked")
rc, out, err = run("link", ID, ID2, "owns")
check("link takes the type as a third word", rc == 0 and last()[2]["type"] == "owns")
rc, out, err = run("link", ID, ID2, "owns")
check("linking again says already linked", rc == 0 and out.strip() == "already linked")
for bad in ("likes", "Owns"):
    rc, out, err = run("link", ID, ID2, bad)
    check(f"link refuses {bad} before sending, exit 2, and lists the types", rc == 2 and srv.requests == [] and "about_person" in err and "related" in err and bad in err)
for reserved in ("supersedes", "derived_from"):
    rc, out, err = run("link", ID, ID2, "--type", reserved)
    check(f"link refuses {reserved} before sending, it is the system's", rc == 2 and srv.requests == [] and "system" in err)
srv.replies["POST /link"] = (400, {"ok": False, "error": "Link type must be one of: about", "code": "bad_link_type"})
rc, out, err = run("link", ID, ID2, "owns")
check("a Worker refusal of the type is one plain line and exit 1", rc == 1 and "Link type must be one of" in err and "Traceback" not in err)
srv.replies.pop("POST /link")
srv.links.append({"source_id": ID3, "target_id": ID, "type": "decided", "made_by": "system", "confidence": 0.8, "created_at": 50})
srv.links.append({"source_id": ID, "target_id": ID3, "type": "old free text", "made_by": "user", "confidence": None, "created_at": 40})
rc, out, err = run("links", ID)
rows = [r.split("  ") for r in out.splitlines()]
check("links reads GET /links with the full id", last()[0] == "GET" and query(last()[1])["id"] == [ID])
check("links prints type, direction, other id and name, one line each", ["decided", "in", ID3, "project-alpha"] in rows and ["owns", "out", ID2, "the-corolla"] in rows)
check("links shows a type outside the list as related, grouped with the related ones", [r[0] for r in rows] == ["decided", "owns", "related", "related"] and rows[2][1:3] == ["out", ID3] and rows[3][1:3] == ["out", ID2])
rc, out, err = run("links", ID, "--json")
check("links --json prints the reply", json.loads(out)["links"][0]["made_by"] == "system")
rc, out, err = run("links", ID3[:8] + "x" * 24)
check("a memory with no links says so", rc == 0 and out.strip() == "no links")
rc, out, err = run("unlink", ID, ID2, "owns")
check("unlink posts /unlink with the full ids and says removed", rc == 0 and last()[1] == "/unlink" and last()[2] == {"source_id": ID, "target_id": ID2, "type": "owns"} and out.strip() == "removed")
rc, out, err = run("unlink", ID, ID2, "owns")
check("unlinking a link that is not there says so", rc == 0 and out.strip() == "no such link")
rc, out, err = run("unlink", ID3, ID, "decided")
check("unlinking a system link removes it and the Worker records the rejection", out.strip() == "removed" and srv.rejections == [(ID3, ID, "decided")])
rc, out, err = run("links", ID)
check("the removed links are gone from links", "owns" not in out and "decided" not in out)
srv.replies["POST /unlink"] = (403, {"ok": False, "error": "Only the admin token may remove a link the system made.", "code": "admin_only"})
rc, out, err = run("unlink", ID3, ID, "decided")
check("a refused unlink is one plain line and exit 1", rc == 1 and "admin token" in err and "Traceback" not in err)
srv.replies.pop("POST /unlink")

# subjects: the fake Worker keeps them, so the script is checked against its own writes
rc, out, err = run("subject", "list")
check("subject list says so when there are none", rc == 0 and out.strip() == "no subjects" and last()[:2] == ("GET", "/subjects"))
rc, out, err = run("subject", "add", "pet", "pip", "Pip", "--brief", "Pip is a beagle. He is afraid of thunder.")
PIP_ID = out.split()[-1]
check("subject add posts slug, kind, name and brief, and prints the slug and the card id", rc == 0 and last()[1] == "/subject"
      and last()[2] == {"slug": "pip", "kind": "pet", "name": "Pip", "brief": "Pip is a beagle. He is afraid of thunder."} and out.split() == ["added", "pip", PIP_ID] and PIP_ID.startswith("card-"))
rc, out, err = run("subject", "add", "asset", "the-corolla", "The Corolla", stdin="")
check("subject add without a brief sends none", rc == 0 and last()[2] == {"slug": "the-corolla", "kind": "asset", "name": "The Corolla"})
rc, out, err = run("subject", "add", "project", "alpha", "Project Alpha", "--brief-file", "-", stdin="Alpha ships on Fridays.\n")
check("--brief-file with a lone dash reads the brief from standard input", rc == 0 and last()[2]["brief"] == "Alpha ships on Fridays.")
brief_file = Path(tempfile.mkdtemp()) / "brief.txt"
brief_file.write_text("Beta is the second project.\n", encoding="utf-8")
rc, out, err = run("subject", "add", "project", "beta", "Project Beta", "--brief-file", str(brief_file))
check("--brief-file PATH reads the brief from the file", rc == 0 and last()[2]["brief"] == "Beta is the second project.")
rc, out, err = run("subject", "add", "pet", "pip", "Pip again")
check("a slug that exists is the Worker's refusal as one plain line, exit 1", rc == 1 and "A subject with that slug exists" in err and "Traceback" not in err)
for bad, why in (("Pip", "uppercase"), ("p", "one character"), ("pip--dog", "double dash"), ("pip-", "trailing dash"), ("p" * 41, "41 characters"), ("pip_dog", "underscore")):
    rc, out, err = run("subject", "add", "pet", bad, "Pip")
    check(f"a slug with {why} is refused before sending, exit 2", rc == 2 and srv.requests == [] and "slug" in err)
rc, out, err = run("subject", "add", "dog", "rex", "Rex")
check("a kind outside the list is refused before sending, exit 2", rc == 2 and srv.requests == [] and "person" in err)
rc, out, err = run("subject", "add", "pet", "rex", "R" * 81)
check("a name over 80 characters is refused before sending", rc == 2 and srv.requests == [] and "80" in err)
rc, out, err = run("subject", "add", "pet", "rex", "Rex", "--brief", "the key is sk-" + "a1b2c3d4" * 4)
check("a brief that holds a secret is refused before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("subject", "add", "pet", "rex", "Rex", "--brief", "Rex <private>hidden part</private> is a lab.")
check("private text is removed from the brief before sending", rc == 0 and "hidden part" not in last()[2]["brief"] and "is a lab." in last()[2]["brief"])
rc, out, err = run("subject", "add", "pet", "mia", "Mia", "--brief", "a", "--brief-file", "x")
check("--brief and --brief-file together are refused", rc == 2 and srv.requests == [])

rc, out, err = run("subject", "set", "pip", "breed", "beagle")
check("subject set sends the field to /subject/update by slug", rc == 0 and last()[1] == "/subject/update" and last()[2] == {"slug": "pip", "fields": {"breed": "beagle"}} and out.strip() == "set breed")
rc, out, err = run("subject", "set", "pip", "breed", "")
check("an empty value removes the field, sent as null", rc == 0 and last()[2] == {"slug": "pip", "fields": {"breed": None}} and out.strip() == "removed breed")
rc, out, err = run("subject", "set", "pip", "vet", "Dr Dana Hart")
rc, out, err = run("subject", "set", "pip", "colour", "brown")
check("a field the kind does not allow is the Worker's refusal, one plain line, exit 1", rc == 1 and "not a field of a pet" in err and "Traceback" not in err)
rc, out, err = run("subject", "set", "nobody", "breed", "x")
check("a slug with no subject is a plain error, exit 1", rc == 1 and "No subject" in err)
rc, out, err = run("subject", "set", "pip", "vet", "the key is sk-" + "a1b2c3d4" * 4)
check("a field value that holds a secret is refused before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)

rc, out, err = run("subject", "alias", "pip", "Pippin")
check("subject alias reads the aliases, then sends the old ones and the new one, lowercase", rc == 0 and [r[1].split("?")[0] for r in srv.requests] == ["/subject", "/subject/update"]
      and query(srv.requests[0][1])["slug"] == ["pip"] and last()[2] == {"slug": "pip", "aliases": ["pippin"]} and out.strip() == "added alias pippin")
rc, out, err = run("subject", "alias", "pip", "the   Good Dog")
check("a second alias keeps the first and squeezes spaces", last()[2]["aliases"] == ["pippin", "the good dog"])
rc, out, err = run("subject", "alias", "pip", "PIPPIN")
check("an alias it already has is said and nothing is sent", rc == 0 and "already an alias" in out and [r[0] for r in srv.requests] == ["GET"])

rc, out, err = run("subject", "scope", "pip", "private")
check("subject scope sends the scope", rc == 0 and last()[2] == {"slug": "pip", "scope": "private"} and out.strip() == "pip is now private")
rc, out, err = run("subject", "scope", "pip", "secret")
check("a scope that is not shared or private is refused before sending", rc == 2 and srv.requests == [])
srv.replies["POST /subject/update"] = (403, {"ok": False, "error": "Only the admin token or a browser login may change a scope.", "code": "admin_only"})
rc, out, err = run("subject", "scope", "pip", "shared")
check("a device token's refusal is one plain line, exit 1", rc == 1 and "admin token" in err and "Traceback" not in err)
srv.replies.pop("POST /subject/update")

srv.links.append({"source_id": ID, "target_id": PIP_ID, "type": "about", "made_by": "user", "confidence": None, "created_at": 90})
srv.links.append({"source_id": ID2, "target_id": PIP_ID, "type": "related", "made_by": "user", "confidence": None, "created_at": 91})
srv.names[ID] = "pip-vet-visit"
rc, out, err = run("subject", "show", "pip")
lines_out = out.splitlines()
check("subject show reads GET /subject by slug", last()[0] == "GET" and query(last()[1])["slug"] == ["pip"])
check("show prints the slug, kind, status, scope and name on the first line, then the id", lines_out[0].split("  ") == ["pip", "pet", "active", "private", "Pip"] and lines_out[1] == "id: " + PIP_ID)
check("show prints the aliases and each field on its own line", "aliases: pippin, the good dog" in lines_out and "vet: Dr Dana Hart" in lines_out and not any(l.startswith("breed:") for l in lines_out))
check("show prints the brief, then only the memories about the card, id and name", lines_out[lines_out.index("brief:") + 1] == "Pip is a beagle. He is afraid of thunder." and "members (1):" in lines_out
      and lines_out[-1] == f"{ID}  pip-vet-visit")
rc, out, err = run("subject", "show", "nobody")
check("show of a slug with no subject is a plain error, exit 1", rc == 1 and "No such subject" in err)

rc, out, err = run("subject", "list")
rows = [r.split("  ") for r in out.splitlines()]
check("subject list prints slug, kind, status, scope, members and name, one subject per line", rc == 0 and ["pip", "pet", "active", "private", "1 members", "Pip"] in rows and ["the-corolla", "asset", "active", "shared", "0 members", "The Corolla"] in rows)
rc, out, err = run("subject", "list", "--kind", "asset")
check("list --kind filters on the Worker", query(last()[1])["kind"] == ["asset"] and [r.split("  ")[0] for r in out.splitlines()] == ["the-corolla"])
rc, out, err = run("subject", "list", "--kind", "dog")
check("list refuses a kind outside the list", rc == 2 and srv.requests == [])
rc, out, err = run("subject", "retire", "the-corolla")
check("subject retire sets the status retired", rc == 0 and last()[2] == {"slug": "the-corolla", "status": "retired"} and out.strip() == "retired the-corolla")
rc, out, err = run("subject", "list", "--kind", "asset")
check("a retired subject is still listed, as retired", "the-corolla  asset  retired" in out)
# proposals: the system makes them, the person's click is accept or dismiss
proposed_row = lambda slug, name, kind: {"id": f"card-{slug}-0000-0000-0000-000000000000", "slug": slug, "kind": kind, "status": "proposed", "scope": "shared", "name": name, "aliases": [], "fields": {}, "brief": "Proposed from conversation, waiting for your click.", "updated_at": 1}
srv.subjects.extend([proposed_row("dana", "Dana", "person"), proposed_row("zed", "Zed", "topic")])
rc, out, err = run("subject", "list", "--status", "proposed")
check("list --status asks the Worker for that status and prints only those", rc == 0 and query(last()[1])["status"] == ["proposed"] and [r.split("  ")[0] for r in out.splitlines()] == ["dana", "zed"] and "dana  person  proposed" in out)
rc, out, err = run("subject", "list", "--kind", "person", "--status", "proposed")
check("kind and status filter together", query(last()[1]) == {"kind": ["person"], "status": ["proposed"]} and [r.split("  ")[0] for r in out.splitlines()] == ["dana"])
rc, out, err = run("subject", "list", "--status", "maybe")
check("list refuses a status outside the list", rc == 2 and srv.requests == [])
rc, out, err = run("subject", "accept", "dana")
check("subject accept posts the slug and prints one line", rc == 0 and last()[:3] == ("POST", "/subject/accept", {"slug": "dana"}) and out.strip() == "accepted dana")
rc, out, err = run("subject", "accept", "dana")
check("accepting a subject that is no longer proposed is the Worker's refusal as one plain line, exit 1", rc == 1 and "not waiting for a click" in err and "Traceback" not in err)
rc, out, err = run("subject", "dismiss", "zed")
check("subject dismiss posts the slug and prints one line", rc == 0 and last()[:3] == ("POST", "/subject/dismiss", {"slug": "zed"}) and out.strip() == "dismissed zed")
rc, out, err = run("subject", "dismiss", "nobody")
check("dismissing a slug with no subject is a plain error, exit 1", rc == 1 and "No subject" in err)
rc, out, err = run("subject", "--help")
check("the help names accept and dismiss as the person's clicks", "accept" in out and "dismiss" in out and "never run by the agent" in out)
rc, out, err = run("subject", "list", "--status", "proposed")
check("nothing is left waiting after both clicks", out.strip() == "no subjects")
srv.subjects[:] = [r for r in srv.subjects if r["slug"] not in ("dana", "zed")]
rc, out, err = run("subject", "add", "pet", "evil", "Evil\x1b[31m")
rc, out, err = run("subject", "list")
check("store text never passes a control character to the terminal", "\x1b" not in out)
srv.devices.extend([{"id": "dev-1", "label": "laptop", "created_at": 1, "last_used_at": None, "allow_private": True}])
rc, out, err = run("devices", "allow-private", "dev-1", "off")
check("devices allow-private posts the flag and the fake Worker keeps it", rc == 0 and last()[1] == "/devices/private" and last()[2] == {"id": "dev-1", "allow_private": False} and srv.devices[0]["allow_private"] is False)
rc, out, err = run("devices", "list")
check("devices list shows the flag from a real reply", "private subjects off" in out)

rc, out, err = run("update", ID, "--tag", "a", "--tag", "b")
check("update with only --tag sends only tags", last()[2] == {"id": ID, "tags": ["a", "b"]})
rc, out, err = run("update", ID)
check("update with nothing to change is refused", rc == 2)
rc, out, err = run("append", ID, stdin="from stdin")
check("append reads standard input", last()[2]["addition"] == "from stdin")
rc, out, err = run("append", ID, "kept <private>hidden part</private> visible part")
check("append removes private text before sending", rc == 0 and "hidden part" not in last()[2]["addition"] and "visible part" in last()[2]["addition"])
rc, out, err = run("append", ID, "the key is sk-" + "a1b2c3d4" * 4)
check("append refuses text that holds a secret before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("update", ID, "keep <private>hidden part</private> visible part")
check("update removes private text before sending", rc == 0 and "hidden part" not in last()[2]["content"] and "visible part" in last()[2]["content"])
rc, out, err = run("update", ID, "<private>all of it</private>")
check("an update whose new text is all private sends nothing", rc == 2 and srv.requests == [])
rc, out, err = run("update", ID, "the key is sk-" + "a1b2c3d4" * 4)
check("update refuses text that holds a secret before anything is sent", rc == 2 and srv.requests == [] and "secret" in err)
rc, out, err = run("status", ID, "draft")
check("status refuses the old draft value", rc == 2 and srv.requests == [])
srv.replies["POST /undo"] = (409, {"error": "nothing to undo", "code": "nothing_to_undo"})
rc, out, err = run("undo", ID)
check("a Worker error is one plain line and exit 1", rc == 1 and "nothing to undo" in err and "Traceback" not in err)

# profile and person read the v2 list shape
srv.replies["GET /list"] = (200, {"ok": True, "entries": [], "next_cursor": None})
rc, out, err = run("profile")
check("profile runs against a v2 list reply", rc == 0 and "no profile yet" in out)
rc, out, err = run("devices", "list")
srv.replies["GET /devices"] = (200, {"devices": [{"id": "d1", "label": "laptop", "created_at": 1, "last_used_at": None}]})
rc, out, err = run("devices", "list")
check("devices lists", rc == 0 and "laptop" in out)
rc, out, err = run("usage")
check("usage runs without a Worker call", rc == 0 and srv.requests == [])

# not configured
rc, out, err = run("recall", "q", env={"ANYMEM_URL": "", "ANYMEM_TOKEN": ""})
check("an unconfigured client says so on one line and exits 1", rc == 1 and "not configured" in err and "Traceback" not in err)

# the audit log
log = Path(cache) / "audit.log"
lines = [json.loads(x) for x in log.read_text().splitlines()]
check("the audit log has a JSON line per call, in a 0600 file", len(lines) > 30 and stat.S_IMODE(log.stat().st_mode) == 0o600)
first = next(x for x in lines if x["route"] == "/recall")
check("a line holds time, harness, script, route, ids, status and ms", set(first) >= {"ts", "harness", "script", "route", "ids", "status", "ms", "method", "session"}
      and first["harness"] == "codex" and first["script"] == "recall" and first["session"] == "sess-1" and first["status"] == 200 and ID in first["ids"])
raw = log.read_text()
check("no query string, no content and no secret is in the log", "what indent" not in raw and "?" not in raw and TOKEN not in raw and "Use tabs" not in raw and "private sentence" not in raw)
check("the failed call is logged with its status", any(x["route"] == "/undo" and x["status"] == 409 for x in lines))

# rotation
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
audit.MAX_BYTES = 2000
audit.set_origin("script", "rot", "s")
for i in range(80):
    audit.record("GET", "/recall?query=x", [ID], 200, i)
cur, old = audit.path(), audit.path().with_name("audit.log.1")
check("the log rotates at the size cap and keeps one older file", old.exists() and cur.stat().st_size <= 2200 and old.stat().st_size <= 2200 and stat.S_IMODE(old.stat().st_mode) == 0o600)
check("audit.record never raises, even when the folder cannot be written", audit.record("GET", "/x") is None)
prev_cache = os.environ.get("ANYMEM_CACHE_DIR")
os.environ["ANYMEM_CACHE_DIR"] = "/proc/none/never"
try:
    check("an unwritable cache folder is not an error", audit.record("GET", "/x") is None)
finally:
    if prev_cache is None:
        os.environ.pop("ANYMEM_CACHE_DIR", None)
    else:
        os.environ["ANYMEM_CACHE_DIR"] = prev_cache

# credential caching: the command runs once per session and the file is private
cred_dir = Path(tempfile.mkdtemp())
counter = cred_dir / "count.txt"
helper = cred_dir / "cred.py"
helper.write_text(f'import json,pathlib\np=pathlib.Path(r"{counter}")\np.write_text(str(int(p.read_text() if p.exists() else 0)+1))\nprint(json.dumps({{"url": "{srv.url}", "token": "{TOKEN}"}}))\n')
cfg = Path(tempfile.mkdtemp())
(cfg / "config.json").write_text(json.dumps({"credential_command": f"{sys.executable} {helper}"}))
CENV = {**BASE_ENV, "ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": tempfile.mkdtemp(), "ANYMEM_PROJECT": "global"}
srv.replies["GET /recall"] = (200, {"ok": True, "results": []})
outs = []
for _ in range(3):
    p = subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s1"}, timeout=60)
    outs.append(p)
check("three runs in one session call the credential command once", counter.read_text() == "1" and all(p.returncode == 0 for p in outs))
files = list((Path(CENV["ANYMEM_CACHE_DIR"]) / "credentials").glob("*.json"))
check("the cache file is mode 0600 in a 0700 folder and holds one entry", len(files) == 1 and stat.S_IMODE(files[0].stat().st_mode) == 0o600 and stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700)
check("the cached secret is never printed", all(TOKEN not in p.stdout + p.stderr for p in outs) and TOKEN not in (Path(CENV["ANYMEM_CACHE_DIR"]) / "audit.log").read_text())
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s2"}, timeout=60)
check("a new session asks again", counter.read_text() == "2" and len(list(files[0].parent.glob("*.json"))) == 2)
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s2", "ANYMEM_CRED_TTL": "0"}, timeout=60)
check("a TTL of 0 turns the cache off", counter.read_text() == "3")
old_time = os.path.getmtime(files[0]) - 5000
for f in files[0].parent.glob("*.json"):
    os.utime(f, (old_time, old_time))
subprocess.run([sys.executable, str(SCRIPTS / "recall.py"), "q"], capture_output=True, text=True, env={**CENV, "ANYMEM_SESSION": "s3"}, timeout=60)
check("an expired entry is asked again and the old files are pruned", counter.read_text() == "4" and len(list(files[0].parent.glob("*.json"))) == 1)

srv.stop()
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
