#!/usr/bin/env python3
"""Runnable check for migration/migrate_v1_to_v2.py and migration/compare.py. `python3 migration/test_migrate.py`, exits non-zero on failure.
No network. The mapping is a pure function, the loader is run against a fake v2 Worker."""
from __future__ import annotations

import copy
import hashlib
import io
import contextlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare  # noqa: E402
import migrate_v1_to_v2 as m  # noqa: E402

failures = []
AT = 1_800_000_000_000


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def entry(**over):
    base = {
        "id": "e1", "content": "---\nname: n1\ndescription: d1\nmetadata:\n  type: feedback\n---\nBody text #alpha here.\n",
        "tags": ["status:canonical", "kind:semantic", "project:anymem", "captured-by:claude-code", "session:abc123", "plain"],
        "source": "session-capture", "created_at": 1000, "updated_at": 2000, "recall_count": 3, "valid_from": None, "valid_until": None,
        "importance_score": 3, "contradiction_wins": 1, "contradiction_losses": 0,
    }
    return {**base, **over}


# frontmatter, hashtags, hash
fm = m.parse_frontmatter("---\nname: \"a b\"\ndescription: 'x'\nmetadata:\n  type: Reference\n---\n  hello  ")
check("frontmatter name, description, type, body", fm == {"name": "a b", "description": "x", "type": "reference", "body": "hello"})
check("no closed block means no frontmatter", m.parse_frontmatter("---\nname: x\nbody")["name"] is None)
check("unknown type is null", m.parse_frontmatter("---\nmetadata:\n  type: weird\n---\nb")["type"] is None)
check("hashtags skip code fences and mid word", m.lift_hashtags("a #One (#two) x#no\n```\n#code\n```") == ["one", "two"])
check("content hash collapses whitespace", m.content_hash("a  b\n c") == hashlib.sha256(b"a b c").hexdigest())
check("tags from a JSON string", m.tag_list('["A b", "#C"]') == ["a-b", "c"])
check("tag list drops long tags and duplicates", m.tag_list(["x" * 65, "ok", "OK"]) == ["ok"])

# mapping
r = m.map_entry(entry(), AT)
check("name, description, type, body parsed", (r["name"], r["description"], r["type"], r["body"]) == ("n1", "d1", "feedback", "Body text #alpha here."))
check("content is the trimmed text", r["content"] == entry()["content"].strip())
check("status, kind, project become columns", (r["status"], r["kind"], r["project"]) == ("canonical", "semantic", "anymem"))
check("captured-by and session become columns", (r["harness"], r["session"]) == ("claude-code", "abc123"))
check("plain tags stay, hashtags lift, reserved tags leave", r["tags"] == ["plain", "alpha"])
check("session-capture is capture", r["origin"] == "capture")
check("created, updated, recall count carried", (r["created_at"], r["updated_at"], r["recall_count"]) == (1000, 2000, 3))
check("valid_from falls back to created_at", r["valid_from"] == 1000)
check("not pinned, not trashed", (r["pinned"], r["deleted_at"]) == (0, None))
for src, want in [("claude", "explicit"), ("vault-memory-import", "import"), ("zcode-native-memory", "import"), ("profile", "profile"), ("person", "person"), ("system", "system"), ("capsule-author", "explicit"), (None, "explicit")]:
    check("source %s becomes %s" % (src, want), m.map_entry(entry(source=src), AT)["origin"] == want)
check("no status tag becomes active", m.map_entry(entry(tags=[]), AT)["status"] == "active")
check("status draft becomes active and the tag goes", (lambda x: (x["status"], x["tags"]))(m.map_entry(entry(tags=["status:draft"]), AT)) == ("active", ["alpha"]))
check("a second status tag stays plain", m.map_entry(entry(tags=["status:canonical", "status:deprecated"]), AT)["tags"] == ["status:deprecated", "alpha"])
check("an invalid project slug stays a tag", m.map_entry(entry(tags=["project:-bad"]), AT)["project"] == "")
check("capsule tag pins", m.map_entry(entry(tags=["capsule:core"]), AT)["pinned"] == 1)
check("capsule slot tag pins", m.map_entry(entry(tags=["capsule-slot:identity"]), AT)["pinned"] == 1)
check("profile pins", m.map_entry(entry(source="profile"), AT)["pinned"] == 1)
check("person pins", m.map_entry(entry(source="person"), AT)["pinned"] == 1)
check("validity carried", m.map_entry(entry(valid_from=500, valid_until=900), AT)["valid_until"] == 900 and m.map_entry(entry(valid_from=500), AT)["valid_from"] == 500)
check("rolled-up goes to the trash at import time", m.map_entry(entry(tags=["rolled-up"]), AT)["deleted_at"] == AT)
check("synthesized goes to the trash", m.map_entry(entry(tags=["synthesized"]), AT)["deleted_at"] == AT)
check("the rolled-up tag is kept", "rolled-up" in m.map_entry(entry(tags=["rolled-up"]), AT)["tags"])
check("missing times fall back", m.map_entry(entry(created_at=None, updated_at=None), AT)["updated_at"] == AT)
for bad, why in [({"id": ""}, "empty id"), ({"id": "x" * 65}, "long id"), ({"content": "  "}, "empty content"), ({"content": "x" * 30001}, "huge content")]:
    try:
        m.map_entry(entry(**bad), AT)
        check("rejects " + why, False)
    except ValueError:
        check("rejects " + why, True)
