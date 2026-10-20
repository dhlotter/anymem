# Benchmark

This page says how recall and capture are measured, what the numbers were, and where they are weak. The author measured every number on the date given, and the scripts that produced them are in `bench/`. Rerun the scripts on your own Worker after setup, so you compare your numbers with ours and not ours with a guess.

The numbers come from one person's store, 877 memories on 2026-10-16 on the old Worker and about 930 on the copy that version 2 was measured on. Yours will differ. Treat ours as a reference point, not a promise. One prompt is 1 to 2 points on the real set and 5 to 6 points on the small sets.

## What it measures

The benchmark asks the Worker questions and checks where the memory we expected shows up. The questions live in `bench/sets/`.

| Set | Queries | What it is |
|---|---|---|
| `paraphrase` | 22 | A question put in different words from the memory. Used to choose a ranking change, so it flatters the result |
| `holdout` | 16 | Written after the change and never tuned on. The honest set |
| `exact` | 20 | Identifiers and names found in at most two notes, made from the memory files by `bench/make_exact.py` |
| `tails` | 38 | Benchmark questions with an instruction tail added, for the hook gate |
| `unrelated` | 20 | Prompts no memory should answer, for the hook gate |
| `real` | 100 | Prompts taken from real sessions, 50 that should find a memory and 50 that should inject nothing, labelled and checked by the author |

The sets shipped in the repo are small placeholder seeds with made up memory names, and a default run leaves a set out while it is still a seed. Your own sets go in `bench/sets/NAME.local.json`, which git ignores, because the prompts and the expected memory names come from your own store and are personal. A `.local.json` file is read instead of the shipped one. `bench/make_exact.py` writes `exact.local.json` from your memory files, and the `real` set (100 prompts from real sessions, 50 that should find a memory and 50 that should inject nothing) lives in `real.local.json`.

### What the columns mean

1. **First, Top 5, Top 10.** How many queries had the expected memory at rank 1, within the first 5, within the first 10.
2. **MRR.** The mean of 1 divided by the rank of the expected memory, counting 0 when it is not in the top 10. 1.0 is perfect.
3. **Hit rate** (the hook gate). The share of queries where the expected memory is among the memories the hook would inject, at most 3.
4. **Quiet rate** (the hook gate). The share of unrelated prompts where the hook injects nothing. One minus this is the false injection rate.

## How to run it

You need a configured client (`setup.py` or `connect.py`, or the `ANYMEM_URL` and `ANYMEM_TOKEN` variables). The scripts use only the standard library and send every query to your own Worker.

```bash
python3 bench/bench.py                  # ranking, the sets that are on by default
python3 bench/bench.py holdout --misses # one set, and list the misses
python3 bench/recall_gate.py --server --real
python3 bench/replay_extract.py TRANSCRIPT.jsonl
```

1. `bench.py` sends `count=0`, so a run never makes memories look recalled. It prints the time of the whole run, and the median and 95th percentile of one recall.
2. `recall_gate.py` runs the hook's own query cleaning and selection against your Worker. `--server` trusts the Worker's `relevant` flag, which is how version 2 decides. Without it the script applies a cosine cutoff, `--cutoffs 0.6,0.65` sweeps it, and `--real` scores the real set. It caches the Worker's answers in a 0600 file under the client's cache folder, one per Worker address, so delete that file after any change to the Worker.
3. `replay_extract.py` replays one real session through `POST /extract` and prints what it proposes and what the Worker's screens dropped. It calls `/extract` and nothing else, so nothing is stored.

## Recall, the old Worker, 2026-10-16 and 17

Measured on the author's store with the old Worker.

| Set | Queries | First | Top 5 | Top 10 | MRR |
|---|---|---|---|---|---|
| paraphrase | 22 | 13 | 17 | 20 | 0.68 |
| holdout | 16 | 8 | 10 | 12 | 0.57 |
| exact | 20 | 14 | 18 | 19 | 0.78 |
| all | 58 | 35 | 45 | 51 | 0.69 |

The whole run took 2 minutes 53 seconds, about 3 seconds per recall. The same benchmark scored 0.74 at about 350 memories, so recall got worse as the store grew.

The hook gate, up to 3 memories injected. At the hook's cutoff of 0.60, paraphrase 19 of 22, holdout 10 of 16, exact 17 of 20, tails cleaned 27 of 38, and 15 of 20 unrelated prompts quiet (0.75). At 0.65 holdout falls to 8 of 16 and quiet rises to 18 of 20 (0.90).

On the 100 real prompts (2026-10-17), at cutoff 0.60 the hit rate was 0.58 and the quiet rate 0.48. At 0.65 they were 0.46 and 0.88. So at the old cutoff about half of the prompts that should inject nothing got memories injected, and raising the cutoff fixed that and lost a quarter of the correct hits.

