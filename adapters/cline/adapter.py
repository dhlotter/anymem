"""The cline adapter: wires anymem into Cline (the 3.x command line `cline-cli` and the Cline desktop app, both on the Cline SDK).
Contract: adapters/README.md.

Cline runs JavaScript plugins. A plugin installed from a local folder is copied by `cline plugin install` to
~/.cline/plugins/_installed/local/<folder>-<hash>/package/. That installer treats every .js file in the folder as a plugin unless
package.json names its entries, so install first generates a small folder that holds exactly two files, and installs that.

install:   writes <home>/.config/anymem/cline-plugin/anymem.js (a copy of plugin.js with the plugin root and the Python path baked
           in) and package.json (name, version, and the one entry), then runs `cline plugin install <that folder> --force --json`
           with HOME set to the home folder. Cline makes the copy. A failed command puts the folder back as it was.
uninstall: `cline plugin uninstall <our install folder>`, then removes the generated folder and the folders install created.
check:     the generated folder is ours and its baked paths exist, Cline's copy is there and current, hook.py answers, and the
           Worker answers /health. Writes nothing in the real folders.

The generated folder is ours only when anymem.js starts with the `// anymem begin` marker and the folder holds nothing else, so
install never overwrites a folder that is not ours and uninstall removes only ours. No Cline config file is edited.

The home folder is options.home for install, and ANYMEM_HOME (else the real home) for detect, check and uninstall, which the
contract calls without options. ANYMEM_CLINE_BIN names the Cline command line (used by the tests, and by anyone with it off PATH).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from hm import scripts

NAME = "cline"
TITLE = "Cline"

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "plugin.js"
PLUGIN_FILE = "anymem.js"
PACKAGE_FILE = "package.json"
BEGIN = "// anymem begin"
END = "// anymem end"
APP_BIN = "/Applications/Cline.app/Contents/MacOS/cline-cli"
BAKED_RE = re.compile(r"^const BAKED = .*$", re.M)
DIRS_RE = re.compile(r"^// created-dirs: (.*)$", re.M)
SHARED_HOOKS = ("memory_recall.py", "memory_capsule.py", "memory_capture.py")
COMMAND_TIMEOUT = 180  # the first plugin install can fetch Cline's own helper packages


def _home(options=None) -> Path:
    if options is not None and getattr(options, "home", None):
        return Path(options.home)
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def _folder(home: Path) -> Path:
    return home / ".config" / "anymem" / "cline-plugin"


def _installs_dir(home: Path) -> Path:
    return home / ".cline" / "plugins" / "_installed" / "local"


def _is_ours(path: Path) -> bool:
    """True for a plugin file whose first line is our marker."""
    try:
        with path.open("r", encoding="utf-8") as f:
            return f.readline().startswith(BEGIN)
    except (OSError, UnicodeDecodeError):
        return False


def _folder_state(folder: Path) -> str:
    """free (no folder), ours, or foreign (anything else, which install and uninstall never touch)."""
    if folder.is_symlink():
        return "foreign"
    if not folder.exists():
        return "free"
    if not folder.is_dir():
        return "foreign"
    names = {p.name for p in folder.iterdir()}
    if PLUGIN_FILE in names and names <= {PLUGIN_FILE, PACKAGE_FILE} and _is_ours(folder / PLUGIN_FILE):
        return "ours"
    return "foreign"


def _our_installs(home: Path) -> list:
    """Cline's copies of our plugin: the install folders whose package/anymem.js starts with our marker."""
    base = _installs_dir(home)
    try:
        found = sorted(p for p in base.iterdir() if p.is_dir() and _is_ours(p / "package" / PLUGIN_FILE))
    except OSError:
        return []
    return found


def _missing_dirs(home: Path) -> list:
    """The folders between home and the generated folder that do not exist yet, outermost first."""
    out, d = [], _folder(home)
    while d != home and not d.exists():
        out.append(d)
        d = d.parent
    return list(reversed(out))


