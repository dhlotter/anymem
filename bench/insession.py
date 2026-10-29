#!/usr/bin/env python3
"""In session saves benchmark: does the agent save memories itself, or only the background extractor?

Reads two local logs, both in the cache folder (~/.cache/anymem, or ANYMEM_CACHE_DIR):

  capture.log          one JSON line per capture run: session, bytes of new transcript, user_chars, proposed (what the extractor proposed)
  audit.log, audit.log.1   one JSON line per Worker call: harness, hook or script, session, route

and prints, per harness and per day (the day is the date of the session's first eligible capture run), over the window:

  eligible    sessions with a capture run of at least 8,000 bytes of new transcript and at least 150 user characters
  agent       eligible sessions where the agent saved something itself (a remember, update or append script call)
  saves       the number of those script calls in eligible sessions
  proposed    eligible sessions where the extractor proposed at least one memory

A session's harness comes from its audit rows. An eligible session with no audit row has no harness and is shown as "unmatched",
because the audit log is rotated (one old file is kept), so a session older than its window or run on another machine has none.

    python3 bench/insession.py                          # 2026-10-24 to today
    python3 bench/insession.py --since 2026-10-24 --until 2026-10-29
    python3 bench/insession.py --cache DIR --json
    python3 bench/insession.py --split-exec             # Codex headless runs (codex exec) shown as codex-exec, not as codex

Most Codex sessions on this machine are not conversations: Paper Past image generation and other jobs run `codex exec` and each one
counts as an eligible session. --split-exec reads each Codex session's first line (under ~/.codex/sessions, or CODEX_HOME) and shows
the ones started by `codex exec` as codex-exec, so the codex row is the interactive ones.

What it cannot tell: a session where nothing was worth saving looks the same as one where the agent forgot. A save needs a script
call, so an agent that wrote a memory some other way is not counted. Counts are one machine's logs. Stdlib only, reads the logs, writes nothing.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys
from pathlib import Path

MIN_BYTES = 8_000       # the same bar as capture's PreCompact and SessionEnd
MIN_USER_CHARS = 150    # the same bar as memory_capture.MIN_USER_CHARS
SAVE_SCRIPTS = ("remember", "update", "append")
UNMATCHED = "unmatched"


def cache_dir(override: "str | None" = None) -> Path:
    if override:
        return Path(override).expanduser()
    env = os.environ.get("ANYMEM_CACHE_DIR")
    return Path(env).expanduser() if env else Path.home() / ".cache" / "anymem"


def read_jsonl(path: Path) -> list:
    """Every JSON object line in the file, in order. A missing file or a broken line gives nothing, never an error."""
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    out.append(rec)
    except OSError:
        pass
    return out


def audit_rows(cache: Path) -> list:
    """The old file first, then the current one, so the rows are in time order."""
    return read_jsonl(cache / "audit.log.1") + read_jsonl(cache / "audit.log")


def eligible_sessions(captures: list, since: str, until: str) -> dict:
    """{session: {"day", "proposed_runs", "proposals"}} for sessions with an eligible capture run in the window (ISO dates, inclusive).
    A capture run's `ts` carries the machine's own offset, so its date part is the local day."""
    out: dict = {}
    for rec in captures:
        day = str(rec.get("ts", ""))[:10]
        sid = str(rec.get("session", ""))
        if not sid or not (since <= day <= until):
            continue
        if not (isinstance(rec.get("bytes"), int) and rec["bytes"] >= MIN_BYTES and isinstance(rec.get("user_chars"), int) and rec["user_chars"] >= MIN_USER_CHARS):
            continue
        s = out.setdefault(sid, {"day": day, "proposals": 0})
        s["day"] = min(s["day"], day)
        n = rec.get("proposed")
        if isinstance(n, int) and n > 0:
            s["proposals"] += n
    return out


def harness_by_session(rows: list) -> dict:
    """{session: harness}, the harness on the session's first audit row. A session belongs to the harness that opened it: a Codex or
    Kilo run started from inside a Claude session inherits its session id, and its rows must not move the session to another harness."""
    out: dict = {}
    for r in rows:
        sid, h = str(r.get("session") or ""), str(r.get("harness") or "")
        if sid and h and sid not in out:
            out[sid] = h
    return out


def codex_exec_sessions(wanted: set) -> set:
    """The ids in `wanted` that are Codex sessions started by `codex exec` (a headless run), read from each session file's first line.
    Codex keeps them as ~/.codex/sessions/YYYY/MM/DD/rollout-TIME-ID.jsonl. An id with no file is not in the result."""
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "sessions"
    found: set = set()
    if not wanted or not root.is_dir():
        return found
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            sid = next((w for w in wanted if name.endswith(w + ".jsonl")), "")
            if not sid:
                continue
            try:
                with open(Path(dirpath) / name, encoding="utf-8") as f:
                    meta = json.loads(f.readline()).get("payload", {})
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(meta, dict) and meta.get("source") == "exec":
                found.add(sid)
    return found


def saves_by_session(rows: list) -> collections.Counter:
    """{session: number of remember, update or append script calls that got an answer 200}."""
    out: collections.Counter = collections.Counter()
    for r in rows:
        sid = str(r.get("session") or "")
        if sid and r.get("script") in SAVE_SCRIPTS and r.get("status") == 200:
            out[sid] += 1
    return out


def measure(captures: list, rows: list, since: str, until: str, split_exec: bool = False) -> dict:
    """{"sessions": [{session, harness, day, agent_saves, proposals}], "audit_from": first audit day or ""}"""
    elig = eligible_sessions(captures, since, until)
    harness = harness_by_session(rows)
    saves = saves_by_session(rows)
    sessions = [
        {"session": sid, "harness": harness.get(sid, UNMATCHED), "day": s["day"], "agent_saves": saves.get(sid, 0), "proposals": s["proposals"]}
        for sid, s in sorted(elig.items(), key=lambda kv: (kv[1]["day"], kv[0]))
    ]
    if split_exec:
        headless = codex_exec_sessions({x["session"] for x in sessions if x["harness"] == "codex"})
        for x in sessions:
            if x["session"] in headless:
                x["harness"] = "codex-exec"
    stamps = [r["ts"] for r in rows if isinstance(r.get("ts"), (int, float))]
    first = datetime.datetime.fromtimestamp(min(stamps)).strftime("%Y-%m-%d %H:%M") if stamps else ""
    return {"sessions": sessions, "audit_from": first}


def tally(sessions: list) -> dict:
    """{key: {eligible, agent_sessions, saves, proposed_sessions, proposals}} for a list of session dicts."""
    out = {"eligible": 0, "agent_sessions": 0, "saves": 0, "proposed_sessions": 0, "proposals": 0}
    for s in sessions:
        out["eligible"] += 1
        out["agent_sessions"] += 1 if s["agent_saves"] else 0
        out["saves"] += s["agent_saves"]
        out["proposed_sessions"] += 1 if s["proposals"] else 0
        out["proposals"] += s["proposals"]
    return out


def pct(part: int, whole: int) -> str:
    return f"{100 * part / whole:.0f}%" if whole else "-"


HEAD = f"{'':<12}{'eligible':>9}{'agent':>7}{'agent%':>8}{'saves':>7}{'proposed':>10}{'prop%':>7}{'proposals':>11}"


def line(label: str, t: dict) -> str:
    return f"{label:<12}{t['eligible']:>9}{t['agent_sessions']:>7}{pct(t['agent_sessions'], t['eligible']):>8}{t['saves']:>7}{t['proposed_sessions']:>10}{pct(t['proposed_sessions'], t['eligible']):>7}{t['proposals']:>11}"


def report(result: dict, since: str, until: str) -> str:
    sessions = result["sessions"]
    lines = [f"In session saves, {since} to {until}. Audit log starts {result['audit_from'] or 'nowhere (no audit rows)'}.", ""]
    lines += ["Per harness", HEAD]
    names = sorted({s["harness"] for s in sessions}, key=lambda h: (h == UNMATCHED, -sum(1 for s in sessions if s["harness"] == h), h))
    for h in names:
        lines.append(line(h, tally([s for s in sessions if s["harness"] == h])))
    lines.append(line("all", tally(sessions)))
    lines += ["", "Per day and harness", HEAD]
    for day in sorted({s["day"] for s in sessions}):
        for h in names:
            mine = [s for s in sessions if s["day"] == day and s["harness"] == h]
            if mine:
                lines.append(line(f"{day[5:]} {h}"[:30], tally(mine)))
    return "\n".join(lines)


def main(argv: "list | None" = None) -> int:
    today = datetime.date.today().isoformat()
    p = argparse.ArgumentParser(description="In session saves benchmark, from the local capture and audit logs")
    p.add_argument("--since", default="2026-10-24", help="first day, ISO date (default 2026-10-24)")
    p.add_argument("--until", default=today, help="last day, ISO date (default today)")
    p.add_argument("--cache", help="the cache folder (default ~/.cache/anymem or ANYMEM_CACHE_DIR)")
    p.add_argument("--split-exec", action="store_true", help="show Codex headless runs (codex exec) as codex-exec, apart from interactive codex")
    p.add_argument("--json", action="store_true", help="print the sessions and totals as JSON")
    args = p.parse_args(argv)
    cache = cache_dir(args.cache)
    captures = read_jsonl(cache / "capture.log")
    if not captures:
        print(f"no capture log at {cache / 'capture.log'}", file=sys.stderr)
        return 1
    result = measure(captures, audit_rows(cache), args.since, args.until, args.split_exec)
    if args.json:
        print(json.dumps({**result, "totals": tally(result["sessions"])}, indent=2))
    else:
        print(report(result, args.since, args.until))
    return 0


if __name__ == "__main__":
    sys.exit(main())
