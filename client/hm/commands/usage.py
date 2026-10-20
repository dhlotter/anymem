"""`usage.py`: what memory adds to your prompts, from this machine's own record.

The hooks note, for every session start and every prompt that searched memory, how many characters they added, how many memories,
and how similar those were. This turns that into numbers: tokens added per session and per prompt (about, at four characters to a
token), and how often memory was used at all. It answers "is memory worth its weight", and nothing about whether an injected memory
was useful, which no log can tell. Only counts are kept, never prompt or memory text. One machine only, and only since the hooks
started recording."""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime

from hm import injection

COMMAND = "usage"
HELP = "what memory adds to your prompts: tokens and how often"
TOP_K = 3
CHARS_PER_TOKEN = 4


def register(parser):
    parser.add_argument("--days", type=int, default=7, help="how many days back (default 7)")


def tokens(chars) -> int:
    return round(chars / CHARS_PER_TOKEN)


def summarise(events: list) -> dict:
    starts = [e for e in events if e.get("k") == "start"]
    recalls = [e for e in events if e.get("k") == "recall"]
    used = [e for e in recalls if (e.get("n") or 0) > 0]
    sims = defaultdict(list)
    for e in used:
        for i, s in enumerate(e.get("sims") or []):
            if s:
                sims[i].append(s)
    days = defaultdict(lambda: {"starts": 0, "prompts": 0, "memories": 0, "chars": 0})
    for e in events:
        d = days[datetime.fromtimestamp(e["ts"]).strftime("%Y-%m-%d")]
        if e.get("k") == "start":
            d["starts"] += 1
        elif e.get("k") == "recall":
            d["prompts"] += 1
            d["memories"] += e.get("n") or 0
        d["chars"] += e.get("chars") or 0
    return {
        "starts": len(starts), "start_chars": sum(e.get("chars") or 0 for e in starts),
        "prompts": len(recalls), "used": len(used), "recall_chars": sum(e.get("chars") or 0 for e in recalls),
        "memories": sum(e.get("n") or 0 for e in used), "by_n": {n: sum(1 for e in used if e.get("n") == n) for n in range(1, TOP_K + 1)},
        "sim": {i: sum(v) / len(v) for i, v in sims.items() if v},
        "profile_prompts":sum(1 for e in recalls if (e.get("profile") or 0) > 0), "people_prompts": sum(1 for e in recalls if (e.get("people") or 0) > 0),
        "days": dict(sorted(days.items())),
    }


def report(s: dict, days: int) -> list:
    if not s["starts"] and not s["prompts"]:
        return ["nothing recorded yet. The hooks note what they add from the next session start or prompt on this machine."]
    out = [f"Memory in your prompts, last {days} days, this machine (tokens are about, 4 characters each)", ""]
    if s["starts"]:
        out.append(f"1. Session start: {s['starts']} starts (resumes and compactions included), about {tokens(s['start_chars'] / s['starts'])} tokens each, "
                   f"{tokens(s['start_chars'])} in all.")
    if s["prompts"]:
        share = 100 * s["used"] / s["prompts"]
        out.append(f"2. Prompts: {s['prompts']} searched memory, {s['used']} ({share:.0f} percent) had something relevant injected, "
                   f"about {tokens(s['recall_chars'] / s['prompts'])} tokens per prompt on average, {tokens(s['recall_chars'])} in all.")
        if s["used"]:
            by = s["by_n"]
            out.append(f"3. When memory is used it adds {s['memories'] / s['used']:.1f} memories: {by[1]} prompts got 1, {by[2]} got 2, {by[3]} got {TOP_K}.")
            sim = ", ".join(f"memory {i + 1}: {v:.2f}" for i, v in sorted(s["sim"].items()))
            out.append(f"4. Average similarity of what was injected ({sim}). The cutoff is 0.60 and a name match can pass below it.")
        out.append(f"5. Profile facts were added on {s['profile_prompts']} prompts, and people on {s['people_prompts']}.")
    out += ["", "By day (starts, prompts, memories injected, tokens added)"]
    for day, d in s["days"].items():
        out.append(f"   {day}: {d['starts']} starts, {d['prompts']} prompts, {d['memories']} memories, about {tokens(d['chars'])} tokens")
    out += ["", "This counts what was added, not whether it helped. Nothing here records a prompt or a memory's text."]
    return out


def run(ns):
    days = max(1, ns.days)
    events = injection.read(time.time() - days * 86400)
    print("\n".join(report(summarise(events), days)))
    return 0