def _problems_with_root(root: Path) -> list:
    """What is missing under a plugin root, as plain sentences."""
    missing = [f"hooks/{name}" for name in SHARED_HOOKS if not (root / "hooks" / name).is_file()]
    missing += [rel for rel in ("client/hm/config.py", "adapters/cline/hook.py", "adapters/cline/transcript.py") if not (root / rel).is_file()]
    return [f"the plugin root {root} has no {rel}" for rel in missing]


def _baked(path: Path) -> dict:
    """The {root, python} baked into an installed plugin file, {} when it cannot be read."""
    try:
        m = re.search(r"^const BAKED = (\{.*\});\s*$", path.read_text(encoding="utf-8"), re.M)
        data = json.loads(m.group(1)) if m else {}
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _plugin_version(root: Path) -> str:
    for base in (root, HERE.parent.parent):
        try:
            version = json.loads((base / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version")
            if isinstance(version, str) and version:
                return version
        except (OSError, ValueError, AttributeError):
            continue
    return "0.0.0"


def _render_plugin(root: Path, python: str, created: list) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    baked = "const BAKED = " + json.dumps({"root": str(root), "python": python}) + ";"
    # json.dumps escapes quotes and backslashes, and a callable replacement keeps re from reading them as group references
    text, n = BAKED_RE.subn(lambda _m: baked, text, count=1)
    if n != 1 or not text.startswith(BEGIN) or not text.rstrip().endswith(END):
        raise ValueError(f"{TEMPLATE} is not the plugin template this adapter expects, nothing was written")
    # the folders install created are recorded on the line after the marker, so uninstall can take them away again
    first, rest = text.split("\n", 1)
    return first + "\n// created-dirs: " + json.dumps([str(d) for d in created]) + "\n" + rest


def _render_package(root: Path) -> str:
    """The folder's package.json. The explicit cline.plugins entry matters: without it Cline's installer takes every .js file it finds."""
    doc = {
        "name": "anymem",
        "version": _plugin_version(root),
        "description": "anymem memory for Cline (generated by the anymem cline adapter)",
        "private": True,
        "type": "module",
        "cline": {"plugins": [{"paths": ["./" + PLUGIN_FILE], "capabilities": ["hooks"]}]},
    }
    return json.dumps(doc, indent=2) + "\n"


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o644)
    tmp.replace(path)


# ---- the Cline command line

def _version_of(exe: str) -> str:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
        lines = out.stdout.strip().splitlines()
        return lines[-1].strip() if out.returncode == 0 and lines else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _major(version: str) -> int:
    m = re.match(r"\s*v?(\d+)", version or "")
    return int(m.group(1)) if m else 0


def _find_cline():
    """(command, version, notes). The command is "" when none was found. The override, then `cline` on PATH, then the desktop
    app's own copy. The first one that reports version 3 or later wins, because the plugin commands are new in 3.x."""
    candidates, notes = [], []
    override = os.environ.get("ANYMEM_CLINE_BIN")
    if override:
        if Path(override).is_file():
            candidates.append(override)
        else:
            notes.append(f"ANYMEM_CLINE_BIN is {override} and that file does not exist")
    on_path = shutil.which("cline")
    if on_path:
        candidates.append(on_path)
    if Path(APP_BIN).is_file() and APP_BIN not in candidates:
        candidates.append(APP_BIN)
    first = ("", "")
    for exe in candidates:
        version = _version_of(exe)
        if _major(version) >= 3:
            return exe, version, notes
        if not first[0]:
            first = (exe, version)
    if first[0]:
        notes.append(f"{first[0]} reports version {first[1] or 'unknown'}, and the plugin commands need Cline 3 or later")
    return first[0], first[1], notes


def _run_cline(exe: str, args: list, home: Path):
    """Runs the Cline command line with HOME set, so everything it writes lands under the home folder install was given."""
    env = dict(os.environ)
    env["HOME"] = str(home)
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=COMMAND_TIMEOUT, env=env, stdin=subprocess.DEVNULL)


def _json_of(text: str):
    text = (text or "").strip()
    for candidate in (text, text.splitlines()[-1] if text else ""):
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except ValueError:
            continue
    return None


