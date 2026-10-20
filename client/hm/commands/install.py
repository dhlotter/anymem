"""`install.py`: wire Anymem into each agent harness through its adapter.

The contract is adapters/README.md. Adapters are found by importing <name>/adapter.py from two folders: adapters/ under the
plugin root, and ~/.config/anymem/adapters/ for harnesses we do not ship. Dropping a folder in the second one is all it takes.

    install.py --list               every adapter, with its detect() result
    install.py NAME                 plan, confirm, install, then check
    install.py --all                the same for every adapter whose detect() says found
    install.py --check [NAME]       check() for NAME, or for every found adapter (exit 1 on any problem)
    install.py --uninstall NAME     uninstall(), then check() must report the wiring gone
    install.py --new NAME           write a working starter adapter in ~/.config/anymem/adapters/NAME

ANYMEM_ADAPTERS_DIR replaces the plugin's adapters folder (your own folder is still read), and ANYMEM_HOME replaces the home folder (tests use both).
An adapter that raises is reported as one line with its name and message, and does not stop --all.
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path

from hm import adapter_roots, config, scripts
from hm.commands import _adapter_scaffold

COMMAND = "install"
HELP = "install, check or uninstall a harness adapter (see --list)"

PLUGIN_ROOT = adapter_roots.PLUGIN_ROOT


class Options:
    def __init__(self, dry_run: bool, yes: bool, plugin_root: Path, home: Path):
        self.dry_run = dry_run
        self.yes = yes
        self.plugin_root = plugin_root
        self.home = home


def register(parser):
    parser.add_argument("harness", nargs="?", metavar="NAME", help="adapter name, see --list")
    parser.add_argument("--list", action="store_true", help="list every adapter with its detect() result")
    parser.add_argument("--all", action="store_true", help="install into every adapter whose detect() says found")
    parser.add_argument("--check", action="store_true", help="run check() for NAME, or for every found adapter")
    parser.add_argument("--uninstall", action="store_true", help="remove NAME's own entries and prove it with check()")
    parser.add_argument("--new", action="store_true", help="write a starter adapter for NAME in your adapters folder")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and write nothing")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation question")


def say(text: str) -> None:
    print(text)


def fail(text: str) -> None:
    print(text, file=sys.stderr)


SECRET_SHAPES = [
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer [redacted]"),
    (re.compile(r"\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"\bre_[A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"(?i)\b(token|secret|password|api[_-]?key)(\s*[=:]\s*)\S+"), r"\1\2[redacted]"),
]


def clean(text) -> str:
    """Adapter-supplied text on one line, with token-shaped text masked. Every string an adapter returns goes through here
    before it is printed. A backstop only: adapters must keep secrets out of their output."""
    text = " ".join(str(text).split())
    for shape, repl in SECRET_SHAPES:
        text = shape.sub(repl, text)
    return text


def one_line(exc: BaseException) -> str:
    return clean(str(exc)) or type(exc).__name__


def as_lines(raw) -> list:
    """Adapter text as cleaned lines. A bare string is one line, never one line per character."""
    if isinstance(raw, str):
        return [clean(raw)]
    if isinstance(raw, (list, tuple)):
        return [clean(line) for line in raw]
    return []


def adapters_dir() -> Path:
    return adapter_roots.plugin_dir()


def user_adapters_dir() -> Path:
    return adapter_roots.user_dir()


def home_dir() -> Path:
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def load_adapters() -> dict:
    """{name: (module, error)}. A folder that fails to import keeps its error, so --list can show it."""
    found = {}
    taken = {}  # name -> True when the plugin's adapter of that name loaded, False when its folder failed to import
    for root in (adapters_dir(), user_adapters_dir()):
        if not root.is_dir():
            continue
        for folder in sorted(p for p in root.iterdir() if (p / "adapter.py").is_file()):
            try:
                module = load_module(folder)
            except (Exception, SystemExit) as exc:
                if folder.name in found:  # yours broke too, or shares the name of a broken built in one
                    found[f"{folder.name} (yours)"] = (None, one_line(exc))
                else:
                    found[folder.name] = (None, one_line(exc))
                    taken[folder.name] = False
                continue
            name = getattr(module, "NAME", folder.name)
            if name in found:  # the plugin's own adapter wins, yours is shown with the reason
                why = "a built in adapter already uses" if taken.get(name, True) else "a built in adapter folder that failed to load holds"
                found[f"{name} (yours)"] = (None, f"{why} the name '{name}', rename your folder and NAME")
                continue
            found[name] = (module, "")
            taken[name] = True
    return found


def load_module(folder: Path):
    """Import folder/adapter.py with its sibling files reachable two ways: `import payload` (the folder is on sys.path while
    the adapter loads) and `from . import payload` (the adapter is a package named after its folder). Sibling modules are
    dropped from sys.modules afterwards, so two adapters can each ship a payload.py. Import siblings at the top of adapter.py:
    a lazy `import payload` inside a function runs after the folder has left sys.path, and fails."""
    name = "anymem_adapter_" + folder.name
    spec = importlib.util.spec_from_file_location(name, folder / "adapter.py", submodule_search_locations=[str(folder)])
    module = importlib.util.module_from_spec(spec)
    where = str(folder)
    before = set(sys.modules)
    sys.modules[name] = module
    sys.path.insert(0, where)
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    finally:
        sys.path.remove(where)
        drop_siblings(folder, before, name)
    return module


def drop_siblings(folder: Path, before: set, name: str) -> None:
    """Forget the modules that loading this folder added from inside it."""
    home = folder.resolve()
    for key in set(sys.modules) - before:
        if key == name or key.startswith(name + "."):
            continue
        path = getattr(sys.modules.get(key), "__file__", None)
        if path and Path(path).resolve().parent == home:
            del sys.modules[key]


def call(name: str, module, attr: str, *args):
    """(True, result), or (False, None) after one line on stderr that names the adapter, the function and the message.
    The lookup sits inside the try, so an adapter that lacks a function is reported like any other failure."""
    try:
        fn = getattr(module, attr, None)
        if fn is None:
            raise LookupError(f"missing {attr}() function")
        return True, fn(*args)
    except (Exception, SystemExit) as exc:
        fail(f"{name}: {attr} failed: {one_line(exc)}")
        return False, None


def detect_one(name: str, module):
    ok, info = call(name, module, "detect")
    if not ok:
        return None
    return info if isinstance(info, dict) else {}


def run_check(name: str, module):
    """(ok, lines), or None when check() raised or returned nothing usable. An adapter may return a "pending" list beside
    "problems": those are printed as next steps and do not make the check fail."""
    ok, result = call(name, module, "check")
    if not ok:
        return None
    if not isinstance(result, dict):
        fail(f"{name}: check returned no result")
        return None
    problems = as_lines(result.get("problems"))
    pending = as_lines(result.get("pending"))  # things only the user can do next (for example approve hooks inside the harness)
    return bool(result.get("ok")) or not problems, problems + [f"next step: {line}" for line in pending]


def confirm(question: str) -> bool:
    try:
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def outside_home(changed, home: Path) -> list:
    """The reported paths that resolve outside home, cleaned for printing. A relative path is read as relative to home."""
    root = home.resolve()
    bad = []
    for item in changed:
        path = Path(str(item))
        target = (path if path.is_absolute() else root / path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            bad.append(clean(item))
    return bad


def guard(name: str, result, options: Options):
    """The changed paths from an install or uninstall result, or None after printing why they cannot be trusted."""
    changed = result.get("changed") if isinstance(result, dict) else None
    if not isinstance(changed, list):
        fail(f'{name}: returned no "changed" list, so the home folder guard cannot run')
        return None
    bad = outside_home(changed, options.home)
    if bad:
        fail(f"{name}: reported changes outside {options.home}: {', '.join(bad)}. The adapter already ran, check those paths by hand.")
        return None
    return changed


def check_one(name: str, module) -> int:
    got = run_check(name, module)
    if got is None:
        return 1
    good, problems = got
    say(f"{name}: {'ok' if good else 'not ok'}")
    for problem in problems:
        say(f"  {problem}")
    return 0 if good else 1


def pick(adapters: dict, name: str):
    """The loaded module for NAME, or None after printing why."""
    if name not in adapters:
        valid = sorted(n for n, (module, _) in adapters.items() if module is not None)
        shown = ", ".join(valid) if valid else "none found in " + str(adapters_dir())
        fail(f"no adapter named '{name}'. Valid: {shown}")
        return None
    module, error = adapters[name]
    if module is None:
        fail(f"{name}: could not load: {error}")
    return module


def list_adapters(adapters: dict) -> int:
    if not adapters:
        say(f"no adapters found in {adapters_dir()}")
        return 0
    for name, (module, error) in adapters.items():
        if module is None:
            say(f"{name}: could not load: {error}")
            continue
        info = detect_one(name, module)
        if info is None:
            continue
        state = "found" if info.get("found") else "not found"
        title = clean(getattr(module, "TITLE", name))
        version = clean(info.get("version") or "-")
        config = clean(info.get("config_path") or "-")
        say(f"{name}  {title}  {state}  version {version}  config {config}")
        for note in as_lines(info.get("notes")):
            say(f"  {note}")
    return 0


def plan_lines(name: str, raw):
    """The plan as a list of cleaned lines (see as_lines), or None after printing why."""
    if not isinstance(raw, (str, list, tuple)):
        fail(f"{name}: plan returned no list of lines, nothing was written")
        return None
    return as_lines(raw)


def install_one(name: str, module, options: Options) -> int:
    ok, raw = call(name, module, "plan", options)
    if not ok:
        return 1
    lines = plan_lines(name, raw)
    if lines is None:
        return 1
    say(f"{clean(getattr(module, 'TITLE', name))} ({name}) plan:")
    for line in lines:
        say(f"  {line}")
    if options.dry_run:
        say(f"{name}: dry run, nothing written")
        return 0
    if not options.yes and not confirm(f"Install {name} now?"):
        say(f"{name}: not installed, nothing changed")
        return 1
    ok, result = call(name, module, "install", options)
    if not ok:
        return 1
    changed = guard(name, result, options)
    if changed is None:
        return 1
    for path in changed:
        say(f"  changed: {clean(path)}")
    for note in as_lines(result.get("notes")):
        say(f"  {note}")
    say(f"{name}: installed")
    return check_one(name, module)


def install_all(adapters: dict, options: Options) -> int:
    rc = 0
    found = 0
    for name, (module, error) in adapters.items():
        if module is None:
            fail(f"{name}: could not load: {error}")
            rc = 1
            continue
        info = detect_one(name, module)
        if info is None:
            rc = 1
            continue
        if not info.get("found"):
            continue
        found += 1
        rc = max(rc, install_one(name, module, options))
    if not found:
        say("no harness found to install into")
    return rc


def check_all(adapters: dict) -> int:
    rc = 0
    checked = 0
    for name, (module, error) in adapters.items():
        if module is None:
            fail(f"{name}: could not load: {error}")
            rc = 1
            continue
        info = detect_one(name, module)
        if info is None:
            rc = 1
            continue
        if not info.get("found"):
            continue
        checked += 1
        rc = max(rc, check_one(name, module))
    if not checked:
        say("no found harness to check")
    return rc


def uninstall_one(name: str, module, options: Options) -> int:
    if options.dry_run:
        say(f"{name}: dry run, nothing removed")
        return 0
    if not options.yes and not confirm(f"Remove {name}'s own entries now?"):
        say(f"{name}: not removed, nothing changed")
        return 1
    ok, result = call(name, module, "uninstall")
    if not ok:
        return 1
    changed = guard(name, result, options)
    if changed is None:
        return 1
    for path in changed:
        say(f"  changed: {clean(path)}")
    got = run_check(name, module)
    if got is None:
        fail(f"{name}: could not prove the removal, check() did not run")
        return 1
    good, _ = got
    if good:
        fail(f"{name}: still wired, check() reports ok after uninstall")
        return 1
    say(f"{name}: removed, check() no longer finds the wiring")
    return 0


def new_adapter(name, dry_run=False) -> int:
    if not name or not _adapter_scaffold.NAME_RE.fullmatch(name):
        fail("give a name of 2 to 31 characters: lower case letters, digits, - or _, starting with a letter (%s)" % scripts.cmd("install", "--new NAME"))
        return 1
    if name in load_adapters():
        fail(f"an adapter named '{name}' already exists, pick another name")
        return 1
    folder = user_adapters_dir() / name
    if folder.exists():
        fail(f"{folder} already exists, nothing written")
        return 1
    if dry_run:
        say(f"dry run, would write adapter.py, payload.py, test_adapter.py and fixtures/ in {clean(str(folder))}")
        return 0
    for path in _adapter_scaffold.create(user_adapters_dir(), name):
        say(f"  wrote {clean(path)}")
    say(f"{name}: starter adapter written. Fill in detect(), install(), check() and uninstall() in adapter.py, "
        f"then run {scripts.cmd('install', '--list')}. Contract: adapters/README.md in the Anymem repo.")
    return 0


def run(ns) -> int:
    if ns.new:
        others = [flag for flag in ("list", "all", "check", "uninstall") if getattr(ns, flag)]
        if others:
            fail(f"--new cannot be combined with --{others[0]}")
            return 1
        return new_adapter(ns.harness, ns.dry_run)
    adapters = load_adapters()
    options = Options(dry_run=ns.dry_run, yes=ns.yes, plugin_root=PLUGIN_ROOT, home=home_dir())
    modes = [flag for flag in ("list", "all", "check", "uninstall") if getattr(ns, flag)]
    if len(modes) > 1:
        fail("pick one of --list, --all, --check, --uninstall")
        return 1
    if ns.list:
        return list_adapters(adapters)
    if ns.all:
        if ns.harness:
            fail("--all takes no NAME")
            return 1
        return install_all(adapters, options)
    if ns.check and not ns.harness:
        return check_all(adapters)
    if not ns.harness:
        fail("say which harness: %s (see %s)" % (scripts.cmd("install", "NAME"), scripts.cmd("install", "--list")))
        return 1
    module = pick(adapters, ns.harness)
    if module is None:
        return 1
    if ns.check:
        return check_one(ns.harness, module)
    if ns.uninstall:
        return uninstall_one(ns.harness, module, options)
    return install_one(ns.harness, module, options)
