"""The Codex adapter: installs Anymem into OpenAI's Codex CLI as a Codex plugin.

Codex 0.157 installs a package that holds .codex-plugin/plugin.json and .agents/plugins/marketplace.json with two commands,
`codex plugin marketplace add FOLDER` and `codex plugin add anymem@anymem`, and removes it with
`codex plugin remove` and `codex plugin marketplace remove`. The plugin brings the skill and the hooks. Codex runs a hook only
after the user approves it (it stores a hash in config.toml), and this adapter never approves anything for the user:
install() says so, and check() reports the hooks as not yet trusted until Codex has recorded the approval.

Everything is written by Codex itself, in CODEX_HOME (default ~/.codex): two tables in config.toml and a copy of the package
in plugins/cache. Before the first change config.toml is copied to config.toml.anymem.bak. uninstall() asks Codex to
remove both entries, and when config.toml is then identical to the backup it deletes the backup too, so the folder is back to
how it was. A config.toml that does not parse is never touched.

Contract: adapters/README.md. Python 3.9, standard library only.
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


NAME = "codex"
TITLE = "OpenAI Codex CLI"

PLUGIN = "anymem"
MARKETPLACE = "anymem"
SELECTOR = PLUGIN + "@" + MARKETPLACE
BACKUP_SUFFIX = ".anymem.bak"
CODEX_BIN_ENV = "ANYMEM_CODEX_BIN"
ROOT = Path(__file__).resolve().parent.parent.parent
TIMEOUT = 90
# folders Codex creates while it works. Empty ones are pruned on uninstall, a folder that holds anything is left alone.
PRUNE = (("plugins", "cache", PLUGIN), ("plugins", "cache"), ("plugins"), (".tmp", "marketplaces"), (".tmp"), ("tmp", "arg0"), ("tmp"))


class AdapterError(Exception):
    """A refusal or a failure with a message meant for the person running install."""


# ---------------------------------------------------------------- where things are

def default_home() -> Path:
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def codex_home(home: Path) -> Path:
    """CODEX_HOME when it is set, else ~/.codex."""
    return Path(os.environ.get("CODEX_HOME") or home / ".codex")


def inside(path: Path, home: Path) -> bool:
    try:
        path.resolve().relative_to(home.resolve())
        return True
    except ValueError:
        return False


def codex_bin() -> str:
    env = os.environ.get(CODEX_BIN_ENV)
    if env:
        return env if Path(env).is_file() else ""
    found = shutil.which("codex")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/codex", "/usr/local/bin/codex", str(default_home() / ".local" / "bin" / "codex")):
        if Path(candidate).is_file():
            return candidate
    return ""


def run_codex(args: list, home_dir: Path, timeout: int = TIMEOUT) -> tuple:
    """(exit code, output) of `codex ARGS` with CODEX_HOME set. Never raises on a failing command."""
    binary = codex_bin()
    if not binary:
        raise AdapterError("the codex command was not found. Install Codex CLI first, or set %s to its path." % CODEX_BIN_ENV)
    env = dict(os.environ, CODEX_HOME=str(home_dir))
    try:
        r = subprocess.run([binary] + args, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AdapterError("codex %s did not finish within %d seconds" % (" ".join(args[:3]), timeout))
    except OSError as e:
        raise AdapterError("could not run codex: %s" % e)
    return r.returncode, (r.stdout + r.stderr).strip()


def first_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("WARNING"):
            return line[:240]
    return text.strip()[:240]


# ---------------------------------------------------------------- reading config.toml (read only)

def config_path(home_dir: Path) -> Path:
    return home_dir / "config.toml"


def read_config(home_dir: Path) -> str:
    try:
        return config_path(home_dir).read_text(encoding="utf-8")
    except OSError:
        return ""


def table_body(text: str, header: str) -> "str | None":
    """The lines under `[header]` up to the next table, or None when that table is not there."""
    m = re.search(r"(?m)^\[%s\][ \t]*$\n?(.*?)(?=^\[|\Z)" % re.escape(header), text, re.S)
    return m.group(1) if m else None


def quoted(body: str, key: str) -> str:
    m = re.search(r'(?m)^%s\s*=\s*"([^"\n]*)"' % re.escape(key), body or "")
    return m.group(1) if m else ""


def state(home_dir: Path) -> dict:
    """What config.toml says about us: marketplace source (or None), plugin entry present and enabled, trusted hook records."""
    text = read_config(home_dir)
    market = table_body(text, "marketplaces." + MARKETPLACE)
    plugin = table_body(text, 'plugins."%s"' % SELECTOR)
    trusted = re.findall(r'(?m)^\[hooks\.state\."([^"\n]*)"\]', text)
    # Codex 0.157 keys a plugin's hook by its selector ("anymem@anymem:adapters/codex/hooks.json:..."), older
    # builds by the cached file path. Seen live on 2026-10-09 after approving the hooks in the desktop app.
    ours = [k for k in trusted if k.startswith(SELECTOR + ":") or "/plugins/cache/%s/" % PLUGIN in k.replace("\\", "/")]
    return {
        "marketplace": quoted(market, "source") if market is not None else None,
        "plugin": plugin is not None,
        "enabled": plugin is not None and re.search(r"(?m)^enabled\s*=\s*true", plugin) is not None,
        "trusted": ours,
    }


REAPPROVE = "Start codex and approve the anymem hooks again (review with /hooks)."


def content_hash(root: Path) -> str:
    """Codex's fingerprint of a plugin folder, as codex-rs/hooks/src/engine/plugin_fingerprint.rs computes it (rust-v0.164.0):
    every entry depth first in byte order, each as its relative path with a length prefix, then "directory", or "file" with its
    size and bytes. __pycache__, .venv, *.pyc and *.egg-info are left out. Raises OSError on a symlink, as Codex refuses one."""
    import hashlib
    import stat
    import struct
    h = hashlib.sha256(b"codex-plugin-bundle-v1")
    pending = [root]
    while pending:
        path = pending.pop()
        rel = os.fsencode(os.path.relpath(path, root)) if path != root else b""
        name = os.path.basename(rel)
        if name in (b"__pycache__", b".venv") or name.endswith((b".pyc", b".egg-info")):
            continue
        h.update(struct.pack("<Q", len(rel)) + rel)
        st = os.lstat(path)
        if stat.S_ISDIR(st.st_mode):
            h.update(b"directory")
            pending.extend(sorted(path.iterdir(), key=lambda p: os.fsencode(p.name), reverse=True))
        elif stat.S_ISREG(st.st_mode):
            h.update(b"file" + struct.pack("<Q", st.st_size))
            with open(path, "rb") as f:  # in chunks, the copy holds the repo's .git with packs of tens of MB
                for chunk in iter(lambda: f.read(1 << 16), b""):
                    h.update(chunk)
        else:
            raise OSError("unsupported plugin entry type: %s" % path)
    return "sha256:" + h.hexdigest()


SEMVER = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?")


def _compare_versions(a: str, b: str) -> int:
    """Codex's compare_plugin_versions: semver order when both names are semver, else plain string order. Close to the semver
    crate, not exact: names it rejects (an empty identifier, a prerelease number with a leading zero) count as semver here,
    and build numbers that differ only in leading zeros compare equal. Cache folder names never look like that."""
    ma, mb = SEMVER.fullmatch(a), SEMVER.fullmatch(b)
    if not (ma and mb):
        return (a > b) - (a < b)

    def ids(text):  # a prerelease or build part: numeric identifiers sort below text ones and by value
        return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in text.split(".")] if text else []

    def key(m):
        return (tuple(int(x) for x in m.groups()[:3]), m.group(4) is None, ids(m.group(4)), ids(m.group(5)))
    ka, kb = key(ma), key(mb)
    return (ka > kb) - (ka < kb)


def active_copy(home_dir: Path) -> "Path | None":
    """The folder Codex runs the plugin from, as codex-rs/core-plugin-common/src/installed.rs active_plugin_version picks it:
    real folders (not symlinks) with a valid name, "local" when present, else the highest version."""
    import functools
    base = home_dir / "plugins" / "cache" / MARKETPLACE / PLUGIN
    try:
        names = [d.name for d in base.iterdir() if d.is_dir() and not d.is_symlink() and re.fullmatch(r"[A-Za-z0-9._+-]+", d.name) and d.name not in (".", "..")]
    except OSError:
        return None
    if not names:
        return None
    return base / ("local" if "local" in names else sorted(names, key=functools.cmp_to_key(_compare_versions))[-1])


def legacy_baseline(home_dir: Path) -> Path:
    """Where Codex 0.164 pins the plugin contents for an approval made before it checked contents (plugin_trust.rs): a file
    named by sha256 of the config file path and the plugin id, each with a little endian length prefix. Codex resolves CODEX_HOME
    to its real path when the variable is set (utils/home-dir), and uses ~/.codex as it is otherwise, so the name does too."""
    import hashlib
    import struct
    cfg = config_path(home_dir)
    if os.environ.get("CODEX_HOME") and Path(os.environ["CODEX_HOME"]) == home_dir:
        cfg = config_path(home_dir.resolve())
    h = hashlib.sha256()
    for part in (os.fsencode(str(cfg)), SELECTOR.encode()):
        h.update(struct.pack("<Q", len(part)) + part)
    return home_dir / ".hook-trust" / h.hexdigest()


def declared_keys(root: Path) -> list:
    """The trust keys Codex checks for the hooks this copy declares, built as discovery.rs builds them (hook_key):
    "<plugin id>:<hooks file>:<event in snake case>:<group index>:<handler index>"."""
    data = json.loads((root / "adapters" / "codex" / "hooks.json").read_text(encoding="utf-8"))
    return ["%s:adapters/codex/hooks.json:%s:%d:%d" % (SELECTOR, re.sub(r"(?<!^)(?=[A-Z])", "_", event).lower(), g, h)
            for event, groups in data["hooks"].items() for g, group in enumerate(groups) for h, _ in enumerate(group["hooks"])]


def stale_trust(home_dir: Path, trusted: list) -> str:
    """Why Codex will refuse an anymem hook it once approved, or ''. The caller adds the fix (REAPPROVE). Codex 0.164 judges
    each hook the active copy declares on its own: it needs a trust record under that hook's key, and the whole active plugin
    folder must hash to that record's trusted_content_hash, or, for a hook approved before 0.164, to a baseline file written
    the first time a hook runs. Any change to the copy (an upgrade, a reinstall, a re-add with new files) fails the hook as
    "plugin contents changed". Records for hooks the copy no longer declares are left alone, Codex never reads them."""
    root = active_copy(home_dir)
    if root is None:
        return ""
    try:
        keys = declared_keys(root)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        return ("Codex cannot read the hooks the installed plugin declares (%s), so it will not run them. Reinstall the plugin with "
                "`codex plugin add %s` first." % (first_line(str(e)), SELECTOR))
    label = lambda k: k.split(":")[-3]  # noqa: E731  the event name inside a key we built
    text = read_config(home_dir)
    # a record without trusted_hash (only `enabled = false`, say) is no approval, Codex rates that hook untrusted (discovery.rs)
    missing = [label(k) for k in keys if k not in trusted or not quoted(table_body(text, 'hooks.state."%s"' % k) or "", "trusted_hash")]
    if missing:
        return "Codex has no approval for the anymem hooks (%s) of its current copy, so it does not run them." % ", ".join(missing)
    pins = {k: quoted(table_body(text, 'hooks.state."%s"' % k) or "", "trusted_content_hash") for k in keys}
    if not all(pins.values()):
        try:
            baseline = legacy_baseline(home_dir).read_text(encoding="utf-8")  # compared as written, as Codex does
        except FileNotFoundError:
            baseline = ""  # not pinned yet: Codex pins the current contents the first time a hook runs
        except (OSError, ValueError) as e:
            return "Codex cannot read its approval baseline for the anymem hooks (%s), so it will not run them." % first_line(str(e))
        pins = {k: v or baseline for k, v in pins.items()}
    try:
        current = content_hash(root)
    except OSError as e:
        return "Codex cannot fingerprint the installed plugin (%s), so it will not run the anymem hooks." % first_line(str(e))
    stale = [label(k) for k, v in pins.items() if v and v != current]
    if not stale:
        return ""
    return ("Codex no longer runs the anymem hooks (%s): the files in %s changed since you approved them, and Codex checks a hash "
            "of the whole plugin folder before every hook." % (", ".join(stale), root))


def config_problem(home_dir: Path, ask_codex: bool = True) -> str:
    """'' when config.toml is absent or valid, else why not. Python 3.11+ parses it here. Older Pythons have no TOML parser, so
    with ask_codex Codex itself is asked (it refuses a file it cannot parse), at the cost of Codex creating its empty tmp/ folder
    inside CODEX_HOME. check() passes ask_codex=False because it must have no side effects."""
    path = config_path(home_dir)
    if not path.exists():
        return ""
    try:
        data = path.read_bytes()
    except OSError as e:
        return "cannot read %s: %s" % (path, e)
    try:
        import tomllib  # type: ignore[import-not-found]
    except ImportError:
        tomllib = None
    if tomllib is not None:
        try:
            tomllib.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            return "%s is not valid TOML: %s" % (path, first_line(str(e)))
    if not ask_codex:
        return ""
    code, out = run_codex(["plugin", "marketplace", "list"], home_dir, timeout=30)
    if code != 0:
        return "Codex cannot read %s: %s" % (path, first_line(out))
    return ""


def package_problem(plugin_root: Path) -> str:
    plugin_json = plugin_root / ".codex-plugin" / "plugin.json"
    market_json = plugin_root / ".agents" / "plugins" / "marketplace.json"
    for path in (plugin_json, market_json):
        if not path.is_file():
            return "%s is missing, so %s is not a Codex plugin package" % (path.name, plugin_root)
    try:
        name = json.loads(plugin_json.read_text(encoding="utf-8")).get("name")
        market = json.loads(market_json.read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError) as e:
        return "the plugin package does not parse: %s" % first_line(str(e))
    if name != PLUGIN or market != MARKETPLACE:
        return "the plugin package is named %r in a marketplace named %r, expected %r in %r" % (name, market, PLUGIN, MARKETPLACE)
    return ""


# ---------------------------------------------------------------- the contract

def codex_version() -> str:
    """`codex --version` run with a scratch CODEX_HOME, because Codex creates a tmp/ folder in whatever CODEX_HOME it is given
    and detect() must not write into the real one."""
    with tempfile.TemporaryDirectory(prefix="hm-codex-version-") as scratch:
        code, out = run_codex(["--version"], Path(scratch), timeout=15)
    m = re.search(r"\d+\.\d+\.\d+\S*", out) if code == 0 else None
    return m.group(0) if m else ""


def detect() -> dict:
    home_dir = codex_home(default_home())
    binary = codex_bin()
    version = ""
    notes = []
    if binary:
        try:
            version = codex_version()
        except AdapterError as e:
            notes.append(str(e))
    else:
        notes.append("the codex command was not found on PATH")
    if binary and not home_dir.is_dir():
        notes.append("%s does not exist yet, Codex has not been run here" % home_dir)
    if state(home_dir)["plugin"]:
        notes.append("the anymem plugin is already installed")
    return {"found": bool(binary), "version": version, "config_path": str(config_path(home_dir)), "notes": notes}


def plan(options) -> list:
    home = Path(getattr(options, "home", None) or default_home())
    root = Path(getattr(options, "plugin_root", None) or ROOT)
    home_dir = codex_home(home)
    cfg = config_path(home_dir)
    st = state(home_dir)
    lines = []
    if st["plugin"] and st["enabled"]:
        lines.append("The anymem plugin is already installed in %s, so nothing would change." % home_dir)
        return lines
    if cfg.exists() and not cfg.with_name(cfg.name + BACKUP_SUFFIX).exists():
        lines.append("Copy %s to %s%s once, before the first change." % (cfg, cfg.name, BACKUP_SUFFIX))
    if st["marketplace"] is None:
        lines.append("Run `codex plugin marketplace add %s`, which adds a [marketplaces.%s] table to %s." % (root, MARKETPLACE, cfg))
    lines.append("Run `codex plugin add %s`, which adds a [plugins.\"%s\"] table to %s and copies the plugin (skill and hooks) into %s." % (SELECTOR, SELECTOR, cfg, home_dir / "plugins" / "cache" / MARKETPLACE))
    lines.append("Nothing else in %s is touched, and nothing is approved for you: Codex asks you to approve the hooks the first time it starts." % home_dir)
    lines.append("Uninstall runs `codex plugin remove` and `codex plugin marketplace remove` and deletes the backup when config.toml matches it again.")
    return lines


def install(options) -> dict:
    home = Path(getattr(options, "home", None) or default_home())
    root = Path(getattr(options, "plugin_root", None) or ROOT).resolve()
    if getattr(options, "dry_run", False):
        return {"changed": [], "notes": ["dry run, nothing written"] + plan(options)}
    home_dir = codex_home(home)
    if not inside(home_dir, home):
        raise AdapterError("CODEX_HOME (%s) is outside the home folder %s, so nothing was written" % (home_dir, home))
    problem = package_problem(root)
    if problem:
        raise AdapterError(problem)
    if not codex_bin():
        raise AdapterError("the codex command was not found. Install Codex CLI first, or set %s to its path." % CODEX_BIN_ENV)
    st = state(home_dir)
    if st["marketplace"] is not None and Path(st["marketplace"]).resolve() != root:
        raise AdapterError("a marketplace named %s already exists in %s and points at %s, not at %s. Remove it first (`codex plugin marketplace remove %s`), nothing was changed." % (MARKETPLACE, config_path(home_dir), st["marketplace"], root, MARKETPLACE))
    problem = config_problem(home_dir)
    if problem:
        raise AdapterError("%s. Fix that first, nothing was changed." % problem)
    if st["plugin"] and st["enabled"] and st["marketplace"] is not None:
        return {"changed": [], "notes": ["the anymem plugin was already installed, nothing changed"] + trust_notes(st, home_dir)}
    changed = []
    cfg = config_path(home_dir)
    backup = cfg.with_name(cfg.name + BACKUP_SUFFIX)
    home_dir.mkdir(parents=True, exist_ok=True)
    if cfg.exists() and not backup.exists():
        shutil.copy2(str(cfg), str(backup))
        changed.append(str(backup))
    added_marketplace = False
    try:
        if st["marketplace"] is None:
            code, out = run_codex(["plugin", "marketplace", "add", str(root)], home_dir)
            if code != 0:
                raise AdapterError("codex plugin marketplace add failed: %s" % first_line(out))
            added_marketplace = True
        code, out = run_codex(["plugin", "add", SELECTOR], home_dir)
        if code != 0:
            raise AdapterError("codex plugin add failed: %s" % first_line(out))
    except AdapterError:
        if added_marketplace:  # leave Codex as we found it
            run_codex(["plugin", "marketplace", "remove", MARKETPLACE], home_dir)
        raise
    changed = [str(cfg), *changed, str(home_dir / "plugins" / "cache" / MARKETPLACE)]
    return {"changed": changed, "notes": trust_notes(state(home_dir), home_dir)}


def trust_notes(st: dict, home_dir: Path) -> list:
    if st["trusted"]:
        stale = stale_trust(home_dir, st["trusted"])  # a fresh copy is the usual way an approval goes stale
        return [stale + " " + REAPPROVE] if stale else ["Codex has recorded its approval for the anymem hooks."]
    return ["Codex does not run the new hooks until you approve them. Start codex and approve the anymem hooks when it asks (review them with /hooks). Start a new session after that. Nothing was approved for you."]


def check() -> dict:
    home_dir = codex_home(default_home())
    problems = []
    pending = []
    if not codex_bin():
        return {"ok": False, "problems": ["the codex command was not found"]}
    bad = config_problem(home_dir, ask_codex=False)
    if bad:
        return {"ok": False, "problems": [bad]}
    st = state(home_dir)
    if not st["plugin"]:
        problems.append("the anymem plugin is not installed in %s. Run `%s`." % (home_dir, scripts.cmd("install", "codex")))
    elif not st["enabled"]:
        problems.append("the anymem plugin is installed but disabled in %s" % config_path(home_dir))
    if st["plugin"]:
        # the file Codex runs is adapters/codex/hooks.json (the plugin manifest names it). hooks/hooks.json is the Claude Code file
        hooks = sorted((home_dir / "plugins" / "cache" / MARKETPLACE / PLUGIN).glob("*/adapters/codex/hooks.json"))
        if not hooks:
            problems.append("the installed plugin has no adapters/codex/hooks.json under %s. Reinstall it." % (home_dir / "plugins" / "cache"))
        if not st["trusted"]:
            pending.append("Codex has not trusted the anymem hooks yet, so they do not run. Start codex and approve them when it asks (review with /hooks).")
        else:
            stale = stale_trust(home_dir, st["trusted"])
            if stale:
                problems.append(stale + " " + REAPPROVE)  # hooks that ran before have stopped, so it is not ok, unlike a first approval still to give
    if not shutil.which("python3"):
        problems.append("python3 is not on PATH, and the hooks run `python3`")
    problems.extend(worker_problems())
    return {"ok": not problems, "problems": problems, "pending": pending}


def worker_problems() -> list:
    """Reads GET /health with the client's own credentials. No side effects."""
    client = str(ROOT / "client")
    if client not in sys.path:
        sys.path.insert(0, client)
    try:
        from hm import api
    except ImportError as e:
        return ["the shared client could not be imported: %s" % first_line(str(e))]
    try:
        api.request("GET", "/health", timeout=5)
    except api.NotConfigured:
        return ["anymem is not configured, so the hooks cannot reach a Worker. Run `%s` or `%s`." % (scripts.cmd("setup"), scripts.cmd("connect"))]
    except api.ApiError as e:
        return ["the Worker answered with an error: %s" % first_line(str(e))]
    except api.NetworkError as e:
        return ["the Worker could not be reached: %s" % first_line(str(e))]
    return []


