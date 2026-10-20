"""`person.py`: one small memory per person the user talks about (docs/profile-design.md, People).

    person.py                              list the people it knows
    person.py show alvin                   show one
    person.py set alvin relationship neighbour
    person.py set alvin email alvin.ward@example.com      (a last name is worked out and flagged, see derive)
    person.py confirm alvin last-name      a worked out fact the user has confirmed
    person.py forget alvin                 remove the memory and its link

A memory named person-<slug>, tagged `person` and `person:<slug>` plus the person's names, linked to the user's profile with the
Worker's `about_person` link. Lines are labelled, each with the day it was last confirmed. Health, money details, legal matters
and government ID numbers are refused, for everyone."""
from __future__ import annotations

import re
import sys
import time
from datetime import datetime, timedelta

from hm import api, screen, shapes
from hm.commands import profile

COMMAND = "person"
HELP = "show or change the small memory kept for a person you talk about (relationship, contact, work)"

FIELDS = {
    "relationship": ("Relationship", ["relationship"]),
    "name": ("Full name", ["name"]),
    "last-name": ("Last name", ["name"]),
    "known-as": ("Known as", ["name"]),
    "email": ("Email", ["email", "contact"]),
    "phone": ("Phone", ["phone", "telephone", "mobile", "cell", "contact"]),
    "work": ("Work", ["work", "employer", "job"]),
    "birthday": ("Birthday", ["birthday", "bday", "born", "turns"]),
    "language": ("Language", ["language"]),
    "contact-preference": ("Contact preference", ["contact"]),
    "note": ("Note", []),
}
LABELS = {v[0]: k for k, v in FIELDS.items()}
CONTACT = ("email", "phone", "contact-preference")
ACTIONS = ("list", "show", "set", "confirm", "forget")
FREE_MAIL = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me",
             "protonmail.com", "mweb.co.za", "webmail.co.za", "telkomsa.net", "vodamail.co.za", "iafrica.com"}


def register(parser):
    parser.add_argument("action", nargs="?", default="list", choices=ACTIONS)
    parser.add_argument("who", nargs="?", help="a name or part of one")
    parser.add_argument("field", nargs="?", choices=sorted(FIELDS))
    parser.add_argument("value", nargs="?")
    parser.add_argument("--derived-from", metavar="WHAT")


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", profile.norm(name).replace("ö", "o").replace("ä", "a").replace("ü", "u")).strip("-")
    return s[:40] or "person"


def head(who: str) -> str:
    return (f"---\nname: person-{slug(who)}\ndescription: What the user needs to know about {who.strip()}: relationship, work, contact. "
            f"Kept up to date by anymem.\nmetadata:\n  type: user\n---\n\n")


def parse(content: str) -> dict:
    body = re.sub(r"^---.*?---\s*", "", content or "", flags=re.S)
    out = {}
    for line in body.splitlines():
        m = re.match(r"^([A-Za-z][A-Za-z -]+):\s*(.*?)(?:\s+\(([^()]*)\))?\s*$", line)
        if m and m.group(1) in LABELS:
            out[LABELS[m.group(1)]] = {"value": m.group(2), "note": m.group(3) or ""}
    return out


def render(who: str, facts: dict) -> str:
    lines = [f"{FIELDS[k][0]}: {facts[k]['value']}" + (f" ({facts[k]['note']})" if facts[k].get("note") else "") for k in FIELDS if k in facts]
    return head(who) + "\n".join(lines) + "\n"


def words(facts: dict, slug_name: str = "") -> list:
    """Name words, lowercase, used as tags so a question that names the person ranks their memory up."""
    out = []
    for text in [slug_name.replace("-", " ")] + [facts.get(k, {}).get("value", "") for k in ("name", "last-name", "known-as")]:
        for w in re.findall(r"[a-z]{3,}", profile.norm(text)):
            if w not in out:
                out.append(w)
    return out


def tags_for(slug_name: str, facts: dict) -> list:
    tags = ["person", f"person:{slug_name}"] + words(facts, slug_name)
    for k in facts:
        for t in FIELDS[k][1]:
            if t not in tags:
                tags.append(t)
    return tags + ["status:canonical"]


