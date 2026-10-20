"""`resave.py`: try again to save memories that failed while the Worker was unreachable."""
from __future__ import annotations

import sys

from hm import api, offline

COMMAND = "resave"
ORIGIN_PREFIXES = ("captured-by:", "session:")
REFUSED = (400, 413, 422)  # the Worker turns this exact body away, so a retry can never work
HELP = "retry the captures that failed to save (listed by doctor), keeping any that still fail"


def register(parser):
    parser.add_argument("--dry-run", action="store_true", help="show what would be retried, send nothing")


def run(ns):
    failures = offline.failures()
    todo = [f for f in failures if f.get("kind") == "capture" and isinstance(f.get("payload"), dict) and f["payload"].get("content")]
    other = [f for f in failures if f not in todo]
    if not todo:
        print("nothing to resave" + (f" ({len(other)} other failure(s) are listed by doctor)" if other else ""))
        return 0
    if ns.dry_run:
        for f in todo:
            print("would resave %s" % (f["payload"].get("name") or "a capture"))
        return 0
    kept, saved = [], 0
    for i, f in enumerate(todo):
        # Saved active, the Worker's default for a capture. The origin tags (captured-by:, session:) come from the tags recorded
        # with the failed capture, so the memory can still be traced and removed.
        origin = [t for t in (f["payload"].get("tags") or []) if isinstance(t, str) and t.startswith(ORIGIN_PREFIXES)]
        body = {"content": f["payload"]["content"], "source": "session-capture", "tags": ["auto-capture", *origin]}
        if f["payload"].get("project"):
            body["project"] = f["payload"]["project"]
        try:
            api.request("POST", "/capture", body, timeout=60)
            saved += 1
        except api.ApiError as e:
            worker_said = isinstance(e.body, dict) and ("code" in e.body or "reason" in e.body)  # a 400 or 413 from something in front of the Worker says nothing about the memory
            if e.status in REFUSED and (e.status == 422 or worker_said):  # refused, so retrying can never work. It is dropped, and said once.
                print("dropped: %s (refused, %s)" % (f["payload"].get("name") or "a capture", (e.body or {}).get("reason") or e.message), file=sys.stderr)
                continue
            kept.append(f)
            print("still failing: %s (%s)" % (f["payload"].get("name") or "a capture", e), file=sys.stderr)
            if e.status == 429:  # rate limited: more writes now only hammer it, so the rest wait for the next run
                kept += todo[i + 1:]
                print("the Worker is limiting writes, the rest wait for the next resave", file=sys.stderr)
                break
        except (api.NotConfigured, api.NetworkError) as e:
            kept.append(f)
            print("still failing: %s (%s)" % (f["payload"].get("name") or "a capture", e), file=sys.stderr)
    offline.discard([f for f in todo if f not in kept])  # only what was handled, so a failure recorded meanwhile stays
    print("resaved %d, %d still waiting" % (saved, len(kept)))
    return 1 if kept else 0