def uninstall() -> dict:
    home = default_home()
    home_dir = codex_home(home)
    changed = []
    st = state(home_dir)
    cfg = config_path(home_dir)
    backup = cfg.with_name(cfg.name + BACKUP_SUFFIX)
    if st["plugin"] or st["marketplace"] is not None:
        bad = config_problem(home_dir)
        if bad:
            raise AdapterError("%s. Nothing was removed." % bad)
    if st["plugin"]:
        code, out = run_codex(["plugin", "remove", SELECTOR], home_dir)
        if code != 0:
            raise AdapterError("codex plugin remove failed: %s" % first_line(out))
        changed.append(str(home_dir / "plugins" / "cache" / MARKETPLACE))
    if st["marketplace"] is not None:
        code, out = run_codex(["plugin", "marketplace", "remove", MARKETPLACE], home_dir)
        if code != 0:
            raise AdapterError("codex plugin marketplace remove failed: %s" % first_line(out))
    if st["plugin"] or st["marketplace"] is not None:
        changed.append(str(cfg))
    if backup.exists():
        try:
            same = cfg.exists() and cfg.read_bytes() == backup.read_bytes()
        except OSError:
            same = False
        if same:
            backup.unlink()
            changed.append(str(backup))
    elif changed and cfg.exists() and cfg.stat().st_size == 0:  # Codex had no config.toml before we installed, and it is empty again
        cfg.unlink()
    prune(home_dir)
    return {"changed": changed}


def prune(home_dir: Path) -> None:
    """Remove the empty folders Codex made for us. rmdir refuses a folder that holds anything."""
    for parts in PRUNE:
        parts = (parts,) if isinstance(parts, str) else parts
        try:
            home_dir.joinpath(*parts).rmdir()
        except OSError:
            pass
