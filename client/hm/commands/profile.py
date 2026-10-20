"""`profile.py`: the one memory that holds facts specific to the person (docs/profile-design.md).

    profile.py                         show it
    profile.py get address             print one value
    profile.py set address "..."       add or change a fact, in place (the old value stays in the memory's history)
    profile.py set last-name Ward --derived-from "his email address"
    profile.py confirm last-name       a derived fact that the person has confirmed
    profile.py unset phone             remove a fact

One memory tagged `profile`, a few labelled lines, each with the date it was last confirmed. Its tags carry the words people
ask with (address, phone, name, email), which the Worker's recall already uses to rank a memory first. A fact that touches a
blocked topic (health, money details, legal matters, government ID numbers) is refused."""
from __future__ import annotations

import re
import sys
import time

from hm import api, screen, shapes

COMMAND = "profile"
HELP = "show or change the memory that holds facts about you (name, contact, address, work)"

# key: (label in the memory, the extra tags it adds so a question with these words finds the profile first)
FIELDS = {
    "name": ("Full name", ["name"]),
    "preferred-name": ("Preferred name", ["name"]),
    "email": ("Email", ["email", "contact"]),
    "phone": ("Phone", ["phone", "telephone", "mobile", "cell", "contact"]),
    "address": ("Home address", ["address", "home"]),
    "postal-address": ("Postal address", ["address", "postal"]),
    "work": ("Work", ["work", "employer", "job"]),
    "work-address": ("Work address", ["address", "work"]),
    "language": ("Language", ["language"]),
    "timezone": ("Timezone", ["timezone"]),
    "units": ("Units", ["units"]),
    "last-name": ("Last name", ["name"]),
}
LABELS = {v[0]: k for k, v in FIELDS.items()}
ACTIONS = ("show", "get", "set", "confirm", "unset", "pending", "accept", "dismiss")
PENDING_TAG = "profile-proposal"
HEAD = ("---\nname: profile\ndescription: The user's own details: my full name, my phone number, my email address, my home street address, "
        "where I live, who I work for, my timezone and units. Kept up to date by anymem.\nmetadata:\n  type: user\n---\n\n")


def register(parser):
    parser.add_argument("action", nargs="?", default="show", choices=ACTIONS)
    parser.add_argument("field", nargs="?", choices=sorted(FIELDS))
    parser.add_argument("value", nargs="?")
    parser.add_argument("--derived-from", metavar="WHAT", help="mark the value as worked out from something the person said, not stated")


def today(now: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))


def parse(content: str) -> dict:
    """{field key: {"value", "note"}} from a profile memory's body, in file order."""
    body = re.sub(r"^---.*?---\s*", "", content or "", flags=re.S)
    out = {}
    for line in body.splitlines():
        m = re.match(r"^([A-Za-z][A-Za-z ]+):\s*(.*?)(?:\s+\(([^()]*)\))?\s*$", line)
        if m and m.group(1) in LABELS:
            out[LABELS[m.group(1)]] = {"value": m.group(2), "note": m.group(3) or ""}
    return out


def render(facts: dict) -> str:
    lines = []
    for key in FIELDS:
        if key in facts:
            f = facts[key]
            lines.append(f"{FIELDS[key][0]}: {f['value']}" + (f" ({f['note']})" if f.get("note") else ""))
    return HEAD + "\n".join(lines) + "\n"


def tags_for(facts: dict) -> list:
    tags = ["profile"]
    for key in facts:
        for t in FIELDS[key][1]:
            if t not in tags:
                tags.append(t)
    return tags


def change(facts: dict, key: str, value: str, derived_from: str | None = None, now: float | None = None) -> dict:
    """The facts with `key` set. A stated value is `confirmed <date>`, a worked out one says what it came from and that it is
    unconfirmed. Raises ValueError for a value that touches a blocked topic or is empty."""
    value = " ".join(str(value).split())
    if not value:
        raise ValueError("the value is empty")
    if screen.blocked(f"{FIELDS[key][0]} {value}"):
        raise ValueError("that touches a topic anymem never records (health, money details, legal matters, government ID numbers)")
    note = f"derived from {' '.join(derived_from.split())}, unconfirmed" if derived_from else f"confirmed {today(now)}"
    out = {k: dict(v) for k, v in facts.items()}
    out[key] = {"value": value, "note": note}
    return out


def confirm(facts: dict, key: str, now: float | None = None) -> dict:
    if key not in facts:
        raise ValueError(f"there is no {FIELDS[key][0].lower()} in the profile")
    out = {k: dict(v) for k, v in facts.items()}
    out[key]["note"] = f"confirmed {today(now)}"
    return out


