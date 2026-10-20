# anymem Worker (version 2)

The Cloudflare Worker behind anymem. Plain JavaScript ES modules. No dependencies, no bundler, no build step. The code that runs is the code you read. Types are written as JSDoc comments.

Version 2.0.7 (`version.js` and `package.json` agree). It holds auth, the audit trail, device tokens, health and stats, storage and history of memories, search, the write pipeline, extract, the capsule, the dashboard, the nightly job, backups and import. [ARCHITECTURE.md](ARCHITECTURE.md) says how each part works. The people who use anymem never run anything in this folder. `setup.py` uploads these files, see [docs/install.md](../docs/install.md).

## Test

Needs a Node that has `node:sqlite` with SQLite FTS5 and the trigram tokenizer. It was developed on Node 26.8.2. There is nothing to install. Run it from this folder.

    node --test "test/**/*.test.js"

`npm test` runs the same command. The tests run against small fakes of D1 (on `node:sqlite`), Vectorize, Workers AI and R2 in `test/helpers/`. Where a Worker step calls a model, the test scripts the model's answer, so no test shows how accurate a model is on real text.

## Migrate

Migrations live in `db/migrations/`, numbered `0001_name.sql` and so on. `db/schema.sql` is the full current schema, and a test checks that the migrations build exactly that. The Worker never applies schema on a request. `setup.py` applies them when it creates a database, and again on a rerun. For development there is also a Node tool.

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node migrate.js

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. The database id is read from `wrangler.local.jsonc`, or from `D1_DATABASE_ID`. The applied version is stored in the `meta` table, so a second run does nothing.

## Deploy

Users deploy with `setup.py`, which creates the resources, uploads every module and the dashboard files, and sets the bindings, the cron trigger and the settings. Its settings come from the `vars` block of `wrangler.jsonc`, except the `ACCESS_*` values, which come from the Access step.

For development, a Wrangler deploy works too.

1. Create the D1 database, the Vectorize index (384 dimensions, cosine, with the `project` and `origin` metadata indexes made before any vector) and the R2 bucket named in `wrangler.jsonc`. Create the two metadata indexes one at a time and read them back. Two requests sent back to back lost one of them on 2026-10-17.
2. Copy `wrangler.jsonc` to `wrangler.local.jsonc` (git ignores `wrangler.*.jsonc`) and fill in the Worker name, the custom hostname, the database name and id, the index and bucket names and the Access values. `wrangler.jsonc` keeps `REPLACE_WITH_*` placeholders for all of them.
3. Run the migrations, then set the secret `AUTH_TOKEN`.
4. `npm run deploy`, which runs `wrangler deploy --config wrangler.local.jsonc`.

## Bindings

| Binding | Resource |
|---|---|
| `DB` | D1 |
| `VECTORIZE` | the Vectorize index |
| `AI` | Workers AI |
| `BACKUP_BUCKET` | R2. Without it the backup routes answer 404 `no_backup_bucket` and the nightly backup step is skipped |
| `ASSETS` | the dashboard files from `ui/`, with `run_worker_first` so the Worker gates every file |

## Settings

| Name | Kind | Meaning |
|---|---|---|
| `AUTH_TOKEN` | secret | The admin bearer token. At least 20 characters |
| `REQUIRE_ACCESS` | var | `true` (the default) checks the Cloudflare Access JWT. `false` runs on the bearer alone. Any other value is a 500 |
| `ACCESS_TEAM_DOMAIN` | var | The Access team host, for example `team.cloudflareaccess.com` |
| `ACCESS_AUD` | var | The audience tag of the Access application |
| `ACCESS_SERVICE_COMMON_NAMES` | var | Comma list of `CLIENT_ID.access` names of the service tokens that may call |
| `ACCESS_ALLOWED_EMAILS` | var | Comma list of browser login emails. A browser login is accepted on dashboard routes only |
| `ACCESS_TOKEN_EXPIRES` | var | The Access service token expiry as a date such as 2027-10-07. The dashboard warns 30 days before and the nightly job records the days left. Optional |
| `ALLOWED_HOSTS` | var | Comma list of host names, for example `memory.example.com`. When set, a request whose host is not in the list gets a 404 before authentication and before any audit write. When unset, any host is served. A set value with no usable host name is a 500. Optional |
| `RECALL_MIN_SIM` | var | Cosine at or above which a hit is relevant. A number from 0 to 1, default 0.75 |
| `RERANK_MIN` | var | Reranker score at or above which a hit is relevant. A number from 0 to 1, default 0.2 |
| `RERANK` | var | `0` turns the reranker off |
| `SUBJECTS` | var | `on` makes a recall also return the subject cards its relevant results are about. `off` or unset leaves the reply as it was, with no `subjects` key. `GET /recall?subject=` and the subject routes work whatever it says |
| `NIGHTLY_SUBREQUESTS` | var | Subrequests the whole nightly run may use. A whole number from 10 to 5000, default 40 (the Free plan). `setup.py` sets 400 when the plan is Paid |
| `NIGHTLY_WALL_MS` | var | Milliseconds each nightly step may take. A whole number from 1000 to 600000, default 20000. `setup.py` sets 120000 when the plan is Paid |
| `SUBJECTS` | var | `on` turns on subject cards in recall (`subjects` in the reply). Default `off`. The subject routes work whatever it says |
| `SMALL_MODEL` | var | The Workers AI model for the small JSON mode jobs (extract, contradiction checks, kind, sensitivity). Default `@cf/meta/llama-3.1-8b-instruct-fast` |

