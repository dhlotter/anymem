#!/usr/bin/env python3
"""Runnable check for memory_review.py. `python3 test_memory_review.py`, exits non-zero on failure.

No network and no model: a fake Claude Code transcript grows in a temp folder and the clock is passed in, so each case reads as
the moment a turn ends.
"""
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
from contextlib import redirect_stdout

for _key in [k for k in os.environ if k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_", "CLAUDE_CODE_"))]:
    del os.environ[_key]
os.environ["ANYMEM_CONFIG_DIR"] = tempfile.mkdtemp()
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
HOOK = pathlib.Path(__file__).resolve().parent / "memory_review.py"
sys.path.insert(0, str(HOOK.parent))
spec = importlib.util.spec_from_file_location("memory_review", str(HOOK))
mr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mr)
failures = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


TMP = pathlib.Path(tempfile.mkdtemp())
T = TMP / "session.jsonl"


def add(nbytes, user=True):
    """Append one message from the person and then assistant text until the transcript grew by `nbytes`. With user=False the
    person typed almost nothing."""
    target = (T.stat().st_size if T.exists() else 0) + nbytes
    said = "We decided to keep the client in Python because it must stay auditable. " * 4 if user else "ok"
    with open(T, "a") as f:
        f.write(json.dumps({"type": "user", "message": {"content": said}}) + "\n")
        while f.tell() < target:
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "x" * 4000}]}}) + "\n")


def stop(now, **extra):
    return mr.hook({"hook_event_name": "Stop", "session_id": "s1", "transcript_path": str(T), "cwd": str(TMP), **extra}, now)


T0 = 1_000_000.0
add(70_000)
check("the first Stop of a session only starts the clock", stop(T0) is None)
check("first sight stores the offset at the current size", json.loads(mr.STATE.read_text())["s1"]["offset"] == T.stat().st_size)
add(10_000)
check("20 minutes but too little new text asks nothing", stop(T0 + 1300) is None)
add(70_000)
check("enough new text but under 20 minutes asks nothing", stop(T0 + 600) is None)
answer = stop(T0 + 1300)
check("60 KB and 20 minutes with the person talking asks for a review", isinstance(answer, dict) and answer.get("decision") == "block")
reason = (answer or {}).get("reason", "")
check("the request names this install's remember and recall scripts", str(mr.memory_capsule.SCRIPTS / "remember.py") in reason and str(mr.memory_capsule.SCRIPTS / "recall.py") in reason)
check("the request lets the agent say nothing to save", "nothing to save" in reason)
check("the request uses no dashes to join clauses", not any(d in reason.replace("<<'EOF'", "") for d in ("—", "–", " - ", " -- ")))
check("the review resets the clock and the offset", json.loads(mr.STATE.read_text())["s1"] == {"offset": T.stat().st_size, "ts": T0 + 1300})
check("the review is logged to the capture log", '"event": "review", "result": "asked"' in mr.cap.LOG.read_text())
check("the turn the review started never asks again", stop(T0 + 9999, stop_hook_active=True) is None)
add(70_000, user=False)
check("right after a review the clock holds it", stop(T0 + 1400) is None)
check("a long stretch where the person typed little asks nothing", stop(T0 + 2700) is None)
check("and the skipped stretch is not carried into the next one", json.loads(mr.STATE.read_text())["s1"]["ts"] == T0 + 2700)

add(70_000)
os.environ["CLAUDE_CODE_SESSION_ATTENDED"] = "0"
check("a headless claude -p run is never asked", stop(T0 + 9000) is None)
del os.environ["CLAUDE_CODE_SESSION_ATTENDED"]
os.environ["CLAUDE_CODE_ENTRYPOINT"] = "sdk-py"
check("an SDK run is never asked", stop(T0 + 9000) is None)
del os.environ["CLAUDE_CODE_ENTRYPOINT"]
os.environ["ANYMEM_REVIEW"] = "0"
check("ANYMEM_REVIEW=0 turns it off", stop(T0 + 9000) is None)
del os.environ["ANYMEM_REVIEW"]
os.environ["ANYMEM_CAPTURE_CHILD"] = "1"
check("the capture's own model call is never asked", stop(T0 + 9000) is None)
del os.environ["ANYMEM_CAPTURE_CHILD"]
(pathlib.Path(os.environ["ANYMEM_CONFIG_DIR"]) / "config.json").write_text(json.dumps({"capture": "off"}))
check("capture off in the config turns the review off too", stop(T0 + 9000) is None)
(pathlib.Path(os.environ["ANYMEM_CONFIG_DIR"]) / "config.json").unlink()
check("other events are ignored", mr.hook({"hook_event_name": "SessionEnd", "session_id": "s1", "transcript_path": str(T)}, T0 + 9000) is None)

def rollout(source):
    path = TMP / f"rollout-{json.dumps(source)[:20]}.jsonl"
    path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "x", "source": source}}) + "\n")
    return str(path)


check("a codex exec rollout counts as headless", mr.headless(rollout("exec")))
check("a Codex subagent rollout counts as headless", mr.headless(rollout({"subagent": "review"})))
check("an interactive Codex rollout does not", not mr.headless(rollout("cli")) and not mr.headless(rollout("vscode")))
check("a Claude Code transcript does not", not mr.headless(str(T)))
check("a missing file does not raise", mr.headless(str(TMP / "missing.jsonl")) is False)

_real = mr.memory_capsule.SCRIPTS
mr.memory_capsule.SCRIPTS = pathlib.Path(tempfile.mkdtemp())
check("no request when the scripts are not there", stop(T0 + 9000) is None)
mr.memory_capsule.SCRIPTS = _real

add(70_000)
mr.time.time = lambda: T0 + 20000
sys.stdin = io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": "s1", "transcript_path": str(T), "cwd": str(TMP)}))
out = io.StringIO()
with redirect_stdout(out):
    mr.main()
check("main prints one JSON answer Claude Code can read", json.loads(out.getvalue()).get("decision") == "block")
sys.stdin = io.StringIO("not json")
out = io.StringIO()
with redirect_stdout(out):
    mr.main()
check("a broken payload prints nothing and does not raise", out.getvalue() == "")

if failures:
    print(f"\n{len(failures)} failed")
    sys.exit(1)
print("\nall passed")
