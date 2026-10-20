#!/usr/bin/env python3
"""Runnable check for the person script: parsing, derivation, matching, stated facts, links. No network."""
from __future__ import annotations

import io
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import api  # noqa: E402
from hm.commands import person as pe, profile as pf  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


NOW = 1_790_000_000
f = pe.change("Alvin", {}, "relationship", "neighbour", now=NOW)
f = pe.change("Alvin", f, "known-as", "Alvin", now=NOW)
text = pe.render("Alvin", f)
check("the memory is named person-<slug> and parses back", "name: person-alvin" in text and pe.parse(text) == f)
f2 = pe.change("Alvin", f, "email", "alvin.ward@example.com", now=NOW)
check("a last name is worked out from first.last and flagged unconfirmed", f2["last-name"]["value"] == "Ward" and "unconfirmed" in f2["last-name"]["note"] and "derived from" in f2["last-name"]["note"])
check("a company domain gives only a flagged work hint", f2["work"]["value"] == "possibly at example.com" and "unconfirmed" in f2["work"]["note"])
check("a stated fact is not flagged", "unconfirmed" not in f2["email"]["note"] and "confirmed 20" in f2["email"]["note"])
check("free mail gives no work hint", "work" not in pe.change("Alvin", f, "email", "alvin.ward@gmail.com", now=NOW))
check("an address like awd@ or alvin.w@ or info@ gives nothing", all("last-name" not in pe.change("Alvin", f, "email", e, now=NOW) for e in ("awd@x.com", "alvin.w@x.com", "info@x.com")))
check("a first part that is not the known first name gives nothing", "last-name" not in pe.change("Alvin", f, "email", "john.smith@x.com", now=NOW))
check("an existing last name is not overwritten by a derivation", pe.change("Alvin", pe.change("Alvin", f, "last-name", "Wardle", now=NOW), "email", "alvin.ward@x.com", now=NOW)["last-name"]["value"] == "Wardle")
c = dict(f2); c["last-name"] = dict(c["last-name"]); c["last-name"]["note"] = "confirmed 2026-10-10"
check("confirming drops the flag", "unconfirmed" not in pe.render("Alvin", c).split("Last name:")[1].splitlines()[0])
for field, value in (("note", "he has cancer"), ("note", "owes me R5000 salary"), ("phone", "ID number 8001015009087"), ("note", "in a court case")):
    try:
        pe.change("Alvin", {}, field, value)
        check("a blocked topic about a person is refused: " + value[:22], False)
    except ValueError:
        check("a blocked topic about a person is refused: " + value[:22], True)
check("the tags carry the name words so naming him ranks his memory up", {"person", "person:alvin", "alvin", "ward"} <= set(pe.tags_for("alvin", f2)))
rows = [{"id": "r1", "tags": ["person"], "content": pe.render("Alvin Ward", pe.change("Alvin Ward", {}, "name", "Alvin Ward", now=NOW))},
        {"id": "r2", "tags": ["person"], "content": pe.render("Alvin Smith", pe.change("Alvin Smith", {}, "name", "Alvin Smith", now=NOW))}]
check("a first name that fits two people is ambiguous", len(pe.match("Alvin", rows)) == 2)
check("a full name picks one", [r["id"] for r in pe.match("Alvin Smith", rows)] == ["r2"])

TR = "USER: my neighbour Alvin is on 082 111 2222 and his email is alvin.ward@example.com. Also Sam from work is my manager.\n\nASSISTANT: ok"
calls = []
store = {"people": [], "profile": {"id": "prof1", "tags": ["profile"], "content": "---\nname: profile\n---\n"}}
def fake(method, path, body=None, timeout=30, settings=None):
    calls.append((method, path, body))
    if path.startswith("/list?tag=person"):
        return store["people"]
    if path.startswith("/list?tag=profile"):
        return [store["profile"]]
    if path == "/capture":
        row = {"id": "pid%d" % (len(store["people"]) + 1), "tags": body["tags"], "content": body["content"]}
        store["people"].append(row)
        return {"ok": True, "id": row["id"]}
    if path == "/update":
        for r in store["people"]:
            if r["id"] == body["id"]:
                r["content"], r["tags"] = body["content"], body["tags"]
        return {"ok": True}
    return {"ok": True}
api.request = fake
res = pe.apply_stated([
    {"name": "Alvin", "field": "relationship", "value": "neighbour", "said": "my neighbour Alvin"},
    {"name": "Alvin", "field": "phone", "value": "082 111 2222", "said": "Alvin is on 082 111 2222"},
    {"name": "Alvin", "field": "email", "value": "alvin.ward@example.com", "said": "his email is alvin.ward@example.com"},
    {"name": "Sam", "field": "work", "value": "from work", "said": "Sam from work is my manager"},
    {"name": "Alvin", "field": "note", "value": "invented", "said": "Alvin likes jazz"}], TR)
check("a person is created when the user says who they are, then facts are added", res[0] == "Alvin: relationship added" and res[1] == "Alvin: phone added" and res[2] == "Alvin: email added")
check("a person with no relationship given is not created", res[3] == "Sam: no relationship given yet, not created")
check("words the person never said are ignored", "not said" in res[4])
check("the new person is linked to the profile with about_person", any(c[1] == "/link" and c[2]["type"] == "about_person" and c[2]["target_id"] == "prof1" for c in calls))
check("the derived last name is on the memory, flagged", "Last name: Ward (derived from" in store["people"][0]["content"] and "unconfirmed" in store["people"][0]["content"])
res = pe.apply_stated([{"name": "Alvin", "field": "phone", "value": "082 999 9999", "said": "Alvin is on 082 999 9999"}], TR.replace("082 111 2222", "082 999 9999"))
check("a different value for a known fact is left alone", res == ["Alvin: phone differs from what is saved, left alone"])

