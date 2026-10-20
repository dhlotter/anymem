"""The plan limits the person is told about (plan section 7, from Cloudflare's docs of 2026-10-16), and the plan question.

The API token cannot read billing, so setup prints what applies and asks which plan the account is on.
"""
from __future__ import annotations

from hm import scripts

ROWS = (
    ("Worker CPU", "10 ms per request and per cron run", "30 s per request (up to 5 min), cron 15 min", "Free fits recall and writes. The nightly job runs in small batches"),
    ("Worker subrequests", "50 per invocation", "10,000", "Free caps the D1 and AI calls per request, so batches stay small"),
    ("Cron triggers", "5 per account", "250", "anymem uses 1"),
    ("D1 size", "500 MB per database", "10 GB", "about 300,000 memories of today's average size on Free"),
    ("D1 queries", "50 per invocation, 5M rows read and 100k written per day", "1,000 per invocation, 25B read and 50M written per month", "Free is plenty for one person"),
    ("D1 Time Travel", "7 days", "30 days", "point in time restore, separate from the R2 backups"),
    ("Vectorize stored", "5M dimensions", "10M included, then a small charge", "at 384 dimensions and about 3 vectors per memory, roughly 4,000 memories on Free. Nothing warns before it fills"),
    ("Vectorize queries", "30M dimensions a month", "50M included", "about 78,000 recalls a month on Free at 384 dimensions"),
    ("Workers AI", "10,000 Neurons a day", "same, then 0.011 US dollars per 1,000", "embeddings are cheap, the extract and contradiction checks use most of it"),
    ("R2", "free tier (amounts to confirm at setup)", "same", "a year of nightly backups is tiny"),
    ("Access", "free up to 50 users", "same", ""),
)
HEADER = ("Resource", "Free", "Paid (5 US dollars a month)", "What it means for anymem")
SUMMARY = ("The Free plan runs anymem for one person until about 4,000 memories, where the vector store caps out. "
           "A store that grows by a few hundred memories a week needs Paid.")
PLANS = ("free", "paid")


def table_lines() -> list:
    rows = [HEADER] + list(ROWS)
    lines = []
    for n, row in enumerate(rows):
        lines.append("  %d. %s" % (n, row[0]) if n else "  Plan limits (from Cloudflare's docs, 2026-10-16)")
        if n:
            lines.append("     Free: %s. Paid: %s." % (row[1], row[2]))
            if row[3]:
                lines.append("     For anymem: %s." % row[3])
    lines.append("  " + SUMMARY)
    return lines


def ask_plan(given: str, ask, say) -> str:
    """The plan name, from --plan, or by asking (`ask` returns the typed text, "" when there is nobody to ask)."""
    if given in PLANS:
        return given
    answer = ask("Which Cloudflare plan is this account on, free or paid? ").strip().lower()
    if answer in PLANS:
        return answer
    say("No plan given, so nothing is recorded. Say it any time with `%s` or `--plan paid`." % scripts.cmd("setup", "--plan free"))
    return ""


def plan_note(plan: str) -> str:
    if plan == "free":
        return "On Free, watch the vector store: about 4,000 memories fills it, and nothing warns you first."
    if plan == "paid":
        return "On Paid the limits above are far beyond one person's use."
    return ""