## Recall, version 2, 2026-10-17 and 18

Measured on a copy of the author's store, 931 live memories, on the author's Worker, with the committed code and no lab settings. The Worker tests ran 5 times before every deploy.

| Gate item | Target | Before tuning | After tuning |
|---|---|---|---|
| MRR, 58 queries | 0.74 or more | 0.814 | 0.853 |
| Real set hit rate | 0.58 or more | 0.56 (28 of 50) | 0.60 (30 of 50) |
| Real set quiet rate | 0.88 or more | 0.88 (44 of 50) | 0.90 (45 of 50) |
| One recall | under 1.5 s | client median 1.55 s | client median 1.26 to 1.30 s, p95 1.53 to 1.57 s, server median 1.15 s |

| Set | Before tuning | After tuning |
|---|---|---|
| MRR paraphrase, holdout, exact | 0.955, 0.802, 0.669 | 0.955, 0.812, 0.773 |
| Hook hits, paraphrase | 18 of 22 | 18 of 22 |
| Hook hits, holdout | 7 of 16 | 9 of 16 |
| Hook hits, exact identifiers in a sentence | 5 of 20 | 4 of 20 |
| Hook hits, tails | 24 of 38 | 27 of 38 |
| Unrelated prompts quiet | 20 of 20 | 20 of 20 |
| Real hit, quiet | 28 and 44 of 50 | 30 and 45 of 50 |

The build gate was met. Hit rate has one prompt of room (30 against a need of 29) and quiet has one (45 against 44), and two builds of the same code differ by one real prompt.

**What was kept.** A word check on the keyword arm, worth 0.10 on the exact set and 0.036 overall. The agreement rule for `relevant`, worth 3 real hits, 2 holdout hits and 3 tails hits with no quiet loss. `RERANK_MIN` of 0.2 instead of 0.15, which bought one prompt of room on the quiet side in both index builds at the price of one real hit and one exact hit. Running the full text read alongside the reranker, 0.2 s faster.

**What was dropped, with the numbers the author recorded.**

1. Extra stop words, no win.
2. A rare word boost of 1 (the exact set collapses to 0.439), 3 and 4 (no gain). RRF k of 20 (0.841) and 120. Keyword weight 0.7 (0.819) and 1.5. 30 and 100 candidates per arm. Reranking the top 5 (saves about 50 ms, changes no score) and the top 12.
3. Dropping a key type. Without question keys MRR is 0.818, without the description key 0.842, without chunk keys 0.828, against 0.850, so each earns its place.
4. Blending the reranker score into the order, 0.825 to 0.844 against 0.850.
5. Chunks of 800 characters (MRR 0.843) and 3,200 (0.852) against 1,600 (0.850 to 0.853). A rebuild of the same code moved the real quiet count by one prompt, which is the noise of the measurement.
6. The name on every later chunk (holdout 0.771 against 0.812), filler word stripping and last sentence only (loses 11 real hits).
7. Cloudflare smart placement, no change beyond noise.
8. `qwen3-embedding-0.6b` with 1,024 dimensions. MRR 0.798, server median 1.79 s, p95 4.8 s, and a reindex three times as long. Worse and slower, so no switch.

**Where it is weak.** Plainly.

1. **The exact identifier hook rate regressed, 17 of 20 to 4 of 20.** Ranking is fine, MRR 0.773 against 0.78. The prompts are one word ("what do we know about Archiving"), the right memory is often second, and the hook then injects nothing. The recall bar we set, hit 0.80 or more on the benchmark sets, is not met on the holdout and exact sets.
2. **The real set is close to its ceiling for this design.** Of the 20 should help prompts still missed, about 10 are found by neither search in the top 50. They are short chat lines whose memory is about earlier context, such as "i havent had luck with the staging deploy".
3. **Margins are one prompt wide**, and the sets are small, 22, 16, 20 and 100 prompts from one store.
4. **Question keys come from a backfill.** The measured copy had its question keys written by `/admin/questions`. A memory saved afterwards does not get any, so the numbers above describe a store where they all exist. See [recall](recall.md).

## Recall, version 2, round 2, 2026-10-18

Same store and Worker. Only the `relevant` decision changed (ranking and MRR are untouched). Measured with `bench/recall_gate.py --server` and `bench/bench.py`, and with a harness that also ran 261 prompts that should inject nothing, in four batches of 81, 60, 60 and 60 written by hand, three of them after a first version of the rules had been fitted to the sets and the first batch.

