#!/usr/bin/env python3
"""Runnable check for <private> text and the injection record behind the usage script. No network."""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import injection, private  # noqa: E402
from hm.commands import usage  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


s = private.strip
check("a private block is removed", s("keep this <private>my card is 4111</private> and this") == "keep this  and this")
check("several blocks, any case and spacing, across lines", s("a <PRIVATE>x\ny</private> b < private >z</ private > c") == "a  b  c")
check("a block that is never closed hides the rest of the message", s("fine <private>secret and everything after") == "fine")
check("a stray closing tag is dropped, text without tags is untouched", s("one </private> two") == "one  two" and s("nothing here") == "nothing here" and s("") == "")
check("a message that is all private becomes empty", s("<private>all of it</private>") == "")

injection.record(k="start", chars=4000)
# the hook asks the Worker for three memories, so the extra count it records is always 0, as in a real session
for n in (3, 1, 0):
    injection.record(k="recall", sid="s1", chars=n * 300, n=n, sims=[0.8, 0.7, 0.65][:n], extra=0, profile=0, people=1 if n == 1 else 0)
rows = injection.read()
check("the record keeps counts only, one line per event", len(rows) == 4 and all(set(r) <= {"ts", "k", "sid", "chars", "n", "sims", "extra", "profile", "people"} for r in rows))
sm = usage.summarise(rows)
check("the summary counts starts, prompts and prompts that injected something", sm["starts"] == 1 and sm["prompts"] == 3 and sm["used"] == 2 and sm["memories"] == 4)
text = "\n".join(usage.report(sm, 7))
check("the report says tokens are about, and that it does not measure usefulness", "about 1000 tokens each" in text and "not whether it helped" in text)
check("the report makes no claim about a higher limit", "limit" not in text and "a higher" not in usage.HELP)
check("an empty record is a plain sentence, not an error", usage.report(usage.summarise([]), 7)[0].startswith("nothing recorded yet"))
check("events older than the window are left out", injection.read(time.time() + 60) == [])
injection.MAX_BYTES, injection.KEEP_LINES = 200, 3
for n in range(10):
    injection.record(n=n, chars=1)
kept = [e.get("n") for e in injection.read()]
check("the file is trimmed to its newest lines", kept[-1] == 9 and 0 not in kept and len(kept) <= 4)

sys.exit(1 if failures else 0)
