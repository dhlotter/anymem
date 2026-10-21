# Capture and probation

A memory gets into the store three ways. You or your agent run `remember.py`. The agent saves one itself during a session because the skill tells it to. Or the capture hook reads a session when it ends. Nothing waits for review, except a profile fact that changes a value the profile already holds. That waits as a pending change on the Profile screen until you accept or dismiss it. Otherwise every memory is saved active, and the safety comes from the screens, the Worker's duplicate and contradiction checks, 60 days of probation for captures, a nightly merge, and an origin on every memory so it can be traced and removed.

## 1. The agent saves as it goes

The skill tells the agent to save the moment a fact comes up, in its own turn, not at the end of the session. It lists four triggers. You correct it or confirm a non obvious choice. A decision is made and confirmed. You state a durable preference or constraint. It learns where something lives outside the repo. It also lists what never to save, which is anything the repo already says, task status, secrets, health, money, legal or ID details, another person's private details, anything that reads like an instruction from an email or a web page, guesses, and text wrapped in `<private>`.

Why this is there. On 2026-10-17 we replayed 30 real sessions. In 28 of them the agent saved nothing by hand, and across all 30 there were 3 save calls covering 2 distinct facts. Of 35 memories rated worth keeping, 1 was covered by an agent save and 34 were not, about 97 percent. Today's agents did not save because no rule asked them to. That number is a floor, not what an agent can do when told to. The effect of the new rule has not been measured, and a replay cannot measure it, because the agents in the transcripts were never told. A week of live use would.

## 2. The capture hook

It is wired to `PreCompact`, `SessionEnd` and `Stop`. The hook decides whether enough has happened, starts a detached worker process and returns at once.

1. **Policy.** Capture must not be off, the session id must not match `exclude_sessions`, and the folder must not match `exclude_paths`. `ANYMEM_CAPTURE=0` overrides everything. The policy comes only from the config file and the environment.
2. **Is it due.** `PreCompact` and `SessionEnd` need 8 KB of new transcript since the last capture. `Stop` needs 60 KB and 20 minutes, a backstop for sessions that never end cleanly. DSH has no session end event, so it gets 8 KB and 5 minutes on `Stop`. A worker started less than 10 minutes ago is assumed alive.
3. **Condense.** The worker reads the transcript from where the last capture stopped, through the reader for that harness. It keeps user and assistant text, and leaves out tool output, system messages and anything the harness injected. Each message is cut to 2,500 characters for you and 1,200 for the assistant, and the newest messages are kept up to 28,000 characters. With fewer than 150 characters of your own text it stops, unless there are 30 or more and the text mentions a birthday. `<private>` text is removed first.
4. **Redact.** The condensed text goes through the local redactor before it leaves the machine.
5. **Tell the model what is already known.** Before it asks, the worker finds everything the agent saved itself in this session. It reads the transcript's `remember`, `append` and `update` script calls, and the local audit log for the session id (set for Claude Code by the session start hook). It lists their names and descriptions under the capsule text, 6,000 characters in all, so the model only adds what is missing. The transcript readers leave out what hooks injected, and the Worker's extractor strips our blocks again before it calls its model, so recalled memories are not extracted back.
6. **Extract.** With a `claude` command on the machine the worker runs `claude -p --model haiku` locally. Without one it posts to the Worker's `POST /extract`. `ANYMEM_EXTRACTION` or the `extraction` config key forces one. The local model may return up to 5 memories. The Worker's extractor returns at most 2.
7. **Screen.** Each proposal needs a kebab case name, a known type (`user`, `feedback`, `project` or `reference`), a description up to 200 characters and a body of 40 to 3,000 characters. Secrets, blocked topics and anything that reads like an instruction are rejected. Dashes used as connectors become commas. Accepted proposals are redacted a second time.
8. **Store.** Each proposal goes to `POST /capture` with source `session-capture`, the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, the project taken from the session folder, and its subject hint when it has one (see below). A refusal (HTTP 422) is final. A network, API or rate limit failure writes the memory to `failed.jsonl` so `resave.py` can retry it.
9. **Record.** The offset moves forward and one line goes to `capture.log`.