check("the 30,000 character limit counts like the Worker", m.utf16_len("a\U0001F600") == 3)
check("every memories column is present", all(c in r for c in m.MEMORY_COLUMNS))

# trash
t = m.map_trash({"id": "t1", "preview": "--- name: gone", "deleted_at": 5000, "source": "claude"}, AT)
check("trash becomes a soft deleted row", (t["deleted_at"], t["origin"], t["created_at"]) == (5000, "explicit", 5000))
check("trash row says it holds only a preview", t["tags"] == [m.PREVIEW_ONLY_TAG])
check("trash row has a content hash", t["content_hash"] == m.content_hash("--- name: gone"))

# document, links, supersedes
export = {
    "entries": [entry(id="a"), entry(id="b", valid_until=3000, source="person"), entry(id="c", tags=["rolled-up"]), entry(id="bad", content="")],
    "edges": [
        {"source_id": "a", "target_id": "b", "type": "supersedes", "weight": 0.9, "created_at": 1},
        {"source_id": "a", "target_id": "b", "type": "relates_to", "weight": 0.9, "created_at": 1},
        {"source_id": "b", "target_id": "c", "type": "about_person", "weight": 1, "created_at": 7},
        {"source_id": "b", "target_id": "gone", "type": "about_person", "weight": 1, "created_at": 7},
    ],
}
doc, rep = m.build_document(export, [{"id": "t1", "preview": "p", "deleted_at": 4000}, {"id": "a", "preview": "dup", "deleted_at": 1}], {}, AT)
ids = [e["id"] for e in doc["entries"]]
check("entries and trash are all in the document", ids == ["a", "b", "c", "t1"])
check("bad entries and duplicate trash ids are reported by id", sorted(e["id"] for e in rep["errors"]) == ["a", "bad"])
check("about_person links carry over, the rest are dropped", doc["links"] == [{"source_id": "b", "target_id": "c", "link_type": "about_person", "created_at": 7}])
check("the report counts dropped edges", rep["edges_dropped"] == 3)
check("a superseded entry points at its replacement", next(e for e in doc["entries"] if e["id"] == "b")["superseded_by"] == "a")
check("report counts", (rep["live_out"], rep["trashed_out"], rep["trash_preview_only"], rep["pinned"]) == (3, 2, 1, 1))
check("document is format 2 with no devices", doc["format"] == 2 and doc["devices"] == [])

# versions
row = m.map_entry(entry(tags=["status:canonical"]), AT)
hist = [
    {"kind": "change", "seq": 2, "at": 3000, "reason": "status", "before_status": "deprecated"},
    {"kind": "change", "seq": 1, "at": 2500, "reason": "status", "before_status": None},
]  # row is canonical now, was deprecated before change 2, and had no status tag before change 1
vs, skipped = m.rebuild_versions(row, hist)
check("status changes rebuild into full versions numbered in time order", [(v["seq"], v["created_at"], v["reason"]) for v in vs] == [(1, 2500, "status"), (2, 3000, "status")] and skipped == 0)
check("each version holds the whole row as it was", json.loads(vs[1]["snapshot"])["status"] == "deprecated" and json.loads(vs[1]["snapshot"])["content"] == row["content"])
check("the version before the first change has the state before it", json.loads(vs[0]["snapshot"])["status"] == "active" and json.loads(vs[0]["snapshot"])["updated_at"] == row["created_at"] and json.loads(vs[1]["snapshot"])["updated_at"] == 2500)
vs2, skipped2 = m.rebuild_versions(row, [{"kind": "change", "seq": 2, "at": 3000, "reason": "update", "before_preview": "x"}, {"kind": "change", "seq": 1, "at": 2500, "reason": "status", "before_status": "active"}])
check("a content rewrite cannot be rebuilt and ends the rebuild", vs2 == [] and skipped2 == 2)

