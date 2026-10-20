"""The kilo adapter: wires anymem into Kilo (command `kilo`, an OpenCode derived agent). Contract: adapters/README.md.

Kilo loads JavaScript plugins from ~/.config/kilo/plugin/*.js, so install writes exactly one file there,
anymem.js, a copy of plugin.js with the plugin root and the Python path baked in. No Kilo config file is edited.
The file is marked by its first line, so install never overwrites a file that is not ours, and uninstall removes only ours.

install:   writes <home>/.config/kilo/plugin/anymem.js (and the folders above it that did not exist, which it
           records in the file's header so uninstall can take them away again). An existing copy of our own file is
           backed up once as anymem.js.anymem.bak before it is replaced.
uninstall: deletes that file, the backup, and the folders install created when they are empty. Afterwards the folder
           tree is byte identical to what it was before install.
check:     reads the file, checks the baked paths, and asks the Worker /health. Writes nothing.

The home folder is options.home for install, and ANYMEM_HOME (else the real home) for detect, check and uninstall,
which the contract calls without options.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from hm import scripts

NAME = "kilo"
TITLE = "Kilo"

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "plugin.js"
PLUGIN_FILE = "anymem.js"
BACKUP_SUFFIX = ".anymem.bak"
BEGIN = "// anymem begin"
BAKED_RE = re.compile(r"^const BAKED = .*$", re.M)
DIRS_RE = re.compile(r"^// created-dirs: (.*)$", re.M)
SHARED_HOOKS = ("memory_recall.py", "memory_capsule.py", "memory_capture.py")


def _home(options=None) -> Path:
    if options is not None and getattr(options, "home", None):
        return Path(options.home)
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def _plugin_dir(home: Path) -> Path:
    return home / ".config" / "kilo" / "plugin"


def _plugin_path(home: Path) -> Path:
    return _plugin_dir(home) / PLUGIN_FILE


def _is_ours(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8") as f:
            return f.readline().startswith(BEGIN)
    except (OSError, UnicodeDecodeError):
        return False


def _missing_dirs(home: Path) -> list:
    """The folders between home and the plugin file that do not exist yet, outermost first."""
    out, d = [], _plugin_dir(home)
    while d != home and not d.exists():
        out.append(d)
        d = d.parent
    return list(reversed(out))


def _problems_with_root(root: Path) -> list:
    """What is missing under a plugin root, as plain sentences."""
    missing = [f"hooks/{name}" for name in SHARED_HOOKS if not (root / "hooks" / name).is_file()]
    missing += [rel for rel in ("client/hm/config.py", "adapters/kilo/hook.py", "adapters/kilo/transcript.py") if not (root / rel).is_file()]
    return [f"the plugin root {root} has no {rel}" for rel in missing]


def _baked(path: Path) -> dict:
    """The {root, python} baked into an installed plugin file, {} when it cannot be read."""
    try:
        m = re.search(r"^const BAKED = (\{.*\});\s*$", path.read_text(encoding="utf-8"), re.M)
        data = json.loads(m.group(1)) if m else {}
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _render(root: Path, python: str, created: list) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    baked = "const BAKED = " + json.dumps({"root": str(root), "python": python}) + ";"
    # json.dumps escapes quotes and backslashes, and a callable replacement keeps re from reading them as group references
    text, n1 = BAKED_RE.subn(lambda _m: baked, text, count=1)
    text, n2 = DIRS_RE.subn(lambda _m: "// created-dirs: " + json.dumps([str(d) for d in created]), text, count=1)
    if n1 != 1 or n2 != 1 or not text.startswith(BEGIN):
        raise ValueError(f"{TEMPLATE} is not the plugin template this adapter expects, nothing was written")
    return text


def detect() -> dict:
    """Read only. Kilo is found when the `kilo` command is on PATH."""
    home = _home()
    exe = shutil.which("kilo")
    version, notes = "", []
    if exe:
        try:
            out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
            version = out.stdout.strip().splitlines()[-1] if out.returncode == 0 and out.stdout.strip() else ""
        except (OSError, subprocess.SubprocessError):
            notes.append("could not read the Kilo version")
    else:
        notes.append("the kilo command is not on PATH")
    target = _plugin_path(home)
    if target.exists():
        notes.append("the anymem plugin is already installed" if _is_ours(target) else f"{target} exists and is not ours, install will refuse it")
    return {"found": bool(exe), "version": version, "config_path": str(target), "notes": notes}


def plan(options) -> list:
    home = _home(options)
    target = _plugin_path(home)
    lines = [f"Write one Kilo plugin file: {target}. Kilo loads every plugin in that folder, so no Kilo config file is edited."]
    if target.exists() and not _is_ours(target):
        lines.append(f"{target} already exists and is not ours, so install will stop without changing anything.")
    elif target.exists():
        lines.append(f"Our own earlier copy is replaced, after one backup as {target.name}{BACKUP_SUFFIX}.")
    for d in _missing_dirs(home):
        lines.append(f"Create the folder {d} (uninstall removes it again when it is empty).")
    lines.append(f"The plugin calls the shared hooks in {options.plugin_root}: the capsule at the first model call of a session, "
                 "recall for each prompt, and capture when a turn ends. It keeps a spool of the conversation in the anymem cache folder.")
    lines.append("Uninstall deletes the plugin file and leaves everything else as it was.")
    return lines


def install(options) -> dict:
    home = _home(options)
    root = Path(options.plugin_root).resolve()
    target = _plugin_path(home)
    problems = _problems_with_root(root)
    if problems:
        raise ValueError("; ".join(problems))
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError(f"{target} is a link or a folder, not a plugin file. Move it away and run install again.")
    if target.exists() and not _is_ours(target):
        raise ValueError(f"{target} already exists and was not written by anymem. Move it away and run install again.")
    created = _missing_dirs(home)
    text = _render(root, scripts.hook_python(), created)
    if options.dry_run:
        return {"changed": [], "notes": plan(options)}
    changed = []
    if target.exists():
        backup = target.with_name(target.name + BACKUP_SUFFIX)
        if not backup.exists():
            shutil.copy2(target, backup)
            changed.append(str(backup))
        # an upgrade keeps the list of folders the first install created
        earlier = DIRS_RE.search(target.read_text(encoding="utf-8"))
        text = DIRS_RE.sub(lambda _m: "// created-dirs: " + (earlier.group(1) if earlier else "[]"), text, count=1)
    _plugin_dir(home).mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o644)
    tmp.replace(target)
    changed.append(str(target))
    return {"changed": changed,
            "notes": ["Restart Kilo (or open a new session) so it loads the plugin.",
                      "Kilo has no transcript file, so the plugin keeps its own spool of the conversation in the anymem cache folder."]}


def check() -> dict:
    """The wiring is in place and the Worker answers. Writes nothing."""
    home = _home()
    target = _plugin_path(home)
    problems = []
    if not target.is_file():
        return {"ok": False, "problems": [f"the plugin file {target} does not exist, run `{scripts.cmd('install', 'kilo')}`"]}
    if not _is_ours(target):
        return {"ok": False, "problems": [f"{target} exists but was not written by anymem"]}
    baked = _baked(target)
    root = Path(str(baked.get("root") or ""))
    if not baked.get("root") or not root.is_dir():
        problems.append(f"the plugin points at a plugin root that does not exist ({baked.get('root') or 'none baked in'}), run install again")
    else:
        problems += _problems_with_root(root)
    python = str(baked.get("python") or "")
    if not python or not Path(python).exists():
        problems.append(f"the Python the plugin runs ({python or 'none baked in'}) does not exist, run install again")
    problems += _worker_problems(root if root.is_dir() else HERE.parent.parent)
    return {"ok": not problems, "problems": problems}


def _worker_problems(root: Path) -> list:
    """Credentials resolve and GET /health answers, through the same client the hooks use."""
    try:
        sys.path.insert(0, str(root / "client"))
        from hm import api, config
        settings = config.load(timeout=5, use_command=True)
        if not settings.configured():
            return ["anymem is not configured (missing %s), run `%s` or `%s`" % (", ".join(settings.missing()), scripts.cmd("setup"), scripts.cmd("connect"))]
        api.request("GET", "/health", timeout=5, settings=settings)
        return []
    except Exception as exc:  # NotConfigured, ApiError, NetworkError, or a client that cannot load
        return [f"the Worker did not answer GET /health: {str(exc)[:160]}"]
    finally:
        if sys.path and sys.path[0] == str(root / "client"):
            sys.path.pop(0)


def uninstall() -> dict:
    """Remove our plugin file, our backup, and the folders install created (only when empty). Anything else stays."""
    home = _home()
    target = _plugin_path(home)
    changed = []
    if target.is_symlink() or not target.exists():
        return {"changed": changed}
    if not _is_ours(target):
        raise ValueError(f"{target} was not written by anymem, so it was left alone")
    m = DIRS_RE.search(target.read_text(encoding="utf-8"))
    try:
        created = [Path(p) for p in json.loads(m.group(1))] if m else []
    except ValueError:
        created = []
    target.unlink()
    changed.append(str(target))
    backup = target.with_name(target.name + BACKUP_SUFFIX)
    if backup.exists():
        backup.unlink()
        changed.append(str(backup))
    for d in sorted(created, key=lambda p: len(p.parts), reverse=True):
        try:
            if home in d.parents:  # never a folder outside the home, whatever the file says
                d.rmdir()
                changed.append(str(d))
        except OSError:
            pass  # not empty, so it is not only ours
    return {"changed": changed}
