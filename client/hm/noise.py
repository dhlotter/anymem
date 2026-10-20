"""Prompts and turns that a harness writes, not the person.

A background task finishing, a CI monitor event, a slash command echo or an interrupt marker arrives as a user turn but
nobody typed it. The per prompt recall hook skips them, so text such as a task report cannot pull a profile line or a
memory into the context. One tuple, used with `str.startswith`.
"""
from __future__ import annotations

import re

HARNESS_PREFIXES = ("<command-name>", "<local-command", "Caveat:", "[SYSTEM NOTIFICATION", "<task-notification",
                    "<ci-monitor-event", "[Request interrupted")
# The reminders a harness wraps around a turn. They are taken out before any text is read, by the hooks and the transcript readers.
REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


def is_harness_text(text: str) -> bool:
    """True when `text` (leading whitespace ignored) starts like a harness generated turn."""
    return (text or "").lstrip().startswith(HARNESS_PREFIXES)
