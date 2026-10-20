"""How close a recalled memory really is, in one place for the prompt hook and the `recall` command.

The Worker's "NN% match" is the rank score scaled so the best hit is always 100, so it says nothing about whether anything is
close. What counts is the cosine similarity of the memory's best chunk (the Worker's explain data, `dense_score`) against a cutoff,
or a rare keyword matched by name. The cutoff is 0.6, from the 2026-10-08 sweep (bench/recall_gate.py, docs/benchmark.md)."""
from __future__ import annotations

import os
import re

DEFAULT_MIN_SIM = 0.6
RARE_IDF = 5.0  # a keyword term at least this rare counts as a name match (3.0 let common words like "capital" through)


def min_similarity() -> float:
    """Cosine similarity a memory's best chunk must reach to count as close. 0 turns the cutoff off."""
    try:
        return float(os.environ.get("ANYMEM_RECALL_MIN_SIM", str(DEFAULT_MIN_SIM)))
    except ValueError:
        return DEFAULT_MIN_SIM


def rare_terms(why) -> list:
    """The rare keywords a hit matched by name, from its explain data."""
    if not isinstance(why, dict):
        return []
    return [str(t.get("term")) for t in why.get("keyword_terms") or [] if t.get("level") == 2 and t.get("idf", 0) >= RARE_IDF]


def looks_like_name(term: str, query: str) -> bool:
    """True when the rare word a hit matched reads as a name or identifier in the prompt: capitalised after the first word, or
    containing a digit, underscore, hyphen or dot, or camel case. A plain lowercase word such as "residential" is a rare word, not
    a name. Terms are stemmed, so a term and a prompt word match on their shared start."""
    term = (term or "").lower()
    if not term or not query:
        return False
    for m in re.finditer(r"[A-Za-z0-9_.\-]+", query):
        tok = m.group(0)
        low = tok.lower()
        if not (low.startswith(term[:max(4, len(term) - 2)]) or term.startswith(low[:max(4, len(low) - 2)])):
            continue
        if re.search(r"[0-9_.\-]", tok) or re.search(r"[a-z][A-Z]", tok) or (tok[:1].isupper() and m.start() > 0):
            return True
    return False


def classify(why, cutoff: float | None = None, query: str | None = None) -> tuple:
    """(close, similarity or None, reason) for one hit's explain data. Without explain data (an older Worker) the cutoff cannot be
    applied, so the hit counts as close and the reason says so.

    Besides closeness in meaning, a hit counts when it matched rare words by name: two or more, or one that looks like a name or
    identifier in the prompt (see looks_like_name). One plain rare word is not enough: on 2026-10-13 "residential" alone put an unrelated
    scraping note into a lookup of a dad's address. Without the prompt (query None) any one rare word still counts, as before."""
    cutoff = min_similarity() if cutoff is None else cutoff
    if not isinstance(why, dict) or "dense_score" not in why:
        return True, None, "no closeness data"
    sim = why.get("dense_score")
    if sim is not None and sim >= cutoff:
        return True, sim, "close in meaning"
    words = rare_terms(why)
    if words and (query is None or len(words) >= 2 or any(looks_like_name(w, query) for w in words)):
        return True, sim, "matched rare words by name"
    return False, sim, "shares words only"
