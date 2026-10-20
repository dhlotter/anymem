"""`remember.py "content"`: save one memory. The Worker screens it, refuses an exact copy, warns about a near copy and closes
an older memory the new one clearly contradicts, and this prints which of those happened."""
from __future__ import annotations

import sys

from hm import api, audit, private, skill
from hm import project as hm_project

COMMAND = "remember"
HELP = "save a memory (frontmatter plus body), from an argument or standard input"


def register(parser):
    parser.add_argument("content", nargs="?", help="the memory text, or - (or nothing) to read standard input")
    parser.add_argument("--tag", action="append", default=[], help="a tag, repeat for more")
    parser.add_argument("--project", help="the project, default the current repo. Use global for none")


def body_for(ns, text: str) -> dict:
    body = {"content": text, "source": "claude"}
    if audit.harness():  # a blank name is left out, so the Worker falls back to the header, which is blank too
        body["harness"] = audit.harness()
    if audit.session():
        body["session"] = audit.session()
    if ns.tag:
        body["tags"] = ns.tag
    # --project is slugged like the current repo's name, so My_Repo and my-repo are one project for recall too
    project = skill.current_project() if ns.project is None else (None if ns.project.lower() in ("", "global", "none") else hm_project.slug(ns.project) or None)
    if project:
        body["project"] = project
    return body


def say(res: dict) -> None:
    mid = str(res.get("id", ""))
    skill.note_ids([mid, res.get("matchId")])
    if res.get("duplicate"):
        near = f" (similarity {res['score']:.2f})" if isinstance(res.get("score"), (int, float)) else ""
        print(f"already stored as {str(res.get('matchId', '?'))}{near}, nothing new saved")
        return
    print(f"saved {mid} ({res.get('status', 'active')})" + (", updated in place" if res.get("updated") else ""))
    if res.get("warning") == "similar":
        print(f"warning: similar to {res.get('matchId')}" + (f" (similarity {res['score']:.2f})" if isinstance(res.get("score"), (int, float)) else "")
              + ". Check whether one of the two should go.")
    if isinstance(res.get("replaced"), dict):
        old = res["replaced"].get("id")
        print(f"It replaces memory {old}, which is now closed history. Tell the person. To bring it back run undo.py {old}")
    if isinstance(res.get("kept_both"), dict):
        k = res["kept_both"]
        print(f"Both stay live, the older one is {k.get('id')} ({k.get('reason')}). Do not retry. Ask the person only if one of the two should go.")


def run(ns):
    text = private.strip(skill.read_text(ns.content)).strip()
    if not text:
        print("anymem: there is nothing to save", file=sys.stderr)
        return 2
    secrets = skill.secret_kinds(text)
    if secrets:
        print(f"anymem: not saved, the text looks like it holds a secret ({', '.join(secrets)}). Remove it and run again.", file=sys.stderr)
        return 2
    try:
        say(api.request("POST", "/capture", body_for(ns, text), timeout=60))
    except api.ApiError as e:
        if e.status == 422:
            print(f"anymem: refused, {e.body.get('reason') or e.message}. Nothing was saved.", file=sys.stderr)
            return 2
        if e.status == 429:
            print(f"anymem: too many writes, wait {e.body.get('retry_after', 'a few minutes')} seconds and run again.", file=sys.stderr)
            return 1
        raise
    return 0
