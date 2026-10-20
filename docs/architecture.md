# Architecture

Anymem has two halves. A client on every machine, made of a skill, scripts, hooks and adapters. A server in your own Cloudflare account, which is one Worker with a few resources behind it. The client is Python 3.9 and the standard library only. The Worker is plain JavaScript modules with no dependencies and no build step. This page is the map. The Worker's internals are in [worker/ARCHITECTURE.md](../worker/ARCHITECTURE.md) and its routes and settings in [worker/README.md](../worker/README.md).

## Components

| Piece | Where it runs | What it does |
|---|---|---|
| Skill, `skills/anymem/SKILL.md` | Your agent | Tells the agent when to remember, recall, forget and correct |
| Scripts, `skills/anymem/scripts/` | Your machine | One fixed script per job. They call the Worker's REST routes and write the local audit log |
| Hooks, `hooks/*.py` | Your machine, started by the harness | Capsule at session start, recall on each prompt, capture at compaction and session end, a guard for the harness's own memory files |
| Adapters, `adapters/NAME/` | Your machine | Per harness. Normalise the hook payload, emit context in the harness's own way, read its transcript, install and uninstall the wiring |
| Client core, `client/hm/` | Your machine | Config, the REST helper, audit log, redaction, private text, topic screen, project detection, offline records, profile and people |
| Worker, `worker/` | Your Cloudflare account | Auth, REST routes, the write pipeline, search, extract, capsule, dashboard, audit, the nightly job, backups |
| D1 | Your Cloudflare account | The source of truth. Memories, tags, versions, keys, links, devices, audit and run records |
| Vectorize | Your Cloudflare account | The embeddings index. Rebuildable from D1 |
| Workers AI | Cloudflare | Embeddings, the reranker, and the small model for extract, contradiction checks, kind and sensitivity |
| R2 | Your Cloudflare account | Nightly backups |
| Cloudflare Access | Your Cloudflare account | Optional, recommended. Machines use a service token and the browser uses a login |

Default resource names are `anymem` (Worker), `anymem-db` (D1), `anymem-vectors` (Vectorize, 384 dimensions, cosine) and `anymem-backups` (R2). `setup.py --name` changes the prefix.

## Data flow

```
 your machine                                              your Cloudflare account

 agent (Claude Code, Codex, ...)
   |  hook events                                     Access (service token, or browser login)
   v                                                          |
 hooks (Python)  -- GET  /prompt-capsules/core ---------------+
                 -- GET  /recall ------------------------------+
                 -- POST /capture ------------------------------+--> Worker --> D1 (truth)
                 -- POST /extract (only without claude) --------+       |-----> Vectorize (index)
 scripts         -- the same routes, plus /entry /list ...      |       |-----> Workers AI
   (run by the agent)                                           |       '-----> R2 (nightly backup)
 browser         -- dashboard, browser login only --------------+
```

Every write goes to D1 through the Worker. Nothing on your machine syncs back up. If the Vectorize index is lost, `POST /admin/reindex` rebuilds it from D1.

## The Worker

1. **Auth.** Access first, then a bearer token. See [security](security.md).
2. **Write pipeline.** Normalise, screen, limit, exact duplicate, same name, neighbours, near duplicate, contradiction, store, then index and classify in the background. See [capture](capture-design.md) and `worker/ARCHITECTURE.md`.
3. **Search.** A vector arm and a keyword arm run in parallel and are merged by rank. A reranker scores relevance. See [recall](recall.md).
4. **Extract.** `POST /extract` turns a transcript into at most 2 memory proposals, plus any profile or person facts, and stores nothing. See [capture](capture-design.md).
5. **Capsule.** Canonical, pinned memories tagged `capsule:core` and `capsule-slot:NAME`, served with an ETag. Over 9,500 characters the reply adds a warning, and the injected block, headings included, is cut at 9,500.
6. **Nightly job**, 01:00 UTC. Back up, purge the trash, reindex, classify, merge near duplicate captures, retire captures nobody recalled, purge old audit rows. See [backups](backups.md) and [capture](capture-design.md).
7. **Dashboard.** Served from `worker/ui` to a browser login only. See [dashboard](dashboard.md).
8. **Audit.** One row per authenticated request, 90 days. Refused and anonymous calls write no row.

Memories live in one table with a status (`canonical`, `active`, `deprecated`, `pending`), an origin (`explicit`, `capture`, `import`, `profile`, `person`, `system`), an optional project, a kind (`semantic` or `episodic`), a `pinned` flag, a probation time for captures, a validity window, and a trash time. Every change writes the previous state to `memory_versions`, which is what `undo` and `history` read. A fact that a newer one replaces is closed as history, never deleted.

## What is stored locally

