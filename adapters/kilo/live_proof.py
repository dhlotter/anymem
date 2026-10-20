#!/usr/bin/env python3
"""Live check of the kilo adapter against the real `kilo` command, in a throwaway home. Needs Kilo and a model it can reach.

    /usr/bin/python3 adapters/kilo/live_proof.py [--model kilo/kilo-auto/free] [--record DIR]

Everything happens under one temporary folder: a fresh HOME for Kilo, a throwaway project, and the anymem config and
cache folders. A fake Worker (client/hm/testing/fake_worker.py) stands in for the real one, so no credential and no real
memory is involved. Steps:

    1. prime the home with one plain Kilo run (Kilo creates its own files on first use), then snapshot ~/.config
    2. install() the plugin into that home. First a bare install then uninstall, which must leave ~/.config byte identical
    3. run Kilo with a prompt about a memory that only the fake Worker holds, and a capsule that only it holds:
       the answer must contain both unique words, and the fake Worker must see GET /recall and GET /prompt-capsules/core
    4. the same prompt is padded past the 8 KB capture floor, so the fake Worker must receive POST /extract and POST /capture
    5. a short session: the capture hook declines (under 8 KB), and the capture state shows it
    6. uninstall() and compare ~/.config with the snapshot. Kilo installs its own plugin dependencies (kilo/node_modules and
       friends) the first time it sees a global plugin folder, that is Kilo's file and stays, so it is listed apart

--record DIR also saves the payloads the plugin sent to hook.py during step 5 and the spool file, as fixtures.
Prints one line per observation and a final JSON summary. Exit 0 when every proof holds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "client"))
from hm.testing import fake_worker  # noqa: E402


KILO_OWN = "kilo/node_modules"
KILO_OWN_FILES = {"kilo/package.json", "kilo/package-lock.json", "kilo/bun.lock", "kilo/bun.lockb"}


def word(prefix: str) -> str:
    return prefix + "".join(random.choice(string.ascii_lowercase) for _ in range(7))


def snapshot(folder: Path) -> dict:
    """{relative path: sha256 of the bytes, or 'dir'} for everything under folder."""
    out = {}
    for p in sorted(folder.rglob("*")):
        rel = str(p.relative_to(folder))
        out[rel] = "dir" if p.is_dir() else ("link" if p.is_symlink() else hashlib.sha256(p.read_bytes()).hexdigest()[:16])
    return out


def real_home_listing() -> dict:
    """Names only of the two real folders this run must never touch. Nothing is read from inside them."""
    home = Path.home()
    return {str(rel): sorted(x.name for x in (home / rel).iterdir()) if (home / rel).is_dir() else None
            for rel in (Path(".config/kilo/plugin"), Path(".config/anymem"))}


def say(text: str) -> None:
    print(text, flush=True)


def kilo(env: dict, project: Path, model: str, prompt: str, timeout: int = 240) -> str:
    done = subprocess.run(["kilo", "run", "--dir", str(project), "-m", model, prompt], stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, env=env, timeout=timeout)
    return (done.stdout + done.stderr).replace("\x1b[0m", "").strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", default="kilo/kilo-auto/free")
    ap.add_argument("--record", help="folder to save the recorded payloads and spool as fixtures")
    args = ap.parse_args()
    if not shutil.which("kilo"):
        say("BLOCKED: the kilo command is not on PATH")
        return 2
    sys.path.insert(0, str(HERE))
    import importlib.util
    spec = importlib.util.spec_from_file_location("kilo_adapter_live", HERE / "adapter.py")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)

    tmp = Path(tempfile.mkdtemp(prefix="hm-kilo-live-"))
    home, project, cfg, cache, rec = tmp / "home", tmp / "project", tmp / "hm-config", tmp / "hm-cache", tmp / "recorded"
    for d in (home, project, cfg, cache, rec):
        d.mkdir()
    marker, mascot = word("ferry"), word("otter")
    memory = {"id": "live-0001", "tags": ["status:canonical"],
              "content": f"---\nname: ferry-route-codename\ndescription: The codename we agreed for the ferry route\n---\n\nThe ferry route codename is {marker}."}
    proposal = {"name": "ferry-route-codename-live", "type": "project", "description": "Codename agreed for the ferry route in the live check",
                "body": f"The ferry route has an agreed codename, {marker}.\n**Why:** it was chosen during the live check of the Kilo adapter.\n**How to apply:** use it when the ferry route comes up."}
    srv = fake_worker.start(recall=[memory], capsule=[{"slot": "identity", "content": f"The project mascot is the {mascot}."}], proposals=[proposal])
    shim = tmp / "python-shim.sh"  # tees the plugin's stdin to a file, then runs the real interpreter
    shim.write_text('#!/bin/sh\nmkdir -p "$HM_RECORD_DIR"\ntee "$HM_RECORD_DIR/$2-$$.json" | exec "%s" "$@"\n' % sys.executable)
    shim.chmod(0o755)
    env = {**{k: v for k, v in os.environ.items() if not k.startswith(("ANYMEM", "XDG_"))},
           "HOME": str(home), "ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-0000",
           "ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": str(cache), "ANYMEM_EXTRACTION": "worker"}
    ok = True

    def prove(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        ok = ok and bool(cond)
        say(f"{'PROVEN ' if cond else 'FAILED '} {label}{(': ' + detail) if detail else ''}")

    real_before = real_home_listing()
    say(f"throwaway folder: {tmp}")
    say("step 1: priming run, no plugin")
    kilo(env, project, args.model, "Reply with the single word OK")
    before = snapshot(home / ".config")

    say("step 2: install")
    Options = SimpleNamespace(dry_run=False, yes=True, plugin_root=ROOT, home=home)
    os.environ["ANYMEM_HOME"] = str(home)
    adapter.install(Options)
    adapter.uninstall()
    prove("bare install then uninstall leaves ~/.config byte identical", snapshot(home / ".config") == before)
    plan = adapter.plan(Options)
    changed = adapter.install(Options)["changed"]
    say("  plan: " + " | ".join(plan))
    say("  changed: " + ", ".join(str(Path(c).relative_to(home)) for c in changed))
    os.environ.update({"ANYMEM_HOME": str(home), "ANYMEM_URL": srv.url, "ANYMEM_TOKEN": "test-token-0000",
                       "ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": str(cache)})
    res = adapter.check()
    prove("check() ok and the Worker answered /health", res["ok"] and ("GET", "/health", None) in srv.requests, json.dumps(res))

    say("step 3: a prompt about a memory only the fake Worker holds")
    question = "Which codename did we agree for the ferry route, and what is the project mascot?"
    answer = kilo(env, project, args.model, question + " Answer in one short line using only the context you were given.")
    say("  model answer: " + answer.replace("\n", " ")[-300:])
    paths = [p for _, p, _ in srv.requests]
    prove("recall marker reached the model", marker in answer, marker)
    prove("capsule marker reached the model", mascot in answer, mascot)
    prove("the Worker saw GET /recall and GET /prompt-capsules/core", any(p.startswith("/recall") for p in paths) and "/prompt-capsules/core" in paths)

    say("step 4: the same question padded past the 8 KB capture floor")
    filler = " ".join(f"Filler note {i}: nothing in this line matters, it only makes the session long enough to capture." for i in range(110))
    kilo(env, project, args.model, f"{question} The notes below are filler, ignore them. {filler} Answer in one short line.")
    for _ in range(60):  # the capture worker is detached, give it time
        if srv.captured:
            break
        time.sleep(0.5)
    paths = [p for _, p, _ in srv.requests]
    prove("the Worker received POST /extract from the capture worker", "/extract" in paths)
    prove("the Worker received POST /capture", bool(srv.captured), json.dumps({k: (v if k != "content" else v[:70]) for k, v in (srv.captured[0] if srv.captured else {}).items()}))
    log = (cache / "capture.log")
    say("  capture.log: " + (log.read_text().strip().splitlines()[-1][:300] if log.exists() else "missing"))
    spools = sorted((cache / "kilo").glob("*.jsonl"))
    say("  spool files: " + ", ".join(f"{p.name} ({p.stat().st_size} bytes)" for p in spools))

    say("step 5: a short session, the capture hook should decline")
    n_capture, n_extract = len(srv.captured), paths.count("/extract")
    env_short = {**env, "ANYMEM_PYTHON": str(shim), "HM_RECORD_DIR": str(rec)}
    kilo(env_short, project, args.model, "Reply with the single word OK")
    time.sleep(3)
    state = json.loads((cache / "capture-state.json").read_text())
    short_sid = max((cache / "kilo").glob("*.jsonl"), key=lambda p: p.stat().st_mtime).stem
    prove("the short session started no capture worker", len(srv.captured) == n_capture and [p for _, p, _ in srv.requests].count("/extract") == n_extract,
          f"spool {(cache / 'kilo' / (short_sid + '.jsonl')).stat().st_size} bytes, floor 8000, state offset {state.get(short_sid, {}).get('offset')}")
    prove("the capture state saw the session and recorded no worker run", short_sid in state and not state[short_sid].get("done"))

    if args.record:
        out = Path(args.record)
        out.mkdir(parents=True, exist_ok=True)
        def scrub(text: str) -> str:  # the throwaway folder's name is not part of a fixture
            for variant in {str(tmp), str(tmp.resolve())}:
                text = text.replace(variant, "/tmp/hm-kilo-fixture")
            return text
        for f in rec.glob("*.json"):
            (out / (f.stem.rsplit("-", 1)[0] + ".json")).write_text(scrub(f.read_text()))
        (out / "spool.jsonl").write_text(scrub((cache / "kilo" / (short_sid + ".jsonl")).read_text()))
        say(f"  recorded fixtures: {sorted(p.name for p in out.iterdir())}")

    say("step 6: uninstall")
    gone = adapter.uninstall()
    say("  changed: " + ", ".join(str(Path(c).relative_to(home)) for c in gone["changed"]))
    after = snapshot(home / ".config")
    differences = sorted(set(after) ^ set(before) | {k for k in before if k in after and before[k] != after[k]})
    kilos_own = [d for d in differences if d.startswith(KILO_OWN) or d in KILO_OWN_FILES]
    ours = [d for d in differences if d not in kilos_own]
    prove("check() reports the wiring gone", not adapter.check()["ok"])
    prove("our plugin file and folders are gone", not (home / ".config/kilo/plugin/anymem.js").exists())
    prove("after the live run and uninstall, ~/.config differs from the snapshot only by Kilo's own dependency install", not ours,
          f"{len(kilos_own)} paths Kilo added itself (kilo/node_modules and its package files), ours left behind: {ours or 'none'}")
    prove("the real home was not touched (kilo plugin folder and anymem config folder listings unchanged)", real_home_listing() == real_before)
    srv.stop()
    say("summary: " + json.dumps({"ok": ok, "requests": [f"{m} {p.split('?')[0]}" for m, p, _ in srv.requests][:40]}))
    if ok:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        say(f"kept {tmp} for inspection")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
