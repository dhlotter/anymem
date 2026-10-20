"""What `setup` remembers about the store it made, kept in config_dir()/deploy.json (mode 0600).

setup writes it as each resource is created, so a rerun resumes and `uninstall` knows exactly what to remove and nothing else.
It holds names and ids only. It never holds the Cloudflare API token or the Worker token.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import config

DEFAULT_NAME = "anymem"


def plugin_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def state_file() -> Path:
    return config.config_dir() / "deploy.json"


def load_state() -> dict:
    try:
        data = json.loads(state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    d = config.config_dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    tmp = state_file().with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(state_file())
