"""A stand-in for ZCode's command line, used by test_adapter.py as <app>/Contents/Resources/glm/zcode.cjs and run by Python.

It mimics what the real ZCode 0.16.9 does for `plugins` and `--version`, as observed on a throwaway home:
  - state lives under $HOME/.zcode/cli: config.json, plugins/installed_plugins.json, plugins/known_marketplaces.json,
    plugins/marketplaces/<name> (a copy of the marketplace folder), plugins/cache/<marketplace>/<plugin>/<version>
  - every file ZCode rewrites comes out in its own formatting (four space indent here, so a restore from a backup shows)
  - `marketplace remove` forgets the marketplace but leaves its copy in plugins/marketplaces
  - `plugins list --json` reports hookDetails read from the installed copy's hooks/hooks.json, and only counts events ZCode
    knows (no PreCompact, no SessionEnd), which is also what the real one does
Every call is appended to $FAKE_ZCODE_LOG when that is set.
"""
import json
import os
import shutil
import sys
from pathlib import Path

EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop")
HOME = Path(os.environ["HOME"])
CLI = HOME / ".zcode" / "cli"
PLUGINS = CLI / "plugins"
CONFIG = CLI / "config.json"
INSTALLED = PLUGINS / "installed_plugins.json"
KNOWN = PLUGINS / "known_marketplaces.json"


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")


def say(text, code=0):
    print(text)
    sys.exit(code)


def manifest(folder):
    try:
        return json.loads((Path(folder) / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def market(folder):
    return json.loads((Path(folder) / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))


def main(argv):
    if os.environ.get("FAKE_ZCODE_LOG"):
        with open(os.environ["FAKE_ZCODE_LOG"], "a", encoding="utf-8") as f:
            f.write(" ".join(argv) + "\n")
    if argv == ["--version"]:
        say("0.16.9")
    if argv[:1] != ["plugins"]:
        say("unsupported by the fake", 2)
    cmd, rest = argv[1], argv[2:]
    if cmd == "validate":
        if manifest(rest[0]) is None:
            say("Plugin manifest is invalid: " + rest[0], 1)
        say("Plugin manifest is valid: " + rest[0])
    if cmd == "marketplace":
        action, rest = rest[0], rest[1:]
        known = load(KNOWN, {"version": 1, "marketplaces": []})
        if action == "add":
            if not Path(rest[0]).is_dir():
                say("Error: Marketplace source path does not exist: " + rest[0], 1)
            data = market(rest[0])
            dest = PLUGINS / "marketplaces" / data["name"]
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(rest[0], dest)
            known["marketplaces"] = [m for m in known["marketplaces"] if m["name"] != data["name"]]
            known["marketplaces"].append({"id": data["name"], "name": data["name"], "source": {"source": "directory", "path": rest[0]}})
            save(KNOWN, known)
            say(f"Added marketplace {data['name']} ({len(data['plugins'])} plugins)")
        if action == "remove":
            known["marketplaces"] = [m for m in known["marketplaces"] if m["name"] != rest[0]]
            save(KNOWN, known)
            say("Removed marketplace " + rest[0])
        say("unsupported by the fake", 2)
    installed = load(INSTALLED, {"version": 1, "plugins": []})
    config = load(CONFIG, {"plugins": {"enabledPlugins": {}, "options": {}}})
    if cmd == "install":
        plugin, _, mp = rest[0].partition("@")
        source = PLUGINS / "marketplaces" / mp
        if not (source / ".claude-plugin" / "marketplace.json").is_file():
            say(f"Failed to install plugin {rest[0]}\n- [error] plugin_dependency_missing: Marketplace not found for dependency: {mp}", 1)
        info = manifest(source) or {}
        dest = PLUGINS / "cache" / mp / plugin / info.get("version", "0.0.0")
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(source, dest)
        installed["plugins"] = [p for p in installed["plugins"] if p["id"] != rest[0]]
        installed["plugins"].append({"id": rest[0], "path": str(dest)})
        config["plugins"]["enabledPlugins"][rest[0]] = True
        save(INSTALLED, installed)
        save(CONFIG, config)
        say(f"Installed plugin {rest[0]} ({info.get('version', '0.0.0')}) [enabled]")
    if cmd == "uninstall":
        entry = next((p for p in installed["plugins"] if p["id"] == rest[0]), None)
        if entry is None:
            say("Plugin not installed: " + rest[0], 1)
        shutil.rmtree(Path(entry["path"]).parents[0], ignore_errors=True)
        try:
            Path(entry["path"]).parents[1].rmdir()  # the marketplace's cache folder goes when it is empty
        except OSError:
            pass
        installed["plugins"] = [p for p in installed["plugins"] if p["id"] != rest[0]]
        config["plugins"]["enabledPlugins"].pop(rest[0], None)
        save(INSTALLED, installed)
        save(CONFIG, config)
        say("Uninstalled plugin " + rest[0])
    if cmd == "list":
        out = []
        for p in installed["plugins"]:
            hooks = load(Path(p["path"]) / "hooks" / "hooks.json", {}).get("hooks", {})
            details = [{"command": h["command"], "event": event, "runnable": True, "type": "command", "timeout": h.get("timeout")}
                       for event, groups in hooks.items() if event in EVENTS for g in groups for h in g["hooks"]]
            out.append({"id": p["id"], "enabled": config["plugins"]["enabledPlugins"].get(p["id"], False), "hookDetails": details})
        say(json.dumps(out, indent=2))
    say("unsupported by the fake", 2)


main(sys.argv[1:])
