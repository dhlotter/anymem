#!/usr/bin/env python3
"""Runnable check for scripts/upgrade-plugins.sh and scripts/bootstrap.sh. Fake claude and codex commands on PATH, a temporary HOME,
and a local git repo standing in for GitHub. No network, no real plugin, no credentials.
`python3 client/tests/test_shell_scripts.py`, exits non-zero on failure."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
UPGRADE = ROOT / "scripts" / "upgrade-plugins.sh"
BOOTSTRAP = ROOT / "scripts" / "bootstrap.sh"
failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


FAKE_CLAUDE = "#!/bin/sh\nexit 0\n"
# `remove` deletes the whole plugin folder, as the real codex does for the old version. `add` fails when FAIL_ADD is set.
FAKE_CODEX = """#!/bin/sh
case "$1 $2" in
  "plugin remove") rm -rf "$HOME/.codex/plugins/cache/anymem/anymem" ;;
  "plugin add") [ -z "$FAIL_ADD" ] || exit 3
                mkdir -p "$HOME/.codex/plugins/cache/anymem/anymem/2.0.2" ;;
esac
exit 0
"""


def run_upgrade(home: Path, fakebin: Path, fail_add: bool):
    env = {"PATH": "%s:%s" % (fakebin, os.defpath), "HOME": str(home)}
    if fail_add:
        env["FAIL_ADD"] = "1"
    p = subprocess.run(["sh", str(UPGRADE)], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


def make_fakebin(base: Path) -> Path:
    fb = base / "bin"
    fb.mkdir()
    for name, body in (("claude", FAKE_CLAUDE), ("codex", FAKE_CODEX)):
        f = fb / name
        f.write_text(body)
        f.chmod(0o755)
    return fb


def seed_cache(home: Path, versions) -> Path:
    cache = home / ".codex" / "plugins" / "cache" / "anymem" / "anymem"
    for v in versions:
        (cache / v).mkdir(parents=True)
        (cache / v / "hook.py").write_text("old " + v)
    return cache


def versions_in(cache: Path):
    return sorted(p.name for p in cache.iterdir()) if cache.is_dir() else []


# ------------------------------------------------------------------ upgrade-plugins.sh
tmp = Path(tempfile.mkdtemp())
fakebin = make_fakebin(tmp)

home = tmp / "home-ok"
cache = seed_cache(home, ["2.0.0", "2.0.1"])
rc, out = run_upgrade(home, fakebin, fail_add=False)
check("upgrade succeeds and keeps every older version next to the new one", rc == 0 and versions_in(cache) == ["2.0.0", "2.0.1", "2.0.2"]
      and (cache / "2.0.0" / "hook.py").read_text() == "old 2.0.0")

home = tmp / "home-addfail"
cache = seed_cache(home, ["2.0.0", "2.0.1"])
rc, out = run_upgrade(home, fakebin, fail_add=True)
check("a failed codex plugin add exits non zero and says so", rc != 0 and "codex plugin add" in out and "failed" in out)
check("a failed codex plugin add puts the older versions back", versions_in(cache) == ["2.0.0", "2.0.1"] and (cache / "2.0.1" / "hook.py").read_text() == "old 2.0.1")

home = tmp / "home-empty"
home.mkdir()
rc, out = run_upgrade(home, fakebin, fail_add=False)
check("no kept versions is not an error, the new version is installed", rc == 0 and versions_in(home / ".codex" / "plugins" / "cache" / "anymem" / "anymem") == ["2.0.2"])

# ------------------------------------------------------------------ bootstrap.sh, from nothing
src = tmp / "source-repo"
(src / "skills" / "anymem" / "scripts").mkdir(parents=True)
(src / "skills" / "anymem" / "scripts" / "init.py").write_text(
    "import pathlib\nprint('ran ' + pathlib.Path(__file__).resolve().parents[3].joinpath('VERSION').read_text().strip())\n")
GIT = ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", "-C", str(src)]


def commit(text: str, message: str):
    (src / "VERSION").write_text(text + "\n")
    subprocess.run(GIT + ["add", "VERSION", "skills"], check=True, capture_output=True)
    subprocess.run(GIT + ["commit", "-q", "-m", message], check=True, capture_output=True)


subprocess.run(["git", "init", "-q", "-b", "main", str(src)], check=True, capture_output=True)
commit("1", "one")
subprocess.run(GIT + ["tag", "v1.0.0"], check=True, capture_output=True)
commit("2", "two")
subprocess.run(GIT + ["tag", "v2.0.0"], check=True, capture_output=True)
commit("3", "three, untagged, on main")

boot_dir = tmp / "elsewhere"
boot_dir.mkdir()
boot = boot_dir / "bootstrap.sh"
shutil.copy(BOOTSTRAP, boot)  # outside a clone, so the script fetches the repo instead of using one


def run_boot(dest: Path, ref: str = ""):
    env = {k: v for k, v in os.environ.items() if not k.startswith("ANYMEM_")}
    env.update(ANYMEM_REPO=str(src), ANYMEM_HOME_DIR=str(dest), HOME=str(tmp / "boot-home"))
    if ref:
        env["ANYMEM_REF"] = ref
    p = subprocess.run(["bash", str(boot)], env=env, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr


rc, out = run_boot(tmp / "dest-default")
check("from nothing the newest release tag is checked out, not the default branch", rc == 0 and "ran 2" in out)
rc, out = run_boot(tmp / "dest-tag", ref="v1.0.0")
check("ANYMEM_REF pins a named tag", rc == 0 and "ran 1" in out)
rc, out = run_boot(tmp / "dest-main", ref="main")
check("ANYMEM_REF=main takes the default branch on purpose", rc == 0 and "ran 3" in out)
commit("4", "four, after the clone")
rc, out = run_boot(tmp / "dest-main", ref="main")
check("a branch ref on an existing clone follows the remote branch, not the copy from the first clone", rc == 0 and "ran 4" in out)
rc, out = run_boot(tmp / "dest-missing", ref="v9.9.9")
check("a ref that does not exist stops with a line that says how to fix it", rc == 1 and "Could not check out v9.9.9" in out)

print("\n%d failed" % len(failures) if failures else "\nall passed")
sys.exit(1 if failures else 0)
