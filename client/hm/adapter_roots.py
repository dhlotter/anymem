"""The two folders adapters are looked up in, shared by install.py and the capture hook so they never disagree.

The plugin's own adapters folder comes first (ANYMEM_ADAPTERS_DIR replaces it), then the person's folder
in the config directory.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List

from hm import config

PLUGIN_ROOT = Path(__file__).resolve().parents[2]


def plugin_dir() -> Path:
    return Path(os.environ.get("ANYMEM_ADAPTERS_DIR") or PLUGIN_ROOT / "adapters")


def user_dir() -> Path:
    return config.config_dir() / "adapters"


def roots() -> List[Path]:
    return [plugin_dir(), user_dir()]