# reuse of an earlier history
check("an entry that only gained recalls is unchanged", m.unchanged(entry(), entry(recall_count=9)))
check("a changed tag list is a change", not m.unchanged(entry(), entry(tags=["status:deprecated"])))
check("changed content is a change", not m.unchanged(entry(), entry(content="other")))


class FakeSource:
    def __init__(self, export, trash):
        self.export, self.trash, self.calls = export, trash, []

    def call(self, method, path, body=None, tries=4):
        self.calls.append(path.split("?")[0])
        if path.startswith("/export"):
            return self.export
        if path.startswith("/trash"):
            return {"items": self.trash, "next_cursor": None}
        if path.startswith("/devices"):
            return {"devices": []}
        return {"entry": {"history": {"items": ["fresh"]}}}


prev = {"export": {"entries": [entry(id="p"), entry(id="q")]}, "histories": {"p": {"items": ["old"]}, "q": {"items": ["old"]}}}
src = FakeSource({"entries": [entry(id="p", recall_count=50), entry(id="q", tags=["status:deprecated"]), entry(id="r")], "edges": [], "projects": []}, [])
with contextlib.redirect_stdout(io.StringIO()):
    got = m.fetch_source(src, previous=prev)
check("history is reused for unchanged entries only", got["histories"] == {"p": {"items": ["old"]}, "q": {"items": ["fresh"]}, "r": {"items": ["fresh"]}})
check("only changed and new entries cost a call", src.calls.count("/entry") == 2)
check("the fetch only uses GET paths", all(c in ("/export", "/trash", "/entry", "/devices") for c in src.calls))

# the loader against a fake v2 Worker
class Fake:
    def __init__(self):
        self.pages, self.reindex = [], 0

    def call(self, method, path, body=None, tries=4):
        if path == "/import":
            self.pages.append(body)
            return {"ok": True, "imported": len(body["entries"]), "skipped": 0, "versions": len(body["versions"]), "questions": len(body["questions"]), "links": len(body["links"]), "devices": 0, "errors": []}
        if path == "/admin/reindex":
            self.reindex += 1
            return {"ok": True, "processed": 1, "remaining": 0 if self.reindex >= 3 else 5}
        raise AssertionError(path)


fake = Fake()
many = {"format": 2, "entries": [m.map_entry(entry(id="i%d" % n, content="x%d" % n), AT) for n in range(120)], "versions": [], "questions": [], "links": [{"source_id": "i0", "target_id": "i119", "link_type": "about_person", "created_at": 1}], "devices": []}
with contextlib.redirect_stdout(io.StringIO()):
    res = m.load_document(fake, many, page=50)
check("120 entries go in 3 pages", [len(p["entries"]) for p in fake.pages] == [50, 50, 20])
check("links travel only with the last page", [len(p["links"]) for p in fake.pages] == [0, 0, 1])
check("each page is sent as format 2", all(p["format"] == 2 for p in fake.pages))
check("reindex runs until nothing remains", fake.reindex == 3 and res["reindex_rounds"] == 3)
check("the result carries timings and counts", res["imported"] == 120 and "import_seconds" in res)

# a v2 export carries search questions, and the loader must send them with the page that holds their memory
fake = Fake()
with_q = dict(many, questions=[{"memory_id": "i%d" % n, "position": p, "text": "question %d %d" % (n, p), "created_at": 5} for n in (0, 60, 119) for p in (0, 1)])
with contextlib.redirect_stdout(io.StringIO()):
    res = m.load_document(fake, with_q, page=50)
check("each page carries the questions of its own memories", [len(p["questions"]) for p in fake.pages] == [2, 2, 2])
check("a question travels with its memory", all(q["memory_id"] in {e["id"] for e in p["entries"]} for p in fake.pages for q in p["questions"]))
check("the result counts the questions", res["questions"] == 6)

class FakeQ:
    def __init__(self):
        self.q, self.r = 0, 0

    def call(self, method, path, body=None, tries=4):
        if path == "/admin/questions":
            self.q += 1
            return {"ok": True, "memories": 50 if self.q < 3 else 0, "questions": 150 if self.q < 3 else 0}
        self.r += 1
        return {"ok": True, "remaining": 0 if self.r >= 2 else 9}


fq = FakeQ()
with contextlib.redirect_stdout(io.StringIO()):
    qres = m.write_questions(fq)
check("questions run until no memory is left, then reindex until done", (qres["questions"], qres["question_rounds"], qres["reindex_rounds"]) == (300, 3, 2))


class FailingQ:
    """Every model call fails, so the memories stay unmarked and every round reports them as failed."""
    def __init__(self):
        self.q = 0

    def call(self, method, path, body=None, tries=4):
        if path == "/admin/questions":
            self.q += 1
            return {"ok": True, "memories": 2, "questions": 0, "failed": 2}
        return {"ok": True, "remaining": 0}


