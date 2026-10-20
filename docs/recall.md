# Recall

Recall finds the memories closest to a prompt, and decides which of them are close enough to inject. The hook runs it on every prompt. `recall.py` and the dashboard's Search screen run it too. It is `GET /recall` on the Worker.

## How a search runs

1. **Clean the query.** Private text, `<system-reminder>` blocks and fenced code are removed, whitespace is collapsed, sentences that only say how to answer ("answer in one sentence", "say none if nothing fits") are dropped unless nothing else is left, and the result is cut to 240 characters. Under 3 characters gives nothing. The hook has its own floor of 20 characters for a prompt and 12 after cleaning.
2. **Search two ways in parallel.**
   1. **Meaning.** The query is embedded with `@cf/baai/bge-small-en-v1.5` (384 dimensions) and Vectorize returns the 50 closest chunks. The best chunk of each memory counts, with its raw cosine similarity.
   2. **Keywords.** An FTS5 trigram index in D1 returns the best 50 memories. Query words are lowercased, lightly stemmed, and stripped of stop words and anything under 3 letters. A word scores its idf, which is high for a word found in few memories, times a level of 2 for a hit in the name or description and 1 for a hit in the body or the question keys. The best 12 hits are then read again, a word found only inside a longer word counts half, and a match in the case you typed counts one and a half times.
3. **Merge** the two lists by reciprocal rank fusion with k 60. A keyword hit that holds a rare word, idf 5 or more, counts double, so an exact identifier beats a vague neighbour.
4. **Filter.** Live memories only. No superseded memory unless `as_of` is given, no pending memory, no capsule memory unless `capsule=1`, then `exclude_ids`, scope, tags, kind, type, origin, `after`, `before` and `min_recalls`.
5. **Probation.** A capture still on probation scores times 0.95, which ranks it a few places lower.
6. **Score relevance.** `@cf/baai/bge-reranker-base` scores the top 8 hits against the query, from the name, description and the first 1,200 characters of the body. It does not reorder. Reordering by it lost on the benchmark, and scoring relevance with it won. It runs while the full text of the returned memories is read. `RERANK=0` turns it off, and a reranker failure leaves the other rules in charge.
7. **Decide `relevant` for each hit.** A hit is relevant when any one of these holds.
   1. The reranker score is at least `RERANK_MIN`, 0.2, and the cosine of its best chunk is at least 0.60. The cosine is the support: a reranker score alone let generic questions through.
   2. The reranker score is at least 0.05, the cosine is at least 0.66 and the meaning search ranks it 3 or better.
   3. The cosine of its best chunk is at least `RECALL_MIN_SIM`, 0.75.
   4. It matched two words of idf 5 or more in its name or description.
   5. It matched one word of idf 6 or more in its name or description, and that word looks like a name or identifier in the prompt. That means a capital letter after the first word, a digit, underscore, hyphen or dot, or camel case.
   6. It is the first hit, both searches rank it in their top 3, and the idf of the words it matched in its name or description adds up to 6.5 or more (agreement).
   7. The prompt has 3 words or fewer, the hit is one of the first three, its keyword rank is 2 or better, and it matched a word of idf 5 or more that sits inside a name or identifier token of the prompt. It also covers 60 percent of the idf of the query's words (lookup, for identifiers such as R84 or TOP-123).

   One plain rare word is not enough. On 2026-10-13 the word "residential" alone put an unrelated note into the answer to a question about a contact detail.
8. **Reply.** `{ok, query, results}`, and `degraded: "vector"` when the vector search failed and keywords alone answered.

A new memory is found by keyword at once and by meaning about two minutes later, because Vectorize takes that long to make a new vector searchable (measured on 2026-10-17). Do not expect `recall.py` to find by paraphrase what you saved a minute ago.

## What a hit holds

`id`, `name`, `description`, `type`, the whole `content`, `tags`, `project`, `origin`, `status`, `created_at`, `updated_at`, then `score` (the fused rank score), `similarity` (the cosine of the best chunk), `rerank` when it was scored, and `relevant`. With `explain=1` each hit adds `why` with `dense_score`, `dense_rank`, `keyword_rank` and `keyword_terms`, and the reply adds `took_ms` and `timings`.

