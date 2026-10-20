#!/usr/bin/env python3
"""Recall benchmark for the anymem Worker.

Runs each query set in bench/sets/ against GET /recall and prints, per set and overall, how often the
right memory is first, in the top 5 and in the top 10, plus MRR (mean reciprocal rank, 1.0 is perfect).
Rankings are by memory name (the `name:` line of the stored frontmatter), repeats removed.

    python3 bench/bench.py            # all sets
    python3 bench/bench.py holdout    # one set
    python3 bench/bench.py real       # the labelled real prompts (see below)
    python3 bench/bench.py --misses   # also list misses

Sets: paraphrase (22, used to pick the fusion change, so optimistic), holdout (16, written afterwards, the honest
one), exact (20 identifiers and names generated from the memory files by make_exact.py), real (labelled prompts from
session logs). Add real misses from daily use to a new set file and rerun. Expected names must exist as memories, the
script says if one does not.

A row with `"exp": []` means the prompt should inject nothing. It has no rank, so it is left out of the top-k and MRR
numbers and the script prints how many were skipped (recall_gate.py scores those rows as quiet). real.json ships as a
placeholder: its first row has a `placeholder` key and no `q`, which the loaders ignore, and a default run leaves the
set out until that row is deleted. Naming it (`bench.py real`) always runs it.

The Worker URL and credentials come from the shared client core (client/hm/config.py): run `setup.py` or
`connect.py` first, or set the ANYMEM_* environment variables. Stdlib only. An unconfigured client prints one line
and exits 1.
Recall counts are not changed, since bench asks with count=0, so repeated runs leave the ranking alone.
"""
from __future__ import annotations

import json, os, re, sys, time, urllib.parse
TIMES = []  # seconds per recall call

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "client"))
from hm import api, config, scripts  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SETS = ["paraphrase", "holdout", "exact"]
SKIPPED_NOTE = "note: real set skipped, sets/real.json still has its placeholder row (delete the row with a `placeholder` key to include it)"
REAL = "real"  # joins a default run once real.json holds real labels, not the placeholder seed


def set_path(name):
    """sets/<name>.local.json when it exists, else sets/<name>.json. The local file is gitignored, so real prompts (personal text from
    session logs) stay on the machine and never reach the repo."""
    local = os.path.join(HERE, "sets", name + ".local.json")
    return local if os.path.exists(local) and not os.environ.get("ANYMEM_BENCH_NO_LOCAL") else os.path.join(HERE, "sets", name + ".json")


def load_set(name):
    """(rows, placeholder) for one set file. An entry without a `q` string is a note, not a query, and is dropped; one that
    carries a `placeholder` key marks the whole file as a seed, so default runs skip it."""
    raw = json.load(open(set_path(name), encoding="utf-8"))
    rows = [x for x in raw if isinstance(x, dict) and isinstance(x.get("q"), str)]
    return rows, any(isinstance(x, dict) and "placeholder" in x for x in raw)


def default_sets():
    """The three tuned sets, plus real once it is filled in. A set that is still the shipped placeholder seed is left out, with a note on stderr."""
    out = []
    for name in SETS + [REAL]:
        if not os.path.exists(set_path(name)):
            continue
        if load_set(name)[1]:
            print("note: %s set skipped, it is still the placeholder seed (put your own in sets/%s.local.json)" % (name, name), file=sys.stderr)  # stderr, so the table on stdout stays as it was
            continue
        out.append(name)
    return out


def recall(settings, query, k=10):
    q = urllib.parse.urlencode({"query": query, "topK": k, "synthesize": "false", "count": 0})
    t0 = time.monotonic()
    data = api.request("GET", "/recall?" + q, timeout=90, settings=settings)
    TIMES.append(time.monotonic() - t0)
    names = []
    for e in data.get("results", []):
        m = re.search(r"^name:\s*(\S+)", e.get("content", ""), re.M)
        n = m.group(1) if m else "?" + e.get("id", "")[:6]
        if n not in names:
            names.append(n)
    return names


def run(settings, set_name, show_misses):
    qs, _ = load_set(set_name)
    ranks, skipped = [], 0
    for x in qs:
        if x["exp"] == []:  # expects nothing injected, so there is no rank to score (a row with no exp key is an error, as before)
            skipped += 1
            continue
        got = recall(settings, x["q"])
        r = next((i for i, n in enumerate(got[:10], 1) if n in x["exp"]), None)
        ranks.append(r)
        if show_misses and r is None:
            print(f"  miss [{set_name}] {x['q'][:70]!r} wanted {x['exp'][0]}, got {got[:3]}")
    return ranks, skipped


def summary(ranks):
    n = len(ranks)
    h = lambda c: sum(1 for v in ranks if v and v <= c)
    return h(1), h(5), h(10), sum(1 / v for v in ranks if v) / n if n else 0.0, n


def main():
    settings = config.load()
    if not settings.configured():
        sys.exit("not configured, run %s or %s" % (scripts.cmd("setup"), scripts.cmd("connect")))
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show = "--misses" in sys.argv
    chosen = args or default_sets()
    allr = []
    print(f"{'set':12}{'queries':>8}{'first':>7}{'top5':>6}{'top10':>7}{'MRR':>7}")
    for s in chosen:
        r, skipped = run(settings, s, show)
        allr += r
        a = summary(r)
        print(f"{s:12}{a[4]:>8}{a[0]:>7}{a[1]:>6}{a[2]:>7}{a[3]:>7.2f}")
        if skipped:
            print(f"  {s}: skipped {skipped} rows with no expected memory (they should inject nothing, recall_gate.py scores them)")
    if len(chosen) > 1:
        a = summary(allr)
        print(f"{'all':12}{a[4]:>8}{a[0]:>7}{a[1]:>6}{a[2]:>7}{a[3]:>7.2f}")
    if TIMES:
        t = sorted(TIMES)
        print(f"recall latency over {len(t)} calls: median {t[len(t) // 2]:.2f}s, p95 {t[int(0.95 * (len(t) - 1))]:.2f}s")


if __name__ == "__main__":
    main()