def _brief(proc) -> str:
    text = re.sub(r"\x1b\[[0-9;]*m", "", (proc.stderr or proc.stdout or "").strip())
    return text.splitlines()[-1][:200] if text else f"exit code {proc.returncode}"


# ---- the contract

def detect() -> dict:
    """Read only. Cline is found when its command line is on PATH, in the desktop app, or named by ANYMEM_CLINE_BIN."""
    home = _home()
    exe, version, notes = _find_cline()
    if exe:
        notes.insert(0, f"command line: {exe}")
        if not version:
            notes.append("could not read the Cline version")
    elif not notes:
        notes.append("the cline command is not on PATH and /Applications/Cline.app is not installed")
    folder = _folder(home)
    state = _folder_state(folder)
    if state == "ours":
        notes.append("the anymem plugin folder is already generated")
    elif state == "foreign":
        notes.append(f"{folder} exists and is not ours, install will refuse it")
    return {"found": bool(exe), "version": version, "config_path": str(home / ".cline"), "notes": notes}


def plan(options) -> list:
    home = _home(options)
    folder = _folder(home)
    exe, version, _notes = _find_cline()
    lines = [f"Generate a plugin folder for Cline: {folder}. It holds two files, {PLUGIN_FILE} and {PACKAGE_FILE}, and nothing else."]
    state = _folder_state(folder)
    if state == "foreign":
        lines.append(f"{folder} already exists and is not ours, so install will stop without changing anything.")
    elif state == "ours":
        lines.append("Our own earlier copy is rewritten only where it differs.")
    for d in _missing_dirs(home):
        lines.append(f"Create the folder {d} (uninstall removes it again when it is empty).")
    if exe:
        lines.append(f"Run `{exe} plugin install {folder} --force --json` with HOME set to {home}. "
                     f"Cline copies the plugin to {_installs_dir(home)}/ and loads it from there. No Cline config file is edited.")
    else:
        lines.append("The Cline command line was not found, so install will stop without changing anything. "
                     "Install Cline 3 or later, or set ANYMEM_CLINE_BIN.")
    lines.append(f"The plugin calls the shared hooks in {options.plugin_root}: the capsule at the first model call of a conversation, "
                 "recall for each message, and capture after each run. It keeps a spool of the conversation in the anymem cache folder.")
    lines.append("Uninstall asks Cline to remove its copy, then deletes the generated folder.")
    return lines


