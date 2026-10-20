"""The subject cards of a recall reply, as text for a prompt or a terminal. The recall hook and recall.py both print them above the
memories, one `- <memory>` line per card with its text fenced (hm/injection.py), so a brief cannot forge a heading or close a block.
A card is one line, as a recalled memory is, because the transcript readers that take an injected recall block out of a transcript
(adapters/kilo/transcript.py, worker/extract/extract.js) know it by its bullet lines and end it at a blank line.

A card is shown only when a result it was reached through is shown too. Showing a card is not a recall of the card: nothing here
calls the Worker or counts anything."""
from __future__ import annotations

from hm import injection

CARD_CHARS = 1200   # one card, its header line included
BLOCK_CHARS = 1800  # every card together, the <memory> tags included
MARK = "- <memory>[card] "  # how a card line starts, for a reader that counts the memory lines around it
MIN_BRIEF = 80      # a card squeezed below this many characters of brief is left out, not shown as a stub


def _line(text) -> str:
    """Stored text on one line, fenced."""
    return injection.fence(" ".join(str(text).split()))


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:max(0, limit - 3)] + "..."


def block(subjects: list, shown_ids) -> str:
    """The cards whose `via` memories include one of shown_ids (a card with no `via` needs only some shown result), best first,
    as one string. Empty when nothing is shown or no card qualifies. A reply with no subjects always gives an empty string."""
    shown = {str(i) for i in shown_ids}
    out, used = [], 0
    for s in subjects:
        via = s.get("via")
        if not shown or (isinstance(via, list) and not shown.intersection(str(v) for v in via)):
            continue
        head = f"[card] {_line(s.get('name') or s.get('slug') or '')} ({_line(s.get('kind') or 'subject')})"
        brief = _line(s.get("brief") or "")
        room = min(CARD_CHARS, BLOCK_CHARS - used) - len("- <memory>: </memory>") - len(head)
        if room < MIN_BRIEF:
            break
        card = f"- <memory>{head}{': ' + _cut(brief, room) if brief else ''}</memory>"
        out.append(card)
        used += len(card) + 1
    return "\n".join(out)
