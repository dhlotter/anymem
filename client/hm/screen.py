"""Topics the memory system never records, shared by capture and the profile (docs/capture-design.md, docs/profile-design.md).

Health or medical matters, money details, legal matters and government ID numbers. Credentials are handled by the redactor and
by capture's secret screen. A fact that touches one of these is dropped whole, never queued."""
from __future__ import annotations

import re

BLOCKED_RE = re.compile(
    r"\b(?:diagnos\w*|cancer|oncolog\w*|chemo\w*|tumou?rs?|prostate|medications?|prescriptions?|surger\w+|surgeon|hospital\w*|symptoms?|"
    r"therap(?:y|ist)\w*|medical|blood pressure|dementia|depress(?:ion|ed)|anxiety|illness|disease|"
    r"salary|payslip|bank balance|account number|iban|card number|credit card|tax return|"
    r"lawsuit|litigation|attorney|solicitor|divorce|custody|last will|deceased estate|court (?:order|case)|subpoena|"
    r"id number|identity number|passport number|social security number)\b|(?<!\d)\d{13}(?!\d)", re.I)


def blocked(text: str) -> bool:
    return bool(BLOCKED_RE.search(text or ""))
