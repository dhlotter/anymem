#!/usr/bin/env python3
"""Replay one real session through the Worker's POST /extract and print what it proposes. For the capture gate (30 real transcripts).

Builds the same text the live capture hook would send, with the hook's own code (hooks/memory_capture.py: the transcript reader,
build_text with its size caps and private text strip, the redactor, the known capsule text), posts it to /extract and prints the
proposals, how many the Worker's screens dropped and why. It calls /extract and nothing else. It never calls /capture or any
route that writes, and the Worker's /extract stores nothing.

    python3 bench/replay_extract.py TRANSCRIPT.jsonl            needs ANYMEM_URL and the usual credentials (or a configured client)
    python3 bench/replay_extract.py TRANSCRIPT.jsonl --dry      only print the size of the text that would be sent, no network
    python3 bench/replay_extract.py TRANSCRIPT.jsonl --json     the Worker's reply as JSON
    python3 bench/replay_extract.py TRANSCRIPT.jsonl --url https://your-worker.example.com

Credentials come from the client's own config order: ANYMEM_URL, ANYMEM_TOKEN, ANYMEM_ACCESS_CLIENT_ID and
ANYMEM_ACCESS_CLIENT_SECRET, then the config file, then credential_command (client/hm/config.py). Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "hooks"))
import memory_capture as hook  # noqa: E402  the live hook's own condensing code
from hm import api, config, redact  # noqa: E402

ROUTE = "/extract"  # the only route this script ever calls


def build(path: str, fmt: str) -> dict:
    """What the live hook would send for this transcript, plus the facts about it the report prints."""
    turns, _ = hook.reader(fmt)(path, 0)
    text, user_chars = hook.build_text(turns)
    short = user_chars < hook.MIN_USER_CHARS and not (
        user_chars >= hook.MIN_USER_CHARS_FACT and hook.LASTING_RE.search(hook.hm_profile.user_text(text)))
    clean, redactions, kinds = redact.redact(text)
    clean = hook.TAG_RE.sub("[tag removed]", clean)  # the hook does this before it posts
    known = hook.known()
    return {"transcript": clean, "known": known, "max": hook.MAX_MEMORIES,
            "turns": len(turns), "user_chars": user_chars, "short": short, "redactions": redactions, "kinds": list(kinds)}


def post_extract(body: dict) -> dict:
    """POST /extract. The one network call in this file."""
    res = api.request("POST", ROUTE, {"transcript": body["transcript"], "known": body["known"], "max": body["max"]}, timeout=90)
    return res if isinstance(res, dict) else {}


def show(item: dict) -> str:
    if item.get("type") == "profile":
        return f"  profile  {item.get('field')} = {item.get('value')}   said: {str(item.get('said'))[:70]}"
    if item.get("type") == "person":
        return f"  person   {item.get('name')} {item.get('field')} = {item.get('value')}   said: {str(item.get('said'))[:70]}"
    body = " ".join(str(item.get("body", "")).split())
    return f"  memory   [{item.get('type')}] {item.get('name')}: {item.get('description')}\n           {body[:240]}"


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="Replay a session transcript through POST /extract. Never writes.")
    ap.add_argument("transcript", help="a Claude Code transcript (.jsonl), or another format with --format")
    ap.add_argument("--url", help="the Worker URL, instead of ANYMEM_URL")
    ap.add_argument("--format", help="transcript format, default sniffed from the file")
    ap.add_argument("--dry", action="store_true", help="print the size of the text only, send nothing")
    ap.add_argument("--json", action="store_true", help="print the Worker's reply as JSON")
    ns = ap.parse_args(argv)
    if ns.url and ns.url.rstrip("/") != (config.load(use_command=False).url or "").rstrip("/"):
        # the token and the Access pair go to the configured Worker only, never to an address typed here
        print(f"replay_extract: --url {ns.url} is not the Worker in your client config, so nothing was sent. Point the client at it with "
              "connect.py or ANYMEM_URL first, or leave --url out.", file=sys.stderr)
        return 2
    fmt = ns.format or hook.detect_format(ns.transcript)
    try:
        built = build(ns.transcript, fmt)
    except (OSError, ValueError) as e:
        print(f"replay_extract: cannot read {ns.transcript}: {e}", file=sys.stderr)
        return 2
    sizes = (f"turns {built['turns']}, text {len(built['transcript'])} chars, user text {built['user_chars']} chars, "
             f"known {len(built['known'])} chars, redactions {built['redactions']}")
    if ns.dry:
        print(sizes)
        print("the live hook would skip this session (too little user text)" if built["short"] else "the live hook would send it to extraction")
        return 0
    if built["short"]:
        print(f"{sizes}\nthe live hook would skip this session (too little user text), nothing sent")
        return 0
    try:
        res = post_extract(built)
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"replay_extract: {e}", file=sys.stderr)
        return 1
    if ns.json:
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return 0
    proposals = res.get("proposals") or []
    print(sizes)
    print(f"proposals {len(proposals)} (model returned {res.get('raw', '?')}), screened out {res.get('screened') or {}}"
          + (f", degraded: {res['degraded']}" if res.get("degraded") else ""))
    for p in proposals:
        print(show(p))
    return 0


if __name__ == "__main__":
    sys.exit(main())