failing = FailingQ()
with contextlib.redirect_stdout(io.StringIO()):
    fres = m.write_questions(failing)
check("a round where every call failed ends the questions loop, and the failures are counted", (fres["questions_failed"], fres["question_rounds"], failing.q) == (2, 1, 1))

# compare
a = {"entries": [m.map_entry(entry(id="x"), AT), m.map_entry(entry(id="y"), AT)], "versions": [], "links": [], "devices": []}
b = copy.deepcopy(a)
diffs, counts = compare.compare(a, b)
check("equal stores have no differences", diffs == [])
b["entries"][0]["content"] = "changed secret text"
b["entries"][1]["tags"] = ["other"]
b["entries"].append(m.map_entry(entry(id="z"), AT))
del b["entries"][0]["name"]
diffs, _ = compare.compare(a, b)
kinds = sorted({d[0] for d in diffs})
check("content, column, tags and extra ids are found", kinds == ["column differs", "content differs", "extra in B", "tags differ"])
check("a missing id is found", ("missing in B", "x", "") in compare.compare(a, {"entries": a["entries"][1:], "versions": [], "links": [], "devices": []})[0])
check("no difference line carries content", "secret" not in json.dumps(diffs))
va = {**a, "versions": [{"memory_id": "x", "seq": 1, "snapshot": '{"a":1}', "reason": "status", "created_at": 1}]}
vb = copy.deepcopy(va)
vb["versions"][0]["snapshot"] = '{"a":2}'
check("a changed version snapshot is found", ("version differs", "x", "seq 1 snapshot") in compare.compare(va, vb)[0])
check("a missing version is found", ("version missing in B", "x", "seq 1") in compare.compare(va, a)[0])
la = {**a, "links": [{"source_id": "x", "target_id": "y", "link_type": "about_person", "created_at": 1}]}
check("a missing link is found", compare.compare(la, a)[0][0][0] == "link missing in B")
check("counts by status are kept", compare.compare(a, a)[1]["A"]["status"] == {"canonical": 2})
src = {"export": {"entries": [entry(id="x"), entry(id="y", tags=["rolled-up"])], "edges": [{"source_id": "x", "target_id": "y", "type": "about_person"}]}, "trash": [{"id": "t", "preview": "p", "deleted_at": 9}]}
docv, _ = m.build_document(src["export"], src["trash"], {}, AT)
check("the v1 check passes on a faithful mapping", compare.check_v1(src, docv) == [])
broken = copy.deepcopy(docv)
broken["entries"][0]["content"] = "other"
broken["entries"][1]["deleted_at"] = None
del broken["entries"][2]
broken["links"] = []
found = sorted({d[0] for d in compare.check_v1(src, broken)})
check("the v1 check finds content, trash state, a missing trash item and a missing link", found == ["v1 about_person edge missing in B", "v1 content differs", "v1 trash item missing or not soft deleted in B", "v1 trash state differs"])
out = io.StringIO()
with contextlib.redirect_stdout(out):
    with tempfile.TemporaryDirectory() as tmp:
        pa = Path(tmp) / "a.json"
        pa.write_text(json.dumps(a))
        code_same = compare.main([str(pa), str(pa)])
check("compare.py prints PASS and exits 0 for equal stores", code_same == 0 and out.getvalue().rstrip().endswith("PASS"))

# devices are not compared: their token hashes are not copied, so a store with a device and one without is still a pass
dev_a = {"entries": [], "versions": [], "links": [], "devices": [{"id": "d1", "label": "second-machine", "token_hash": "0" * 64}]}
check("a device on one side only is not a difference", compare.compare(dev_a, {"entries": [], "versions": [], "links": [], "devices": []})[0] == [])

# the id limit is 50 bytes, the same as the Worker's import, so an id it refuses is refused here and not at import
check("a 50 byte id converts", m.map_entry(entry(id="a" * 50), AT)["id"] == "a" * 50)
for bad in ("a" * 51, "é" * 26):
    try:
        m.map_entry(entry(id=bad), AT)
        check("an id of %d bytes is refused by the converter" % len(bad.encode()), False)
    except ValueError:
        check("an id of %d bytes is refused by the converter" % len(bad.encode()), True)

# a document written by the rehearsal is private from the moment it exists
with tempfile.TemporaryDirectory() as tmp:
    target = Path(tmp) / "document.json"
    m.write_private(target, "{}")
    check("a written document is 0600", target.stat().st_mode & 0o777 == 0o600)

print("%d failures" % len(failures) if failures else "all passed")
sys.exit(1 if failures else 0)