def derive(facts: dict, key: str, value: str, who: str = "") -> dict:
    """Facts that follow from one the user stated, as {field: (value, what it came from)}. A short fixed list:
    1. An email local part `first.last` or `first_last` whose first part is a first name already known (the name the person is
       saved under, or a name line) gives the last name.
    2. An email at a company domain (not free mail) gives a work hint, only when there is no work line yet.
    Nothing else is worked out: not from a phone number, an address, or a tone. The caller saves these flagged as unconfirmed."""
    out = {}
    if key != "email":
        return out
    first_names = {w for w in re.findall(r"[a-z]{2,}", profile.norm(" ".join([who] + [facts.get(k, {}).get("value", "") for k in ("name", "known-as")])))}
    for addr in re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", value, re.I):
        local, domain = addr.lower().split("@", 1)
        m = re.fullmatch(r"([a-z]{2,})[._-]([a-z]{2,})", local)
        if m and m.group(1) in first_names and "last-name" not in facts and "last-name" not in out:
            out["last-name"] = (m.group(2).capitalize(), f"their email address {addr}")
        if domain not in FREE_MAIL and "work" not in facts and "work" not in out:
            out["work"] = (f"possibly at {domain}", f"the domain of {addr}")
    return out


# A person memory records what is needed to work with someone, not a verdict on their character or mood (docs/profile-design.md).
CHARACTER_RE = re.compile(r"\b(?:difficult|strict|perfectionist|moody|lazy|annoying|stubborn|rude|stressed|angry|grumpy|nasty|arrogant|"
                          r"unreliable|incompetent|toxic|manipulative|dishonest|nice|kind|lovely|pushy|demanding|emotional|jealous|selfish)\b", re.I)


def change(who: str, facts: dict, key: str, value: str, derived_from: str | None = None, now: float | None = None) -> dict:
    value = " ".join(str(value).split())
    if not value:
        raise ValueError("the value is empty")
    if screen.blocked(f"{FIELDS[key][0]} {value}"):
        raise ValueError("that touches a topic anymem never records (health, money details, legal matters, government ID numbers)")
    if CHARACTER_RE.search(value):
        raise ValueError("a description of someone's character or mood is not kept, only what is needed to work with them")
    note = f"derived from {' '.join(derived_from.split())}, unconfirmed" if derived_from else f"confirmed {profile.today(now)}"
    out = {k: dict(v) for k, v in facts.items()}
    out[key] = {"value": value, "note": note}
    if not derived_from:
        for dk, (dv, why) in derive(out, key, value, who).items():
            out[dk] = {"value": dv, "note": f"derived from {why}, unconfirmed"}
    return out


MESSAGE_ASK = re.compile(r"\b(?:send|write|wish|message|whatsapp|text|email)\s+(?:to\s+)?(?:him|her|them)\b|\bsend\s+(?:a|an|the)\s+(?:message|whatsapp|email|text|note)\b", re.I)
RELATIVE_DAYS = {"today": 0, "tomorrow": 1, "yesterday": -1}


def asked_to_message(said: str, transcript: str) -> bool:
    """True when the user turn that holds `said` is a request to send, write or wish someone something."""
    want = profile.norm(said)
    turns = (m.group(1) for m in re.finditer(r"(?:^|\n\n)USER: (.*?)(?=\n\n(?:USER|ASSISTANT): |\Z)", transcript or "", re.S))
    return bool(want) and any(want in profile.norm(t) and MESSAGE_ASK.search(t) for t in turns)


def resolve_day(value: str, now: float | None = None) -> str:
    """A birthday said as today, tomorrow or yesterday becomes the day and month it was on when it was said ("11 October").
    Anything else is kept as the person said it. The year is only ever kept when the user gave it."""
    delta = RELATIVE_DAYS.get(profile.norm(value))
    if delta is None:
        return value
    d = datetime.fromtimestamp(now if now is not None else time.time()) + timedelta(days=delta)
    return f"{d.day} {d.strftime('%B')}"


def rows_all() -> list:
    rows = api.list_all({"tag": "person", "n": 100})
    return [r for r in rows if "person" in (r.get("tags") or [])
            and re.search(r"^name:\s*person-", str(r.get("content", "")), re.M)]


