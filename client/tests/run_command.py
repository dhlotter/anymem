#!/usr/bin/env python3
"""Runs one command module of the client the way a skill script does, for the tests that drive a command from outside.
    python3 run_command.py install --list
Not a product entry point. The product runs commands through skills/anymem/scripts."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hm import skill  # noqa: E402

skill.launch(sys.argv[1], argv=sys.argv[2:])