# What a first person question has to contain for the hook to look the fact up in the profile directly. Only the lines asked
# about are returned, so a phone number or an address is never added to a prompt that did not ask for it.
INTENTS = (
    (re.compile(r"\bmy\s+(?:\w+\s+){0,2}address\b|\bwhere\s+(?:do\s+)?i\s+live\b|\bmy\s+(?:\w+\s+)?(?:zip|postal|post)\s*code\b", re.I), ("address", "postal-address")),
    (re.compile(r"\bmy\s+(?:\w+\s+){0,2}(?:phone|mobile|cell|cellphone|telephone)\b|\bmy\s+(?:phone\s+|cell\s+|mobile\s+)?number\b|\bcall\s+me\b", re.I), ("phone",)),
    (re.compile(r"\bmy\s+(?:\w+\s+){0,2}e-?mail\b", re.I), ("email",)),
    (re.compile(r"\b(?:my\s+(?:full\s+|last\s+|legal\s+)?name|my\s+surname|who\s+am\s+i|what\s+am\s+i\s+called)\b", re.I), ("name", "preferred-name", "last-name")),
    (re.compile(r"\bwho\s+do\s+i\s+work\s+for\b|\bwhere\s+do\s+i\s+work\b|\bmy\s+(?:employer|job|role|work\s+address)\b", re.I), ("work", "work-address")),
    (re.compile(r"\bmy\s+time\s*zone\b", re.I), ("timezone",)),
)
FIRST_PERSON = re.compile(r"\b(?:my|i|me|mine|i'm|i'd)\b", re.I)


def wanted(query: str) -> list:
    """Profile field keys a first person question asks about, in order. Empty when it is not about the person."""
    if not FIRST_PERSON.search(query or ""):
        return []
    keys = []
    for pattern, fields in INTENTS:
        if pattern.search(query):
            keys += [k for k in fields if k not in keys]
    return keys


def lookup(query: str, facts: dict) -> list:
    """The lines of `facts` that the question asks about, as "Label: value" with the note when it is not confirmed."""
    out = []
    for key in wanted(query):
        f = facts.get(key)
        if f:
            out.append(f"{FIELDS[key][0]}: {f['value']}" + (f" ({f['note']})" if "unconfirmed" in f.get("note", "") else ""))
    return out


def norm(text: str) -> str:
    return " ".join(str(text or "").lower().split())


def user_text(transcript: str) -> str:
    """Only what the person wrote, from a condensed transcript of `USER: ...` and `ASSISTANT: ...` turns."""
    return "\n".join(m.group(1) for m in re.finditer(r"(?:^|\n\n)USER: (.*?)(?=\n\n(?:USER|ASSISTANT): |\Z)", transcript or "", re.S))


def stated(item: dict, transcript: str) -> bool:
    """True when the person really said it: `said` appears in one of their own turns and contains the value."""
    said, value = norm(item.get("said")), norm(item.get("value"))
    return bool(said and value and value in said and said in norm(user_text(transcript)))


def pending_rows(timeout: float = 30, settings=None) -> list:
    return [r for r in shapes.entries(api.request("GET", "/list?tag=%s&n=20" % PENDING_TAG, timeout=timeout, settings=settings))
            if PENDING_TAG in (r.get("tags") or [])]


def pending_field(row: dict) -> str:
    m = re.search(r"^name:\s*profile-proposal-(\S+)", str(row.get("content", "")), re.M)
    return m.group(1) if m else ""


def pending_value(row: dict) -> str:
    m = re.search(r"^Proposed [^:\n]+:\s*(.+?)\s*$", str(row.get("content", "")), re.M)
    return m.group(1) if m else ""


def propose(key: str, value: str, old: str, now: float | None = None) -> str:
    """Save (or replace) the pending change for one field as a pending memory, which recall never injects. Returns its id."""
    label = FIELDS[key][0]
    content = (f"---\nname: profile-proposal-{key}\ndescription: A proposed change to the profile, waiting for the person to accept it.\n"
               f"metadata:\n  type: user\n---\n\nProposed {label}: {value}\nCurrent {label}: {old}\nSaid on {today(now)}\n")
    tags = [PENDING_TAG, "status:pending", f"field:{key}"]
    for r in pending_rows():
        if pending_field(r) == key:
            api.request("POST", "/update", {"id": r["id"], "content": content, "tags": tags}, timeout=60)
            return str(r["id"])
    return str(api.request("POST", "/capture", {"content": content, "source": "profile-proposal", "tags": tags}, timeout=60).get("id", ""))


