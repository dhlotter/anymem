#!/usr/bin/env python3
"""Gate for the per prompt recall hook: does it inject the right memory, and does it stay quiet when nothing fits?

Runs the hook's own functions (hooks/memory_recall.py clean_query, recall, select) against a live Worker and reports:

  hit        share of queries that have an expected memory where that memory is among the injected ones
  quiet      share of unrelated prompts where nothing is injected (the false injection rate is 1 minus this)
  tails      the same hit rate for benchmark questions with an instruction tail appended, raw query versus cleaned
  real       labelled real prompts, as two lines per cutoff: hit (rows with an expected memory) and quiet (rows with
             `exp: []`, where injecting nothing is the pass). Left out while real.json is the placeholder seed, unless --real

    python3 bench/recall_gate.py          (needs a configured client: setup.py or connect.py first)
    ... python3 bench/recall_gate.py --cutoffs 0,0.3,0.4,0.5,0.6     sweep the similarity cutoff
    ... python3 bench/recall_gate.py --show-sims                      print the similarity of every top hit
    ... python3 bench/recall_gate.py --real                           score bench/sets/real.json even as a placeholder

The cutoff needs the Worker's explain=1 field (`why.dense_score`). Against a Worker without it only cutoff 0 is
meaningful and the script says so. Worker answers are cached in a file per Worker address, in the client's cache folder
(GATE_CACHE overrides the path), so a sweep makes no extra calls. The cache holds memory text, so it is 0600. Delete it after
any change to the Worker.

Pass bars set before the Worker was rebuilt. Hit >= 0.80 on the benchmark sets, quiet >= 0.90 on the unrelated set.
Stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "hooks"))
import memory_recall as hook  # noqa: E402
sys.path.insert(0, str(HERE))
import bench as bench_sets  # noqa: E402  (load_set: the one loader that drops note rows and spots the placeholder seed)

SETS = HERE / "sets"


def cache_path() -> Path:
    """One cache file per Worker address, in the client's cache folder. It holds memory text, so it is never in a shared temp folder."""
    if os.environ.get("GATE_CACHE"):
        return Path(os.environ["GATE_CACHE"])
    url = hook.config.load(use_command=False).url or ""
    return hook.config.cache_dir() / ("recall-gate-%s.json" % hashlib.sha256(url.encode("utf-8")).hexdigest()[:16])


def write_cache(path: Path, data: dict) -> None:
    """Owner only: a 0700 folder and a 0600 file, written under a temporary name and moved into place."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def load(name: str) -> list:
    return bench_sets.load_set(name)[0]


def load_real(force: bool) -> list:
    """The real set's rows, or none when the file is missing or still the placeholder seed (force keeps the seed)."""
    if not os.path.exists(bench_sets.set_path("real")):
        return []
    rows, placeholder = bench_sets.load_set("real")
    if placeholder and not force:
        print(bench_sets.SKIPPED_NOTE + ", or pass --real", file=sys.stderr)
        return []
    return rows


def realistic(x: dict) -> str:
    """A bare identifier is not a prompt anyone sends. Put it in a sentence, as a user would."""
    return x["q"] if len(x["q"]) >= 20 else f"what do we know about {x['q']}"


def raw_query(prompt: str) -> str:
    """What the hook sent before query cleaning existed: reminders stripped, first 300 characters."""
    return " ".join(hook.REMINDER_RE.sub("", prompt).split())[:300]


class Recaller:
    def __init__(self) -> None:
        self.path = cache_path()
        try:
            self.cache = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}

    def warm(self, queries: list[str]) -> None:
        todo = [q for q in dict.fromkeys(queries) if q and q not in self.cache]
        if not todo:
            return
        old, old_k = hook._timeout, hook.TOP_K
        hook._timeout = lambda: 60.0
        hook.TOP_K = 5  # fetch enough candidates to measure injecting up to 5
        try:
            with ThreadPoolExecutor(4) as ex:
                # count=0: measuring must not bump the recall counts on the store it measures
                for q, res in zip(todo, ex.map(lambda q: hook.recall(q, count=0), todo)):
                    # the v2 Worker keeps the project in its own field, the hook's scope rule reads a project: tag
                    self.cache[q] = [{**e, "tags": [*(e.get("tags") or []), *([f"project:{e['project']}"] if e.get("project") else [])]} for e in res]
        finally:
            hook._timeout, hook.TOP_K = old, old_k
        write_cache(self.path, self.cache)

    def get(self, q: str) -> list:
        return self.cache.get(q) or []


def injected(results: list, cutoff: float, k: int = 3, query: str | None = None) -> list[str]:
    old = hook.TOP_K
    hook.TOP_K = k
    try:
        return [i["name"] for i in hook.select(results, set(), cutoff, None, query)]
    finally:
        hook.TOP_K = old


def rate(num: int, den: int) -> str:
    return f"{num}/{den} = {num / den:.2f}" if den else "n/a"


