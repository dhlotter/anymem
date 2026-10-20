#!/usr/bin/env python3
"""Regenerate bench/sets/exact.json from the memory files: identifiers and names that appear in only one or two
memories, half asked bare and half as "what do we know about X". Seeded, so the same files give the same set.
Run it when memories change a lot, and expect exact scores to shift a little because the expected files shift.
The output is sets/exact.local.json, gitignored, because the names and ticket ids in it come from your own memories.

    python3 bench/make_exact.py [memory_dir]      # default: ANYMEM_DIR, the folder of memory files
"""
from __future__ import annotations

import collections, json, os, random, re, sys

M = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ANYMEM_DIR", "")
if not M:
    sys.exit("usage: make_exact.py MEMORY_DIR (or set ANYMEM_DIR)")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sets", "exact.local.json")
files = {f[:-3]: open(os.path.join(M, f), encoding="utf-8").read() for f in os.listdir(M) if f.endswith(".md") and f != "MEMORY.md"}
body = {n: t.split("---", 2)[-1] for n, t in files.items()}
pat = re.compile(r"\b(?:[A-Z]{2,6}-\d{2,5}|[A-Z][A-Za-z]*\d[A-Za-z0-9]*|[A-Z][a-z]{6,})\b")
occ = collections.defaultdict(set)
for n, t in body.items():
    for m in set(pat.findall(t)):
        occ[m].add(n)
stop = {"however", "because", "another", "anything", "nothing", "something"}
cands = [(w, sorted(ns)) for w, ns in occ.items() if 1 <= len(ns) <= 2 and w.lower() not in stop]
ident = [c for c in cands if re.search(r"\d", c[0])]
names = [c for c in cands if not re.search(r"\d", c[0])]
random.seed(7)
pick = random.sample(ident, min(12, len(ident))) + random.sample(names, min(8, len(names)))
qs = [{"q": w if i % 2 == 0 else f"what do we know about {w}", "exp": ns} for i, (w, ns) in enumerate(pick)]
json.dump(qs, open(OUT, "w"), indent=1)
print(f"wrote {len(qs)} queries to {OUT}")
