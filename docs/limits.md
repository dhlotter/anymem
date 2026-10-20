# Limits and costs

Anymem runs in your own Cloudflare account. This page lists the Cloudflare limits that matter, what they mean for one person's store, what costs money, and the limits Anymem sets itself.

The Cloudflare figures are from Cloudflare's documentation as read on 2026-10-16. They change, and Cloudflare's wording is loose in places, for example on how a vector dimension is counted. Treat the sums as an estimate and check the usage pages in your own dashboard after the first month. Setup prints this table and asks which plan you are on, because the API token cannot read billing.

## Cloudflare, Free and Paid

| Resource | Free | Paid, 5 US dollars a month | What it means for Anymem |
|---|---|---|---|
| Worker CPU | 10 ms per request and per cron run | 30 s per request, up to 5 min, cron 15 min | Free fits recall and writes. The nightly job runs in small batches |
| Worker subrequests | 50 per invocation | 10,000 | Free caps the D1, Vectorize and AI calls per request, so batches stay small |
| Cron triggers | 5 per account | 250 | Anymem uses 1 |
| D1 size | 500 MB per database | 10 GB | about 300,000 memories of the average size seen so far, on Free |
| D1 queries | 50 per invocation, 5M rows read and 100k written per day | 1,000 per invocation, 25B read and 50M written per month | Free is plenty for one person |
| D1 Time Travel | 7 days | 30 days | Point in time restore, separate from the R2 backups |
| Vectorize stored | 5M dimensions | 10M included, then a small charge | At 384 dimensions and about 3 vectors per memory, roughly 4,000 memories on Free |
| Vectorize queries | 30M dimensions a month | 50M included | About 78,000 recalls a month on Free at 384 dimensions |
| Workers AI | 10,000 Neurons a day | the same, then 0.011 US dollars per 1,000 | Embeddings are cheap. The extract and contradiction checks use most of it |
| R2 | free tier, amounts to confirm | the same | A year of nightly backups is tiny |
| Access | free up to 50 users | the same | |

## What it means

1. **Free runs Anymem for one person until about 4,000 memories**, where the vector store caps out. A store that grows by a few hundred a week needs Paid. The author's store was 877 memories on 2026-10-16, growing by about 365 a week, and the account is on Paid.
2. **Nothing warns you before the vector store fills.** The dashboard's Health screen shows the vector count and the stored dimensions as gauges against the Workers Paid figures, and the page says so. The gauges have no alert, and `doctor.py` does not compare the count with a limit. On Free the dimension gauge shows 10 million where Free includes 5 million, so watch the count yourself and work from the Free figure.
3. **The nightly job is built for the 50 subrequest cap.** The steps share one budget of 40 subrequests for the whole run, each step has 20 seconds (a store on Paid gets 400 and 120 seconds from `setup.py`, set by `NIGHTLY_SUBREQUESTS` and `NIGHTLY_WALL_MS`), they work in small batches, and a backlog continues the next night.
4. **Workers AI use per write.** A capture costs one small model call for the sensitivity check, up to three more when a neighbour is close enough to look like a contradiction, and one for its kind in the background. Each session capture is one extraction call, locally through `claude` or on the Worker. Each recall is one embedding and one rerank. We have not measured Neurons per capture, so watch the Workers AI usage page after you turn capture on.

## What costs money

1. **The Workers Paid plan**, if you pass the Free limits above. Cloudflare sets the price.
2. **Workers AI past the daily allowance**, which Cloudflare either bills or limits depending on your plan.
3. **Anything else on the same account**, other Workers, domains or products, on its own terms.

Anymem calls no paid service outside Cloudflare. The one exception is local capture extraction through `claude -p`, which uses your own Claude plan.

## Limits Anymem sets itself

| Limit | Value |
|---|---|
| Writes | 40 per token in a rolling 10 minutes, then 429 with a wait time. Imports are exempt |
| One memory | 30,000 characters |
| One request body | 1,000,000 bytes, and 10 MB for an import page |
| Capsule | 9,500 characters. A reply over it adds a warning, and the injected block, headings included, is cut at 9,500 |
| The recall hook | 3 memories, about 1,800 characters |
| The trash | 14 days, then deleted for good |
| Capture probation | 60 days, then trashed if never recalled |
| Backups in R2 | 30 days |
| The Worker's audit table | 90 days |
| The recall log, one row per memory a counted recall returned | 90 days |
| The hook quiet rate counters | 90 days |
| `/export` in one reply | 3,000 entries. Above that it asks you to page, up to 1,000 an entry page |
| Memories in a recall reply | 1 to 50, 5 by default |
| Extraction on the Worker | at most 2 memories a session, and nothing at all for under 800 characters of your own text |
