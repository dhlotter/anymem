"""How messages name a script people can run, and which Python runs the hook scripts. One place, so every message and every
adapter uses the same words and the same interpreter.

Most messages are read by a person or an agent that has the plugin folder somewhere on disk, so the folder is written as
<plugin dir>. The scripts live in skills/anymem/scripts inside it.
"""
from __future__ import annotations

import sys

PLUGIN_DIR = "<plugin dir>"
SCRIPTS_DIR = PLUGIN_DIR + "/skills/anymem/scripts"


def hook_python() -> str:
    """The interpreter every adapter writes into its hook command: the Python that runs the install, by its full path. Harness apps
    start hooks with their own PATH, which may hold no python3, so a bare name is not enough. python3 is only the fallback for an
    interpreter with no path."""
    return sys.executable or "python3"


def cmd(name: str, args: str = "") -> str:
    """The command line that runs one script, for example cmd("doctor", "--probe")."""
    line = "python3 %s/%s.py" % (SCRIPTS_DIR, name)
    return line + " " + args if args else line