def install(options) -> dict:
    home = _home(options)
    root = Path(options.plugin_root).resolve()
    folder = _folder(home)
    problems = _problems_with_root(root)
    if problems:
        raise ValueError("; ".join(problems))
    state = _folder_state(folder)
    if state == "foreign":
        raise ValueError(f"{folder} already exists and was not written by anymem. Move it away and run install again.")
    if options.dry_run:
        return {"changed": [], "notes": plan(options)}
    exe, version, notes = _find_cline()
    if not exe:
        raise ValueError("the Cline command line was not found (" + "; ".join(notes or ["no cline on PATH and no /Applications/Cline.app"]) + "). "
                         "Install Cline 3 or later, or set ANYMEM_CLINE_BIN to its command line.")
    if _major(version) < 3:
        raise ValueError("; ".join(notes) or f"{exe} is older than Cline 3")

    plugin_path, package_path = folder / PLUGIN_FILE, folder / PACKAGE_FILE
    created = _missing_dirs(home)
    if state == "ours":  # an upgrade keeps the list of folders the first install created
        earlier = DIRS_RE.search(plugin_path.read_text(encoding="utf-8"))
        try:
            created = [Path(p) for p in json.loads(earlier.group(1))] if earlier else []
        except ValueError:
            created = []
    plugin_text = _render_plugin(root, scripts.hook_python(), created)
    package_text = _render_package(root)

    def same(path: Path, text: str) -> bool:
        try:
            return path.read_text(encoding="utf-8") == text
        except OSError:
            return False

    installs = _our_installs(home)
    current = len(installs) == 1 and same(installs[0] / "package" / PLUGIN_FILE, plugin_text) and same(installs[0] / "package" / PACKAGE_FILE, package_text)
    if state == "ours" and same(plugin_path, plugin_text) and same(package_path, package_text) and current:
        return {"changed": [], "notes": ["Nothing to change, the plugin is already installed and current."] + _after_notes()}

    before = {p: (p.read_text(encoding="utf-8") if p.exists() else None) for p in (plugin_path, package_path)}
    changed = []
    folder.mkdir(parents=True, exist_ok=True)
    for path, text in ((plugin_path, plugin_text), (package_path, package_text)):
        if before[path] != text:
            _write(path, text)
            changed.append(str(path))
    try:
        proc = _run_cline(exe, ["plugin", "install", str(folder), "--force", "--json"], home)
        data = _json_of(proc.stdout) if proc.returncode == 0 else None
        if data is None:
            raise ValueError(f"`{Path(exe).name} plugin install` failed: {_brief(proc)}. Nothing was changed.")
        install_path = Path(str(data.get("installPath") or ""))
        entries = data.get("entryPaths")
        if not data.get("installPath") or not isinstance(entries, list) or not entries or not install_path.is_dir():
            raise ValueError("`plugin install` answered without an install folder or entry path, so the plugin may not be loaded. Nothing was changed.")
        if home.resolve() not in install_path.resolve().parents:
            raise ValueError(f"`plugin install` put the plugin at {install_path}, outside {home}. Check HOME handling in your Cline, nothing else was changed.")
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        for path in (plugin_path, package_path):  # put the generated folder back as it was
            if before[path] is None:
                path.unlink(missing_ok=True)
            elif path.exists() and path.read_text(encoding="utf-8") != before[path]:
                _write(path, before[path])
        for d in reversed(created if state == "free" else []):  # the folders this install made, deepest first, only when empty
            try:
                d.rmdir()
            except OSError:
                pass
        raise ValueError(str(exc) if isinstance(exc, ValueError) else f"the Cline command failed: {str(exc)[:200]}")
    for stale in _our_installs(home):  # an older copy under another folder name would load a second time
        if stale != install_path:
            try:
                _run_cline(exe, ["plugin", "uninstall", str(stale), "--json"], home)
                changed.append(str(stale))
            except (OSError, subprocess.SubprocessError):
                pass
    changed.append(str(install_path))
    return {"changed": changed, "notes": _after_notes()}


def _after_notes() -> list:
    return ["Restart Cline, or start a new session, so it loads the plugin.",
            "Cline gives a hook 3 seconds, so recall may be skipped when the Worker is slow. See docs/harnesses/cline.md."]


def check() -> dict:
    """The wiring is in place, hook.py answers and the Worker answers. Writes nothing in the real folders."""
    home = _home()
    folder = _folder(home)
    plugin_path = folder / PLUGIN_FILE
    state = _folder_state(folder)
    if state == "free":
        return {"ok": False, "problems": [f"the plugin folder {folder} does not exist, run `{scripts.cmd('install', 'cline')}`"]}
    if state == "foreign":
        return {"ok": False, "problems": [f"{folder} exists but was not written by anymem"]}
    problems = []
    baked = _baked(plugin_path)
    root = Path(str(baked.get("root") or ""))
    if not baked.get("root") or not root.is_dir():
        problems.append(f"the plugin points at a plugin root that does not exist ({baked.get('root') or 'none baked in'}), run install again")
    else:
        problems += _problems_with_root(root)
    python = str(baked.get("python") or "")
    if not python or not Path(python).exists():
        problems.append(f"the Python the plugin runs ({python or 'none baked in'}) does not exist, run install again")
    try:
        entry = json.loads((folder / PACKAGE_FILE).read_text(encoding="utf-8"))["cline"]["plugins"][0]["paths"]
        if entry != ["./" + PLUGIN_FILE]:
            problems.append(f"{folder / PACKAGE_FILE} does not name {PLUGIN_FILE} as the only plugin entry, run install again")
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        problems.append(f"{folder / PACKAGE_FILE} is missing or has no cline.plugins entry, run install again")
    installs = _our_installs(home)
    if not installs:
        problems.append(f"Cline has no copy of the plugin under {_installs_dir(home)}, run `{scripts.cmd('install', 'cline')}`")
    else:
        if len(installs) > 1:
            problems.append("Cline holds more than one copy of the anymem plugin, run install again to remove the older ones")
        copy = installs[-1] / "package" / PLUGIN_FILE
        if _baked(copy) != baked or not (installs[-1] / "package" / PACKAGE_FILE).is_file():
            problems.append("Cline's copy of the plugin differs from the generated one, run install again")
    if root.is_dir() and python and Path(python).exists():
        problems += _hook_problems(root, python)
    problems += _worker_problems(root if root.is_dir() else HERE.parent.parent)
    pending = ["Restart Cline, or start a new session, so it loads the plugin. Cline reads plugins when a session starts."] if not problems else []
    return {"ok": not problems, "problems": problems, "pending": pending}