| File | Folder | Purpose |
|---|---|---|
| `config.json` | config, mode 0600 | Worker address, token, optional Access pair, `credential_command`, capture policy |
| `deploy.json` | config, mode 0600 | What `setup` created, so a rerun resumes and `uninstall` knows what to remove. Names and ids, no secrets |
| `backups/` | config | Output of `backup.py` |
| `adapters/` | config | Adapters you wrote with `install.py --new` |
| `capsule.json` | cache, mode 0600 | The last good capsule with its ETag and fetch time |
| `audit.log`, `audit.log.1` | cache, mode 0600 | One line per Worker call, no text and no secrets |
| `capture-state.json` | cache, mode 0600 | Per session byte offset of what was already captured. Entries over 14 days old are dropped |
| `capture.log` | cache, mode 0600 | One JSON line per capture run. What was proposed, stored, skipped and why, and counts of redactions, never the redacted text |
| `failed.jsonl` | cache, mode 0600 | Memories that could not be saved, the last 200. Holds memory text |
| `injection.log` | cache | Counts of what the hooks injected, for `usage.py` |
| `recall-seen.json` | cache, mode 0600 | Which memories were already injected in the last 40 sessions |
| `recall-check.json`, `check-last` | cache | The monthly recall check result and when it last ran |
| `person-index.json` | cache, mode 0600 | The saved person memories, kept 10 minutes so a prompt does not wait on a list call |
| `ids.json` | cache, mode 0600 | The last 500 ids a script printed, so a later script can take their first 8 characters |
| `credentials/` | cache, mode 0700 | A cached `credential_command` result, for `ANYMEM_CRED_TTL` seconds (900 by default) |

## Recall path

The recall hook runs on every prompt (`UserPromptSubmit`).

1. **Skip.** Nothing happens when `ANYMEM_RECALL=0`, in the extraction child of the capture hook, for a slash command, for a prompt under 20 characters, for a prompt the harness wrote (a task notification, a command echo, an interrupt marker), or when under 12 characters are left after cleaning.
2. **Clean the prompt.** Remove private text, `<system-reminder>` blocks and fenced code, collapse whitespace, drop sentences that only say how to answer, and cut to 240 characters. The Worker cleans again on its side.
3. **Ask the Worker.** `GET /recall` with `topK=3`, `count=1`, `explain=1`, a `scope` of `project:SLUG` inside a project, and `exclude_ids` for what this session already saw.
4. **Keep what may be injected.** Drop capsule memories, pending memories, memories already shown this session, memories of another project, and hits the Worker did not mark `relevant`.
5. **Inject.** One line per memory, name, description and the first 320 characters of the body, about 1,800 characters in all, as `additionalContext`. If nothing survives the hook prints nothing.

The same hook adds the profile lines a prompt asks about ("what is my address") and what you told it about a person the prompt names. Details of the search are in [recall](recall.md).

## Capture path

The capture hook is wired to `PreCompact`, `SessionEnd` and `Stop`. It decides whether enough has happened, starts a detached worker process and returns at once, so a session never waits on it. The detached worker condenses the new part of the transcript, redacts it, finds what the agent already saved this session, asks a model for memories (up to 5 from the local model, 2 from the Worker's own extractor), screens each, and posts it to `POST /capture`. See [capture](capture-design.md).

## Offline behaviour

1. **Session start** uses the cached capsule when the Worker cannot be reached, and says how old it is.
2. **Recall has no offline copy.** The recall hook injects nothing and `recall.py` fails with one line.
3. **Writes need the network.** A failed automatic capture goes to `failed.jsonl`. Nothing retries in the background. `doctor.py` lists what is unsaved and `resave.py` saves it again. A failed `remember.py` is not queued, so run it again.
4. Hooks never block long. The capsule call times out after 4 seconds, the recall call after 6 and the whole prompt hook after 8.

## Project scoping

A memory belongs to a project or to nobody, which is global. The project of a session is the folder name of its git root, lowercased into a slug of at most 40 characters. Inside a git worktree it is the name of the main repository, so a worktree and the main checkout share a project. A session in the home folder or the filesystem root has no project. `ANYMEM_PROJECT` overrides it with a slug, or with `global`, `none` or an empty value.

1. Capture and `remember.py` tag new memories with the project.
2. Recall in a project sees that project plus global memories. A session with no project sees only global memories. The Worker applies `scope=project:SLUG`, and the hook checks the `project` field of each hit again.
3. Scoping is a relevance rule, not a security boundary. The same token can read every project with `recall.py --all`.

## Tokens

The Worker accepts the admin token (the `AUTH_TOKEN` secret that setup sets) and per device tokens made with `devices.py add`. Only the SHA-256 hash of a device token is stored. A device token cannot reach the routes marked admin. See [security](security.md).
