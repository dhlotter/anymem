"""`recall_check`: can the store still find its own memories? Run monthly by capture, or by hand.

It samples 40 active memories (a fixed slice, so runs are comparable), searches for each one with its own name and description,
and counts how often the memory comes back first and in the top five. As a store fills with repeats and stale notes the right
memory gets pushed down, and this rate is the first number to move. The first run becomes the baseline. A later run warns when
the top five rate falls more than 0.08 below the baseline or under 0.80. The searches use `count=0`, so they do not make
memories look recalled. The result is written to the cache folder and the session start prints a warning when it says warn."""
from __future__ import annotations

import json
import re
import sys
import time
from urllib.parse import urlencode

from hm import api, config, shapes

COMMAND = "recall-check"
HELP = "check that the store still finds its own memories, and warn when that gets worse"
SAMPLE = 40
DROP = 0.08
FLOOR = 0.80
MIN_SAMPLE = 20  # one miss moves the rate by 0.05 here, so a smaller store would warn on noise, and an empty one would set a 0.0 baseline


def register(parser):
    parser.add_argument("--quiet", action="store_true", help="print only a warning")
    parser.add_argument("--reset-baseline", action="store_true", help="make this run the new baseline")


def state_file():
    return config.cache_dir() / "recall-check.json"


def read_state() -> dict:
    try:
        d = json.loads(state_file().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def all_entries() -> list:
    """Every live memory, paged through /list (the export route refuses a large store in one reply)."""
    return api.list_all({"n": 500}, timeout=60)


def sample(entries: list) -> list:
    """A fixed slice, active or canonical memories with a name and description, every k-th by id. Pending and deprecated are left out."""
    ok = sorted((e for e in entries if e.get("status", "active") in ("active", "canonical") and shapes.name_of(e) and shapes.description_of(e)
                 and not any(t.startswith("capsule") for t in e.get("tags") or [])), key=lambda e: str(e.get("id")))
    if len(ok) <= SAMPLE:
        return ok
    step = len(ok) / SAMPLE
    return [ok[int(i * step)] for i in range(SAMPLE)]


def judge(first: int, top5: int, n: int, state: dict, now: float, reset: bool = False) -> dict:
    """The new state: the rates, the baseline, and ok or warn with the reason."""
    rate1, rate5 = (first / n if n else 0.0), (top5 / n if n else 0.0)
    base = state.get("baseline") if not reset else None
    if not base:
        base = {"top5": rate5, "top1": rate1, "n": n, "at": now}
    status, why = "ok", ""
    if rate5 < FLOOR:
        status, why = "warn", f"only {rate5:.2f} of memories are found in the top five, below {FLOOR:.2f}"
    elif rate5 < base["top5"] - DROP:
        status, why = "warn", f"the top five rate fell from {base['top5']:.2f} to {rate5:.2f}"
    return {"at": now, "n": n, "top1": round(rate1, 3), "top5": round(rate5, 3), "baseline": base, "status": status, "why": why}


def run(ns):
    try:
        entries = all_entries()
        picked = sample(entries)
        if len(picked) < MIN_SAMPLE:
            if not ns.quiet:
                print("memory health: skipped, %d memories to check, at least %d are needed" % (len(picked), MIN_SAMPLE))
            return 0
        first = top5 = 0
        for e in picked:
            query = (shapes.name_of(e).replace("-", " ") + ". " + shapes.description_of(e))[:240]
            res = api.request("GET", "/recall?" + urlencode({"query": query, "topK": 5, "count": 0}), timeout=60).get("results", [])
            ids = [str(r.get("id")) for r in res]
            first += bool(ids) and ids[0] == str(e["id"])
            top5 += str(e["id"]) in ids
        out = judge(first, top5, len(picked), read_state(), time.time(), reset=getattr(ns, "reset_baseline", False))
        d = state_file().parent
        d.mkdir(parents=True, exist_ok=True)
        state_file().write_text(json.dumps(out), encoding="utf-8")
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"anymem: {e}", file=sys.stderr)
        return 1
    if out["status"] == "warn":
        print(f"memory health: warn, {out['why']}. Open the dashboard health page, and forget what is stale.")
    elif not ns.quiet:
        print(f"memory health: ok, {out['n']} memories sampled, found first {out['top1']:.2f}, in the top five {out['top5']:.2f} (baseline {out['baseline']['top5']:.2f})")
    return 0