def slug_of(row: dict) -> str:
    m = re.search(r"^name:\s*person-(\S+)", str(row.get("content", "")), re.M)
    return m.group(1) if m else ""


def display(row: dict) -> str:
    f = parse(row.get("content", ""))
    return f.get("name", {}).get("value") or f.get("known-as", {}).get("value") or slug_of(row).replace("-", " ").title()


def match(who: str, rows: list) -> list:
    """The people whose memory this name refers to: an exact slug, else everyone who has the name as a whole word."""
    want = slug(who)
    exact = [r for r in rows if slug_of(r) == want]
    if exact:
        return exact
    ws = set(re.findall(r"[a-z]{2,}", profile.norm(who)))
    if not ws:
        return []
    return [r for r in rows if ws <= set(words(parse(r["content"]), slug_of(r)))]


def save(who: str, row: dict | None, facts: dict) -> str:
    s = slug_of(row) if row else slug(who)
    content, tags = render(who, facts), tags_for(s, facts)
    if row:
        api.request("POST", "/update", {"id": row["id"], "content": content, "tags": tags}, timeout=60)
        return str(row["id"])
    res = api.request("POST", "/capture", {"content": content, "source": "person", "tags": tags}, timeout=60)
    pid = str(res.get("id", ""))
    try:  # the link from this person to the user's profile; a failure here never loses the memory
        prow, _ = profile.load()
        if prow and pid:
            api.request("POST", "/link", {"source_id": pid, "target_id": prow["id"], "type": "about_person"}, timeout=30)
    except Exception:
        pass
    return pid


COMMON = {"will", "may", "mark", "bill", "grace", "rose", "hope", "faith", "joy", "art", "ray", "august", "june", "april", "van", "der", "den", "the"}
CONTACT_ASK = re.compile(r"\b(?:e-?mail|phone|number|call|contact|reach|whatsapp)\b", re.I)


def mentioned(prompt: str, rows: list, limit: int = 3) -> list:
    """The saved people a prompt names, by a whole name word. A word that is also an ordinary English word is ignored."""
    low = " " + " ".join(re.findall(r"[a-z]+", profile.norm(prompt))) + " "
    out = []
    for r in rows:
        ws = [w for w in words(parse(r.get("content", "")), slug_of(r)) if w not in COMMON]
        if any(f" {w} " in low for w in ws):
            out.append(r)
    return out[:limit]


def lines_for(prompt: str, rows: list) -> list:
    """What to tell the model about the people the prompt names: who they are to the user and the lasting facts. Email, phone
    and contact preference only when the prompt asks about reaching them, so they are never added to a prompt that did not."""
    asks = bool(CONTACT_ASK.search(prompt or ""))
    out = []
    for r in mentioned(prompt, rows):
        facts = parse(r["content"])
        bits = []
        for k, f in facts.items():
            if k in CONTACT and not asks:
                continue
            bits.append(f"{FIELDS[k][0].lower()} {f['value']}" + (" (unconfirmed)" if "unconfirmed" in f.get("note", "") else ""))
        out.append(f"{display(r)}: " + "; ".join(bits))
    return out


