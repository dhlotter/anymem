"""How hook.py hands context to Cline.

Cline injects through its plugin API, not through hook output, so the protocol is one line between hook.py and plugin.js, written
for the session-start and prompt events:

    {"keep": true, "additionalContext": "the text to add to the model request"}

plugin.js adds the text to the model request as a hook_context message (beforeModel). "keep" says whether the capture policy
allows the conversation text to be spooled. It is always there, so the plugin never has to guess, and the text is left out when
there is none.
"""
from __future__ import annotations

import json


def reply(text: str, keep: bool) -> str:
    """The exact bytes written for one event. ASCII only, so any stdout encoding works."""
    out = {"keep": bool(keep)}
    if text:
        out["additionalContext"] = text
    return json.dumps(out) + "\n"
