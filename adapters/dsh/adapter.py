"""DSH (the DeepSeek Harness, command `dsh`) adapter. The contract is adapters/README.md, the user page is docs/harnesses/dsh.md.

How DSH is wired: a profile is a stack of plugin bundles plus a patch file, <home>/.dsh/profiles/<profile>/cordis.patch.yml,
a YAML list of entries. Hooks come from the bridge plugin @deepseek-ai/dsh-hooks-claude-code, which reads a Claude Code style
settings file. This adapter writes its own such file, <home>/.config/anymem/dsh-hooks.json, and adds ONE entry to each
profile's patch file that mounts a second bridge instance (id hooks-anymem) on it, so any hooks the profile already has
keep running beside ours.

The patch file is never parsed or rewritten. Our entry is a text block between the lines `# anymem begin` and
`# anymem end`, appended at the end, and uninstall cuts exactly that block out again. Install refuses a patch file it
cannot prove is a plain block style list, and says the one block to add by hand.

install() writes only under options.home. check() and uninstall() take no options, so they use the home folder the `install`
command uses: ANYMEM_HOME when set, otherwise the real home.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from hm import scripts

NAME = "dsh"
TITLE = "DeepSeek Harness"

BEGIN = "# anymem begin"
END = "# anymem end"
TAG_EMPTY = "replaces-empty-list"
TAG_NEWLINE = "no-final-newline"
BRIDGE_ID = "hooks-anymem"
BRIDGE_PLUGIN = "@deepseek-ai/dsh-hooks-claude-code"
PATCH_FILE = "cordis.patch.yml"
BACKUP_SUFFIX = ".anymem.bak"
HOOKS_FILE = "dsh-hooks.json"
ADAPTER_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = ADAPTER_DIR.parent.parent


# ---------------------------------------------------------------- paths

def _home(options=None) -> Path:
    if options is not None:
        return Path(options.home)
    return Path(os.environ.get("ANYMEM_HOME") or Path.home())


def _dsh_dir(home: Path) -> Path:
    """<home>/.dsh, or $DSH_HOME when that is set and sits inside the home folder (never write outside it)."""
    chosen = os.environ.get("DSH_HOME")
    if chosen:
        try:
            Path(chosen).resolve().relative_to(home.resolve())
            return Path(chosen)
        except ValueError:
            pass
    return home / ".dsh"


def _hooks_file(home: Path) -> Path:
    return home / ".config" / "anymem" / HOOKS_FILE


def _patch_files(home: Path) -> list:
    """The patch file of every existing profile."""
    root = _dsh_dir(home) / "profiles"
    try:
        return sorted(p / PATCH_FILE for p in root.iterdir() if (p / PATCH_FILE).is_file())
    except OSError:
        return []


# ---------------------------------------------------------------- the hooks file

def _command(python: str, script: Path, event: str) -> str:
    return "%s %s %s" % (shlex.quote(python), shlex.quote(str(script)), event)


def hooks_config(plugin_root: Path, python: str = "") -> dict:
    script = Path(plugin_root) / "adapters" / "dsh" / "hook.py"
    python = python or scripts.hook_python()

    def entry(event: str, timeout: int) -> list:
        return [{"hooks": [{"type": "command", "command": _command(python, script, event), "timeout": timeout}]}]

    return {
        "anymem": {"adapter": NAME, "note": "written by install.py dsh, removed by install.py --uninstall dsh"},
        "hooks": {
            "SessionStart": entry("session-start", 10),
            "UserPromptSubmit": entry("prompt", 9),
            "Stop": entry("capture", 5),
        },
    }


def _ours(path: Path) -> bool:
    try:
        return isinstance(json.loads(path.read_text(encoding="utf-8")).get("anymem"), dict)
    except (OSError, ValueError, AttributeError):
        return False


# ---------------------------------------------------------------- the patch file

def block_text(hooks_path: Path, tags: tuple = ()) -> str:
    begin = " ".join([BEGIN, *tags])
    return "\n".join([
        begin,
        "# Mounts the anymem hooks (capsule, recall, capture) as a second hooks bridge. Remove with install.py --uninstall dsh.",
        "- insert:",
        "    - id: %s" % BRIDGE_ID,
        '      name: "%s"' % BRIDGE_PLUGIN,
        "      config:",
        "        configPath: %s" % json.dumps(str(hooks_path)),
        END,
    ]) + "\n"


def manual_step(hooks_path: Path) -> str:
    return ("Add this to the end of the patch file by hand: " + block_text(hooks_path).replace("\n", " ").strip())


def _block_span(lines: list):
    """(first index, last index) of our block in a list of lines, None when absent. Raises when the markers do not pair up."""
    begins = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == BEGIN or line.startswith(BEGIN + " ")]
    ends = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == END]
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        raise ValueError("the anymem markers in this file do not pair up")
    return begins[0], ends[0]


def classify(text: str) -> tuple:
    """(kind, why). kind is empty, empty-list, list, present, or refuse (then why says why)."""
    lines = text.splitlines(keepends=True)
    try:
        if _block_span(lines) is not None:
            return "present", ""
    except ValueError as exc:
        return "refuse", str(exc)
    if "\r" in text:
        return "refuse", "it uses Windows line endings"
    if "id: " + BRIDGE_ID in text:
        return "refuse", "it already has an entry with the id %s that is not ours" % BRIDGE_ID
    content = [line for line in text.split("\n") if line.strip() and not line.lstrip().startswith("#")]
    if not content:
        return "empty", ""
    top = [line for line in content if not line[0].isspace()]
    if len(content) == 1 and content[0] == "[]":
        return "empty-list", ""
    if top and all(line == "-" or line.startswith("- ") for line in top) and (content[0] == "-" or content[0].startswith("- ")):
        return "list", ""
    return "refuse", "it is not a plain block style YAML list"


def add_block(text: str, kind: str, hooks_path: Path) -> str:
    """The patch text with our block added. `kind` comes from classify()."""
    if kind == "empty-list":
        lines = text.splitlines(keepends=True)
        i = next(n for n, line in enumerate(lines) if line.rstrip("\n") == "[]")
        tags = (TAG_EMPTY,) + (() if lines[i].endswith("\n") else (TAG_NEWLINE,))
        lines[i] = block_text(hooks_path, tags)
        return "".join(lines)
    if text and not text.endswith("\n"):
        return text + "\n" + block_text(hooks_path, (TAG_NEWLINE,))
    return text + block_text(hooks_path)


def _only_comments(lines: list) -> bool:
    """True when nothing but comments and blank lines is left, the same test classify() makes for an empty file."""
    return all(not line.strip() or line.lstrip().startswith("#") for line in lines)


def remove_block(text: str) -> str:
    """The patch text with our block cut out, byte identical to what install started from, and with anything the user added after it kept as it is."""
    lines = text.splitlines(keepends=True)
    span = _block_span(lines)
    if span is None:
        return text
    first, last = span
    tags = lines[first].split()[3:]
    after = lines[last + 1:]
    replacement = []
    if TAG_EMPTY in tags and _only_comments(lines[:first] + after):
        # the template's [] goes back only when nothing else is left, a flow list followed by block items is not valid YAML
        replacement = ["[]" + ("" if TAG_NEWLINE in tags and not after else "\n")]
    out = "".join(lines[:first] + replacement + after)
    if TAG_NEWLINE in tags and TAG_EMPTY not in tags and not after and out.endswith("\n"):
        out = out[:-1]  # our block was the last thing, so the separator newline we added is the one to drop
    return out


def _read(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".anymem.tmp")
    tmp.write_bytes(text.encode("utf-8"))
    shutil.copymode(str(path), str(tmp))
    os.replace(str(tmp), str(path))


# ---------------------------------------------------------------- contract

def detect() -> dict:
    home = _home()
    binary = shutil.which("dsh")
    dsh = _dsh_dir(home)
    version = ""
    if binary:
        try:
            out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
            version = out[0] if out else ""
        except (OSError, subprocess.SubprocessError):
            pass
    patches = _patch_files(home)
    notes = ["profiles: " + (", ".join(p.parent.name for p in patches) or "none yet, start dsh once to create them")]
    for patch in patches:
        try:
            if _block_span(_read(patch).splitlines(keepends=True)) is not None:
                notes.append("%s is already wired" % patch.parent.name)
        except (OSError, ValueError):
            notes.append("%s: could not read the patch file" % patch.parent.name)
    return {"found": bool(binary) or dsh.is_dir(), "version": version, "config_path": str(dsh / "profiles"), "notes": notes}


def plan(options) -> list:
    home = _home(options)
    hooks = _hooks_file(home)
    patches = _patch_files(home)
    if not patches:
        return ["refuse: no dsh profile found under %s, start dsh once to create one, then run this again" % (_dsh_dir(home) / "profiles")]
    lines = ["write %s with the capsule, recall and capture hooks (this file is ours alone)" % hooks]
    for patch in patches:
        try:
            kind, why = classify(_read(patch))
        except (OSError, ValueError) as exc:
            kind, why = "refuse", "it cannot be read (%s)" % type(exc).__name__
        if kind == "refuse":
            lines.append("refuse to touch %s because %s" % (patch, why))
        elif kind == "present":
            lines.append("leave %s as it is, the anymem block is already there" % patch)
        else:
            lines.append("back up %s once as %s, then add one marked block that mounts a second hooks bridge (id %s) on %s"
                         % (patch, patch.name + BACKUP_SUFFIX, BRIDGE_ID, hooks))
    return lines


def install(options) -> dict:
    home = _home(options)
    hooks = _hooks_file(home)
    script = Path(options.plugin_root) / "adapters" / "dsh" / "hook.py"
    if not script.is_file():
        raise RuntimeError("cannot find %s, plugin_root is wrong" % script)
    patches = _patch_files(home)
    if not patches:
        raise RuntimeError("no dsh profile found under %s. Start dsh once to create one, then run this again." % (_dsh_dir(home) / "profiles"))
    if hooks.exists() and not _ours(hooks):
        raise RuntimeError("%s exists and was not written by anymem, move it away first" % hooks)
    work = []  # (patch file, old text, new text), all checked before anything is written
    for patch in patches:
        try:
            old = _read(patch)
        except (OSError, ValueError) as exc:
            raise RuntimeError("cannot read %s (%s). %s" % (patch, type(exc).__name__, manual_step(hooks))) from None
        kind, why = classify(old)
        if kind == "refuse":
            raise RuntimeError("will not touch %s because %s. %s" % (patch, why, manual_step(hooks)))
        if kind != "present":
            work.append((patch, old, add_block(old, kind, hooks)))
    if options.dry_run:
        return {"changed": [], "notes": plan(options)}
    changed = []
    wanted = json.dumps(hooks_config(options.plugin_root), indent=2) + "\n"
    if not hooks.exists() or hooks.read_text(encoding="utf-8") != wanted:
        hooks.parent.mkdir(parents=True, exist_ok=True)
        hooks.write_text(wanted, encoding="utf-8")
        changed.append(str(hooks))
    for patch, old, new in work:
        backup = patch.with_name(patch.name + BACKUP_SUFFIX)
        if not backup.exists():
            shutil.copy2(str(patch), str(backup))
            changed.append(str(backup))
        _write(patch, new)
        changed.append(str(patch))
    notes = ["wired %d profile(s): %s" % (len(patches), ", ".join(p.parent.name for p in patches)),
             "start a new dsh session to load the hooks, DSH reads its hook files when it starts"]
    return {"changed": changed, "notes": notes}


def uninstall() -> dict:
    home = _home()
    hooks = _hooks_file(home)
    changed, notes, stuck = [], [], []
    work = []  # (patch file, old text, new text), every profile is worked out before any file is written
    for patch in _patch_files(home):
        try:
            text = _read(patch)
            work.append((patch, text, remove_block(text)))
        except (OSError, ValueError) as exc:
            stuck.append(patch)
            notes.append("left %s alone, it cannot be cleaned (%s)" % (patch, exc if isinstance(exc, ValueError) else type(exc).__name__))
    for patch, text, new in work:
        backup = patch.with_name(patch.name + BACKUP_SUFFIX)
        if new != text:
            _write(patch, new)
            changed.append(str(patch))
        if backup.exists() and backup.read_bytes() == new.encode("utf-8"):
            backup.unlink()  # the file is back to what it was when we backed it up, so the copy has done its job
            changed.append(str(backup))
    if stuck:  # a profile we could not clean may still mount the hooks file, so it stays
        notes.append("kept %s, because a profile that could not be cleaned may still mount it. Fix that patch file, then run uninstall again" % hooks)
    elif hooks.exists() and _ours(hooks):
        hooks.unlink()
        changed.append(str(hooks))
        try:
            hooks.parent.rmdir()  # only when nothing else lives there
        except OSError:
            pass
    out = {"changed": changed}
    if notes:
        out["notes"] = notes
    return out


def check() -> dict:
    home = _home()
    hooks = _hooks_file(home)
    problems = []
    patches = _patch_files(home)
    if not patches:
        problems.append("no dsh profile found under %s" % (_dsh_dir(home) / "profiles"))
    for patch in patches:
        try:
            text = _read(patch)
            wired = _block_span(text.splitlines(keepends=True)) is not None
        except (OSError, ValueError) as exc:
            problems.append("%s: %s" % (patch, exc if isinstance(exc, ValueError) else type(exc).__name__))
            continue
        if not wired:
            lost = " (an entry with our id is there but our markers are gone, remove it by hand and install again)" if "id: " + BRIDGE_ID in text else ""
            problems.append("profile %s has no anymem block%s" % (patch.parent.name, lost))
    problems += _check_hooks_file(hooks)
    if not problems:
        problems += _check_reach()
    return {"ok": not problems, "problems": problems}


def _check_hooks_file(hooks: Path) -> list:
    try:
        data = json.loads(hooks.read_text(encoding="utf-8"))
    except OSError:
        return ["the hooks file %s is missing" % hooks]
    except ValueError:
        return ["the hooks file %s is not valid JSON" % hooks]
    problems = []
    events = (data.get("hooks") or {}) if isinstance(data, dict) else {}
    command = ""
    for event in ("SessionStart", "UserPromptSubmit", "Stop"):
        try:
            command = events[event][0]["hooks"][0]["command"]
        except (KeyError, IndexError, TypeError):
            problems.append("the hooks file has no %s hook" % event)
    if command:
        try:
            python, script = shlex.split(command)[:2]
        except ValueError:
            return problems + ["a hook command in %s cannot be read" % hooks]
        if not Path(script).is_file():
            problems.append("the hook script %s is missing, install again from the current folder" % script)
        else:
            try:
                ping = subprocess.run([python, script, "ping"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
            except (OSError, subprocess.SubprocessError) as exc:
                return problems + ["the hook command does not start (%s)" % type(exc).__name__]
            if ping.stdout.strip() != "ok":
                problems.append("the hook script starts but does not load the shared hooks (ping printed %r)" % ping.stdout.strip()[:40])
    return problems


def _check_reach() -> list:
    if str(PLUGIN_ROOT / "client") not in sys.path:
        sys.path.insert(0, str(PLUGIN_ROOT / "client"))
    from hm import api, config
    settings = config.load()
    if not settings.configured():
        return ["anymem is not configured (missing %s), run `%s` or `%s`" % (", ".join(settings.missing()), scripts.cmd("setup"), scripts.cmd("connect"))]
    saved = config.read_file()
    hidden = [key for key in ("token", "access_client_secret") if settings.source.get(key) == "env" and not saved.get(key) and not saved.get("credential_command")]
    if hidden:
        return ["the %s is only set in the environment, and DSH removes variables with TOKEN, SECRET, KEY or PASSWORD in their name before it runs a hook, "
                "so the hooks will not see it. Keep it in the config file (`connect.py` writes it) or set a credential_command" % " and ".join(hidden)]
    try:
        api.request("GET", "/health", timeout=8, settings=settings)
    except (api.ApiError, api.NetworkError) as exc:
        return ["the hooks cannot reach the Worker: %s" % exc]
    return []
