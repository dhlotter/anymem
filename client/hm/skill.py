"""What every skill script shares. A script is a few lines that call launch("name"), and the work lives in hm/commands/<name>.py.

A command module has COMMAND, HELP, register(parser) and run(namespace) that returns an exit code. launch() sets who is calling
for the audit log, parses the arguments, runs the command and turns the three expected failures (not configured, an HTTP error,
no network) into one plain line on stderr and exit code 1. Nothing here prints a token.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys

from . import api, audit, config, project as hm_project, redact, shapes

FULL_ID = 32  # a memory id is a uuid, anything shorter is taken as a prefix
MIN_PREFIX = 8  # the shortest prefix the local id list will answer
KEEP_IDS = 500


def _ids_file():
    return config.cache_dir() / "ids.json"


def note_ids(ids) -> None:
    """Remember the ids a script just printed, so a later script can take their first 8 characters without a slow scan of the
    whole store. Ids only, newest last, mode 0600. Never raises."""
    try:
        have = _known_ids()
        merged = [i for i in have if i not in set(ids)] + [str(i) for i in ids if i]
        p = _ids_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(merged[-KEEP_IDS:], f)
    except Exception:
        pass


def _known_ids() -> list:
    try:
        data = json.loads(_ids_file().read_text(encoding="utf-8"))
        return [i for i in data if isinstance(i, str)] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def launch(name: str, script: "str | None" = None, argv: "list | None" = None) -> None:
    """Run hm/commands/<name>.py as the script `script` (default the same name)."""
    audit.set_origin("script", script or name)
    module = importlib.import_module(f"hm.commands.{name}")
    parser = argparse.ArgumentParser(prog=f"{script or name}.py", description=module.HELP)
    module.register(parser)
    ns = parser.parse_args(argv)
    try:
        code = module.run(ns)
    except (api.NotConfigured, api.ApiError, api.NetworkError) as e:
        print(f"anymem: {e}", file=sys.stderr)
        code = 1
    sys.exit(code or 0)


def clean(text) -> str:
    """Printable only. Text from the store must never carry a control or escape sequence to the terminal."""
    return "".join(ch if ch.isprintable() or ch in "\n\t" else "?" for ch in str(text))


def read_text(value: "str | None") -> str:
    """The text argument, or standard input when it is missing or "-", so a long memory can come in through a here document."""
    return value if value not in (None, "-") else sys.stdin.read()


SECRET_KINDS_IGNORED = ("home_path",)  # a home folder is redacted, but it is not a secret


def secret_kinds(text: str) -> list:
    """The kinds of secret the local redactor finds in text. Every write that sends text runs this before anything leaves."""
    _, _, kinds = redact.redact(text)
    return [k for k in kinds if k not in SECRET_KINDS_IGNORED]


def current_project() -> "str | None":
    return hm_project.current()


def resolve(prefix: str, deleted: bool = False) -> str:
    """A full memory id from a full id or a unique prefix. A prefix of 8 or more characters is looked up first among the ids earlier
    scripts printed (one local read). Otherwise the store is paged through /list, which is slow on a large store. Raises
    api.ApiError (404 or 400) when there is no single match."""
    prefix = (prefix or "").strip()
    if len(prefix) >= FULL_ID:
        return prefix
    near = [i for i in _known_ids() if i.startswith(prefix)] if len(prefix) >= MIN_PREFIX else []
    if len(near) == 1:
        return near[0]
    hits = [e["id"] for e in api.list_all({"n": 500, **({"deleted": 1} if deleted else {})}) if str(e.get("id", "")).startswith(prefix)]
    if len(hits) == 1:
        return hits[0]
    raise api.ApiError(404 if not hits else 400, f"no memory with id {prefix}" if not hits else f"id {prefix} matches {len(hits)} memories, give more of it")


def line(entry: dict) -> str:
    """One line for a list view: full id, name, status and the project when there is one. The full id is printed so the next
    script needs no lookup."""
    bits = [str(entry.get("id", "")), clean(shapes.name_of(entry) or "(unnamed)")]
    if entry.get("status") and entry["status"] != "active":
        bits.append(f"[{entry['status']}]")
    if entry.get("project"):
        bits.append(f"(project {clean(entry['project'])})")
    return "  ".join(bits)