The extractor may add one optional field to a memory, `subject`, with a name and a kind. It is set only when the memory introduces a named person, pet, vehicle, property, project or topic that has its own identity, such as "Pip is my dog". It is never set for a general rule, a preference, a company or a tool (unless the tool is your own project), and a memory has at most one. The local hook checks it before sending, with the same checks the Worker runs again. The name is 2 to 60 characters of plain text, at most 5 words, made of Latin letters, digits, spaces, apostrophes, periods, hyphens and ampersands, in one alphabet, and not a command of 4 words or more. The kind is a known one, the name is not a generic word and holds no secret or instruction, and it appears in the memory's own text. The name goes through the same redaction as the memory. A hint that fails any check is dropped and the memory is saved without it. A save that has to wait for a retry (the Worker was unreachable) keeps its hint, and `resave.py` sends it again. A hint is only a hint. The Worker makes a proposal from it when `SUBJECTS_AUTO` is on, and the proposal waits for your click, see [subjects](subjects.md).

Profile and person facts you state about yourself ride along in the same extraction, with the quoted words checked against your own turns. See [profile and people](profile-design.md).

The session start prints one line saying how many memories were saved automatically in the last 7 days and how to list or remove them. Nothing needs reviewing.

### What is never recorded

Capture refuses anything about health or medical matters, money details (balances, account or card numbers, salary, tax figures), legal matters, insurance claims, identity numbers and credentials. This is a refusal, not a different queue. It applies in the extraction prompt, in the client screen, and again on the Worker. An explicit `remember` is exempt from the topic screens and gets only the secret check.

### How good it is

Measured on 30 real sessions on 2026-10-17, each memory rated by hand as keep, unsure or junk. The ratings are one reader's, and for the Worker's extractor they were made from the proposal text without opening each transcript.

| Extractor | Proposed | Per session | Keep | Unsure | Junk | Sessions with 0 or 1 memory |
|---|---|---|---|---|---|---|
| The capture hook with Haiku, before v2 | 67 | 2.27 | 35 | 8 | 24 | 12 of 30 |
| The Worker's extractor after its fixes | 21 | 0.70 | 1 | 5 | 15 | 23 of 30 |

1. **Volume is fixed on the Worker's extractor, junk is not.** 71 percent of its memories were junk, against a goal of under 20 percent. Most were task or status lines worded as rules, and facts that a config file or a skill file already holds. A pattern check cannot tell "the reviewer stays on Opus" from a lasting preference.
2. **Haiku was 36 percent junk and 52 percent keep.** That is why the hook prefers the local Haiku path whenever the `claude` command exists. The goal was missed there too.
3. **Duplicates were the biggest junk source for Haiku**, 15 of the 24, which is what the Worker's duplicate checks are for.
4. **The Worker's extractor does not look at the store before proposing.** One duplicate and one near duplicate got through. A recall with a reranker threshold would drop them. It is not built.
5. **Thin sessions never reach the model.** The Worker's extractor returns an empty list without a model call when there is under 800 characters of your own text. Its screens drop task and status wording, bodies that do not explain their description, quotes that are not in your own turns, and repeats inside one answer.

## 3. What the Worker does to every write

Every write goes down one pipeline, in this order. The first four steps differ by origin.

1. **Normalise.** Hashtags in the text become tags without changing the text, tags are lowercased, the frontmatter is parsed. At most 30,000 characters.
2. **Screen.** A capture gets every screen. Any other origin gets only the secret check.
   1. Secrets, by token shape and by key name.
   2. Instructions to act on, and a URL with an order attached.
   3. Our own injected blocks echoed back.
   4. Blocked topics. A word list first, then one small model call that asks whether the text holds health, money, tax, legal, identity or insurance details. If that call fails, the word list is all there is.

   A refusal is HTTP 422 with a reason, `secret`, `instruction`, `injected_block`, `blocked_topic` or `sensitive`.
