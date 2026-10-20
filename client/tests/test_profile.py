#!/usr/bin/env python3
"""Runnable check for the profile script: parsing, changing, tags and the topic screen. No network."""
from __future__ import annotations

import io
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api  # noqa: E402
from hm.commands import profile as pf  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


NOW = 1_790_000_000
f = pf.change({}, "name", "Sam Example", now=NOW)
f = pf.change(f, "address", "1 Test Street, Town", now=NOW)
text = pf.render(f)
check("the memory is named profile and typed user", "name: profile" in text and "type: user" in text)
check("each line carries the day it was confirmed", "Home address: 1 Test Street, Town (confirmed 2026-09-2" in text or "(confirmed 20" in text)
check("render then parse gives the same facts back", pf.parse(text) == f)
moved = pf.change(f, "address", "9 New Road, City", now=NOW + 86400)
check("changing a fact replaces the line, it does not add a second one", text.count("Home address") == 1 and pf.render(moved).count("Home address") == 1 and "9 New Road" in pf.render(moved) and "1 Test Street" not in pf.render(moved))
check("the tags carry the words people ask with", {"profile", "name", "address", "home"} <= set(pf.tags_for(f)) and "phone" not in pf.tags_for(f))
d = pf.change(f, "last-name", "Example", derived_from="his email address", now=NOW)
check("a worked out fact says where it came from and that it is unconfirmed", "derived from his email address, unconfirmed" in pf.render(d))
c = pf.confirm(d, "last-name", now=NOW)
check("confirming turns the flag into a confirmed date", "unconfirmed" not in pf.render(c) and "confirmed 20" in pf.parse(pf.render(c))["last-name"]["note"])
for field, value in (("name", "Sam, diagnosed with cancer"), ("phone", "my ID number 8001015009087"), ("work", "salary 90k"), ("address", "court case address")):
    try:
        pf.change({}, field, value)
        check("a blocked topic is refused: " + value[:24], False)
    except ValueError:
        check("a blocked topic is refused: " + value[:24], True)
try:
    pf.change({}, "name", "   ")
    check("an empty value is refused", False)
except ValueError:
    check("an empty value is refused", True)
rows = [{"id": "p1", "tags": ["person:sam", "profile"], "content": "---\nname: person-sam\n---\nx"}, {"id": "p2", "tags": ["profile", "name"], "content": text}]
check("find picks the memory named profile, not a person", pf.find(rows)["id"] == "p2")

# run(): first save creates the memory as canonical, the second updates the same one in place
calls = []
store = {"row": None}
def fake(method, path, body=None, timeout=30, settings=None):
    calls.append((method, path, body))
    if path.startswith("/list"):
        return {"ok": True, "entries": [store["row"]] if store["row"] else [], "next_cursor": None}
    if path == "/capture":
        store["row"] = {"id": "abc12345-0", "tags": body["tags"], "content": body["content"]}
        return {"ok": True, "id": "abc12345-0", **({"kept_both": {"id": "old1", "reason": "pinned"}} if store.get("conflict") else {})}
    if path == "/update":
        store["row"] = {"id": body["id"], "tags": body["tags"], "content": body["content"]}
        return {"ok": True}
    return {"ok": True}
api.request = fake
def go(**kw):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = pf.run(SimpleNamespace(**{"derived_from": None, "value": None, "field": None, **kw}))
    return rc, out.getvalue(), err.getvalue()
rc, out, _ = go(action="set", field="address", value="1 Test Street")
check("the first set creates the memory as canonical", rc == 0 and calls[-1][1] == "/capture" and "status:canonical" in calls[-1][2]["tags"])
store["row"] = {"id": "abc12345-0", "tags": ["profile"], "content": pf.render(pf.change({}, "address", "1 Test Street"))}
rc, out, _ = go(action="set", field="address", value="9 New Road")
check("a second set updates the same memory in place", rc == 0 and calls[-1][1] == "/update" and calls[-1][2]["id"] == "abc12345-0" and "9 New Road" in calls[-1][2]["content"] and "1 Test Street" not in calls[-1][2]["content"])
check("update keeps the canonical status tag", "status:canonical" in calls[-1][2]["tags"])
check("update always sends the canonical status tag", "status:canonical" in calls[-1][2]["tags"] and "status:draft" not in calls[-1][2]["tags"] and "status:pending" not in calls[-1][2]["tags"])
store["row"] = None; store["conflict"] = True; calls.clear()
rc, out, _ = go(action="set", field="name", value="Sam Example")
check("a capture the Worker answers with kept_both is not promoted again, the save is the last call", rc == 0 and calls[-1][1] == "/capture" and not any(c[1] == "/status" for c in calls))
store["conflict"] = False
go(action="set", field="address", value="9 New Road")
rc, out, _ = go(action="get", field="address")
check("get prints just the value", rc == 0 and out.strip() == "9 New Road")
rc, _, err = go(action="set", field="name", value="Sam has cancer")
check("a blocked fact exits 2 and says why", rc == 2 and "never records" in err)
rc, out, _ = go(action="unset", field="name")
rc, out, _ = go(action="unset", field="address")
check("removing the last fact trashes the memory", rc == 0 and calls[-1][1] == "/forget")
facts = pf.change(pf.change(pf.change({}, "address", "1 Test Street", now=NOW), "phone", "+1 555 0100", now=NOW), "work", "Tester at Example", now=NOW)
check("a question about my address asks for the address only", pf.wanted("what is my street address") == ["address", "postal-address"] and pf.lookup("what is my street address", facts) == ["Home address: 1 Test Street"])
check("a question about my phone returns only the phone", pf.lookup("what is my phone number", facts) == ["Phone: +1 555 0100"])
check("who do I work for finds the work line", pf.lookup("who do I work for", facts) == ["Work: Tester at Example"])
check("a question that is not about me asks for nothing", pf.wanted("what is the address of the Eiffel tower") == [] and pf.wanted("explain this function") == [])
check("an address that is not mine asks for nothing", pf.wanted("what is the address of my server") == [] and pf.wanted("send the email to the address on file") == [])
check("a first person prompt about something else asks for nothing", pf.wanted("can you fix my build") == [])
check("a derived fact is returned with its unconfirmed flag", pf.lookup("what is my last name", pf.change({}, "last-name", "Ward", derived_from="his email", now=NOW)) == ["Last name: Ward (derived from his email, unconfirmed)"])

