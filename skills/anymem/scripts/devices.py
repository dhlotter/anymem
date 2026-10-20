#!/usr/bin/env python3
"""The devices script. Arguments and what it does are in client/hm/commands/devices.py, run it with --help."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "client"))
from hm import skill  # noqa: E402

skill.launch("devices")
