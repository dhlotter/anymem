"""The ZCode adapter (adapters/README.md is the contract).

ZCode takes hooks from plugins and from its user config, and it strips the `hooks` key from a project's .zcode/config.json
on purpose, so a project file cannot carry them. So this adapter installs a small ZCode plugin through ZCode's own command
line (`zcode plugins ...`) instead of editing a settings file:

  1. it writes the plugin folder <home>/.zcode/anymem/plugin (plugin.json, marketplace.json, hooks/hooks.json),
     its three hooks run `<python> <plugin_root>/adapters/zcode/hook.py EVENT`, where <python> is hm.scripts.hook_python(),
  2. `plugins marketplace add` that folder, then `plugins install anymem@anymem`.

ZCode ignores the `args` list that a Claude Code hooks file may carry, a hook must be one `command` string, which is why the
shared hooks/hooks.json cannot be reused as it is.

Nothing here changes a ZCode setting. ZCode keeps its plugin bookkeeping in three JSON files, and before the first change each
one that exists is copied to <file>.anymem.bak. Uninstall asks ZCode to remove the plugin and the marketplace, deletes
what ZCode leaves behind of them and the per session conversation files the hook kept, and puts a file back from its backup when
nothing else in it changed.

Environment, for tests and unusual installs: ANYMEM_HOME (the home folder), ANYMEM_ZCODE_APP (the app folder,
default /Applications/ZCode.app), ANYMEM_ZCODE_NODE (the program that runs zcode.cjs, default node).
stdlib only, Python 3.9.
"""
from __future__ import annotations

import json
import os
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from hm import scripts

NAME = "zcode"
TITLE = "ZCode"

PLUGIN = "anymem"
MARKETPLACE = "anymem"
PLUGIN_ID = f"{PLUGIN}@{MARKETPLACE}"
BAK = ".anymem.bak"
MADE_FILE = "created-dirs.json"  # inside the plugin folder: the bookkeeping folders the install created
CLI_TIMEOUT = 120

# event name, hook word, timeout in seconds (ZCode counts seconds, a 1 second hook was cut at 1,002 ms)
HOOKS = (
    ("SessionStart", "session-start", 10),
    ("UserPromptSubmit", "prompt", 9),
    ("Stop", "capture", 5),
)


# ---------------------------------------------------------------- where things are

def _home(options=None) -> Path:
    if options is not None and getattr(options, "home", None):
        return Path(options.home)
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def _app() -> Path:
    return Path(os.environ.get("ANYMEM_ZCODE_APP") or "/Applications/ZCode.app")


def _cjs() -> Path:
    return _app() / "Contents" / "Resources" / "glm" / "zcode.cjs"


def _node() -> str:
    return os.environ.get("ANYMEM_ZCODE_NODE") or shutil.which("node") or ""


def _plugin_root(options=None) -> Path:
    if options is not None and getattr(options, "plugin_root", None):
        return Path(options.plugin_root)
    return Path(__file__).resolve().parent.parent.parent


def _cli_dir(home: Path) -> Path:
    return home / ".zcode" / "cli"


def _state_files(home: Path) -> list:
    """The three files ZCode writes plugin bookkeeping into."""
    plugins = _cli_dir(home) / "plugins"
    return [_cli_dir(home) / "config.json", plugins / "installed_plugins.json", plugins / "known_marketplaces.json"]


def _source_dir(home: Path) -> Path:
    return home / ".zcode" / "anymem" / "plugin"


def _sessions_dir(home: Path) -> Path:
    """Where hook.py keeps each session's prompts and replies until capture has read them (the cache folder of the client core)."""
    cache = os.environ.get("ANYMEM_CACHE_DIR") or str(home / ".cache" / "anymem")
    return Path(cache) / "zcode-sessions"


def _leftovers(home: Path) -> list:
    """Folders ZCode keeps for the marketplace and the plugin, and may leave behind after a remove."""
    plugins = _cli_dir(home) / "plugins"
    return [plugins / "marketplaces" / MARKETPLACE, plugins / "cache" / MARKETPLACE, plugins / "data" / PLUGIN_ID]


