"""`subject.py list | show SLUG | add KIND SLUG NAME | set SLUG FIELD VALUE | alias SLUG NAME | scope SLUG shared|private | retire SLUG | accept SLUG | dismiss SLUG`:
the things memories are about (a person, a pet, a car, a project) and the short brief that describes each one. Make or change one only
when the person asks. The Worker writes the card memory, never write one by hand.
The system proposes subjects on its own (status proposed). Only the person decides: accept and dismiss are theirs to run, never the agent's."""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import urlencode

from hm import api, private, shapes, skill

COMMAND = "subject"
HELP = "list, show, add and change subjects (a person, a pet, an asset, a project, an area, a topic)"

KINDS = ("person", "pet", "asset", "project", "area", "topic")
STATUSES = ("proposed", "active", "stale", "retired")
SLUG = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")  # the Worker's rule, 2 to 40 characters


def register(parser):
    sub = parser.add_subparsers(dest="subject_action", metavar="ACTION", required=True)
    ls = sub.add_parser("list", help="every subject: slug, kind, status, scope, members, name")
    ls.add_argument("--kind", choices=KINDS)
    ls.add_argument("--status", choices=STATUSES, help="only subjects with this status, proposed ones are waiting for the person's click")
    show = sub.add_parser("show", help="one subject: its fields, brief and members")
    show.add_argument("slug", metavar="SLUG")
    add = sub.add_parser("add", help="make a subject, active at once")
    add.add_argument("kind", metavar="KIND", choices=KINDS, help="one of " + ", ".join(KINDS))
    add.add_argument("slug", metavar="SLUG", help="lowercase letters and digits with single dashes, 2 to 40 characters")
    add.add_argument("name", metavar="NAME", help="the display name, up to 80 characters")
    text = add.add_mutually_exclusive_group()
    text.add_argument("--brief", help="the brief, a few sentences")
    text.add_argument("--brief-file", metavar="PATH", help="read the brief from a file, or - for standard input")
    setf = sub.add_parser("set", help="set one field, an empty VALUE removes it")
    setf.add_argument("slug", metavar="SLUG")
    setf.add_argument("field", metavar="FIELD")
    setf.add_argument("value", metavar="VALUE")
    alias = sub.add_parser("alias", help="add another name the subject goes by")
    alias.add_argument("slug", metavar="SLUG")
    alias.add_argument("name", metavar="NAME")
    scope = sub.add_parser("scope", help="shared, or private to the devices allowed to see private subjects (admin or browser login)")
    scope.add_argument("slug", metavar="SLUG")
    scope.add_argument("scope", metavar="SCOPE", choices=("shared", "private"))
    retire = sub.add_parser("retire", help="mark a subject retired, nothing is deleted")
    retire.add_argument("slug", metavar="SLUG")
    accept = sub.add_parser("accept", help="the person's click: make a proposed subject active (never run by the agent)")
    accept.add_argument("slug", metavar="SLUG")
    dismiss = sub.add_parser("dismiss", help="the person's click: turn a proposed subject down, its slug stays taken (never run by the agent)")
    dismiss.add_argument("slug", metavar="SLUG")


def _one_line(text) -> str:
    return skill.clean(" ".join(str(text).split()))


def _refuse(message: str) -> int:
    print(f"anymem: {message}", file=sys.stderr)
    return 2


def _screened(text: str, what: str) -> "int | None":
    """None when text may go, else the exit code after saying why: a secret is never sent."""
    secrets = skill.secret_kinds(text)
    return _refuse(f"not saved, the {what} looks like it holds a secret ({', '.join(secrets)}). Remove it and run again.") if secrets else None


def _get(slug: str) -> dict:
    return api.request("GET", "/subject?" + urlencode({"slug": slug}), timeout=30).get("subject") or {}


def _update(slug: str, **changes) -> dict:
    return api.request("POST", "/subject/update", {"slug": slug, **changes}, timeout=30).get("subject") or {}


