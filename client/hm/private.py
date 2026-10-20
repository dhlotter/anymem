"""`<private>...</private>`: text the person marks as not to be remembered.

Anything between the tags is removed before a session is read for capture and before a prompt is used to search memory, so it
is never extracted, never saved and never sent to a model by anymem. A tag that is opened and never closed hides the rest of
that message (fail closed). Applies to every harness, because it runs on the turns after a transcript reader has produced them.
Limit: if the assistant repeats the private text in its own reply without the tags, that copy is not hidden."""
from __future__ import annotations

import re

_CLOSED = re.compile(r"<\s*private\s*>.*?<\s*/\s*private\s*>", re.S | re.I)
_OPEN = re.compile(r"<\s*private\s*>.*\Z", re.S | re.I)
_STRAY = re.compile(r"<\s*/\s*private\s*>", re.I)


def strip(text: str) -> str:
    """The text with every private block removed."""
    if not text or "private" not in text.lower():
        return text or ""
    return _STRAY.sub("", _OPEN.sub("", _CLOSED.sub("", text))).strip()