def apply_stated(items: list, transcript: str, now: float | None = None) -> list:
    """Facts capture found the user stating about other people. A person is created when the user gives who they are to them.
    A fact not on the memory yet is added. A different value for a fact that has one is left alone, and logged: changing it is
    an explicit `person set`. A name that fits more than one person is skipped, not guessed. Returns one log line per item."""
    out, rows = [], rows_all()
    for it in items:
        who, key, value = " ".join(str(it.get("name", "")).split()), str(it.get("field", "")).strip(), " ".join(str(it.get("value", "")).split())
        if not who or key not in FIELDS:
            out.append(f"{who or '?'}: unknown field")
            continue
        if key == "birthday" and profile.norm(value) not in profile.norm(it.get("said")):
            # The model may have turned "today" into a date itself. The date is worked out here, from the user's own word.
            rel = re.search(r"\b(today|tomorrow|yesterday)\b", str(it.get("said", "")), re.I)
            if rel:
                value = rel.group(1).lower()
                it = {**it, "value": value}
        if not profile.stated(it, transcript):
            out.append(f"{who}: {key} not said by the person, ignored")
            continue
        hit = match(who, rows)
        if len(hit) > 1:
            out.append(f"{who}: {len(hit)} people fit this name, skipped")
            continue
        row = hit[0] if hit else None
        facts = parse(row["content"]) if row else {}
        if key == "birthday":
            value = resolve_day(value, now)
        if row is None and not (key == "relationship" or "relationship" in {str(i.get("field")) for i in items if profile.norm(i.get("name")) == profile.norm(who)}):
            # Asking the assistant to send them a message is enough to know they are someone the user is in touch with. Flagged
            # unconfirmed, like every derived fact, and the one inference made here.
            if asked_to_message(str(it.get("said", "")), transcript):
                try:
                    row = {"id": save(who, None, change(who, {}, "relationship", "contact", derived_from="the user asking for a message to them", now=now)), "tags": ["person"]}
                except ValueError as e:
                    out.append(f"{who}: refused ({e})"[:90])
                    continue
                rows = rows_all()
                row = match(who, rows)[0] if match(who, rows) else None
                facts = parse(row["content"]) if row else {}
            else:
                out.append(f"{who}: no relationship given yet, not created")
                continue
        if key in facts and profile.norm(facts[key]["value"]) == profile.norm(value):
            out.append(f"{who}: {key} already known")
            continue
        if key in facts:
            out.append(f"{who}: {key} differs from what is saved, left alone")
            continue
        try:
            new = change(row and display(row) or who, facts, key, value, now=now)
        except ValueError as e:
            out.append(f"{who}: refused ({e})"[:90])
            continue
        pid = save(who, row, new)
        row = row or {"id": pid, "content": render(who, new), "tags": ["person"]}
        rows = [r for r in rows if r["id"] != row["id"]] + [{**row, "content": render(display(row) if row.get("id") else who, new)}]
        out.append(f"{who}: {key} added")
    return out


def run(ns):
    try:
        rows = rows_all()
        if ns.action == "list":
            if not rows:
                print("no people saved yet")
            for r in rows:
                f = parse(r["content"])
                print(f"{display(r)}: {f.get('relationship', {}).get('value', 'relationship not known')}")
            return 0
        if not ns.who:
            print(f"anymem: person {ns.action} needs a name", file=sys.stderr)
            return 2
        hit = match(ns.who, rows)
        if len(hit) > 1:
            print("anymem: more than one person fits, say which: " + ", ".join(display(r) for r in hit), file=sys.stderr)
            return 1
        row = hit[0] if hit else None
        facts = parse(row["content"]) if row else {}
        if ns.action == "show":
            if not row:
                print(f"nobody called {ns.who} is saved", file=sys.stderr)
                return 1
            for k, f in facts.items():
                print(f"{FIELDS[k][0]}: {f['value']}" + (f" ({f['note']})" if f["note"] else ""))
            return 0
        if ns.action == "forget":
            if not row:
                print(f"nobody called {ns.who} is saved", file=sys.stderr)
                return 1
            api.request("POST", "/forget", {"id": row["id"]}, timeout=60)
            print(f"{display(row)} moved to the trash for 14 days, with the link to your profile")
            return 0
        if not ns.field:
            print(f"anymem: person {ns.action} needs a field ({', '.join(sorted(FIELDS))})", file=sys.stderr)
            return 2
        if ns.action == "confirm":
            if ns.field not in facts:
                print(f"no {FIELDS[ns.field][0].lower()} saved for {ns.who}", file=sys.stderr)
                return 1
            facts[ns.field]["note"] = f"confirmed {profile.today()}"
            pid = save(display(row), row, facts)
        else:  # set
            if ns.value is None:
                print("anymem: person set needs a value", file=sys.stderr)
                return 2
            if row is None and ns.field != "relationship":
                print(f"anymem: {ns.who} is not saved yet. Set the relationship first: person.py set {ns.who} relationship \"neighbour\"", file=sys.stderr)
                return 1
            who = display(row) if row else ns.who
            pid = save(who, row, change(who, facts, ns.field, ns.value, getattr(ns, "derived_from", None)))
        print(f"updated {ns.who} ({FIELDS[ns.field][0].lower()}), memory {pid[:8]}")
        return 0
    except ValueError as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 2
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 1
