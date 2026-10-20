"""Antigravity CLI (command `agy`) adapter. Contract: adapters/README.md. User page: docs/harnesses/agy.md.

agy reads hooks from a hooks.json file, a map from a hook name to its events. The global file is ~/.gemini/config/hooks.json and
a workspace file is .agents/hooks.json. This adapter owns exactly one entry, the key "anymem":

    {"anymem": {"PreInvocation": [{"type": "command", "command": "<python> .../adapters/agy/hook.py prompt", "timeout": 15}],
                        "Stop":          [{"type": "command", "command": "<python> .../adapters/agy/hook.py capture", "timeout": 10}]}}

<python> is the Python that ran the install, by full path (hm.scripts.hook_python), so the hooks do not depend on agy's PATH.

Every other hook name in the file is left alone. Install backs the file up once as hooks.json.anymem.bak, refuses a file that
is not a valid JSON object, and uninstall puts the original bytes back when only this entry was added. When install creates the
file's folders it records them in hooks.json.anymem.dirs, and uninstall removes exactly those folders. `options.workspace`
(optional, must sit inside options.home) makes install, check and uninstall work on that workspace's .agents/hooks.json instead of
the global file. check() and uninstall() take no arguments from the install command, so they fall back to ANYMEM_HOME or the home folder.
Python 3.9, stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from hm import scripts

NAME = "agy"
TITLE = "Antigravity CLI"
KEY = "anymem"
BACKUP_SUFFIX = ".anymem.bak"
DIRS_SUFFIX = ".anymem.dirs"  # the folders install created for the file, written only when there are some
PROMPT_TIMEOUT = 15   # seconds: the capsule fetch (4) and the recall hook (8) can both run on the first model call of a conversation
CAPTURE_TIMEOUT = 10
PLUGIN_ROOT = Path(__file__).resolve().parents[2]


class Refused(Exception):
    """The config file is not something install may touch."""


def _home(options=None) -> Path:
    if options is not None and getattr(options, "home", None):
        return Path(options.home)
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def _root(options=None) -> Path:
    root = getattr(options, "plugin_root", None) if options is not None else None
    return Path(root) if root else PLUGIN_ROOT


def config_path(home: Path, workspace=None) -> Path:
    if workspace:
        return Path(workspace) / ".agents" / "hooks.json"
    return home / ".gemini" / "config" / "hooks.json"


def _target(options=None) -> Path:
    home = _home(options)
    workspace = getattr(options, "workspace", None) if options is not None else None
    if workspace:
        ws = Path(os.path.abspath(str(workspace)))
        try:
            ws.relative_to(os.path.abspath(str(home)))
        except ValueError:
            raise Refused(f"the workspace {ws} is outside the home folder {home}, so nothing was written") from None
    return config_path(home, workspace)


def desired(plugin_root: Path) -> dict:
    hook = shlex.quote(str(plugin_root / "adapters" / NAME / "hook.py"))
    python = shlex.quote(scripts.hook_python())
    return {
        "PreInvocation": [{"type": "command", "command": f"{python} {hook} prompt", "timeout": PROMPT_TIMEOUT}],
        "Stop": [{"type": "command", "command": f"{python} {hook} capture", "timeout": CAPTURE_TIMEOUT}],
    }


def _load(path: Path) -> "tuple[dict, bytes | None]":
    """(parsed object, original bytes), or ({}, None) when the file does not exist. Raises Refused for anything that is not a JSON object."""
    if not path.exists():
        return {}, None
    try:
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise Refused(f"{path} is not valid JSON ({type(exc).__name__}), so nothing was changed. Fix or move that file, then run install again.") from None
    if not isinstance(data, dict):
        raise Refused(f"{path} is valid JSON but not an object of hook names, so nothing was changed.")
    return data, raw


def _indent(raw: "bytes | None") -> "int | str":
    """Keep the file's own indentation when it has one."""
    if raw:
        m = re.search(rb"^\{\s*\n([ \t]+)\S", raw)
        if m:
            width = m.group(1)
            return "\t" if width.startswith(b"\t") else len(width)
    return 2


