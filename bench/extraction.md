# Extraction on the Worker: measurement plan

Status: run on 2026-10-08 against the test deployment. Results and the decision are at the bottom.

## Question

Does `POST /extract` (Workers AI) produce memory proposals close enough to the client's Claude Haiku extraction (`hooks/memory_capture.py`) to be the default for users who do not have Claude Code?

## Setup

1. Pick 5 saved session transcripts, already redacted and condensed the way the capture hook sends them (under 30000 characters each). Use a spread: one rich in corrections, one that is mostly task chatter (the right answer is zero proposals), one that ends mid analysis, one with a reference to an outside system, one with a stated user preference.
2. Run each through the Haiku path and save the proposals as `bench/extraction/<n>.haiku.json`.
3. Run each through `POST /extract` on the deployed Worker with the same `known` text and `max` 5. Save as `bench/extraction/<n>.worker.json`.
4. Repeat the Worker run once with each candidate model (`LLM_MODEL` default, plus at least one larger model) so the default can be chosen.

## Record, per transcript and per model

| Field | How |
|---|---|
| Proposals returned | count in the response |
| Proposals kept | a human reads each one and keeps it only if it is a durable fact worth storing |
| Proposals wrong | invented, stale, one time, a secret, or a conclusion the session never accepted |
| Missed | durable facts the Haiku run found that this run did not |
| Neurons per call | from the Workers AI usage response (or the account usage page, before and after, if the binding does not return usage) |
| Latency | wall clock for the `/extract` call, median of 3 runs |
| Soft failures | calls that came back with `error: "model_unavailable"` |

Rate limit: 20 calls per user per hour (one counter per user, shared across that user's tokens). A counter store failure fails open.

## Decision rule

The Worker path becomes the default for users without Claude Code when, across the 5 transcripts, it keeps at least 80 percent of what Haiku keeps, returns no more than one wrong proposal in total, and costs under an agreed neuron budget per call. Otherwise Haiku stays the default where Claude Code exists and the Worker path stays opt in. Write the chosen default and the numbers here when run.

## Results (2026-10-08)

**What was run.** Five real session transcripts from one person's Claude Code history, condensed and redacted by the capture hook (27,000 to 28,000 characters each), with `known` set to "(none)" for every path. Haiku ran through the client path (`claude -p --model haiku`). The Worker ran `POST /extract` with `max` 5 on a test deployment, once with its default model (`@cf/meta/llama-4-scout-17b-16e-instruct`, "Scout") and once with a larger one (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, "70B"), set with `PATCH /config {"LLM_MODEL": ...}`. A `--var` at deploy time does not change the model. The transcripts and raw proposals contain private content, so they are not in the repo.

**Who judged.** One reader (Claude, not the transcript's owner) read each proposal against its transcript. A proposal counts as kept when it is a specific durable fact the transcript supports. It counts as wrong when it is vague, a status or one time task, trivial, or not supported. Treat the counts as a rough read, not a ground truth. The transcripts were not chosen to match the five types in the setup (the stated mix did not survive contact with real sessions), and one second sample per Scout transcript showed the output changes between runs.

| | Returned | Kept | Wrong | Duplicate or borderline | Median latency | Failed calls |
|---|---|---|---|---|---|---|
| Haiku (client) | 10 | 10 | 0 | 0 | 44 s (includes starting `claude -p`) | 0 |
| Worker, Scout | 18 | 7 | 9 | 2 | 24 s, longest 52 s | 2 of 5 timed out at the first limit of 25 s |
| Worker, 70B | 15 | 2 | 12 | 1 | 19 s | 0, but 2 of 5 came back empty |

Findings:
1. **Haiku was precise but not complete.** It returned nothing for one transcript where the user plainly asked to bundle work into fewer pull requests, and found one fact in a transcript where Scout found three real ones. Both Worker models found that pull request preference.
2. **Scout** kept 7 of the 10 that Haiku kept (70 percent, bar 80) and returned 9 wrong ones: vague roles ("user is a technical lead"), status ("jobs were migrated"), one time fixes, and a project goal with no content. One proposal named the plural database name that the user had since corrected.
3. **70B** was worse: one line statuses ("Worker deployed with fixes", "Outstanding tasks"), and two transcripts returned nothing. Larger did not mean better here.
4. **The first timeout was too short.** Scout needs 22 to 52 seconds on a 28,000 character transcript. The Worker's limit went from 25 to 60 seconds (`EXTRACT_TIMEOUT_MS`), under the client's 90 second wait. After that no call failed.
5. **Neurons per call (estimate, not measured).** The Workers AI binding returns no usage. From the published per million token prices as we remember them, which we did not look up again: about 8,000 tokens in and 500 out is roughly 235 neurons for Scout and 315 for 70B. At 10,000 free neurons a day that is about 40 Scout calls a day. Measure it from the account usage page before relying on this.

## Decision

The rule was: the Worker path becomes the default when it keeps 80 percent of what Haiku keeps and returns at most one wrong proposal. Scout kept 70 percent with 9 wrong, and 70B kept 20 percent with 12 wrong. Neither passes. **Haiku stays the default where the `claude` command exists, and the Worker path stays opt in** (`extraction` set to `worker`). Proposals are saved as drafts and need a review, so about half of them being noise is a real cost for a person with no Claude Code.

What is not settled: `extraction` set to `auto` still falls back to the Worker when `claude` is missing, which the rule says it should not do by default. That change is pending a decision. Other models (a reasoning model such as `@cf/openai/gpt-oss-120b` with a larger `EXTRACT_MAX_TOKENS`) and a prompt tuned for Scout were not tried.