def _hook_problems(root: Path, python: str) -> list:
    """hook.py session-start runs and prints one valid JSON line. The cache folder is a throwaway one and the capsule is switched
    off, so this reads and writes nothing real and makes no network call. The Worker is checked on its own."""
    try:
        with tempfile.TemporaryDirectory(prefix="hm-cline-check-") as tmp:
            env = dict(os.environ)
            env.update({"ANYMEM_PLUGIN_ROOT": str(root), "ANYMEM_CACHE_DIR": tmp, "ANYMEM_CAPSULE": "0"})
            out = subprocess.run([python, str(root / "adapters" / "cline" / "hook.py"), "session-start"], input=json.dumps({"sessionID": "anymem-check", "directory": tmp}),
                                 capture_output=True, text=True, timeout=30, env=env)
        line = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
        reply = json.loads(line) if line else None
        if out.returncode != 0 or not isinstance(reply, dict) or "keep" not in reply:
            return ["hook.py session-start did not answer with a valid reply, run install again"]
        return []
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return [f"hook.py session-start could not run: {str(exc)[:160]}"]


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
    """Ask Cline to remove its copy, then remove the generated folder and the folders install created. Anything else stays."""
    home = _home()
    folder = _folder(home)
    state = _folder_state(folder)
    if state == "foreign":
        raise ValueError(f"{folder} was not written by anymem, so it was left alone")
    changed = []
    installs = _our_installs(home)
    if installs:
        exe, _version, _notes = _find_cline()
        for copy in installs:
            removed = False
            if exe:
                try:
                    proc = _run_cline(exe, ["plugin", "uninstall", str(copy), "--json"], home)
                except (OSError, subprocess.SubprocessError) as exc:
                    raise ValueError(f"the Cline command failed: {str(exc)[:200]}. Nothing else was removed, run uninstall again.")
                removed = proc.returncode == 0 or not copy.exists()
                if not removed:
                    raise ValueError(f"`{Path(exe).name} plugin uninstall` failed: {_brief(proc)}. Nothing else was removed, run uninstall again.")
            elif home.resolve() in copy.resolve().parents and _is_ours(copy / "package" / PLUGIN_FILE):
                shutil.rmtree(copy)  # no command line to ask, so remove the one folder that is verified to be ours
                removed = True
            if removed:
                changed.append(str(copy))
        local = _installs_dir(home)
        try:
            local.rmdir()  # Cline's own empty `local` folder, only when nothing else is in it
        except OSError:
            pass
    if state == "ours":
        created = []
        m = DIRS_RE.search((folder / PLUGIN_FILE).read_text(encoding="utf-8"))
        try:
            created = [Path(p) for p in json.loads(m.group(1))] if m else []
        except ValueError:
            created = []
        for name in (PLUGIN_FILE, PACKAGE_FILE):
            target = folder / name
            if target.exists():
                target.unlink()
                changed.append(str(target))
        try:
            folder.rmdir()
            changed.append(str(folder))
        except OSError:
            pass
        for d in sorted(created, key=lambda p: len(p.parts), reverse=True):
            try:
                if home in d.parents and d != folder:  # never a folder outside the home, whatever the file says
                    d.rmdir()
                    changed.append(str(d))
            except OSError:
                pass  # not empty, so it is not only ours
    return {"changed": changed}