def _dump(data: dict, raw: "bytes | None") -> bytes:
    text = json.dumps(data, indent=_indent(raw), ensure_ascii=False)
    if raw is None or raw.endswith(b"\n"):
        text += "\n"
    return text.encode("utf-8")


def _write(path: Path, content: bytes, like: "Path | None" = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".anymem.tmp")
    tmp.write_bytes(content)
    if like is not None and like.exists():
        shutil.copymode(like, tmp)
    tmp.replace(path)


def _backup_path(path: Path) -> Path:
    return path.with_name(path.name + BACKUP_SUFFIX)


def _command_version() -> str:
    exe = _find_agy()
    if not exe:
        return ""
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=8, stdin=subprocess.DEVNULL)
        return (out.stdout.strip().splitlines() or [""])[0][:60]
    except (OSError, subprocess.SubprocessError):
        return ""


def _find_agy() -> "str | None":
    found = shutil.which("agy")
    if found:
        return found
    fallback = Path.home() / ".gemini" / "antigravity-cli" / "bin" / "agy"
    return str(fallback) if fallback.is_file() else None


# ---------------------------------------------------------------- contract

def detect() -> dict:
    path = config_path(_home())
    notes = []
    found = bool(_find_agy())
    if not found:
        notes.append("the agy command was not found on PATH")
    try:
        data, _ = _load(path)
        if path.exists():
            notes.append(f"{path.name} has {len(data)} hook name(s)" + (", including anymem" if KEY in data else ""))
    except Refused as exc:
        notes.append(str(exc))
    return {"found": found, "version": _command_version() if found else "", "config_path": str(path), "notes": notes}


def plan(options) -> list:
    try:
        path = _target(options)
        data, raw = _load(path)
    except Refused as exc:
        return [str(exc)]
    want = desired(_root(options))
    if data.get(KEY) == want:
        return [f"{path} already has the {KEY} hooks, nothing to change."]
    lines = []
    if raw is None:
        lines.append(f"Create {path}, which does not exist yet.")
    else:
        lines.append(f"Back up {path} once as {_backup_path(path).name}, if that backup does not exist yet.")
        lines.append(f"Keep the file's other {len(data) - (1 if KEY in data else 0)} hook name(s) exactly as they are.")
    lines.append(f'{"Replace" if KEY in data else "Add"} the "{KEY}" entry in {path} with a PreInvocation hook that runs {want["PreInvocation"][0]["command"]} (capsule and recall, {PROMPT_TIMEOUT} second limit).')
    lines.append(f'The same entry gets a Stop hook that runs {want["Stop"][0]["command"]} (capture when a run ends, {CAPTURE_TIMEOUT} second limit).')
    lines.append("Nothing else is written. `%s` removes exactly this entry." % scripts.cmd("install", "--uninstall agy"))
    return lines


def install(options) -> dict:
    path = _target(options)
    data, raw = _load(path)
    want = desired(_root(options))
    if data.get(KEY) == want:
        return {"changed": [], "notes": [f"{path} already has the {KEY} hooks."]}
    notes, changed = [], []
    if raw is not None:
        bak = _backup_path(path)
        if not bak.exists():
            _write(bak, raw, like=path)
            notes.append(f"backed up the original as {bak}")
            changed.append(str(bak))
    made = _missing(path.parent, _stop(options)) if raw is None else []  # the folders this install has to create
    data[KEY] = want
    _write(path, _dump(data, raw), like=path)
    changed.insert(0, str(path))
    if made:  # uninstall removes these folders and no others, so they are written down next to the file
        dirs = _dirs_path(path)
        dirs.write_text(json.dumps(made), encoding="utf-8")
        changed.append(str(dirs))
    notes.append("start a new agy session for the hooks to load. `/hooks` in the TUI lists them.")
    return {"changed": changed, "notes": notes}