def score_real(real, cutoff: float, k: int, rc) -> tuple:
    """(hits, quiet, hit rows, quiet rows) for the real set. A row with an expected memory is a hit when that memory is injected,
    a row with `exp: []` is quiet when nothing is injected."""
    hits = quiet = n_hit = n_quiet = 0
    for x in real:
        q = hook.clean_query(x["q"])
        got = injected(rc.get(q), cutoff, k, q)
        if x["exp"] != []:
            n_hit += 1
            hits += bool(set(x["exp"]) & set(got))
        else:
            n_quiet += 1
            quiet += not got
    return hits, quiet, n_hit, n_quiet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoffs", default="0")
    ap.add_argument("--show-sims", action="store_true")
    ap.add_argument("--inject", default="3,5", help="how many memories the hook injects, comma separated")
    ap.add_argument("--server", action="store_true", help="trust the v2 Worker's own `relevant` flag instead of applying a cosine cutoff here")
    ap.add_argument("--real", action="store_true", help="score the real set even while it is the placeholder seed")
    a = ap.parse_args()
    cutoffs = [float(x) for x in a.cutoffs.split(",")]
    if a.server:
        hook.relevant = lambda e, cutoff, query=None: bool(e.get("relevant"))
        cutoffs = [0.0]  # the cutoff column is unused, the Worker decided

    bench = {n: load(n) for n in ("paraphrase", "holdout", "exact")}
    tails, unrelated = load("tails"), load("unrelated")
    real = load_real(a.real)
    rc = Recaller()
    for x in bench["exact"]:
        x["q"] = realistic(x)
    queries = [hook.clean_query(x["q"]) for s in bench.values() for x in s]
    queries += [hook.clean_query(x["q"]) for x in tails + unrelated + real] + [raw_query(x["q"]) for x in tails]
    rc.warm([q for q in queries if q])

    have_sim = any("dense_score" in (e.get("why") or {}) for res in rc.cache.values() for e in res)
    if not have_sim and cutoffs != [0.0]:
        print("note: the Worker did not return why.dense_score, only cutoff 0 is meaningful (it comes from the Worker's explain=1 field)\n")
        cutoffs = [0.0]

    if a.show_sims and have_sim:
        print("top hit similarity: relevant benchmark queries versus unrelated prompts")
        def top(q):
            r = [e for e in rc.get(q) if not hook.is_capsule(e)]
            return (r[0].get("why") or {}).get("dense_score") if r else None
        rel = sorted(x for s in bench.values() for x in [top(hook.clean_query(i["q"])) for i in s] if x is not None)
        unr = sorted(x for x in [top(hook.clean_query(i["q"])) for i in unrelated] if x is not None)
        pct = lambda v, p: v[int(p * (len(v) - 1))] if v else float("nan")
        print(f"  relevant  n={len(rel)}  min {pct(rel,0):.3f}  p10 {pct(rel,.1):.3f}  median {pct(rel,.5):.3f}")
        print(f"  unrelated n={len(unr)}  median {pct(unr,.5):.3f}  p90 {pct(unr,.9):.3f}  max {pct(unr,1):.3f}\n")

    for k in [int(v) for v in a.inject.split(",")]:
      print(f"--- injecting up to {k} memories")
      table(k, cutoffs, bench, tails, unrelated, rc, real)


def table(k, cutoffs, bench, tails, unrelated, rc, real=()) -> None:
    print(f"{'cutoff':>7} | {'paraphrase':>14} {'holdout':>14} {'exact':>14} | {'tails raw':>14} {'tails clean':>14} | {'quiet (unrelated)':>18}")
    for c in cutoffs:
        cols = []
        for n in ("paraphrase", "holdout", "exact"):
            hits = sum(1 for x in bench[n] if set(x["exp"]) & set(injected(rc.get(hook.clean_query(x["q"])), c, k, hook.clean_query(x["q"]))))
            cols.append(rate(hits, len(bench[n])))
        t_raw = sum(1 for x in tails if set(x["exp"]) & set(injected(rc.get(raw_query(x["q"])), c, k, raw_query(x["q"]))))
        t_clean = sum(1 for x in tails if set(x["exp"]) & set(injected(rc.get(hook.clean_query(x["q"])), c, k, hook.clean_query(x["q"]))))
        quiet = sum(1 for x in unrelated if not injected(rc.get(hook.clean_query(x["q"])), c, k, hook.clean_query(x["q"])))
        print(f"{c:>7.2f} | {cols[0]:>14} {cols[1]:>14} {cols[2]:>14} | {rate(t_raw, len(tails)):>14} {rate(t_clean, len(tails)):>14} | {rate(quiet, len(unrelated)):>18}")
    for c in cutoffs if real else ():
        hits, quiet, n_hit, n_quiet = score_real(real, c, k, rc)
        print(f"real, cutoff {c:.2f}: hit   {rate(hits, n_hit)}")
        print(f"real, cutoff {c:.2f}: quiet {rate(quiet, n_quiet)}")


if __name__ == "__main__":
    main()
