#!/usr/bin/env python3
"""Runnable check for hm.project."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import project  # noqa: E402
from hm.commands import remember  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


os.environ.pop("ANYMEM_PROJECT", None)
check("slug lowercases and replaces odd characters", project.slug("My Repo_v2!") == "my-repo-v2")
check("slug is capped", len(project.slug("a" * 100)) == project.MAX_LEN)
base = Path(tempfile.mkdtemp()).resolve()
repo = base / "Cool Project"
(repo / "src" / "deep").mkdir(parents=True)
subprocess.run(["git", "init", "-q", str(repo)], check=True)
check("a folder inside a repo gives the repo's slug", project.current(str(repo / "src" / "deep")) == "cool-project")
plain = base / "notes"
plain.mkdir()
check("a folder outside any repo is global", project.current(str(plain)) is None)
home_repo = base / "home-as-repo"
(home_repo / "src").mkdir(parents=True)
subprocess.run(["git", "init", "-q", str(home_repo)], check=True)
real_home = os.environ.get("HOME")
os.environ["HOME"] = str(home_repo)
try:
    check("the home folder is never a project, even when it is a git repo", project.current(str(home_repo)) is None and project.current(str(home_repo / "src")) is None)
finally:
    if real_home is None:
        os.environ.pop("HOME", None)
    else:
        os.environ["HOME"] = real_home
os.environ["ANYMEM_PROJECT"] = "Forced Name"
check("the environment can force a project", project.current(str(plain)) == "forced-name")
os.environ["ANYMEM_PROJECT"] = "global"
check("the environment can force global even inside a repo", project.current(str(repo)) is None)
os.environ["ANYMEM_PROJECT"] = ""
check("an empty override means global", project.current(str(repo)) is None)
os.environ.pop("ANYMEM_PROJECT", None)
wt = base / "wt-copy"
subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(wt), "-b", "side"], check=True)
check("a git worktree scopes to the real repository, not its own folder name", project.current(str(wt)) == "cool-project")
check("remember --project is slugged, so it matches the repo's own name in recall", remember.body_for(argparse.Namespace(tag=[], project="My_Repo"), "x")["project"] == "my-repo")
check("remember --project global still means no project", "project" not in remember.body_for(argparse.Namespace(tag=[], project="global"), "x"))
print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
