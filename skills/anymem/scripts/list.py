#!/usr/bin/env python3
"""The list script. Arguments and what it does are in client/hm/commands/listing.py, run it with --help."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "client"))
from hm import skill  # noqa: E402

skill.launch("listing", "list")
