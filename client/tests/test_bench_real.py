#!/usr/bin/env python3
"""Runnable check for the bench `real` set (bench/bench.py, bench/recall_gate.py, bench/sets/real.json). No network, no secrets:
the Worker call is a stub, plus one pass against the in-repo fake Worker on 127.0.0.1."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
os.environ["ANYMEM_CONFIG_DIR"] = tempfile.mkdtemp()  # the client and the hook read and write here, never the real config or cache
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
os.environ["GATE_CACHE"] = os.path.join(tempfile.mkdtemp(), "gate-cache.json")
os.environ["ANYMEM_PROJECT"] = "global"
os.environ["ANYMEM_BENCH_NO_LOCAL"] = "1"  # a real.local.json on this machine must not change what the seed checks see
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT / "bench"))
import bench  # noqa: E402
import recall_gate as gate  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


hit = lambda name, sim: {"id": "id-" + name, "content": f"---\nname: {name}\ndescription: d\n---\nbody", "tags": [], "why": {"dense_score": sim, "keyword_terms": []}}

# the seed file
rows, placeholder = bench.load_set("real")
quiet_rows = [x for x in rows if not x["exp"]]
hit_rows = [x for x in rows if x["exp"]]
check("the seed has 6 to 8 query rows, none of them the note row", 6 <= len(rows) <= 8 and all("placeholder" not in x for x in rows))
check("the seed marks itself as a placeholder", placeholder)
check("the seed mixes 2 or 3 quiet rows with hit rows", 2 <= len(quiet_rows) <= 3 and len(hit_rows) >= 3)
check("the seed's expected names are generic placeholders", all(n.startswith("placeholder-") for x in hit_rows for n in x["exp"]))
check("every seed query is long enough for the hook to search", all(gate.hook.clean_query(x["q"]) for x in rows))
check("the shipped tuned sets are placeholder seeds, and unrelated is a plain set of 20", all(bench.load_set(n)[1] for n in ("paraphrase", "holdout", "exact", "tails"))
      and not bench.load_set("unrelated")[1] and len(bench.load_set("unrelated")[0]) == 20)
check("no shipped set names a memory outside the made up examples", all(n.startswith(("example-", "placeholder-")) for name in ("paraphrase", "holdout", "exact", "tails", "real") for x in bench.load_set(name)[0] for n in x["exp"]))

# default runs: the placeholder stays out until it is filled in
check("a default run leaves every placeholder set out", bench.default_sets() == [])
here = bench.HERE
tmp = Path(tempfile.mkdtemp())
(tmp / "sets").mkdir()
try:
    bench.HERE = str(tmp)
    check("a default run with no set files runs nothing", bench.default_sets() == [])
    for name in bench.SETS:
        (tmp / "sets" / (name + ".json")).write_text(json.dumps([{"q": "a labelled prompt for " + name, "exp": ["m1"]}]), encoding="utf-8")
    check("a default run without a real file is the three tuned sets once they are real", bench.default_sets() == bench.SETS)
    (tmp / "sets" / "real.json").write_text(json.dumps([{"note": "just a note"}, {"q": "a labelled prompt about the example service", "exp": ["m1"]}]), encoding="utf-8")
    check("a real file without the placeholder key joins a default run, note rows dropped", bench.default_sets() == bench.SETS + ["real"] and len(bench.load_set("real")[0]) == 1)
    (tmp / "sets" / "real.local.json").write_text(json.dumps([{"q": "a private prompt that stays on the machine", "exp": []}]), encoding="utf-8")
    check("the local file is ignored when told to, so tests see the tracked set", len(bench.load_set("real")[0]) == 1 and bench.load_set("real")[0][0]["q"].startswith("a labelled"))
    del os.environ["ANYMEM_BENCH_NO_LOCAL"]
    check("a gitignored real.local.json wins over real.json", bench.load_set("real")[0][0]["q"].startswith("a private prompt"))
    os.environ["ANYMEM_BENCH_NO_LOCAL"] = "1"
    (tmp / "sets" / "real.local.json").unlink()
    (tmp / "sets" / "typo.json").write_text(json.dumps([{"q": "a prompt whose label has the wrong key", "expected": ["m1"]}]), encoding="utf-8")
    try:
        bench.run(None, "typo", False)
        raised = False
    except KeyError:
        raised = True
    check("a row with no exp key is an error, not a quiet row", raised)
finally:
    bench.HERE = here

# bench.py with a stubbed /recall: exp [] rows are skipped, the rest are ranked
asked = []


def stub_request(method, path, timeout=None, settings=None):
    asked.append(path)
    names = ["other-a", "placeholder-memory-one", "placeholder-memory-three"] if "deploy+process" in path else ["other-b"]
    return {"results": [{"id": f"id{i}", "content": f"---\nname: {n}\n---\nbody"} for i, n in enumerate(names)]}


real_request, bench.api.request = bench.api.request, stub_request
try:
    ranks, skipped = bench.run(None, "real", False)
finally:
    bench.api.request = real_request
check("bench skips the exp [] rows and counts them", skipped == len(quiet_rows) and len(ranks) == len(hit_rows))
check("bench never asks the Worker about a skipped row", len(asked) == len(hit_rows) and not any("boiling" in p for p in asked))
check("bench ranks a hit row by the name in the content", ranks[0] == 2 and ranks[1:] == [None] * (len(hit_rows) - 1))
check("the summary copes with a set that has no ranked rows", bench.summary([]) == (0, 0, 0, 0.0, 0))
check("the summary of the real ranks is right", bench.summary(ranks)[:3] == (0, 1, 1))

# recall_gate.py: quiet rows and hit rows are scored apart
real = [{"q": "what do we know about the deploy process for the example service", "exp": ["placeholder-memory-one"]},
        {"q": "what is the boiling point of water at sea level in celsius", "exp": []},
        {"q": "write a function that returns the sum of a list of integers", "exp": []},
        {"q": "how did we decide to handle the retry logic in the example client", "exp": ["placeholder-memory-four"]}]
rc = gate.Recaller()
rc.cache = {
    gate.hook.clean_query(real[0]["q"]): [hit("placeholder-memory-one", 0.9)],
    gate.hook.clean_query(real[1]["q"]): [hit("unrelated-note", 0.3)],   # below a 0.6 cutoff, so nothing is injected
    gate.hook.clean_query(real[2]["q"]): [hit("unrelated-note", 0.8)],   # above it, so this prompt gets a false injection
    gate.hook.clean_query(real[3]["q"]): [hit("placeholder-memory-one", 0.9)],  # injects, but the wrong memory
}
check("at cutoff 0.6 one of two hit rows and one of two quiet rows pass", gate.score_real(real, 0.6, 3, rc) == (1, 1, 2, 2))
check("at cutoff 0 every row injects, so no quiet row passes", gate.score_real(real, 0.0, 3, rc) == (1, 0, 2, 2))
check("a set with no quiet rows reports no quiet rows", gate.score_real(real[:1], 0.6, 3, rc) == (1, 0, 1, 0))
out = io.StringIO()
with contextlib.redirect_stdout(out):
    gate.table(3, [0.6], {n: [] for n in ("paraphrase", "holdout", "exact")}, [], [], rc, real)
text = out.getvalue()
check("the gate prints a hit line and a quiet line for real", "real, cutoff 0.60: hit   1/2 = 0.50" in text and "real, cutoff 0.60: quiet 1/2 = 0.50" in text)
out = io.StringIO()
with contextlib.redirect_stdout(out):
    gate.table(3, [0.6], {n: [] for n in ("paraphrase", "holdout", "exact")}, [], [], rc)
check("the gate prints nothing extra without a real set", "real," not in out.getvalue())
check("the gate leaves the placeholder out unless asked", gate.load_real(False) == [] and len(gate.load_real(True)) == len(rows))
check("the gate's own loader drops note rows", all("q" in x for x in gate.load("real")))

# the gate's cache: one file per Worker address, in the client's cache folder, 0600, and recall is asked with count=0
os.environ.pop("GATE_CACHE", None)
os.environ["ANYMEM_URL"] = "http://gate-a.example.test"
path_a = gate.cache_path()
os.environ["ANYMEM_URL"] = "http://gate-b.example.test"
path_b = gate.cache_path()
check("the cache file is per Worker address", path_a != path_b and path_a.parent == gate.hook.config.cache_dir())
gate_tmp = Path(tempfile.mkdtemp()) / "cache-check" / "x.json"
gate.write_cache(gate_tmp, {"q": []})
check("the cache file is written 0600 in a 0700 folder", (os.stat(gate_tmp).st_mode & 0o777) == 0o600 and (os.stat(gate_tmp.parent).st_mode & 0o777) == 0o700)
sent = []
real_recall = gate.hook.recall
gate.hook.recall = lambda q, project=None, seen=None, count=1: sent.append(count) or []
os.environ["GATE_CACHE"] = os.path.join(tempfile.mkdtemp(), "count-check.json")
try:
    rc_count = gate.Recaller()
    rc_count.warm(["what do we know about the retry logic", "deploy process for the example service"])
finally:
    gate.hook.recall = real_recall
check("the gate asks the Worker with count 0, so it does not count recalls", sent == [0, 0])
check("the recall parameters carry count 0 when asked", gate.hook.recall_params("q", None, set(), 0)["count"] == 0 and gate.hook.recall_params("q", None, set())["count"] == 1)

# the same scripts against the in-repo fake Worker (a static answer for every query)
srv = fake_worker.start(recall=[hit("placeholder-memory-one", 0.8), hit("placeholder-memory-four", 0.8)])
os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"] = srv.url, "fake-token-for-tests"
try:
    ranks, skipped = bench.run(bench.config.load(), "real", False)
    check("bench runs the seed against the fake Worker", skipped == len(quiet_rows) and ranks[0] == 1 and ranks[2] == 2)
    rc = gate.Recaller()
    rc.cache = {}
    rc.warm([gate.hook.clean_query(x["q"]) for x in rows])
    check("the gate scores the seed against the fake Worker", gate.score_real(rows, 0.6, 3, rc) == (2, 0, len(hit_rows), len(quiet_rows)))
finally:
    srv.stop()

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