`ALLOWED_HOSTS` is a second layer for a Worker behind a custom domain. If a workers.dev address is ever turned back on, the Worker still refuses it. `setup.py` copies it from the `vars` block of the committed `wrangler.jsonc` on every run, so put it there (or in `wrangler.local.jsonc` for a Wrangler deploy). A value that exists only on the Worker, set by hand, is not read back by `setup.py` and a rerun drops it.

With `REQUIRE_ACCESS` true, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are required, and at least one of `ACCESS_SERVICE_COMMON_NAMES` and `ACCESS_ALLOWED_EMAILS`. A bad setting stops every request with a 500 that says what is wrong. The Worker never falls back to open access.

## Routes

Every route needs the Access JWT (unless `REQUIRE_ACCESS` is false) and then a bearer token. `any` means the admin token or a device token. `admin` means the admin token only, and a device token gets a 403. `browser` means a verified browser login is also accepted, and needs no bearer. `browser write` means a browser login may write, but only from the dashboard's own page.

| Route | Who | What it does |
|---|---|---|
| `GET /health` | any, browser | `{ok, version, schema_version, vectorize}`. 503 when the database cannot answer |
| `GET /count` | any, browser | `{count}`, live memories |
| `GET /stats` | admin, browser | counts by status and origin, `unvectorized`, `unclassified`, the counters of today and the last 7 days (`capture`, `extract`, `conflicts`, `model_failures`), the last nightly run |
| `GET /devices` | admin, browser | `{devices}`, each with `allow_private` |
| `POST /devices` | admin | `{label}` returns `{device, token}` with 201. The token is shown once |
| `POST /devices/revoke` | admin | `{id}` |
| `POST /devices/private` | admin | `{id, allow_private}` with a boolean. A device with `allow_private` false never sees a private subject. A browser login is refused (403 `browser_not_allowed`) |
| `GET /audit` | admin, browser | `since`, `until`, `actor`, `route`, `harness`, `result`, `limit`, `cursor` |
| `GET /entry`, `GET /list`, `GET /history` | any, browser | read memories |
| `GET /recall` | any, browser | search, see Recall below. `?subject=SLUG` lists the memories about one subject instead |
| `POST /capture` | any, browser write for profile and person notes only | the write pipeline |
| `POST /update`, `/append`, `/status`, `/forget`, `/restore`, `/undo` | any, browser write | change memories. History is kept on every change |
| `POST /link`, `POST /unlink` | any, browser write | `{source_id, target_id, type}`. `type` is one of `about`, `part_of`, `owns`, `affects`, `decided`, `contradicts`, `about_person`, `related` (`supersedes` and `derived_from` are the system's, 400 `reserved_link_type`). `/unlink` replies `{ok, removed}`. A device token may remove only a user link, not a system link (403 `admin_only`) |
| `GET /links` | any, browser | `?id=` returns the links of a memory in both directions with `made_by` and `confidence` |
| `POST /subject` | admin, browser write | `{slug, kind, name, brief?, fields?, aliases?, scope?}` makes a subject and its card memory, replies `{ok, subject}`. A taken slug is 409 `subject_exists`, a bad slug, kind or field is 400 (`bad_slug`, `bad_kind`, `bad_field`) |
| `POST /subject/update` | admin, browser write | `{id or slug, name?, brief?, fields?, aliases?, scope?, status?}`. `fields` merge and `null` removes a key. `status` is `active` or `retired`. A new brief or name writes a new version of the card |
| `GET /subjects` | any, browser | `?kind=&status=&scope=&q=` lists subjects, newest updated first, each with `member_count`. `q` matches slug, name and aliases |
| `GET /subject` | any, browser | `?slug=` or `?id=` returns the subject with its `brief` and up to 200 `members`. A private subject the caller may not see is a 404 |
| `POST /extract` | any | `{transcript, known, max}` returns `{proposals}` and stores nothing |
| `GET /prompt-capsules/core` | any, browser | the capsule, with an ETag and 304 |
| `GET /export` | admin, browser | the whole store in format 2, or a page of it. A browser login gets it without the device `token_hash` values |
| `POST /import` | admin | a format 2 document, or the old Worker's export |
| `GET /backup`, `GET /backup/DAY` | admin, browser | list the R2 backups, download one |
| `POST /backup/run` | admin | take today's backup now |
| `POST /admin/reindex` | admin | build vectors for memories that lack them |
| `POST /admin/questions` | admin | write likely questions for memories that have none |
| `POST /admin/harness` | admin | `{id, harness}` fills in the harness of a memory that has none. It never replaces one |
| `POST /admin/run-maintenance` | admin | run the nightly job now, optionally `{steps, wall_ms, subrequests}` |
| `POST /vectorize-probe`, `GET /vectorize-probe?probe=` | any | the doctor's vector probe |
| `GET /ui/api/overview`, `/ui/api/home`, `/ui/api/growth`, `/ui/api/recalls`, `/ui/api/probation`, `/ui/api/activity`, `/ui/api/runs`, `/ui/api/usage`, `/ui/api/audit-facets`, `/ui/api/harnesses` | admin, browser | read routes for the dashboard screens, they write nothing but the audit row |
| `GET /ui/api/token-expiry`, `/ui/api/memory-extras` | any, browser | read routes for the dashboard |
| `GET /ui/api/people` | admin, browser | the profile and the changes waiting on it, for the Profile screen |
| `GET /`, `GET /ui/*` | browser login only | the dashboard files |

### Recall

`GET /recall?query=` replies `{ok, query, results}` as before. With `SUBJECTS` set to `on` the reply also has `subjects`: at most 2 cards, each `{id, slug, name, kind, brief, fields, via}`. A card is there when a returned result with `relevant` true has an `about` link to it, and the subject is `active` or `stale`. `via` lists those result ids, and the card of the best ranked result comes first. `brief` is the text of the card memory. The cards cost one more query and change nothing in `results`. Showing a card is not a recall of it, so `count=1` counts only the results. With `SUBJECTS` off or unset there is no `subjects` key at all.

`GET /recall?subject=SLUG` replies `{ok, query: null, subject, results}`. `subject` is the card in the shape above without `via`. `results` are the live memories with an `about` link to the card, newest updated first, as many as `topK` (default 5, at most 50), each in the same shape as a recall result without the scores, `relevant` and `why`. It is a plain read: nothing is ranked or counted. An unknown or malformed slug is 404.

Private subjects: a device token whose device has `allow_private` 0 never gets a private subject, its card memory, or a memory whose only `about` links go to private subjects, from `/recall`, `/entry`, `/list`, `/history` or `/links`. A hidden memory is a 404 that reads the same as a missing id, and `/list` and `/links` leave it out. A `/list` page is cut before the rule runs, so such a device can get a page shorter than `n` that still has a `next_cursor`. The admin token, a browser login and a device with `allow_private` 1 see everything.

Errors are always `{"error": "...", "code": "..."}`. Callers may send `X-Anymem-Harness` and `X-Anymem-Script` headers, which are written to the audit row, and a hook may send `X-Anymem-Outcomes` (what it did with its prompts), which is added to daily counters and kept nowhere else. There is no MCP route.

## The nightly job

One cron trigger, `0 1 * * *`, runs these steps in order. The steps share one budget of 40 subrequests for the run (`NIGHTLY_SUBREQUESTS`), each has 20 seconds (`NIGHTLY_WALL_MS`), and a step that stops early continues the next night.

1. `backup` writes `backups/anymem-YYYY-MM-DD.json.gz` to R2, and refuses one with fewer than 80 percent of the newest backup's entries.
2. `purge_trash` deletes memories trashed more than 14 days ago.
3. `reindex` builds vectors for memories without them.
4. `classify` sets the kind of memories that have none.
5. `merge` closes near duplicate captures from the last 14 days into the older one, at 0.90 similarity and 0.45 word overlap.
6. `probation` ends probation for recalled captures, trashes captures never recalled in 60 days, and trashes idle project captures after 90.
7. `purge_old` deletes counter, audit and recall log rows over 90 days old, and the last doctor probe vector.
8. `token` records the days left on the Access service token.

One row in `runs` holds the result. The details are in ARCHITECTURE.md.