| Set | Round 1 end | Round 2 end |
|---|---|---|
| MRR paraphrase, holdout, exact | 0.955, 0.812, 0.773 | 0.955, 0.812, 0.773 |
| Hook hits, paraphrase | 18 of 22 | 20 of 22 |
| Hook hits, holdout | 9 of 16 | 11 of 16 |
| Hook hits, exact identifiers in a sentence | 4 of 20 | 16 of 20 (0.80) |
| Hook hits, tails | 27 of 38 | 28 of 38 |
| Unrelated prompts quiet | 20 of 20 | 20 of 20 |
| Real hit, quiet | 30 and 45 of 50 | 31 and 47 of 50 |
| False injections on 261 generic prompts | 28 | 28 |
| One recall, client median, p95 | 1.28 s, 1.57 s | 1.28 s, 1.57 s |

**What was kept.** 1. A lookup rule for short queries that name one rare thing. The query has 3 words or fewer, a top keyword hit matched a word of rarity 5 or more that sits inside a name shaped token (a digit, underscore, hyphen or dot, camel case, or a capital after the first word), and the hit covers 60 percent of the idf of all query words (a word found in no memory counts in full). Worth 12 exact hits, no false injection on any batch. 2. The agreement rule at 6.5 instead of 7, one holdout and one tails hit, no cost. 3. The reranker needs support. A score at 0.2 counts with a cosine of 0.60, a score of 0.05 counts with a cosine of 0.66 and a dense rank of 3 or better. Worth 2 real quiet prompts, 1 real hit, 1 holdout hit, 2 paraphrase hits.

**What was tried and dropped.** 1. The lookup rule without the name test (exact 16 of 20 too, but 5 of 81 generic prompts injected a note, "how do I parse json in swift", "what is a good name for a bakery"). 2. A coverage backed rule for natural language (dense rank 4, keyword rank 5, coverage 0.4, first two places) which reached holdout 13 of 16 and paraphrase 22 of 22 and was deployed once, then measured on the quiet batches and removed, it lifted false injections from 6 to 18 of 81 and 9 to 14 of 60, and no cosine floor fixed that without losing the gain. 3. Relaxing the agreement ranks to 5 or 10 for short queries (no effect), a lower reranker floor for queries of 2 to 4 words (costs a real quiet prompt), a lower name idf for the lookup rule (one more exact hit, one unrelated false injection). 4. A tight coverage rule on top of the final build (two more paraphrase hits, none on holdout, six constants).

**What is still short of the bar.** Plainly.

1. **Holdout is 11 of 16 (0.69), not 0.80.** Of the five misses, two are not in the top 10 or not retrieved at all ("what the release checklist says", "which linters the team allows", ranking and retrieval), one has the wanted memory second behind a similar one, one has it second behind a keyword only hit, and one is a borderline relevance miss. Every rule that reached 12 or 13 injected a note on 5 to 8 percent more of the generic prompts. The old Worker at its production cutoff scored 10 of 16, so the bar was not met by it either.
2. **The four remaining exact misses cannot be reached by a relevance rule.** "Archiving" has the wanted memory at rank 8, "Widgets" and "Telemetry" do not retrieve it, "Gateway" is a common word (idf 3.8) that matches in many names. The lookup rule needs a name shaped token, so a bare lowercase word such as "planner" would not trigger it, the exact set writes them capitalised.
3. **The hook injects a related note on about 11 percent of generic questions** (28 of 261 prompts such as "how do I rename a branch in git"), with round 1 rules and with these. Those notes are the nearest neighbours of the questions and the reranker rates several of them highly. On the real set quiet is 0.94, on the unrelated set 1.00, on generic technical questions about 0.89.
4. The sets are small. Real hit moved by one prompt, which is inside the noise of one rebuild.

## Capture, 30 real sessions, 2026-10-17

Rated by hand, memories only. See [capture](capture-design.md) for the detail.

| | Proposed | Keep | Unsure | Junk | Sessions with 0 or 1 |
|---|---|---|---|---|---|
| Capture hook with Haiku, before v2 | 67 | 35 | 8 | 24 | 12 |
| Worker extractor, first fix | 29 | 2 | 5 | 22 | 18 |
| Worker extractor, final | 21 | 1 | 5 | 15 | 23 |

The goal was most sessions giving 0 or 1 memory and junk under one in five of what is kept. The volume goal is met by the Worker's extractor. The junk goal is met by neither extractor. The ratings are one reader's, the Worker rows were rated from the proposal text without opening each transcript, and the model is not deterministic, so a gap of 5 points between the two Worker runs is inside the noise. The 30 sessions skew the same way, 26 of them were vault rooted desktop sessions and none were Codex or ZCode.

## In session saving, 2026-10-17

Of 35 memories rated keep, 1 was covered by an agent save in the same session and 34 were not, 97.1 percent not covered. 28 of 30 sessions held no save by hand, and there were 3 save calls covering 2 distinct facts. This measures the habits of agents that were never told to save. It is not an estimate of what they do now that the skill tells them.