def apply_stated(items: list, transcript: str, now: float | None = None) -> list:
    """What to do with the facts capture found the person stating about themselves. A fact that is not already in the profile
    is added. The same fact is left alone. A different value for a fact that has one becomes a pending change that the person
    accepts or dismisses. Returns one line per item for the capture log."""
    out = []
    row, facts = load()
    for it in items:
        key = str(it.get("field", "")).strip()
        value = " ".join(str(it.get("value", "")).split())
        if key not in FIELDS:
            out.append(f"{key or '?'}: unknown field")
        elif not stated(it, transcript):
            out.append(f"{key}: not said by the person, ignored")
        elif key in facts and norm(facts[key]["value"]) == norm(value):
            out.append(f"{key}: already in the profile")
        else:
            try:
                new = change(facts, key, value, now=now)
            except ValueError as e:
                out.append(f"{key}: refused ({e})"[:90])
                continue
            if key in facts:
                propose(key, value, facts[key]["value"], now)
                out.append(f"{key}: change proposed")
            else:
                row_id = save(row, new)
                facts = new
                row = row or {"id": row_id, "tags": ["profile"]}
                out.append(f"{key}: added")
    return out


def find(rows: list) -> dict | None:
    """The profile memory among rows listed by tag: the one named profile, not a person or anything else."""
    for r in rows or []:
        if isinstance(r, dict) and "profile" in (r.get("tags") or []) and re.search(r"^name:\s*profile\s*$", str(r.get("content", "")), re.M):
            return r
    return None


def load() -> tuple:
    row = find(api.list_all({"tag": "profile", "n": 100}))
    return row, (parse(row["content"]) if row else {})


def save(row: dict | None, facts: dict) -> str:
    content, tags = render(facts), tags_for(facts) + ["status:canonical"]
    if row:
        api.request("POST", "/update", {"id": row["id"], "content": content, "tags": tags}, timeout=60)
        return str(row["id"])
    res = api.request("POST", "/capture", {"content": content, "source": "profile", "tags": tags}, timeout=60)
    return str(res.get("id", ""))


def run(ns):
    try:
        row, facts = load()
        action = ns.action
        if action == "pending":
            rows = pending_rows()
            if not rows:
                print("no profile changes waiting")
            for r in rows:
                print(f"{pending_field(r)}: {pending_value(r)}   accept: profile.py accept {pending_field(r)}   ignore: profile.py dismiss {pending_field(r)}")
            return 0
        if action in ("accept", "dismiss"):
            if not ns.field:
                print(f"anymem: profile {action} needs a field", file=sys.stderr)
                return 2
            hit = [r for r in pending_rows() if pending_field(r) == ns.field]
            if not hit:
                print(f"no pending change for {ns.field}", file=sys.stderr)
                return 1
            if action == "accept":
                save(row, change(facts, ns.field, pending_value(hit[0])))
            api.request("POST", "/forget", {"id": hit[0]["id"]}, timeout=60)
            print(("profile updated (%s)" % FIELDS[ns.field][0].lower()) if action == "accept" else f"dismissed the proposed {FIELDS[ns.field][0].lower()}")
            return 0
        if action == "show":
            if not facts:
                print("no profile yet. Add a fact: profile.py set name \"Your Name\"")
                return 0
            for key, f in facts.items():
                print(f"{FIELDS[key][0]}: {f['value']}" + (f" ({f['note']})" if f["note"] else ""))
            return 0
        if not ns.field:
            print(f"anymem: profile {action} needs a field ({', '.join(sorted(FIELDS))})", file=sys.stderr)
            return 2
        if action == "get":
            if ns.field not in facts:
                print(f"no {FIELDS[ns.field][0].lower()} in the profile", file=sys.stderr)
                return 1
            print(facts[ns.field]["value"])
            return 0
        if action == "set":
            if ns.value is None:
                print("anymem: profile set needs a value", file=sys.stderr)
                return 2
            new = change(facts, ns.field, ns.value, getattr(ns, "derived_from", None))
        elif action == "confirm":
            new = confirm(facts, ns.field)
        else:  # unset
            if ns.field not in facts:
                print(f"no {FIELDS[ns.field][0].lower()} in the profile", file=sys.stderr)
                return 1
            new = {k: v for k, v in facts.items() if k != ns.field}
            if not new and row:
                api.request("POST", "/forget", {"id": row["id"]}, timeout=60)
                print("profile is empty, so the memory was moved to the trash for 14 days")
                return 0
        pid = save(row, new)
        print(f"profile updated ({FIELDS[ns.field][0].lower()}), memory {pid[:8]}")
        return 0
    except ValueError as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 2
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 1