def check(options=None) -> dict:
    problems = []
    try:
        path = _target(options)
        data, _ = _load(path)
    except Refused as exc:
        return {"ok": False, "problems": [str(exc)]}
    entry = data.get(KEY)
    if not isinstance(entry, dict):
        return {"ok": False, "problems": [f'{path} has no "{KEY}" entry. Run `{scripts.cmd("install", "agy")}`.']}
    hook_files = {}  # hook.py path -> the interpreter the command that names it starts with
    for event, mode in (("PreInvocation", "prompt"), ("Stop", "capture")):
        handlers = entry.get(event)
        commands = [h.get("command", "") for h in handlers if isinstance(h, dict)] if isinstance(handlers, list) else []
        if not any(c.rstrip().endswith(" " + mode) and "hook.py" in c for c in commands):
            problems.append(f"the {KEY} entry has no {event} hook that runs hook.py {mode}")
            continue
        for c in commands:
            try:
                parts = shlex.split(c)
            except ValueError:
                continue
            for p in parts:
                if p.endswith("hook.py"):
                    hook_files.setdefault(p, parts[0])
    for script in sorted(hook_files):
        python = hook_files[script]
        if not Path(script).is_file():
            problems.append(f"{script} does not exist, the plugin folder moved. Run `{scripts.cmd('install', 'agy')}` again.")
            continue
        try:  # the check runs under the interpreter the hook command names, so it tests what agy will run
            out = subprocess.run([python, script, "check"], capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
            if out.stdout.strip() != "ok":
                problems.append(f"{python} did not start the hook script cleanly (needs Python 3.9 or newer)")
        except (OSError, subprocess.SubprocessError) as exc:
            problems.append(f"could not run {python} {script} ({type(exc).__name__})")
    sys.path.insert(0, str(PLUGIN_ROOT / "client"))
    try:
        from hm import api  # noqa: E402
        api.request("GET", "/health", timeout=6)
    except Exception as exc:  # NotConfigured, ApiError, NetworkError, or an import problem
        problems.append(f"the Worker is not reachable from this machine: {exc}"[:240])
    finally:
        sys.path.remove(str(PLUGIN_ROOT / "client"))
    return {"ok": not problems, "problems": problems}


def uninstall(options=None) -> dict:
    path = _target(options)
    data, raw = _load(path)
    if KEY not in data:
        return {"changed": [], "notes": [f"{path} has no {KEY} entry, nothing to remove."]}
    changed = []
    del data[KEY]
    bak = _backup_path(path)
    original = None
    if bak.exists():
        try:
            original = json.loads(bak.read_bytes().decode("utf-8"))
        except (OSError, ValueError):
            original = None
    if bak.exists() and original == data:
        _write(path, bak.read_bytes(), like=path)  # only our entry was added: put the original bytes back
        bak.unlink()
        changed += [str(path), str(bak)]
    elif not bak.exists() and not data:
        made = _recorded(path)  # the folders install created, read before their record goes
        path.unlink()  # we created the file, so it goes away with its entry
        changed.append(str(path))
        dirs = _dirs_path(path)
        if dirs.exists():
            dirs.unlink()
            changed.append(str(dirs))
        _remove_made(made)
    else:
        _write(path, _dump(data, raw), like=path)
        changed.append(str(path))
    return {"changed": changed}


def _stop(options=None) -> Path:
    """The folder that install and uninstall never go above: the workspace when there is one, otherwise the home folder."""
    workspace = getattr(options, "workspace", None) if options is not None else None
    return Path(workspace) if workspace else _home(options)


def _dirs_path(path: Path) -> Path:
    """The record of the folders install created for `path`, next to the file."""
    return path.with_name(path.name + DIRS_SUFFIX)


def _missing(folder: Path, stop: Path) -> list:
    """The folders from `folder` up to `stop` (not included) that do not exist yet, innermost first."""
    stop = Path(os.path.abspath(str(stop)))
    folder = Path(os.path.abspath(str(folder)))
    out = []
    while folder != stop and stop in folder.parents and not folder.exists():
        out.append(str(folder))
        folder = folder.parent
    return out


def _recorded(path: Path) -> list:
    """The folders install recorded for `path`. Nothing when there is no record, so uninstall removes only what it knows it made."""
    try:
        made = json.loads(_dirs_path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [m for m in made if isinstance(m, str)] if isinstance(made, list) else []


def _remove_made(made: list) -> None:
    """Remove the recorded folders from the inside out. Stops at the first one that is not empty."""
    for folder in made:
        try:
            Path(folder).rmdir()
        except OSError:
            return
