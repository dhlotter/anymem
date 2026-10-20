#!/usr/bin/env python3
"""Runnable check for the recall check (sampling and judging only). No network."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm.commands import recall_check as rc  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


mk = lambda i, tags=(): {"id": f"id{i:04d}", "content": f"---\nname: n{i}\ndescription: d{i}\n---\nb", "tags": list(tags)}
E = [mk(i) for i in range(200)] + [mk(900, ["status:draft"]), {"id": "bare", "content": "no frontmatter", "tags": []}]
s = rc.sample(E)
check("the sample is 40 active memories with a name and description", len(s) == 40 and all("status:draft" not in e["tags"] and e["id"] != "bare" for e in s))
check("the sample is the same slice every time", [e["id"] for e in rc.sample(E)] == [e["id"] for e in s])
check("a store smaller than the sample is used whole", len(rc.sample(E[:10])) == 10)
first = rc.judge(30, 38, 40, {}, 1000.0)
check("the first run sets the baseline and is ok", first["status"] == "ok" and first["baseline"]["top5"] == 0.95)
check("a small change is ok", rc.judge(29, 37, 40, first, 2000.0)["status"] == "ok")
check("a drop of more than 0.08 from the baseline warns", rc.judge(25, 33, 40, first, 2000.0)["status"] == "warn")
check("a rate under 0.80 warns even with a low baseline", rc.judge(20, 30, 40, {"baseline": {"top5": 0.7, "top1": 0.5, "n": 40, "at": 1}}, 2000.0)["status"] == "warn")
check("reset makes this run the baseline", rc.judge(25, 33, 40, first, 2000.0, reset=True)["baseline"]["top5"] == 0.825)
# an empty or tiny store is skipped: no warning, no baseline written (#62)
import argparse  # noqa: E402
import contextlib  # noqa: E402
import io  # noqa: E402
import tempfile  # noqa: E402

_state = Path(tempfile.mkdtemp()) / "recall-check.json"
rc.state_file = lambda: _state
for _count, _label in ((0, "an empty store"), (5, "a store of five")):
    rc.all_entries = lambda _n=_count: [mk(i) for i in range(_n)]
    _out, _err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_err):
        _code = rc.run(argparse.Namespace(quiet=False, reset_baseline=False))
    check(_label + " is skipped, with no warning, exit 0, and no baseline written", _code == 0 and not _state.exists() and "skipped" in _out.getvalue() and "warn" not in _out.getvalue())
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
