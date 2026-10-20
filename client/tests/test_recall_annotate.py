#!/usr/bin/env python3
"""Runnable check for the shared relevance rule that the old Worker fallback in the prompt hook uses. No network."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
os.environ.pop("ANYMEM_RECALL_MIN_SIM", None)
sys.path.insert(0, str(ROOT / "client"))
from hm import relevance  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


check("close in meaning at the cutoff", relevance.classify({"dense_score": 0.6}, 0.6)[0] and not relevance.classify({"dense_score": 0.59, "keyword_terms": []}, 0.6)[0] and not relevance.classify({"dense_score": None, "keyword_terms": []}, 0.6)[0])
check("a rare word match is found, a common word is not", relevance.rare_terms({"keyword_terms": [{"term": "upington", "level": 2, "idf": 6.1}, {"term": "the", "level": 2, "idf": 1.0}, {"term": "x", "level": 1, "idf": 9}]}) == ["upington"])
check("classify keeps a name match, drops a shared common word, keeps a hit with no data", relevance.classify({"dense_score": None, "keyword_terms": [{"term": "pieter", "level": 2, "idf": 7}]})[0]
      and not relevance.classify({"dense_score": 0.3, "keyword_terms": []})[0] and relevance.classify(None)[0])

Q = "what is the home address of my dad Dirk Okonkwo, the residential one"
KEY = lambda *terms: {"dense_score": None, "keyword_terms": [{"term": t, "level": 2, "idf": 6.0} for t in terms]}
check("one plain rare word is not a name match, the dad's address case", not relevance.classify(KEY("residential"), 0.6, Q)[0])
check("a capitalised name in the prompt is a name match", relevance.classify(KEY("okonkwo"), 0.6, Q)[0] and relevance.looks_like_name("dirk", Q))
check("an identifier is a name match: digits, hyphens, underscores, dots", all(relevance.looks_like_name(t, f"check the {w} setup please") for t, w in
      (("r2", "R2"), ("anymem-backups", "anymem-backups"), ("backup_key", "backup_key"), ("worker.ts", "worker.ts"))))
check("camel case in the prompt counts when the term starts the same way", relevance.looks_like_name("vectorize", "fix the vectorizeIndex call"))
check("a capitalised first word of the sentence alone is not a name", not relevance.looks_like_name("residential", "Residential address please"))
check("two rare words match even when neither looks like a name", relevance.classify(KEY("residential", "datacenter"), 0.6, Q)[0])
check("without the prompt one rare word still counts, as before", relevance.classify(KEY("residential"), 0.6)[0])
check("close in meaning still counts with no rare word", relevance.classify({"dense_score": 0.7, "keyword_terms": []}, 0.6, Q)[0])


sys.exit(1 if failures else 0)
