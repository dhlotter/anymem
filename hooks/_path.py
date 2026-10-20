"""Puts the shared client core (../client) on sys.path, so every hook can `from hm import config, api`.

Import this module first in a hook: `import _path  # noqa: F401`. Works the same from a git checkout and from an installed
plugin, because both keep hooks/ and client/ side by side.
"""
from __future__ import annotations

import sys
from pathlib import Path

CLIENT = Path(__file__).resolve().parent.parent / "client"
if str(CLIENT) not in sys.path:
    sys.path.insert(0, str(CLIENT))
