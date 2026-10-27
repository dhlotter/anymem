# Anymem

Shared memory for coding agents, on your own Cloudflare account.

You tell an agent something once. Anymem keeps it in a Worker, a D1 database and a Vectorize index that you own, and every agent on every machine can read it. It works with seven harnesses, Claude Code, Codex, Antigravity (agy), DSH, Kilo, ZCode and Cline.

This is an early release, tested on one Cloudflare account and supported on a best effort basis by one maintainer.

It costs nothing on the Cloudflare free plan for about 4,000 memories. Past that you need Workers Paid, 5 US dollars a month. See [limits](docs/limits.md).

**Report a problem.** Security issues: see [SECURITY.md](SECURITY.md). Anything else: [GitHub issues](https://github.com/dhlotter/anymem/issues).

## What you get

1. **A store you own.** A Worker, a D1 database, a Vectorize index and an R2 backup bucket in your Cloudflare account. You can read it, back it up and delete it.
2. **Hooks that run without you.** The capsule (your always on rules) loads at session start. The closest memories are added to each prompt. At the end of a session a hook saves what is worth keeping.
3. **A skill and short scripts.** The agent saves, searches and corrects memories by running one fixed Python script per job. Python standard library only.
4. **A dashboard** in the browser, behind Cloudflare Access, to search, browse, edit, restore and watch the store.
5. **Nightly backups** to R2, and a local copy on demand.

## What is different about it

These are the reasons to use it over a hosted memory service or an MCP server.

1. **Readable source.** The Worker is plain JavaScript modules in `worker/`. No dependencies, no bundler, no build step. Setup uploads the files as they are, so the code that runs is the code you can read. The client is Python and uses only the standard library.
2. **No MCP.** The Worker has no `/mcp` route. Agents run scripts and hooks call REST routes. Nothing sits in your agent's tool list.
3. **No server generated commands.** The scripts are files in this repo. A reply from the Worker is data. It is never turned into a command.
4. **An audit trail.** Every call from a script or hook is noted in `~/.cache/anymem/audit.log`. Every authenticated request that reaches the Worker gets a row in its `audit` table, kept 90 days, except the dashboard's own file loads. Refused and anonymous calls write no row to that table. Neither holds memory text or a secret.
5. **Probation for captures.** A memory saved by the capture hook has 60 days to be recalled once. If it never is, the nightly job moves it to the trash, where you can restore it for 14 days.
6. **Nothing writes unasked.** The Worker writes no memory of its own. No digests, no summaries, no insights. Memories come from you, from your agent, or from the capture hook, which you can switch off.
7. **Memories are data.** Injected blocks say they are context only. The Worker refuses a capture that reads like an instruction. Each hit carries its origin.

## Quick start

You need a Cloudflare account, a Cloudflare API token (`setup.py --scopes` prints the permissions), Python 3.9 or newer and git. You do not need Node.js or Wrangler.

```bash
git clone https://github.com/dhlotter/anymem && cd anymem
bash scripts/bootstrap.sh
```

1. **Bootstrap** fetches this repo to `~/.local/share/anymem` (or uses the clone you run it from) and starts `init.py`.
2. **Init** asks whether to create a new store in your Cloudflare account or connect to one you already have. It then wires every harness it finds, runs the doctor and lists what only you can do next. That is usually restarting open sessions and approving the hooks in Codex.
3. **Doctor** proves it works.

```bash
python3 skills/anymem/scripts/doctor.py --probe
```

Claude Code takes its hooks from the plugin.

```bash
claude plugin marketplace add dhlotter/anymem
claude plugin install anymem@anymem
```

A second machine runs `init.py`, chooses connect and pastes a connection string made with `devices.py add NAME --share`. The full walk through is in [install](docs/install.md).

## Harnesses

Hook events were probed live on 2026-10-08 by running each harness with a logging hook. Each guide says how far that harness was tested.

| Harness | Hooks or events used | Prompt in the payload | Context injection | Guide |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreCompact, SessionEnd, Stop, PreToolUse | yes | `additionalContext` | [claude-code](docs/harnesses/claude-code.md) |
| Codex 0.157 | SessionStart, UserPromptSubmit, Stop, SessionEnd | yes | `additionalContext` | [codex](docs/harnesses/codex.md) |
| Antigravity CLI 1.3.1 | PreInvocation, Stop | no, read from the transcript | stdout `injectSteps` | [agy](docs/harnesses/agy.md) |
| ZCode 0.16.9 | SessionStart, UserPromptSubmit, Stop | yes | `additionalContext`, seen in the model request | [zcode](docs/harnesses/zcode.md) |
| DSH 0.2.0 rc2 | SessionStart, UserPromptSubmit, Stop, through a Claude style bridge | yes | `additionalContext`, the model repeated the marker | [dsh](docs/harnesses/dsh.md) |
| Kilo 7.7.5 | chat.message, session.idle, session compacting, system prompt transform, in a JavaScript plugin | yes | system prompt, proven | [kilo](docs/harnesses/kilo.md) |
| Cline 3.0.74 | beforeRun, beforeModel, afterRun, in a JavaScript plugin | read from the model request | a `hook_context` message in the request, not yet proven in a live run | [cline](docs/harnesses/cline.md) |

A harness we do not ship takes one adapter. See [add a harness](docs/add-a-harness.md).

`gemini-extension.json` is a Gemini CLI extension manifest that names `skills/anymem/SKILL.md` as its context file. It has no hooks, so Gemini CLI gets no capsule, recall or capture, and nothing in the repo reads or tests it.

## Numbers we measured

The author measured all of these on the dates shown, on a copy of their own store, about 930 memories at the time. The scripts are in `bench/`. One person's store is a small sample, so a gap of one or two prompts is noise.

**Recall.** 58 benchmark questions (22 paraphrase, 16 holdout, 20 exact), and 100 real prompts taken from session logs (50 that should find a memory, 50 that should inject nothing).

| Measure | Old Worker, 2026-10-16 and 17 | Version 2, round 2, 2026-10-18 |
|---|---|---|
| Benchmark MRR, all 58 | 0.69 | 0.853 |
| MRR paraphrase, holdout, exact | 0.68, 0.57, 0.78 | 0.955, 0.812, 0.773 |
| Real prompts that should help, hit rate | 0.58 (cutoff 0.60) | 0.62 (31 of 50) |
| Real prompts that should inject nothing, quiet rate | 0.48 (cutoff 0.60) | 0.94 (47 of 50) |
| Hook injects the expected memory, paraphrase set (22) | 19 | 20 |
| Same, holdout set (16) | 10 | 11 |
| Same, exact identifiers put in a sentence (20) | 17 | 16 |
| Unrelated prompts that inject nothing (20) | 15 | 20 |
| Time for one recall | about 3 s | median 1.26 to 1.30 s, p95 1.53 to 1.57 s |

The real prompt hit rate is level, within two prompts. The gain is in ranking and in staying quiet. The exact identifier case fell to 4 of 20 in round 1 and came back to 16 of 20 in round 2, after a lookup rule for short queries that name one rare thing. That is one prompt short of the old Worker. The four that still miss cannot be fixed by a relevance rule: the memory ranks too low, is not retrieved, or the word is too common. The hook still injects a related note on about 11 percent of generic questions. The old Worker's hook rows are at cutoff 0.60 with 3 memories injected. At the old Worker's cutoff about half of the prompts that should inject nothing got memories injected. Raising the cutoff to 0.65 fixed that and cost a quarter of the correct hits (hit 0.46, quiet 0.88). Round 1 numbers, the rules behind round 2 and the experiments that did not help are in [recall](docs/recall.md) and [benchmark](docs/benchmark.md).

**Capture.** 30 real sessions replayed on 2026-10-17, each memory rated by hand.

| Extractor | Memories proposed | Keep | Junk | Sessions with 0 or 1 memory |
|---|---|---|---|---|
| The capture hook with Haiku, before v2 | 67 | 52 percent | 36 percent | 12 of 30 |
| The Worker's own extractor, after its fixes | 21 | 5 percent | 71 percent | 23 of 30 |

We aimed for under one junk memory in five and met that with neither. The hook uses Haiku through the `claude` command whenever that command exists, and the Worker's extractor only when it does not. Probation and the nightly merge are what catch the rest. See [capture](docs/capture-design.md).

**Migration rehearsal, 2026-10-17.** The author's v1 export (965 live entries, 111 trash items) was converted and loaded into a separate Worker twice. Both runs matched the source row for row (1,076 of 1,076 memories, 440 versions, 2 links, 0 differences). A full run took 1,528 and 1,674 seconds.

## Limits

Cloudflare's limits, as its documentation read on 2026-10-16. Check them before you rely on a number.

| Resource | Free | Paid, 5 US dollars a month | What it means |
|---|---|---|---|
| Worker CPU | 10 ms per request and per cron run | 30 s per request, cron 15 min | Free fits recall and writes. The nightly job works in small batches |
| Worker subrequests | 50 per invocation | 10,000 | Free keeps each batch small |
| D1 size | 500 MB | 10 GB | about 300,000 memories of average size on Free |
| D1 Time Travel | 7 days | 30 days | point in time restore, separate from the R2 backups |
| Vectorize stored | 5M dimensions | 10M included, then a small charge | roughly 4,000 memories on Free |
| Vectorize queries | 30M dimensions a month | 50M included | about 78,000 recalls a month on Free |
| Workers AI | 10,000 Neurons a day | same, then 0.011 US dollars per 1,000 | extract and contradiction checks use most of it |
| Access | free up to 50 users | same | |

1. **Free works for one person up to about 4,000 memories.** That is where the vector store fills. A store that grows by a few hundred a week needs Paid. The author's store was 877 memories on 2026-10-16 and the account is on Paid.
2. **Little warns you before the vector store fills.** The dashboard Health screen shows the vector count and the stored dimensions as gauges against the Workers Paid figures in `worker/plan-limits.js`, and says so on the page. On Free the dimension gauge shows 10 million where Free includes 5 million, so work out the Free room yourself. Those figures are typed in from the Cloudflare documentation, not read from your account, and the doctor does not check them.
3. **40 writes per token in 10 minutes.** The 41st gets a 429 with a wait time. Never loop `remember.py` over a list.
4. **A new vector takes about two minutes to become searchable by meaning.** A new memory is found by keyword at once.
5. **Python 3.9 or newer.** macOS and Linux. Windows is out of scope.
6. **One person per deployment.**

The full table with the plan notes is in [limits](docs/limits.md).

### What is not proven

1. Setup has never run from a brand new Cloudflare account. It ran for real once, as the rehearsal on 2026-10-17 on the author's account, with a workers.dev address, no Access and no custom domain.
2. The installer's Access step and its custom domain step have only run against a fake Cloudflare API in the tests. The rehearsal used neither.
3. The dashboard's browser login has not been exercised on a real hostname. Service token calls through Access have.
4. The effect of the in session save rule has not been measured. Today's agents saved by hand in 2 of 30 sessions.
5. Recall misses short chat prompts whose memory is about earlier context. Of the 20 real prompts that still miss, about 10 are not found by either search.
6. Recall is short of the 0.80 hook hit bar we set on the holdout set (11 of 16) and on exact identifiers (16 of 20). The hook injects a related note on about 11 percent of generic questions.
7. The tools that move a version 1 store to version 2 were rehearsed twice on a copy of the author's store. They have not been run on any other store. See [migration](docs/migration.md).

## What it does not do

1. No MCP server, no claude.ai or Cowork connector, no OAuth.
2. No teams and no sharing. One person, one store.
3. No digests, weekly insights, reminders or summaries.
4. No review queue. Captures are saved and nothing waits for you, except a changed profile value, which waits on the People screen until you accept or dismiss it. You undo with `forget.py`.
5. No offline recall. Session start uses a cached capsule when the Worker is away. A prompt just gets no memories.
6. No encryption beyond what Cloudflare does. Whoever holds your Cloudflare account can read the store.
7. The model provider behind your agent sees whatever is injected into a prompt.
8. It refuses to record health, money, legal or identity details, in a capture or in the profile. How reliably it refuses is not measured.

## Documentation

1. [Install, upgrade, uninstall and the configuration reference](docs/install.md)
2. [Commands, one section per skill script](docs/commands.md)
3. [Architecture, the Worker, the client, hooks and adapters](docs/architecture.md)
4. [Security and audit](docs/security.md)
5. [Privacy, what leaves your machine](docs/privacy.md)
6. [Capture and probation](docs/capture-design.md)
7. [Recall](docs/recall.md)
8. [Backups and restore](docs/backups.md)
9. [Dashboard](docs/dashboard.md)
10. [Subjects and the automatic part](docs/subjects.md)
11. [Profile and people](docs/profile-design.md)
12. [Migration from version 1](docs/migration.md)
13. [Troubleshooting](docs/troubleshooting.md)
14. [Add a harness](docs/add-a-harness.md)
15. [Limits and costs](docs/limits.md)
16. [Cloudflare resources, and running without a domain](docs/cloudflare.md)
17. [Benchmark](docs/benchmark.md)
18. [Why scripts and hooks, not MCP](docs/why-skill-not-mcp.md)
19. [The Worker, its routes, settings and internals](worker/README.md) and [worker/ARCHITECTURE.md](worker/ARCHITECTURE.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