def go(**kw):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = pe.run(SimpleNamespace(**{"derived_from": None, "value": None, "field": None, "who": None, **kw}))
    return rc, out.getvalue(), err.getvalue()
rc, out, _ = go(action="list")
check("list shows the person and the relationship", rc == 0 and "neighbour" in out)
rc, out, _ = go(action="forget", who="alvin")
check("forget trashes the memory", rc == 0 and calls[-1][1] == "/forget")

# naming a saved person in a prompt
people = [{"id": "r1", "tags": ["person"], "content": pe.render("Alvin", pe.change("Alvin", pe.change("Alvin", pe.change("Alvin", {}, "relationship", "neighbour", now=NOW), "email", "alvin.ward@example.com", now=NOW), "language", "English", now=NOW))}]
check("a prompt that names him gets who he is, without his email", pe.lines_for("draft a message to Alvin about the fence", people)[0].startswith("Alvin: relationship neighbour") and "email" not in pe.lines_for("draft a message to Alvin about the fence", people)[0])
check("a prompt about reaching him also gets the email", "alvin.ward@example.com" in pe.lines_for("what is alvin's email", people)[0])
check("a derived last name shows as unconfirmed", "last name Ward (unconfirmed)" in pe.lines_for("tell me about alvin", people)[0])
check("a prompt that does not name him gets nothing", pe.lines_for("what is the weather", people) == [])
check("a word that is an ordinary English word does not match", pe.lines_for("I will do it", [{"id": "w", "tags": ["person"], "content": pe.render("Will", pe.change("Will", {}, "relationship", "friend", now=NOW))}]) == [])
for value in ("strict about deadlines, a perfectionist", "can be difficult", "always moody on Mondays"):
    try:
        pe.change("Maria", {}, "note", value)
        check("a verdict on character is refused: " + value[:24], False)
    except ValueError:
        check("a verdict on character is refused: " + value[:24], True)
check("a practical note is kept", pe.change("Maria", {}, "note", "prefers WhatsApp, answers within the hour", now=NOW)["note"]["value"] == "prefers WhatsApp, answers within the hour")
print("ok" if not failures else f"{len(failures)} failed")
# birthdays and a person known only from a request to message them (the Zuck case, 2026-10-11)
import datetime as _dt
check("a birthday said as today becomes the day and month it was said", pe.resolve_day("today", _dt.datetime(2026, 10, 11, 14, 0).timestamp()) == "11 October"
      and pe.resolve_day("tomorrow", _dt.datetime(2026, 10, 31, 9, 0).timestamp()) == "1 November" and pe.resolve_day("11 October 1980") == "11 October 1980")
store["people"].clear()
calls.clear()
ZT = "USER: its zucks bday today can you send him a message to wish him\n\nASSISTANT: done"
SAID = "its zucks bday today can you send him a message to wish him"
res = pe.apply_stated([{"name": "Zuck", "field": "birthday", "value": "today", "said": "its zucks bday today"}], ZT, _dt.datetime(2026, 10, 11, 14, 0).timestamp())
mem = pe.parse(store["people"][0]["content"]) if store["people"] else {}
check("asking for a message to someone makes them a flagged contact and keeps the birthday", len(store["people"]) == 1
      and mem.get("relationship", {}).get("value") == "contact" and "unconfirmed" in mem["relationship"]["note"] and mem.get("birthday", {}).get("value") == "11 October")
store["people"].clear()
res = pe.apply_stated([{"name": "Zuck", "field": "birthday", "value": "11 October", "said": "its zucks bday today"}], ZT, _dt.datetime(2026, 10, 11, 14, 0).timestamp())
check("a date the model worked out itself is redone from the user's own word", len(store["people"]) == 1 and pe.parse(store["people"][0]["content"]).get("birthday", {}).get("value") == "11 October")
store["people"].clear()
res = pe.apply_stated([{"name": "Zuck", "field": "birthday", "value": "11 October", "said": "his birthday is 11 October"}], "USER: his birthday is 11 October")
check("a birthday with no relationship and no message request still does not create a person", store["people"] == [] and "no relationship" in res[0])

# person set on a name that is not saved yet: the relationship comes first, a field alone is refused
store["people"] = []
del calls[:]
rc, out, err = go(action="set", who="Sam", field="email", value="sam@example.com")
check("a field set on a person who is not saved yet is refused, and says to set the relationship first",
      rc == 1 and "relationship first" in err and out == "" and not any(c[1] == "/capture" for c in calls) and store["people"] == [])
rc, out, err = go(action="set", who="Sam", field="relationship", value="colleague")
check("setting the relationship first creates the person", rc == 0 and len(store["people"]) == 1)
rc, out, err = go(action="set", who="Sam", field="email", value="sam@example.com")
check("a field can be set once the person has a relationship", rc == 0 and "email" in pe.parse(store["people"][0]["content"]))

# a person memory past the first page of tag=person is still found (#103)
def _page_fn(first, second, cursor_name="page2"):
    def fn(method, path, body=None, timeout=30, settings=None):
        if "cursor=" + cursor_name in path:
            return {"ok": True, "entries": second, "next_cursor": None}
        return {"ok": True, "entries": first, "next_cursor": cursor_name}
    return fn


api.request = _page_fn([{"id": "pe-other", "tags": ["person"], "content": "---\nname: person-someone-else\n---\nbody"}],
                       [{"id": "pe-real", "tags": ["person"], "content": "---\nname: person-sam\n---\nname: Sam"}])
check("a person past the first page of /list is still listed", [r["id"] for r in pe.rows_all()] == ["pe-other", "pe-real"])

sys.exit(1 if failures else 0)