def _run(args: list, home: Path):
    """(exit code, stdout, stderr). ZCode runs with HOME set to `home`, so everything it writes lands there. Only stdout is
    parsed: a warning that node prints on stderr must not break a version or a JSON list."""
    node = _node()
    if not node or not _cjs().is_file():
        return 127, "", "ZCode's command line was not found"
    try:
        done = subprocess.run([node, str(_cjs()), *args], capture_output=True, text=True, timeout=CLI_TIMEOUT,
                              stdin=subprocess.DEVNULL, env={**os.environ, "HOME": str(home)})
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)
    return done.returncode, done.stdout or "", done.stderr or ""


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- ZCode's own Memory feature

def builtin_memory(home: Path) -> list:
    """Plain sentences for each place ZCode's own Memory is on. Read only.

    The command line writes memory files and tells the model to, unless `features.memory` or `memory.use` is false in
    ~/.zcode/cli/config.json (both default to true). The desktop app has its own switch, `memoryEnabled` in
    ~/.zcode/v2/setting.json (default false)."""
    found = []
    try:
        cli = _read_json(_cli_dir(home) / "config.json")
        cli = cli if isinstance(cli, dict) else {}
    except (OSError, ValueError):
        cli = {}
    features = cli.get("features") if isinstance(cli.get("features"), dict) else {}
    memory = cli.get("memory") if isinstance(cli.get("memory"), dict) else {}
    if features.get("memory") is not False and memory.get("use") is not False:
        found.append("the ZCode command line has its own file memory on (features.memory and memory.use default to true in "
                     "~/.zcode/cli/config.json), so the model is also told to write memory files under ~/.zcode/cli/memories")
    try:
        setting = _read_json(home / ".zcode" / "v2" / "setting.json")
    except (OSError, ValueError):
        setting = {}
    if isinstance(setting, dict) and setting.get("memoryEnabled") is True:
        found.append("the ZCode desktop app has Memory switched on (memoryEnabled in ~/.zcode/v2/setting.json)")
    return found


MEMORY_ADVICE = ("two memory systems write to two places. To turn ZCode's own off, set features.memory to false in "
                 "~/.zcode/cli/config.json, and switch Memory off in the desktop app's settings. This adapter never changes ZCode settings.")


# ---------------------------------------------------------------- the contract

def detect() -> dict:
    home = _home()
    notes = []
    version = ""
    found = _cjs().is_file() and bool(_node())
    if not _cjs().is_file():
        notes.append(f"ZCode was not found at {_app()}")
    elif not _node():
        notes.append("node was not found, ZCode's command line needs it")
    else:
        code, out, _ = _run(["--version"], home)
        version = out.strip().splitlines()[0] if code == 0 and out.strip() else ""
        try:
            with (_app() / "Contents" / "Info.plist").open("rb") as f:
                notes.append("ZCode app " + str(plistlib.load(f).get("CFBundleShortVersionString", "?")))
        except (OSError, ValueError, plistlib.InvalidFileException):
            pass
    for line in builtin_memory(home) if found else []:
        notes.append("warning: " + line)
    return {"found": found, "version": version, "config_path": str(_cli_dir(home) / "config.json"), "notes": notes}


def plan(options) -> list:
    home = _home(options)
    root = _plugin_root(options)
    source = _source_dir(home)
    lines = [
        f"Write a small ZCode plugin folder at {source} (plugin.json, marketplace.json, hooks/hooks.json). Its three hooks "
        f"(SessionStart, UserPromptSubmit, Stop) run {root / 'adapters' / 'zcode' / 'hook.py'}.",
        f"Copy each ZCode plugin file that exists to <file>{BAK} first (once): "
        + ", ".join(str(p) for p in _state_files(home)) + ".",
        f"Run `zcode plugins marketplace add {source}` and `zcode plugins install {PLUGIN_ID}`. ZCode records them in those "
        "same files and copies the plugin under ~/.zcode/cli/plugins.",
        "No ZCode setting is changed.",
    ]
    for line in builtin_memory(home):
        lines.append("Note: " + line + ". " + MEMORY_ADVICE)
    return lines