# stated by the person, added or proposed
TR = "USER: hi, I just moved. My new address is 9 New Road, Town. Also call me Sam.\n\nASSISTANT: Congratulations. Your old address was 1 Test Street.\n\nUSER: thanks"
check("user_text keeps only the person's turns", "9 New Road" in pf.user_text(TR) and "Congratulations" not in pf.user_text(TR))
check("a statement the person made is accepted", pf.stated({"field": "address", "value": "9 New Road, Town", "said": "My new address is 9 New Road, Town."}, TR))
check("something only the assistant said is not accepted", not pf.stated({"field": "address", "value": "1 Test Street", "said": "Your old address was 1 Test Street."}, TR))
check("a value that is not inside the quoted words is not accepted", not pf.stated({"field": "address", "value": "5 Other Road", "said": "My new address is 9 New Road, Town."}, TR))
check("words that are not in any turn are not accepted", not pf.stated({"field": "address", "value": "7 Made Up Lane", "said": "I live at 7 Made Up Lane"}, TR))
calls.clear(); store["row"] = None; store["conflict"] = False; store["pending"] = []
_base = api.request
def fake2(method, path, body=None, timeout=30, settings=None):
    if path.startswith("/list?tag=profile-proposal"):
        return store["pending"]
    if path == "/capture" and "profile-proposal" in body["tags"]:
        calls.append((method, path, body)); store["pending"].append({"id": "pp1", "tags": body["tags"], "content": body["content"]}); return {"ok": True, "id": "pp1"}
    return _base(method, path, body, timeout, settings)
api.request = fake2
go(action="set", field="address", value="1 Test Street")
res = pf.apply_stated([{"field": "address", "value": "9 New Road, Town", "said": "My new address is 9 New Road, Town."}, {"field": "preferred-name", "value": "Sam", "said": "call me Sam"},
                       {"field": "phone", "value": "+1 555 0000", "said": "my phone is +1 555 0000"}, {"field": "name", "value": "Sam has cancer", "said": "call me Sam"}], TR)
check("a different value for an existing fact becomes a pending change, not an edit", res[0] == "address: change proposed" and "9 New Road" not in store["row"]["content"])
check("a pending change is saved as status pending so recall never injects it", any(c[2]["tags"][:2] == ["profile-proposal", "status:pending"] and "field:address" in c[2]["tags"] for c in calls if c[2]))
check("a fact the person stated for the first time is added", res[1] == "preferred-name: added" and "Preferred name: Sam" in store["row"]["content"])
check("a fact the person did not say is ignored", "not said by the person" in res[2])
check("a blocked fact is not saved", "name" in res[3] and "added" not in res[3] and "Sam has cancer" not in store["row"]["content"])
check("accepting applies the pending value and clears it", go(action="accept", field="address")[0] == 0 and "9 New Road, Town" in store["row"]["content"] and calls[-1][1] == "/forget")
check("the pending list is read by field", pf.pending_field({"content": "---\nname: profile-proposal-phone\n---\nProposed Phone: +1\n"}) == "phone" and pf.pending_value({"content": "---\nname: profile-proposal-phone\n---\nProposed Phone: +1 555\nCurrent Phone: x\n"}) == "+1 555")
# a profile memory past the first page of tag=profile is still found (#103)
def paged(first, second, cursor_name="page2"):
    """A /list that answers two pages: `first` with a next_cursor, then `second` for that cursor."""
    def fn(method, path, body=None, timeout=30, settings=None):
        if not path.startswith("/list"):
            raise AssertionError(path)
        if "cursor=" + cursor_name in path:
            return {"ok": True, "entries": second, "next_cursor": None}
        return {"ok": True, "entries": first, "next_cursor": cursor_name}
    return fn


OTHER_ROW = {"id": "pf-other", "tags": ["profile"], "content": "---\nname: not-the-profile\n---\nbody"}
PAGE_ROW = {"id": "pf-real", "tags": ["profile", "status:canonical"], "content": "---\nname: profile\n---\naddress: 1 Test Street\n"}
api.request = paged([OTHER_ROW], [PAGE_ROW])
row, facts = pf.load()
check("the profile memory is found on the second page of /list", row is not None and row["id"] == "pf-real")
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
