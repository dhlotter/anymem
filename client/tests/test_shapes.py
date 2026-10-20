#!/usr/bin/env python3
"""The reply readers in hm/shapes.py, v2 shapes and the old Worker's. `python3 client/tests/test_shapes.py`. No network."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import shapes  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


E = {"id": "a1", "name": "n"}
check("a v2 /list reply gives its entries", shapes.entries({"ok": True, "entries": [E, "junk"], "next_cursor": None}) == [E])
check("the old bare list still reads", shapes.entries([E, 3]) == [E])
check("anything else gives an empty list", shapes.entries(None) == [] and shapes.entries({"entries": "x"}) == [] and shapes.entries("x") == [])
check("entry unwraps `entry` and accepts an unwrapped one", shapes.entry({"ok": True, "entry": E}) == E and shapes.entry(E) == E and shapes.entry(None) == {})
check("results skips non dicts", shapes.results({"results": [E, 1]}) == [E] and shapes.results({}) == [])

flat = {"ok": True, "sections": [{"slot": "identity", "content": "A", "source_id": "m1"}, {"slot": "identity", "content": "B"}, {"slot": "empty", "content": "  "}], "etag": "e"}
check("a flat v2 capsule keeps sections with text, two in one slot included", [x["content"] for x in shapes.sections(flat)] == ["A", "B"])
check("an empty v2 capsule is an empty list, not None", shapes.sections({"ok": True, "sections": []}) == [])
old = {"sections": [{"slot": "identity"}], "text": json.dumps({"sections": [{"slot": "identity", "content": "A"}]})}
check("the old capsule (a JSON string in text) still reads", shapes.sections(old) == [{"slot": "identity", "content": "A"}])
check("no sections at all, or text that is not JSON, is None", shapes.sections({"ok": True}) is None and shapes.sections({"text": "nope"}) is None and shapes.sections("x") is None)
check("source_id reads the v2 and the old field", shapes.source_id({"source_id": "a"}) == "a" and shapes.source_id({"source_entry_id": "b"}) == "b" and shapes.source_id({}) == "")

check("ids_of finds the id, the match, the replaced and kept ids, results and entries, and nothing else",
      shapes.ids_of({"id": "a", "matchId": "b", "replaced": {"id": "c", "reason": "x"}, "kept_both": {"id": "d"}, "entry": {"id": "e"}, "results": [{"id": "f"}, {"id": "a"}], "entries": [{"id": "g"}], "content": "text"}) == list("abcdefg")
      and shapes.ids_of([{"id": "z"}]) == ["z"] and shapes.ids_of("x") == [])
check("subjects reads the cards of a recall reply and skips what is not a dict", shapes.subjects({"results": [], "subjects": [{"slug": "pip"}, "junk"]}) == [{"slug": "pip"}]
      and shapes.subjects({"results": []}) == [] and shapes.subjects({"subjects": "x"}) == [] and shapes.subjects(None) == [])
check("ids_of adds a subject's card id and the cards of a list", shapes.ids_of({"subject": {"id": "s1"}, "subjects": [{"id": "s2"}]}) == ["s1", "s2"])
check("name_of and description_of read the v2 field or the frontmatter", shapes.name_of({"name": "v2"}) == "v2" and shapes.name_of({"content": "---\nname: old\ndescription: \"d\"\n---\nb"}) == "old"
      and shapes.description_of({"content": "---\nname: old\ndescription: \"d\"\n---\nb"}) == "d" and shapes.name_of({}) == "")

# the fake Worker answers in the v2 shape by default, so the client tests see what the real Worker sends (#89)
import urllib.request  # noqa: E402
from hm.testing import fake_worker  # noqa: E402


def _capsule(srv):
    req = urllib.request.Request(srv.url + "/prompt-capsules/core", headers={"Authorization": "Bearer test-token"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


srv = fake_worker.start(capsule=[{"slot": "identity", "content": "rules"}])
try:
    reply = _capsule(srv)
    check("the fake Worker's capsule carries the text in the flat sections, as the v2 Worker does", reply["sections"] == [{"slot": "identity", "content": "rules", "source_id": "m-0", "updated_at": 1}])
finally:
    srv.stop()
srv = fake_worker.start(capsule=[{"slot": "identity", "content": "rules"}], legacy=True)
try:
    check("legacy=True keeps the old shape, so the fallback can still be tested", "content" not in _capsule(srv)["sections"][0] and shapes.sections(_capsule(srv))[0]["content"] == "rules")
finally:
    srv.stop()

sys.exit(1 if failures else 0)