## Scope

`scope=project:SLUG` returns that project plus the global memories. `scope=all`, or no scope, returns everything. The hook sends the project of the current git repo and drops results from other projects, so a session with no project gets only global memories. `recall.py` sends the same project unless you pass `--all`, but with no project it sends no scope and searches every project. Scope is a relevance rule, not a security boundary.

## Counting only what is relevant

`recall_count` and `last_recalled_at` change only when the request carries `count=1`, and only for the hits marked relevant. The prompt hook and `recall.py` send it. Checks, the benchmark and the dashboard's Search screen send `count=0`. A plain recall writes nothing except its audit row, which lists the returned ids. A browser login always gets `count=0` whatever it sends, because its cookie rides on any cross site request and a read must not write. This matters because the count drives [probation](capture-design.md#4-probation), so a benchmark run must never make memories look used. A counted recall also writes one row per relevant memory to `recall_log` (time, harness, memory id, no query), which is how the dashboard says which tool was given which memory. The hook reports what it did with the answer, injected, quiet or failed, in a header on its next request, and the dashboard shows the quiet rate from those reports.

## What is indexed

Each memory has search keys in `memory_keys`.

1. **Chunk keys.** The name, description and body cut into chunks of 1,600 characters with 200 of overlap, at a paragraph, sentence or word break. Most memories are one chunk.
2. **A description key**, the description on its own.
3. **Question keys**, up to three likely questions a person might type, written by `@cf/ibm-granite/granite-4.0-h-micro`. **Only `POST /admin/questions` and the migration's `questions` command write them. A memory saved through the write pipeline does not get any.** Run the admin route from time to time if you want paraphrase recall on newer memories. Question keys are kept by every rebuild.

The vector id of a key is `MEMORYID:TYPE:POSITION`, so it can always be worked out and a stale vector deleted without reading it. A change to a memory's content, project or trash state clears its vector ids in the same batch, which marks it as needing indexing. The write routes index in the background, and the nightly job works through anything left.

## What was measured

All of it is in [benchmark](benchmark.md). In short, on a copy of the author's store of about 930 memories, on 2026-10-18.

1. MRR on 58 benchmark questions rose from 0.69 on the old Worker (2026-10-16) to 0.853.
2. On 100 real prompts the hit rate is level at 0.60, the quiet rate rose from 0.48 to 0.90.
3. A recall takes a client median of 1.26 to 1.30 s. The server median is 1.15 s and the rest is the network.

Tuned and kept on 2026-10-17 and 18. The word check on the keyword arm, the agreement rule for `relevant`, and `RERANK_MIN` 0.2. Tried and dropped, each with its numbers in [benchmark](benchmark.md). Extra stop words, a rare boost of 1, 3 and 4 (1 collapses the exact set), RRF k 20 and 120, other keyword weights, 30 and 100 candidates per arm, reranking the top 5 and 12, blending the reranker into the order, dropping any one key type (each one earns its place), chunks of 800 and 3,200 characters, the name on later chunks, filler stripping, last sentence only, Cloudflare's smart placement, and `qwen3-embedding-0.6b` (worse MRR and slower).

## Where it falls short

1. **Bare identifiers inside a sentence.** Hook hits on the 20 exact identifier prompts are 16 of 20, against 17 of 20 on the old Worker (2026-10-16). That is one prompt short, the same size as the noise between two builds. The ranking is good (MRR 0.773, the old Worker 0.78), but a one word prompt such as "what do we know about Archiving" often has the right memory second, and then the hook injects nothing.
2. **Chatty prompts.** Of the 20 real prompts that should find a memory and still miss, about 10 are found by neither search. They are short chat lines whose memory is about earlier context.
3. **The margins are one prompt wide.** Hit 30 of 50 against a target of 29, quiet 45 against 44. Two builds of the same code differ by one prompt. Treat every cutoff as a plateau, not a point.
4. **The sets are small.** 22, 16, 20 and 100 prompts, from one person's store.
5. **Weak matches exist.** `recall.py` prints `(weak match)` for a hit that is not relevant. Do not state one as fact.
