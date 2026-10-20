"""Which project a session belongs to. Memories are scoped by project by default.

    current("/path/inside/a/repo") -> "my-repo"      the git root's folder name as a slug
    current("/home/me")            -> None           no project: a global memory

ANYMEM_PROJECT overrides it: a slug to force a project, or "global" (also "none" or "") to force no project.
The home folder and the filesystem root never count as a project, so a session opened there stays global.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

MAX_LEN = 40


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:MAX_LEN].strip("-")


def git_root(cwd: str) -> "Path | None":
    try:
        out = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=2)
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    p = Path(cwd).resolve()
    for d in (p, *p.parents):
        if (d / ".git").exists():
            return d
    return None


def repo_name(root: Path) -> str:
    """The repository's own folder name. Inside a git worktree the toplevel is the worktree folder, so a session there would
    scope to a different project than the main checkout. The common git dir points back at the real repository."""
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                             capture_output=True, text=True, timeout=2)
        common = Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
        if common is not None and common.name == ".git":
            return common.parent.name
    except (OSError, subprocess.SubprocessError):
        pass
    return root.name


def current(cwd: "str | None" = None) -> "str | None":
    forced = os.environ.get("ANYMEM_PROJECT")
    if forced is not None:
        forced = forced.strip().lower()
        return None if forced in ("", "global", "none") else (slug(forced) or None)
    base = cwd or os.getcwd()
    root = git_root(base)
    if root is None or root == Path.home() or root == Path(root.anchor):
        return None
    return slug(repo_name(root)) or None
