#!/usr/bin/env python3
"""One timed rehearsal of the migration against a rehearsal Worker. Stdlib only.

    python3 migration/rehearse.py SOURCE.json --label "rehearsal 1" --log LOG.md --work DIR [--reset]

SOURCE.json is what migrate_v1_to_v2.py export saved. Stages, in order, each timed, each appended to the log file as soon as it ends
so a crash keeps the progress.

    reset      empty the rehearsal store (only with --reset, needs the Cloudflare variables of reset_rehearsal.py)
    convert    map the export to a v2 document
    load       paged import, then reindex until the vectors are done
    questions  write search questions for every memory, then reindex again
    compare    row by row compare of the document and the store, and of the raw export and the store
    doctor     skills/anymem/scripts/doctor.py --probe
    bench      bench/bench.py
    gate       bench/recall_gate.py --server --real

The target comes from TARGET_URL and TARGET_TOKEN. The client scripts read ANYMEM_URL and ANYMEM_TOKEN, which this sets from those,
and ANYMEM_CONFIG_DIR and ANYMEM_CACHE_DIR, which it points at DIR so no real client config is touched. Refuses the live address.
The log gets ids and numbers only, never content or credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import migrate_v1_to_v2 as mig  # noqa: E402


def stage_env(environ, work: Path) -> dict:
    """The environment of the client scripts run against the target. The target's Access pair (TARGET_ACCESS_*) becomes the
    ANYMEM_ACCESS_* pair they read, so they reach the Worker through Access. Nothing from the real client config is read."""
    env = dict(environ, ANYMEM_URL=environ["TARGET_URL"], ANYMEM_TOKEN=environ["TARGET_TOKEN"], ANYMEM_CONFIG_DIR=str(work / "config"),
               ANYMEM_CACHE_DIR=str(work / "cache"), GATE_CACHE=str(work / "gate-cache.json"))
    for k, source in (("ANYMEM_ACCESS_CLIENT_ID", "TARGET_ACCESS_CLIENT_ID"), ("ANYMEM_ACCESS_CLIENT_SECRET", "TARGET_ACCESS_CLIENT_SECRET")):
        env.pop(k, None)
        if environ.get(source):
            env[k] = environ[source]
    return env


class Log:
    def __init__(self, path: Path, label: str):
        self.path, self.label = path, label

    def add(self, text: str) -> None:
        print(text, flush=True)
        with open(self.path, "a") as f:
            f.write(text + "\n")


def run(cmd: list, env: dict, out: Path) -> tuple:
    """Runs a command, saves its output to a file, returns (seconds, exit code, last lines)."""
    t = time.time()
    p = subprocess.run(cmd, env=env, capture_output=True, text=True)
    out.write_text(p.stdout + p.stderr)
    tail = [l for l in (p.stdout + p.stderr).splitlines() if l.strip()]
    return round(time.time() - t, 1), p.returncode, tail


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source")
    ap.add_argument("--label", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--work", required=True, help="a folder for the document and each stage's output")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--no-questions", action="store_true")
    ap.add_argument("--at", type=int, default=None, help="the import time in ms, default now")
    args = ap.parse_args(argv)
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    log = Log(Path(args.log), args.label)
    target = mig.target_http()
    env = stage_env(os.environ, work)
    py = sys.executable
    failed = []
    log.add("\n### %s, started %s UTC" % (args.label, time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())))
    wall = time.time()

    def stage(name: str, seconds: float, ok: bool, detail: str) -> None:
        log.add("%d. %s took %.1fs, %s. %s" % (stage.n, name, seconds, "ok" if ok else "FAILED", detail))
        stage.n += 1
        if not ok:
            failed.append(name)

    stage.n = 1
    if args.reset:
        s, code, tail = run([py, str(HERE / "reset_rehearsal.py")], env, work / "reset.txt")
        stage("reset", s, code == 0, "; ".join(tail[-2:]))
    src = json.loads(Path(args.source).read_text())
    t = time.time()
    doc, report = mig.build_document(src["export"], src["trash"], src["histories"], args.at if args.at is not None else int(time.time() * 1000))
    doc_path = work / "document.json"
    mig.write_private(doc_path, json.dumps(doc))
    counts = {k: v for k, v in report.items() if k != "errors"}
    stage("convert", time.time() - t, not report["errors"], "%s, error ids %s" % (json.dumps(counts), [e["id"] for e in report["errors"]][:10]))

    t = time.time()
    result = mig.load_document(target, doc, say=lambda s: None)
    stage("load", time.time() - t, not result["error_ids"] and not result["skipped"], "import %.1fs, reindex %.1fs in %d rounds, %s" % (result["import_seconds"], result["reindex_seconds"], result["reindex_rounds"], json.dumps({k: result[k] for k in ("imported", "skipped", "versions", "links", "devices")})))

    if not args.no_questions:
        t = time.time()
        q = mig.write_questions(target, say=lambda s: None)
        stage("questions", time.time() - t, True, "%d questions in %d rounds (%.1fs), reindex %d rounds (%.1fs)" % (q["questions"], q["question_rounds"], q["question_seconds"], q["reindex_rounds"], q["reindex_seconds"]))

    s, code, tail = run([py, str(HERE / "compare.py"), str(doc_path), "target", "--v1", args.source], env, work / "compare.txt")
    stage("compare", s, code == 0, " | ".join(l for l in tail if l.split()[0] in ("memories", "live", "trash", "pinned", "versions", "links", "devices", "differences:", "PASS", "FAIL")))
    for l in tail:
        if l.startswith("  "):
            log.add("   " + l.strip())

    s, code, tail = run([py, str(ROOT / "skills/anymem/scripts/doctor.py"), "--probe"], env, work / "doctor.txt")
    verdict = next((l for l in tail if l.startswith("verdict")), "no verdict")
    bad = [l.split()[0] + " " + l.split()[1] for l in tail if l.startswith(("FAIL", "WARN"))]
    stage("doctor --probe", s, code == 0, "%s %s" % (verdict, bad))

    s, code, tail = run([py, str(ROOT / "bench/bench.py")], env, work / "bench.txt")
    rows = [l for l in tail if l.split()[0] in ("set", "paraphrase", "holdout", "exact", "real", "all", "recall")]
    stage("bench", s, code == 0, " | ".join(" ".join(r.split()) for r in rows))

    s, code, tail = run([py, str(ROOT / "bench/recall_gate.py"), "--server", "--real"], env, work / "gate.txt")
    rows = [" ".join(l.split()) for l in tail if l.startswith(("0.00", "   0.00", "real", "---")) or "0.00 |" in l]
    stage("recall gate", s, code == 0, " | ".join(rows))

    log.add("%s finished after %.1fs, %s." % (args.label, time.time() - wall, "all stages ok" if not failed else "failed stages " + ", ".join(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