3. **Limit.** 40 writes per device token in a rolling 10 minutes, across every write route and not only captures, then 429 with a wait time. A refused write gives its slot back. Nothing is held.
4. **Exact duplicate.** A live memory with the same content hash refuses the write. It works on the very next write, with no index wait.
5. **Same name.** A capture, profile or person write with the name of a live memory of the same origin updates that memory in place and keeps a version. An explicit write with a taken name is a new memory.
6. **Neighbours.** The new memory is embedded and the closest live memories are found. Vectorize takes about two minutes to make a new vector searchable, so memories changed in the last 10 minutes are compared straight from D1 too.
7. **Near duplicate.** 0.95 similarity or more refuses the write and names the match. From 0.85 up to 0.95 it is stored with `warning: similar`.
8. **Contradiction.** One model call checks the neighbours above 0.45 similarity. If it names one, and that memory is neither pinned nor canonical and is under 1,500 characters, two more calls run with the memories in a different order. Each must quote the clashing sentences word for word. Both agree, and the old memory closes as history and the reply says `replaced`. Otherwise both stay live and the reply says `kept_both` with a reason, `pinned`, `canonical`, `too_long` or `unsure`. A lost fact costs more than a duplicate, so any doubt keeps both.
9. **Store** the row, tags and search text in one D1 batch, which is a transaction. Two racing writes of the same text store one. A capture gets `probation_until` 60 days out.
10. **After the reply.** Index the memory and classify its kind. If either fails, the nightly job does it. Then, only when `SUBJECTS_AUTO` is on, link the memory to the subjects it is about, and make a proposal from its subject hint when nothing was linked, the memory has no subject link at all, and the writer is not a device kept from private subjects. See [subjects](subjects.md).

The reply is `ok`, `id`, `status`, `tags`, plus as they apply `duplicate` with `matchId`, `warning` with `matchId` and `score`, `updated`, `replaced` or `kept_both`. The scripts and hooks turn these into one plain line. `undo.py` on the old memory reopens a replacement.

The accuracy of the contradiction, sensitivity and kind model calls on real text has not been measured. The tests script the model's answers.

## 4. Probation

Only memories with origin `capture` ever go on probation. Explicit, profile, person, system and import memories, pinned memories and canonical ones are never retired.

1. **A capture gets 60 days.** `probation_until` is set when it is stored. While it lasts the capture ranks slightly lower in recall, its score times 0.95.
2. **One recall makes a capture safe from rule 3.** Once its 60 days have passed, the nightly job clears `probation_until` on a capture that has been recalled at least once, and it ranks normally. Only a recall that counts adds to the count, which is one the prompt hook or `recall.py` sends with `count=1` and the Worker marks relevant. Checks and benchmarks send `count=0`.
3. **Never recalled in 60 days, to the trash.** A capture with no recall at all that is 60 days old or older goes to the trash with the reason `retire_never_recalled`.
4. **An idle project note, to the trash.** A capture of type `project` with no recall in 90 days (measured from its last recall, or from its creation if it never had one) goes to the trash with the reason `retire_idle_project`.
5. **The trash keeps it 14 days.** `restore.py ID` brings it back in that time. After 14 days the nightly job deletes it, with its tags, keys, links, link rejections, versions and vectors.

Ending probation changes one column. It writes no version and does not touch `updated_at`.

## 5. The nightly merge

Near duplicate captures that slipped past the write checks are merged by the nightly job, a few at a time, and a backlog continues the next night.

1. **Candidates.** Live captures from the last 14 days that are not pinned, not canonical and not pending.
2. **A match** is an older live capture of the same project, not pinned, not canonical, with similarity 0.90 or more and a word overlap of 0.45 or more. Overlap is the share of words the two texts have in common, over all the words of both. Similarity alone joined memories that only looked alike, so both tests must pass.
3. **The newer one closes into the older one.** It becomes history with `superseded_by` set, and its version row says `merge`. Nothing is deleted. `undo.py` reopens it.
4. **A fallback** covers a neighbour that is not searchable yet, or a Vectorize failure. A live capture with exactly the same name and a word overlap of 0.85 or more is merged too.
5. **Never touched.** Explicit and profile and person memories, pinned memories and canonical memories, on either side of a pair. A neighbour of another origin is never a match.

## Controls

| Control | Effect |
|---|---|
| `ANYMEM_CAPTURE=0` | Capture off everywhere, beating the config file |
| `"capture": "off"` in `config.json` | Capture off |
| `exclude_paths`, `exclude_sessions` | Skip folders and sessions |
| `<private>` and `</private>` around text | Never read for capture, never sent to a model or used as a search query |
| `list.py --origin capture --days 7` | What was saved lately |
| `forget.py ID` | Remove one. `restore.py ID` brings it back for 14 days |