def _write_source(home: Path, root: Path) -> Path:
    source = _source_dir(home)
    hook = root / "adapters" / "zcode" / "hook.py"
    (source / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (source / "hooks").mkdir(parents=True, exist_ok=True)
    description = "Shared memory for ZCode: recall on every prompt, capture as a session goes on."
    manifest = {"name": PLUGIN, "version": "1.0.0", "description": description, "author": {"name": "anymem"}}
    market = {"name": MARKETPLACE, "owner": {"name": "anymem"},
              "plugins": [{"name": PLUGIN, "description": description, "source": "./"}]}
    python = shlex.quote(scripts.hook_python())
    hooks = {"hooks": {event: [{"hooks": [{"type": "command", "command": f"{python} {shlex.quote(str(hook))} {word}",
                                           "timeout": seconds}]}] for event, word, seconds in HOOKS}}
    for path, data in ((source / ".claude-plugin" / "plugin.json", manifest),
                       (source / ".claude-plugin" / "marketplace.json", market),
                       (source / "hooks" / "hooks.json", hooks)):
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return source


def _backup(files: list) -> None:
    for path in files:
        bak = Path(str(path) + BAK)
        if path.is_file() and not bak.exists():
            shutil.copy2(path, bak)


GONE_WORDS = ("not installed", "not found")  # what ZCode says when the plugin or marketplace is already gone, the state we want


def _said(out: str, err: str) -> str:
    """ZCode's output on one line, stdout and stderr both, for a message."""
    return " ".join((out + " " + err).split())


def _remove_from_zcode(home: Path) -> list:
    """Ask ZCode to drop our plugin and marketplace. Returns the lines ZCode printed when it complained."""
    problems = []
    for args in (["plugins", "uninstall", PLUGIN_ID, "--force"], ["plugins", "marketplace", "remove", MARKETPLACE]):
        code, out, err = _run(args, home)
        text = _said(out, err)
        if code != 0 and not any(word in text.lower() for word in GONE_WORDS):
            problems.append(f"zcode {' '.join(args[:3])}: {text[:200]}")
    return problems


def install(options) -> dict:
    home = _home(options)
    root = _plugin_root(options)
    if not _cjs().is_file() or not _node():
        raise RuntimeError(f"ZCode was not found (looked for {_cjs()} and node), nothing was changed")
    for path in _state_files(home):
        if path.is_file():
            try:
                _read_json(path)
            except (OSError, ValueError):
                raise ValueError(f"{path} is not valid JSON, fix or remove it first, nothing was changed")
    if getattr(options, "dry_run", False):
        return {"changed": [], "notes": ["dry run: " + line for line in plan(options)]}
    _backup(_state_files(home))
    source = _write_source(home, root)
    code, out, err = _run(["plugins", "validate", str(source)], home)
    if code != 0:
        raise RuntimeError("ZCode rejected the plugin folder: " + _said(out, err)[:200])
    # the folders ZCode is about to create for the plugin. A second install keeps what the first one recorded.
    made = sorted(set(_made_folders(home)) | {str(p.parent) for p in _leftovers(home) if not p.parent.exists()})
    (source.parent / MADE_FILE).write_text(json.dumps(made), encoding="utf-8")
    _remove_from_zcode(home)  # a second install starts from a clean slate, and the backups from the first one stay
    for args in (["plugins", "marketplace", "add", str(source)], ["plugins", "install", PLUGIN_ID]):
        code, out, err = _run(args, home)
        if code != 0:
            raise RuntimeError(f"zcode {' '.join(args[:3])} failed: " + _said(out, err)[:200])
    changed = [source.parent] + [p for p in _state_files(home) if p.is_file()] + [p for p in _leftovers(home) if p.exists()]
    notes = ["Restart ZCode, or start a new session, so the hooks load."]
    for line in builtin_memory(home):
        notes.append("Warning: " + line + ". " + MEMORY_ADVICE)
    return {"changed": [str(p) for p in changed], "notes": notes}


def _hook_starts(python: str, script: str) -> bool:
    """Runs the hook with the check word, as agy's check does. True when it prints ok, which it does only after every shared
    module loads. The interpreter is the one the hook command names, so the check tests what ZCode will run."""
    try:
        done = subprocess.run([python, script, "check"], capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.stdout.strip() == "ok"


def check() -> dict:
    home = _home()
    problems = []
    if not _cjs().is_file() or not _node():
        return {"ok": False, "problems": ["ZCode was not found, run install again once it is installed"]}
    code, out, _ = _run(["plugins", "list", "--json"], home)
    entry = None
    try:
        listed = json.loads(out) if code == 0 else []
        entry = next((e for e in listed if isinstance(e, dict) and e.get("id") == PLUGIN_ID), None)
    except ValueError:
        problems.append("zcode plugins list did not return JSON")
    if entry is None:
        problems.append(f"{PLUGIN_ID} is not installed in ZCode, run `{scripts.cmd('install', 'zcode')}`")
    else:
        if entry.get("enabled") is not True:
            problems.append(f"{PLUGIN_ID} is installed but disabled, run `zcode plugins enable {PLUGIN_ID}`")
        details = entry.get("hookDetails") if isinstance(entry.get("hookDetails"), list) else []
        events = sorted({d.get("event") for d in details if isinstance(d, dict) and d.get("runnable") is True})
        missing = [e for e, _, _ in HOOKS if e not in events]
        if missing:
            problems.append(f"ZCode counts {len(events)} runnable hooks for the plugin, missing: {', '.join(missing)}")
        checked = set()
        for d in details:
            command = str(d.get("command", "")) if isinstance(d, dict) else ""
            parts = shlex.split(command) if command else []
            script = next((x for x in parts if x.endswith("hook.py")), "")
            if script and not Path(script).is_file():
                problems.append(f"a hook points at {script}, which does not exist, run `{scripts.cmd('install', 'zcode')}` again")
                break
            if script and script not in checked:  # the interpreter the hook command names must run it, not just exist
                checked.add(script)
                if not _hook_starts(parts[0], script):
                    problems.append(f"{parts[0]} did not run {script} (needs Python 3.9 or newer, and the check word must print ok)")
    try:
        sys.path.insert(0, str(_plugin_root() / "client"))
        from hm import api
        api.request("GET", "/health", timeout=8)
    except Exception as exc:  # NotConfigured, ApiError, NetworkError, or the client not importable
        problems.append("the Worker is not reachable from this machine: " + " ".join(str(exc).split())[:200])
    ok = not problems
    for line in builtin_memory(home):
        problems.append("warning: " + line + ". " + MEMORY_ADVICE)
    return {"ok": ok, "problems": problems}


def _restore(path: Path) -> bool:
    """Drop the backup of `path`. The file goes back to the backup's exact bytes when its content is the same, so ZCode having
    rewritten it in its own formatting leaves no trace. A file that holds anything else now (another plugin was installed in
    between) stays as ZCode wrote it. Returns whether there was a backup."""
    bak = Path(str(path) + BAK)
    if not bak.is_file():
        return False
    try:
        if path.is_file() and _read_json(path) == _read_json(bak):
            shutil.copy2(bak, path)
    except (OSError, ValueError):
        pass
    bak.unlink()
    return True


def _made_folders(home: Path) -> list:
    """The folders the plugin install created for ZCode's plugin bookkeeping, as recorded in the plugin folder. Nothing when there
    is no record, so uninstall removes only what it knows it made."""
    try:
        made = json.loads((_source_dir(home).parent / MADE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [m for m in made if isinstance(m, str)] if isinstance(made, list) else []


def _drop_tree(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    elif path.exists():
        path.unlink()


def uninstall() -> dict:
    home = _home()
    changed = []
    notes = []
    if _cjs().is_file() and _node():
        for line in _remove_from_zcode(home):
            notes.append(line)
    else:
        notes.append("ZCode was not found, so ZCode itself was not asked to remove the plugin")
    made = _made_folders(home)  # read before the plugin folder that holds the record goes
    for path in _leftovers(home):  # ZCode keeps a copy of the marketplace after a remove
        if path.exists():
            _drop_tree(path)
            changed.append(str(path))
    for folder in made:  # marketplaces, cache or data: only the ones install created, and only when ours was the last thing in them
        try:
            Path(folder).rmdir()
        except OSError:
            pass
    source = _source_dir(home)
    if source.parent.exists():
        _drop_tree(source.parent)
        changed.append(str(source.parent))
    sessions = _sessions_dir(home)  # conversation copies this adapter's hook made, they go with it
    if sessions.exists():
        _drop_tree(sessions)
        try:
            sessions.resolve().relative_to(home.resolve())
            changed.append(str(sessions))
        except ValueError:
            notes.append(f"removed {sessions}")
    for path in _state_files(home):
        if _restore(path):
            changed.append(str(path))
    return {"changed": changed, "notes": notes}
