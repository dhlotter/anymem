"""Print context the way Antigravity CLI takes it.

A PreInvocation hook prints one JSON object on stdout, {"injectSteps":[{"ephemeralMessage":"..."}]}. agy stores the message as a
step in the conversation (type EPHEMERAL_MESSAGE) and the model sees it from then on, so context injected on the first call of a
run is still there on the later calls of a tool loop.
"""
from __future__ import annotations

import json


def render(*blocks: str) -> str:
    """The stdout text for these context blocks (empty ones dropped), or "" when there is nothing to inject. One step, blocks
    separated by a blank line."""
    text = "\n\n".join(b.strip() for b in blocks if isinstance(b, str) and b.strip())
    return json.dumps({"injectSteps": [{"ephemeralMessage": text}]}) + "\n" if text else ""