def _list(ns) -> int:
    query = {k: v for k, v in (("kind", ns.kind), ("status", ns.status)) if v}
    rows = shapes.subjects(api.request("GET", "/subjects" + ("?" + urlencode(query) if query else ""), timeout=30))
    if not rows:
        print("no subjects")
        return 0
    for r in rows:
        print(f"{_one_line(r.get('slug'))}  {_one_line(r.get('kind'))}  {_one_line(r.get('status'))}  {_one_line(r.get('scope'))}  {int(r.get('member_count') or 0)} members  {_one_line(r.get('name') or '')}")
    skill.note_ids([r["id"] for r in rows if r.get("id")])
    return 0


def _show(ns) -> int:
    s = _get(ns.slug)
    print(f"{_one_line(s.get('slug'))}  {_one_line(s.get('kind'))}  {_one_line(s.get('status'))}  {_one_line(s.get('scope'))}  {_one_line(s.get('name') or '')}")
    print(f"id: {_one_line(s.get('id'))}")
    if s.get("aliases"):
        print("aliases: " + ", ".join(_one_line(a) for a in s["aliases"]))
    for key, field in sorted((s.get("fields") or {}).items()):
        print(f"{_one_line(key)}: {_one_line(field.get('value') if isinstance(field, dict) else field)}")
    print("brief:")
    print(skill.clean(str(s.get("brief") or "").strip()) or "(none)")
    members = s.get("members") or []
    print(f"members ({int(s.get('member_count') or len(members))}):")
    for m in members:
        print(f"{_one_line(m.get('id'))}  {_one_line(m.get('name') or '(unnamed)')}")
    skill.note_ids([s.get("id")] + [m.get("id") for m in members if m.get("id")])
    return 0


def _add(ns) -> int:
    if len(ns.slug) < 2 or len(ns.slug) > 40 or not SLUG.fullmatch(ns.slug):
        return _refuse("the slug is 2 to 40 characters: lowercase letters and digits with single dashes between them.")
    if not 1 <= len(ns.name.strip()) <= 80:
        return _refuse("the name is 1 to 80 characters.")
    brief = ""
    if ns.brief_file:
        brief = sys.stdin.read() if ns.brief_file == "-" else Path(ns.brief_file).read_text(encoding="utf-8")
    brief = private.strip(ns.brief or brief).strip()
    refused = _screened(ns.name + "\n" + brief, "name or brief")
    if refused:
        return refused
    body = {"slug": ns.slug, "kind": ns.kind, "name": ns.name.strip()}
    if brief:
        body["brief"] = brief
    s = api.request("POST", "/subject", body, timeout=60).get("subject") or {}
    skill.note_ids([s.get("id")])
    print(f"added {_one_line(s.get('slug') or ns.slug)}  {_one_line(s.get('id'))}")
    return 0


def _set(ns) -> int:
    value = ns.value.strip()
    refused = _screened(value, "value") if value else None
    if refused:
        return refused
    _update(ns.slug, fields={ns.field: value or None})
    print(f"set {ns.field}" if value else f"removed {ns.field}")
    return 0


def _alias(ns) -> int:
    name = " ".join(ns.name.lower().split())
    if not name:
        return _refuse("the alias is empty.")
    have = [str(a) for a in _get(ns.slug).get("aliases") or []]
    if name in have:
        print(f"{name} is already an alias")
        return 0
    _update(ns.slug, aliases=have + [name])  # the Worker replaces the list, so the old names go back with the new one
    print(f"added alias {name}")
    return 0


def _scope(ns) -> int:
    _update(ns.slug, scope=ns.scope)
    print(f"{ns.slug} is now {ns.scope}")
    return 0


def _retire(ns) -> int:
    _update(ns.slug, status="retired")
    print(f"retired {ns.slug}")
    return 0


def _decide(ns, action: str, past: str) -> int:
    s = api.request("POST", "/subject/" + action, {"slug": ns.slug}, timeout=30).get("subject") or {}
    skill.note_ids([s.get("id")])
    print(f"{past} {_one_line(s.get('slug') or ns.slug)}")
    return 0


def _accept(ns) -> int:
    return _decide(ns, "accept", "accepted")


def _dismiss(ns) -> int:
    return _decide(ns, "dismiss", "dismissed")


def run(ns):
    return {"list": _list, "show": _show, "add": _add, "set": _set, "alias": _alias, "scope": _scope, "retire": _retire, "accept": _accept, "dismiss": _dismiss}[ns.subject_action](ns)
