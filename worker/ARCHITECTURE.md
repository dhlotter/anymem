# Worker architecture

Version 2.0.3. This file says how the Worker is built and why. The routes and settings are in [README.md](README.md). Plain JavaScript modules, no dependencies and no build step.

## Module map

| File | Job |
|---|---|
| `index.js` | `createWorker()` builds the fetch and scheduled handlers. It holds the route table, runs the host check and auth, calls the handler, and writes the audit row for an authenticated call. The default export is the real Worker. |
| `hosts.js` | The optional `ALLOWED_HOSTS` check. Another host gets a 404 before auth and before any audit write. |
| `auth.js` | Access JWT check with WebCrypto, bearer and device token check, auth settings. |
| `http.js` | `HttpError`, JSON replies, bounded body reader, integer query parameters. |
| `audit.js` | Writes, lists and purges audit rows. |
| `devices.js` | Device token routes. |
| `memory/parse.js` | Frontmatter, hashtags, reserved tags, content hash, the 30,000 character limit. Pure, no database. |
| `memory/store.js` | The storage layer on D1. `createStore(db, now)` gives create, get, getVersion, update, append, setStatus, softDelete, restore, supersede, undo, history, link and list. |
| `memory/diff.js` | The one line summary of what a version changed, used by history. |
| `memory/routes.js` | The handlers for `/entry`, `/list`, `/history`, `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`. |
| `search/chunk.js` | Cuts a memory into chunks (1,600 characters, 200 overlap, at paragraph, sentence or word breaks), builds the search keys, and makes the vector ids. |
| `search/embed.js` | Workers AI `@cf/baai/bge-small-en-v1.5`, 384 dimensions, batches of 50. |
| `search/indexer.js` | Keeps `memory_keys` and Vectorize in step with the memories. Also `reindex`. |
| `search/fts.js` | Keyword search over `memory_fts` weighted by word rarity. |
| `search/query.js` | Cleans a prompt into a query, the same rules the hook had. |
| `search/recall.js`, `search/routes.js` | The recall pipeline and `GET /recall`. |
| `search/relevance.js` | Decides `relevant` per hit. |
| `search/questions.js` | Likely questions per memory from `granite-4.0-h-micro` in JSON mode. |
| `admin/routes.js`, `admin/legacy.js` | `POST /admin/reindex`, `POST /admin/questions`, `POST /admin/harness`, `POST /import` and the old export mapping. |
| `write/pipeline.js` | The write pipeline behind `POST /capture`. Every step in order, see "The write pipeline" below. |
| `write/route.js` | The `POST /capture` handler. Reads the request, maps source to origin, calls the pipeline. |
| `write/screen.js` | The screens: secrets, instructions, our own injected blocks, blocked topics, and the model check for sensitive topics. |
| `write/conflict.js` | The contradiction rule. It decides, the pipeline acts. |
| `write/neighbours.js` | The only place the write path touches search: embed a new memory, ask Vectorize for the closest live memories. |
| `write/kind.js` | Classifies a memory as semantic or episodic. Also what the nightly job calls. |
| `extract/extract.js` | `POST /extract`: strip our blocks, ask the model, screen every proposal. Stores nothing. |
| `limits.js` | The write limit and the model call limit on `write_counter`. |
| `counters.js` | Daily counters on `counters`, collected and written in one batch, read by `/stats`. |
| `harnesses.js` | The list of harness ids, aliases and proper names, and the label rules (Imported or Unknown for a blank harness, by origin). The client keeps the same list in `client/hm/harnesses.py` and a test in each language fails when they differ. |
| `outcomes.js` | The `X-Anymem-Outcomes` header. Parses `injected=2,quiet=5` and adds it to the counters `hook.recall.<word>.<harness>`. |
| `ai.js` | `askJson` (one JSON mode call to the small model, null on any failure) and `asData` (text into a prompt with tags removed). |
| `capsule.js` | The core capsule: build from memories, cache in `capsule_cache`, ETag, `GET /prompt-capsules/core`, and `onChange` which drops the cache. |
| `dashboard.js` | Serves `ui/` through the `ASSETS` binding after auth, with the CSP and a content type chosen in code. |
| `dashboard-insights.js` | The read routes of the home, activity, health and audit screens, see "Read routes added for the dashboard" below. They only read. |
| `dashboard-status.js` | Turns the facts of the store into the checks of the home status line. Pure. |
| `dashboard-harnesses.js` | `GET /ui/api/harnesses`, see "Harness views" below. Only reads. |
| `plan-limits.js` | The Cloudflare plan figures the Health screen measures against, with the date they were checked. |
| `dashboard-api.js` | `GET /ui/api/overview`, `/ui/api/people`, `/ui/api/token-expiry`, `/ui/api/memory-extras`, and the guard that limits what a browser may save through `/capture`. |
| `ui/` | The dashboard. Plain HTML, CSS and ES modules, see "Dashboard" below. |
| `dev/dev-server.js` | Development only. The real Worker over in-memory fakes on 127.0.0.1, for looking at the dashboard. Never deployed. |
| `system.js` | `/health`, `/count`, `/stats`, and the `LIVE` SQL fragment that defines a live memory. |
| `cron/maintenance.js` | The nightly job and `POST /admin/run-maintenance`. The step list and the `runs` row, see "Nightly job" below. |
| `cron/budget.js` | The time and subrequest budget of a step, and `countedEnv` which counts every binding call against it. |
| `cron/purge.js`, `cron/indexing.js`, `cron/merge.js`, `cron/probation.js` | The steps themselves. |
| `backup/export.js`, `backup/import.js`, `backup/backup.js` | Export format v2, its importer, the R2 backup and the routes `GET /export`, `GET /backup`, `GET /backup/<day>`, `POST /backup/run`. |
| `search/probe.js` | `POST` and `GET /vectorize-probe` for the skill's `doctor.py --probe`. |
| `scripts/set-lifecycle.js` | Development tool, not part of the Worker. Sets the R2 lifecycle rule for `backups/`. `setup.py` sets the same rule itself. |
| `migrate.js` | Applies `db/migrations` over the D1 REST API. Not part of the Worker. `setup.py` does the same itself. |
| `db/schema.sql`, `db/migrations/` | The schema. A change is a new numbered migration, and `schema.sql` is updated to match. |
| `test/helpers/` | Fakes for D1, Vectorize, AI and R2, a JWT minter, and `createApp()`. |

## Adding a route

1. Write a handler `async ({request, url, env, now, maxBody, actor, memoryIds}) => Response`.
2. Add a row to `ROUTES` in `index.js`. Set `admin` when a device token must not call it. Set `browser` when a verified
   browser login may call it (the dashboard).
3. Push the ids of any memory the handler reads or changes into `memoryIds`. They go into the audit row.
4. Throw `HttpError` (or the helpers in `http.js`) for expected failures. Anything else becomes a 500 with no detail.

## How auth works

1. `readAuthConfig` checks the settings on every request. A bad setting is a 500, never open access.
2. With `REQUIRE_ACCESS` true, the `Cf-Access-Jwt-Assertion` header is verified. RS256 signature against the team keys,
   then `iss`, `aud`, `exp` and `nbf`. The keys are fetched from `https://<team>/cdn-cgi/access/certs` and kept in memory for at most an hour.
   An unknown key id triggers one refetch, and never more than one a minute. Nothing else is cached. A refused token always
   gets the same generic 401, and the reason is logged with `console.warn`.
3. A service token JWT has `common_name` and no email. The name must be in `ACCESS_SERVICE_COMMON_NAMES`. It then
   continues to the bearer check.
4. A browser JWT has an email. It must be in `ACCESS_ALLOWED_EMAILS`. It then counts as admin and needs no bearer, on
   routes with `browser: true` (reads) or `browserWrite: true` (writes, see the next section). A route with neither is a
   403 `browser_not_allowed`. A route with `browserOnly: true` (the dashboard files) also refuses a service token or
   bearer, 403 `browser_only`.
5. The bearer is the admin token or a device token. Both are compared as SHA-256 hashes in constant time. Device hashes
   come from the `devices` table where `revoked_at` is null. A device on an `admin` route gets a 403.

## Browser writes and CSRF

A browser sends the Access login cookie on any request to the site, including one a hostile page triggers. So a write
made with a browser login is only accepted when the request proves it came from our own page. `checkSameOrigin` in
`auth.js` applies three rules, all must hold, and any miss is 403 `csrf_rejected`.

1. The `Origin` header is present and equals the Worker's own origin (the origin of the request URL).
2. `Sec-Fetch-Site` is `same-origin` when the browser sends it. Absent is allowed, rules 1 and 3 still apply.
3. The `X-Anymem-UI` header is `1`. A cross site form or a simple request cannot set a custom header.

Routes with `browserWrite: true`: `/capture`, `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`.
`/capture` is wrapped by `profileSavesOnly`. A browser may only save `origin` or `source` of `profile` or `person`
through it (403 `browser_capture_scope` otherwise), because that is all the People screen needs. Every other write route has neither flag, so it stays bearer only. That covers
`/devices`, `/devices/revoke`, `/import`, `/backup/run`, `/admin/reindex`, `/admin/questions`, `/admin/harness`, `/admin/run-maintenance` and `/extract`.
The audit actor for a browser write is `browser` with the email. Reads need none of the three rules.

## Capsule contract

`GET /prompt-capsules/core`, any bearer or browser login.

1. **Source.** Memories with status `canonical`, `pinned = 1`, live (not trashed, not closed), tagged `capsule:core` and
   `capsule-slot:<slot>`. The section text is `body` (what follows the frontmatter), trimmed. An empty body is skipped.
2. **Order.** Slots `identity`, `preferences`, `constraints`, `principles`, then any other slot alphabetically. One
   section per memory, so two memories in one slot give two sections with the same slot, oldest first. A memory with
   two slot tags is listed under the alphabetically first one.
3. **Reply.** `{ok, sections: [{slot, content, source_id, updated_at}], etag, chars, cap: 9500}`. `chars` is the sum of
   the section text lengths, not counting the headings the client adds. Over the cap the reply still works and adds
   `over_cap: true` and `warning`.
4. **ETag.** A strong ETag, the quoted SHA-256 hex of the slots, ids and text. It is also the `ETag` header. A matching
   `If-None-Match` (a list, `W/` prefix or `*` all count) gets 304 with no body. `updated_at` is not part of it, so a
   change that does not alter the text keeps the same ETag.
5. **Cache.** `capsule_cache` row 1 holds the sections and the ETag. A read rebuilds it when the row is missing.
6. **Invalidation.** After any successful non-GET route, `index.js` calls `onChange(db, memoryIds)` with the ids the
   route touched. It deletes the cache row and bumps `meta.capsule_gen` when a touched memory carries `capsule:core`
   now, or is in the cached capsule (so removing a tag, forgetting, restoring, a status change, undo and import all
   count). A rebuild only stores itself when `capsule_gen` is unchanged since it started, so a write that lands during a
   rebuild is never overwritten by the older build. Anything later that changes memories outside a route (the nightly
   job) must call `onChange` itself.

## Dashboard

Served by the Worker from `ui/` through the Workers static assets binding (`assets` in `wrangler.jsonc`, binding
`ASSETS`, `run_worker_first: true`). The reason is that the Worker handles every request first, so `auth.js` gates every
file and no file is public, and there is no build step because the files are served as they are. `serveUi` maps `/` to
`index.html` and `/ui/x` to the asset `/x`, picks the content type from the extension (html, js, css, svg, json only),
and adds the CSP, `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and `no-cache`.

The CSP is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'; object-src 'none'`. The page loads nothing from another site.

Only a browser Access login on `ACCESS_ALLOWED_EMAILS` can load it (`browserOnly`). No token is typed, read or stored in
the browser. Every call from the page goes through `ui/lib/api.js`, which sends `X-Anymem-UI: 1` and same origin
credentials.

### Map

| File | Job |
|---|---|
| `ui/index.html` | The shell. A skip link, the icon sprite, the phone bar, the sidebar, `main`, the two dialogs and the message corner |
| `ui/style.css`, `ui/charts.css`, `ui/screens.css` | Tokens and the frame, the charts, and the screens. Light and dark. Every colour and font is a token |
| `ui/theme-init.js` | Runs before the first paint so a saved theme does not flash. The only classic script |
| `ui/app.js` | Hash router. Mounts one screen into `main`, and lets a screen follow its own address with `update` |
| `ui/shell.js` | The sidebar with live counts, the phone drawer, the theme switch, the command palette and the remember dialog |
| `ui/lib/html.js` | `html` template tag. Every interpolated value is escaped. Store text never becomes markup |
| `ui/lib/api.js` | The only place that calls `fetch`. It sends `X-Anymem-UI` and the harness label `dashboard` |
| `ui/lib/chart.js`, `chart-dom.js`, `tooltip.js` | Hand written SVG charts, drawing at the width of the box, and the hover and arrow key readout |
| `ui/lib/diff.js` | The line diff of two versions |
| `ui/lib/prefs.js`, `theme.js` | With `theme-init.js`, the only code that touches browser storage. The theme |
| `ui/lib/format.js`, `filters.js`, `relevance.js`, `profile.js`, `route.js`, `palette.js`, `remember.js`, `shell-data.js` | Pure helpers, unit tested |
| `ui/lib/components.js`, `dom.js` | Shared view pieces and the DOM glue (event delegation with `data-action`, no inline handlers) |
| `ui/lib/grid.js` | The table header kit shared by Memories, Audit, Trash and Activity. A funnel in a column header opens that column's choices as a menu, a sort button, and the chips for the filters in use. The menus use the browser's popover so a scrolling table cannot clip them |
| `ui/lib/drawer.js` | The memory drawer, with every action it offers. Every screen that lists memories mounts it and gives it where closing goes. The address holds the open memory, for example `#/trash/<id>` |
| `ui/screens/home.js` | `#/home`. `/ui/api/home`, `growth`, `recalls`, `probation` and `/list` |
| `ui/screens/search.js` | `#/search`. `GET /recall?explain=1&checks=1&count=0`, and the text the hook would add |
| `ui/screens/memories.js` | `#/memories` and `#/memories/<id>`. `GET /list` with filters and sort. The drawer (`lib/drawer.js`) uses `/entry`, `/history`, `/ui/api/memory-extras`. Edit with `if_updated_at`, append, status, link, undo, forget, restore. A lost race shows a clear message and a reload button |
| `ui/screens/activity.js` | `#/activity`. `GET /ui/api/activity`, undo through `POST /undo` |
| `ui/screens/trash.js` | `#/trash`. `GET /list?deleted=1`, the last 14 days, restore |
| `ui/screens/capsule.js` | `#/capsule`. `GET /prompt-capsules/core` and `/entry` for the name of each source |
| `ui/screens/people.js` | `#/people`. `GET /ui/api/people`. Accept writes the field into the profile memory (`/update`, or `/capture` with `source: profile` when there is none) then forgets the pending item. Dismiss forgets it, with an undo |
| `ui/screens/health.js` | `#/health`. `/ui/api/home`, `overview`, `usage`, `runs`, `token-expiry` and `GET /backup` |
| `ui/screens/audit.js` | `#/audit`. `GET /audit` and `/ui/api/audit-facets` |

### Read routes added for the dashboard

All of these are `GET` and write nothing but their own audit row. Most need the admin token or a browser login. `people`, `token-expiry` and `memory-extras` also take a device token.

| Route | Reply |
|---|---|
| `GET /ui/api/overview` | Everything `/stats` returns, plus `now`, `by_project`, `by_kind`, `by_type`, `pending`, `trash` (forgotten in the last 14 days), `vectors` (`{count, dimensions}` when Vectorize reports it), `capture` (whatever `/stats` carries under `capture`, else null). |
| `GET /ui/api/home` | `{owner, headline, nav, checks, summary}`. `headline` has the live count, memories saved this week and the week before, memories recalled this week, recall calls from machines this week and before, and memories closed by the system this week and before. `nav` has the numbers beside the sidebar items, and the capsule cap. `checks` are `{id, label, state, detail, href}` with state `ok`, `warn`, `fail` or `off`, worked out in `dashboard-status.js` |
| `GET /ui/api/growth?days=30\|90\|365` | Memories saved per day (per week for a year), counted by origin, every bucket present |
| `GET /ui/api/recalls` | Recall calls from machines per day for 30 days with how many returned no memory, the count by harness, the most recalled memories used in the last 30 days, and the memories older than a week that were never recalled |
| `GET /ui/api/probation` | Captures on probation with `days_left`, `recall_count`, `retires` (false for a memory the nightly job never retires, such as a pinned or canonical one) and `retire_at` for one nobody recalled |
| `GET /ui/api/activity?kind=&state=&n=&cursor=` | `state` is `all`, `open`, `closed`, `trashed` or `changed_since`, and the filter runs on the Worker, so every page answers it. What the system changed, from version rows with the reasons `supersede`, `merge`, `retire_never_recalled` and `retire_idle_project`. Each has `state`, `can_undo` (true while the change is the latest version and undo still works), `purge_at` and `replaced_by`. Also the counts of the last 30 days and how many trashed memories go for good within 3 days |
| `GET /ui/api/runs?n=` | The latest runs with each step as `{name, state, headline}` |
| `GET /ui/api/usage` | Database size, vector counts and stored dimensions against `plan-limits.js`, the write limit by token, and the capture counters per day for 14 days |
| `GET /ui/api/audit-facets?days=` | The harnesses and routes seen lately with counts, and the calls per day |
| `GET /ui/api/people` | `{ok, profile, people, pending, pending_total}`, full entries. Pending are `status: pending` memories of origin profile or person, or tagged `profile-proposal`, at most 500 of them, and `pending_total` is the same count as the Home badge. |
| `GET /ui/api/token-expiry` | `{ok, configured, expires, days_left, warn}` from `ACCESS_TOKEN_EXPIRES` (a date). `warn` is true at 30 days or fewer. |
| `GET /ui/api/memory-extras?id=` | `{ok, probation_until, purge_at, links: [{direction, id, type, name, created_at}], saved_by, recalled_by, recall_log_since}`. The entry does not carry these. `saved_by` is `{at, by, kind, script}` found in the audit trail by the memory's creation time, null when the trail does not hold the save, and left out for a device token. `recalled_by` is `[{harness, label, times}]` from `recall_log` and `recall_log_since` the oldest row there. |
| `GET /ui/api/harnesses` | `{ok, now, days, sources, recalls, used, outcomes}`, see "Harness views". `used.by_harness[].top` ranks inside each tool, three per tool. |
| `GET /ui/api/sources` | `{ok, sources}`, the same `sources` as `/ui/api/harnesses`, and nothing else. The Memories screen reads its filter options from here. |
| `GET /ui/api/trash?sort=&origin=&project=` | `{ok, window_days, entries, shown, matching, total, soon, older, projects}`. The restorable trash, closest to the end first (`sort=forgotten` for newest forgotten first), filtered and capped at 500 on the Worker. Each entry has `purge_at`. `total` counts everything restorable, `matching` what the filters keep, `older` what is past the window. |

Other routes gained optional read parameters for the dashboard. `GET /list` takes `harness` (an id, an alias, or `none` for the memories with no harness). `GET /audit` takes `harness` and `result` (`ok`, `refused`, `limited`, `denied` or `failed`, classes of HTTP status). `GET /list` takes `sort` (`created`, `updated` or `recalls`) and its cursor then carries the order. `GET /recall` takes `checks=1` with `explain=1` and adds `why.checks`, every relevance rule with whether it held and a sentence saying why. The recall hook does not ask for it, so its reply does not grow.

The Health screen reads the capture counters per day from `/ui/api/usage` and the model failures of the last 7 days from `/ui/api/overview`. It reads the backup list as `{backups: [...]}` (or `entries` or `objects`), each with a `day` or a name holding `YYYY-MM-DD`, and links to `/backup/<day>`.

### Harness views

`GET /ui/api/harnesses` (admin or browser login, read only) answers four questions and says which source each answer comes from.

| Key | What it holds | Source and limit |
|---|---|---|
| `sources` | `{total, rows: [{harness, label, filter, memories}]}`, the live memories by harness. A blank harness is two rows, Imported (origin import) and Unknown (any other origin), and both have `filter: "none"`. A known alias counts under its id | the `harness` column. A memory saved before clients sent a name is blank |
| `recalls` | `{total, empty, by_harness: [{harness, label, calls, empty}]}`, machine recall calls in 30 days | the audit table. It says who asked and how many calls returned nothing, never what a hook did with the answer |
| `used` | `{since, total, by_harness: [{harness, label, recalls, memories, top: [{id, title, count}]}]}`, up to 3 memories per tool in 30 days. `since` is the oldest row of the log, null when it is empty | `recall_log`, written by counted recalls only, 90 days, no query text. Titles only |
| `outcomes` | `{since, windows: [{days, injected, quiet, failed, prompts, quiet_percent}], by_harness}` for 7 and 30 days. `prompts` is injected plus quiet, and `quiet_percent` is quiet over prompts, null with none. `failed` is a search that could not run and is never part of the rate. `since` is the first day any hook reported, null before | the counters `hook.recall.*`. Only clients that send `X-Anymem-Outcomes` appear in it |

The labels come from `harnesses.js`, so the page holds no list of harness names. An entry carries `harness_label`, a recall result and an activity row carry `harness` and `harness_label`, an audit row carries `harness_label`, and the audit facets and the recall counts by harness carry `label`.

### Looking at it

`node worker/dev/dev-server.js` runs the real Worker over in-memory fakes at http://127.0.0.1:8787, signs a browser login
on every request, and seeds a few memories (some with hostile text). Development only.

## How the audit works

Every authenticated request that reaches `handle` writes one `audit` row with `ctx.waitUntil`, so the reply never waits for it. A refused or anonymous request, and a successful dashboard file load, writes none. A failed
audit write is logged without detail and never changes the reply. The row holds time, actor kind and id, harness and
script from the `X-Anymem-*` headers (letters, digits and `._:-` only, 64 characters at most), method, the path without the
query string, status, duration and memory ids. It never holds content, a token or a query string. The nightly job deletes
rows older than 90 days.

## Decisions to keep in mind

1. `project` is an empty string for global memories, not null.
2. `content_hash` has a plain index, not a unique one. The exact duplicate rule belongs to the write pipeline, which checks it and inserts in one statement.
3. The Vectorize metadata indexes are `project` and `origin`. Add an index before the first vector that uses a new filter.
4. `/stats` reports `count` at the top level, because the client doctor reads it from there.

## Storage rules

### Versions and compare and set

1. Every change to a memory goes through one function in `store.js`. It writes one D1 batch. The first statement inserts
   the previous state into `memory_versions` (seq, snapshot, reason, time). The snapshot is the full row as JSON plus the
   tag list. Then the row update, the tag replace and the FTS replace follow. D1 runs a batch as a transaction.
2. The version number is the next free one, read just before the batch. Two writers that read the same state both try
   the same number. The unique key on `(memory_id, seq)` rejects the second, its whole batch rolls back, and the caller
   gets 409 `lost_race`. This holds even when the caller sent no `if_updated_at`, so an append can never be lost.
3. `if_updated_at` on `/update` is checked first. A stale value is 409 `stale_update`. `updated_at` always moves forward
   by at least one millisecond per change, so two changes in the same millisecond still differ.
4. A change that alters nothing (same content and tags, same status, forgetting a trashed memory) writes no version.
5. Reasons are `update`, `append`, `status`, `forget`, `restore`, `supersede`, `undo`, `merge` (the nightly merge, through supersede), and `retire_never_recalled` and `retire_idle_project` (the nightly probation step, through forget). Create writes no version.
6. Link rows are not memory changes. They write no version.

### Undo

1. Undo reverts to the version with the highest seq. It writes the current state as a new version with reason `undo`,
   so a second undo goes forward again. Undo of a supersede reopens the old memory (`valid_until` and `superseded_by` come back).
2. Undo restores the content fields, tags, status, project, kind, pinned, validity and `deleted_at`. It keeps the id,
   `created_at`, origin, harness, session, `recall_count` and `last_recalled_at`.
3. No earlier version is 409 `nothing_to_undo`. Undoing a forget after 14 days is 410, the same as restore.
4. Search keys (`memory_keys`) and vectors are not touched by the store. The write routes call `indexMemories` after an update,
   an append or an undo, and the nightly job picks up what is left. The FTS row reads the keys that exist at the time of the change.

### Trash

1. `/forget` sets `deleted_at` and writes a version. Rows, tags and links stay. The FTS row is removed.
2. `get`, `list`, `history` of other routes hide a trashed memory. `GET /entry?id=&deleted=1` and `GET /list?deleted=1` show it.
   `GET /history` works on a trashed memory.
3. `/restore` works while `now - deleted_at` is at most 14 days. After that it is 410 `restore_window_passed`. A memory
   that is not in the trash is 409 `not_in_trash`. Forgetting a trashed memory returns the same entry and changes nothing.
4. The nightly `purge_trash` step deletes a memory 14 days after it was trashed, with its rows, tags, keys, links, versions, FTS row and vectors.

### Validity and lists

1. A closed memory (`valid_until` set by `supersede`) is not in `/list`. It is still readable with `/entry` and `/history`.
   `pending` and `deprecated` memories are in `/list`, filter them with `status`.
2. The FTS table holds every memory that is not in the trash. Search joins `memories` and applies `LIVE`.
3. Pinned is set from the tags `capsule:core` and `capsule-slot:*`, and from the origins `profile` and `person`.
   It is recomputed on every content or tag update.
4. `store.supersede(oldId, newId, at, reason)` has no route. The write pipeline and the nightly merge call it.

## Reply shapes

Errors are `{error, code}`. Replies below all carry `ok: true`.

| Route | Reply |
|---|---|
| `GET /entry?id=&version=&deleted=` | `{ok, entry}`. `version=N` returns the state before change N and adds `version` to the entry. |
| `GET /list` | `{ok, entries, next_cursor}`. Entries are the full entry, content included. |
| `GET /history?id=` | `{ok, id, versions: [{seq, reason, at, summary}]}`, newest first. The summary reads like `content +12 chars, status active to canonical, tags +x`. |
| `POST /capture` | `{ok, id, status, tags}` |
| `POST /update`, `/append`, `/status`, `/forget`, `/restore`, `/undo` | `{ok, entry}` |
| `POST /link` | `{ok, created}`, false when the link already existed |

The entry is `{id, name, description, type, body, content, tags, status, origin, harness, harness_label, session, project, kind,
pinned, valid_from, valid_until, superseded_by, recall_count, last_recalled_at, created_at, updated_at, deleted_at}`.
`tags` is a sorted list of plain tags. Reserved tags live in `status`, `kind` and `project`. `name` is an empty string
when the text has no frontmatter. `pinned` is a boolean. Times are milliseconds.

`/list` filters: `tag` (repeat it, all must match), `status`, `origin`, `harness` (an id or alias, or `none` for no harness), `type`, `project`, `after` (created_at at or
after), `before` (created_at before), `min_recalls`, `max_recalls`, `deleted=1`, `n` (1 to 500, default 50), `cursor`.
The order is newest first, then by id. The cursor is opaque and encodes `created_at` and id, so paging never repeats or
skips a row, even when many share a timestamp.

`/update` takes `{id, content?, tags?, if_updated_at?}` with at least one of content and tags. Tags given replace the
stored tags, tags left out keep them. Hashtags in the content always count as tags. `/append` adds the text after a blank line.

`/capture` maps `source` to `origin`: `session-capture` is `capture`, `claude` is `explicit`, `profile` and `person`
stay, anything else is `explicit`. A body `origin` wins when given. `harness` is the body value or the `X-Anymem-Harness`
header, a known alias such as `claude-code` is stored as its id, and `session` is the body value. The `project` field becomes a `project:` tag.

A `status:` tag outside `canonical`, `active`, `deprecated`, `pending` is a 400, so the old `status:draft` is refused.

Browser logins are accepted on the reads, and on the dashboard writes under the CSRF rules above. Everything else needs a bearer token.

## Search

Vectorize takes about two minutes to make a new vector searchable (measured live on 2026-10-17). A new memory is found by
keyword at once and by meaning about two minutes later. The write pipeline does not wait for that. Its neighbour check also
embeds the memories changed in the last ten minutes straight from D1 and compares them with the new text (write/neighbours.js,
at most 20). Tests run against a fake Vectorize that is searchable at once, except the neighbour tests, which give it the two
minute lag.

### Keys and vectors

1. A memory has keys in `memory_keys`. A chunk key per chunk of name, description and body (position is the chunk number), one
   description key, and up to three question keys. The vector id is `<memoryId>:<keyType>:<position>`, so it can always be
   worked out and a stale vector can be deleted without reading it. Vector metadata is `{memory_id, project, origin}`.
2. The store clears every `vector_id` of a memory in the same batch as any change to its content, project or trash state. That is
   the unvectorized marker. A memory needs indexing when a key has no vector id, or when it is live and has no keys at all. The one exception is a trashed
   memory's question rows, which keep no vector id on purpose and do not count. A just forgotten memory still waits until a pass removes its chunk keys, and after that nothing about it is pending.
   `/stats` `unvectorized` counts those, `POST /admin/reindex {limit}` works through them oldest first and returns
   `{processed, remaining}`, and the nightly `reindex` step uses the same function.
3. The write routes run `indexMemories` with `ctx.waitUntil`, so a write stays fast. The indexer embeds, upserts, then swaps the
   key rows in one D1 batch that only applies while `updated_at` is still the value it embedded, so a change that lands
   mid-index is never overwritten (it retries up to three times). Vectors of removed chunks are deleted after the swap. A forget
   removes the chunk and description keys and every vector, and keeps the question rows (without vector ids, and they do not make
   the memory wait). A restore builds the keys and vectors again, questions included. A status change or a supersede does not touch them.
4. Question keys are written by `POST /admin/questions` (an admin backfill, and the migration's `questions` command calls it) and
   kept by every rebuild, with the time they were written, also for a memory in the trash. An import stores them with no vector id and
   the first reindex embeds them. The write pipeline does not write them, so **a memory saved through `/capture` has no question keys** until
   the backfill runs again. A memory the model could not answer for is marked in `meta` (`no_questions:ID`) so it is not tried on every
   call. The FTS `keys` column holds only the question keys.

### Recall

1. Clean the query (`query.js`). Under 3 characters gives nothing. A floor of 12 would drop bare identifiers such as
   `R05` or `ABC-12027` (half of the exact set). The hooks keep their own floors, 20 for a prompt and 12 once cleaned.
2. In parallel, embed and query Vectorize (top 50 chunks, best chunk per memory, raw cosine kept) and run the keyword search
   (top 50). Keyword terms are lowercase, stemmed lightly, without stop words and under 3 letters. Each term is counted with
   one `MATCH` query for its document frequency (the vocabulary table of a trigram index lists trigrams, not words, so no
   migration was needed) and a second for where it matched. Score is the sum of idf times level, level 2 for name or
   description, level 1 for body or question keys. idf is `ln(1 + (N - df + 0.5) / (df + 0.5))`.
3. Reciprocal rank fusion, k 60. A keyword hit that holds a rare word (idf 5 or more) counts double.
4. Filters in one D1 query: live, no superseded memories unless `as_of`, no pending, no capsule memories unless `capsule=1`,
   scope (`project:<slug>` is that project plus global, `all` or nothing is everything), `exclude_ids`, repeated `tag`, `kind`,
   `type`, `origin`, `after`, `before`, `min_recalls`.
5. A captured memory on probation scores times 0.95.
6. The reranker `bge-reranker-base` scores the top 8 (name, description, 1,200 characters of body). It does not reorder. It
   runs while the full text of the returned memories is read. `RERANK=0` turns it off.
7. `relevant` is true when one of these holds. The rerank score is at least `RERANK_MIN` (0.2) and the cosine is at least 0.60, or the rerank
   score is at least 0.05 with a cosine of 0.66 or more and a dense rank of 3 or better. The cosine is at least `RECALL_MIN_SIM`
   (0.75). Two words of rarity 5 or more matched the name or description, or one word of rarity 6 or more that looks like a name in
   the prompt. The first hit has both a dense rank and a keyword rank of 3 or better and the rarity of the words it matched in its
   name or description adds up to 6.5 or more (the agreement rule). The query has 3 words or fewer and one of the first three hits,
   with a keyword rank of 2 or better, matched a word of rarity 5 or more that sits inside a name shaped token of the prompt (a
   digit, underscore, hyphen or dot inside, camel case, or a capital after the first word) and covers 60 percent of the idf of all
   the query words (the lookup rule, for identifiers such as R84 or TOP-123). A failed reranker leaves the other rules in charge.
8. Reply: `{ok, query, results}`. A result has `id, name, description, type, content (whole), tags, project, origin, harness, harness_label, status,
   created_at, updated_at, score, similarity, rerank (when scored), relevant`, and with `explain=1` `why {dense_score,
   dense_rank, keyword_rank, coverage, query_words, keyword_terms [{term, level, idf}]}` plus `took_ms` and `timings` (ms, embed, vectorize and keyword are since the
   start, load and rerank are the step itself). `degraded: "vector"` marks a reply made without the vector search.
9. `recall_count` and `last_recalled_at` change only with `count=1`. Only hits marked relevant are counted, and each one also gets a `recall_log` row with the time and the harness of the caller (see "Counters" below), written in its own statement so a failure there never undoes the count. A plain recall writes nothing but its audit row, which lists the
   returned ids. Query parameters are `query, topK (1 to 50, default 5), scope, exclude_ids, tag, kind, type, origin, after,
   before, min_recalls, as_of, capsule, explain, count`. `synthesize` is ignored.

### Import and reindex

`POST /import {entries, offset, limit}` (admin only, body up to 10 MB, limit up to 200) takes the old export. It maps the status
tag to `status` (none or draft is active), source to origin, `captured-by` to harness, `session`, `project` and `kind` tags to
columns, keeps other tags, keeps ids, times, validity and recall count, and writes through the store. An existing id is skipped.
`synthesized` and `rolled-up` entries go to the trash with the import time. It builds no vectors, run `/admin/reindex` after.
A bad entry is skipped and listed in `errors`. Edges (links) are not imported from the old shape. A body with `format: 2` goes to the v2 importer instead, see "Export format v2 and import".

### Measurements and tuning

Measured on a copy of the author's store, 931 live memories, on the author's Worker, 2026-10-17 and 18. The sets, the numbers and every experiment are in [docs/benchmark.md](../docs/benchmark.md). The short form follows.

| Measure | Before tuning | After tuning |
|---|---|---|
| MRR, 58 queries (paraphrase, holdout, exact) | 0.814 (0.955, 0.802, 0.669) | 0.853 (0.955, 0.812, 0.773) |
| Real prompts, hit and quiet, 50 each | 28 and 44 | 31 and 47 |
| Hook hits, paraphrase, holdout, exact, tails | 18, 7, 5, 24 | 20, 11, 16, 28 |
| One recall | client median 1.55 s | client median 1.26 to 1.30 s, server median 1.15 s |

Kept. A word check on the keyword arm, the agreement rule for `relevant`, `RERANK_MIN` 0.2, then in round 2 the lookup rule for name shaped words, agreement at 6.5, and cosine support for the reranker. The reranker scores relevance and does not reorder, because reordering by it lost on the benchmark. Tried and dropped, with numbers in the benchmark page. Extra stop words, other rare word boosts, RRF k 20 and 120, other keyword weights, 30 and 100 candidates, reranking the top 5 and 12, blending the reranker into the order, dropping any one key type, chunks of 800 and 3,200 characters, the name on later chunks, filler stripping, last sentence only, smart placement, and `qwen3-embedding-0.6b`. Two builds of the same code differ by one real quiet prompt, so one prompt is the noise of the measurement.

What the numbers say, and the limits. The gate margins are one prompt wide. Of the 20 should help prompts still missed, about 10 are found by neither search. The hook hit rate on bare identifiers put in a sentence is 16 of 20, against 17 of 20 on the old Worker, since the lookup rule (name shaped words only). Holdout is 11 of 16, the old Worker had 10. On generic questions that touch the store's own topics about 11 percent get a related note injected. The sets are small, 22, 16, 20 and 100 prompts, so treat the cutoffs as a plateau, not a point.

## The write pipeline

`POST /capture {content, tags?, project?, source?, origin?, harness?, session?}` runs `write/pipeline.js`. The order matters.
Origin comes from `origin`, else from `source` (`session-capture` is capture, `claude` explicit, `profile`, `person`), else explicit.
`/import` does not use the pipeline. It calls `store.create` itself, so it skips every screen, the limit and the duplicate checks.

1. **Normalise.** `parseMemory`: trim, hashtags to tags, frontmatter, 30,000 characters at most. 400 or 413.
2. **Screen.** A capture (origin capture) gets every screen. Every other origin gets only the secret check.
   1. Secrets: the token shapes of `client/hm/redact.py` (PEM, `sk-`, `gh*_`, `xox*`, `AKIA`, `AIza`, JWT, Bearer, Basic, `npm_`
      and `hf_`, `glpat-`, URL credentials, `KEY=VALUE` for secret, token, password, apikey, auth, credential, long mixed runs).
   2. Instructions: the client's injection phrases, and a URL with an order attached ("visit https://...", "https://... and run it").
   3. Our own injected blocks echoed back: the headings `## Relevant memories`, `## Memory capsule`, `## From your profile`,
      `## People this prompt names`, and the closing phrase "Context only, check it against the prompt".
   4. Blocked topics, the client word list first (`client/hm/screen.py`), then one small model call in JSON mode asking whether
      the text holds a person's health, money, tax, legal, identity or insurance details. Cheap screens run first, so the model
      only sees text that passed them. If the model call fails or does not parse, the word list is all there is, and the counters
      `screen.model_fallback` and `model.failure.sensitivity` go up.
   A refusal is HTTP 422 `{ok: false, error, code: "refused", reason}`. The reasons are `secret`, `instruction`, `injected_block`,
   `blocked_topic` and `sensitive`.
3. **Limit.** `limits.js`. More than 40 writes per device token in a rolling 10 minutes is HTTP 429, across every write route (`/capture`,
   `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`), not only captures. The reply is
   `{error, code: "rate_limited", retry_after}` with a `Retry-After` header. The admin token and a browser login are not counted. Each write is a
   `write_counter` row keyed by its own millisecond, so the count is exact. A refused attempt gives its slot back, so hammering
   does not extend the wait. Nothing is held. Writes refused by a screen are not counted. Duplicates are.
4. **Exact duplicate.** A live memory (not trashed, not closed) with the same `content_hash` answers
   `{ok: true, duplicate: true, matchId}` and nothing is stored. A trashed copy does not count.
5. **Same name.** A write of origin capture, profile or person whose name matches a live memory of the same origin updates that
   memory in place and keeps a version: `{ok, id, status, tags, updated: true}`. An explicit write with a taken name is a new memory.
6. **Neighbours.** `write/neighbours.js` embeds the first chunk of the new memory and asks Vectorize for the 30 closest chunks, then keeps
   the 10 best live memories with their best cosine. If the embedding or Vectorize fails the write goes on without neighbours and
   `model.failure.embed` goes up. Profile and person writes skip steps 6 to 8.
7. **Near duplicate.** Cosine 0.95 or above answers `{ok: true, duplicate: true, matchId, score}` and stores nothing. From 0.85 up to
   0.95 the memory is stored and the reply adds `warning: "similar", matchId, score`.
8. **Contradiction.** `write/conflict.js`, below.
9. **Store.** `store.create(..., {unlessLiveDuplicate: true})`. The duplicate check and the insert are one SQL statement, so two racing
   writes of the same text store exactly one, and the loser is answered as a duplicate of the winner. Captured origin gets
   `probation_until = now + 60 days`. If step 8 said replace, `store.supersede(old, new, now)` runs right after, in its own batch.
10. **After.** In `ctx.waitUntil`: index the memory (`indexMemories`) and classify its kind. Either can fail alone. A memory without
    vectors or without a kind is picked up by the nightly job.

Success reply: `{ok, id, status, tags}` plus, as they apply, `warning` with `matchId` and `score`, `replaced: {id, reason}` (the old
memory's id, reason `contradiction`) or `kept_both: {id, reason}` (the old memory's id, reason `pinned`, `canonical`, `too_long` or `unsure`).
The audit row lists the new id and any matched or replaced id.

### The contradiction rule

1. Neighbours above 0.45 similarity, at most 5, best first. None means no model call.
2. One JSON mode call shows the new memory and the numbered neighbours and answers `{match: n}` (0 for none). A failure or an
   answer outside the list is no contradiction, counted as `model.failure.detect`.
3. The named memory is never replaced when it is pinned (capsule, profile, person), canonical or longer than 1,500 characters. Both
   stay live with reason `pinned`, `canonical` or `too_long`. A canonical memory gives `canonical`, even when it is not pinned.
4. Otherwise two confirm calls run in parallel with the memories in a different order. Each answers
   `{verdict: both_true | new_wins, old_claim, new_claim}`.
5. Replace only when both answers are `new_wins` and both claims appear word for word (after folding whitespace, markdown marks and
   case, at least 12 characters) in their memories. Both `both_true` is no contradiction. Anything else, including a failed or
   unparseable call, is `kept_both` with reason `unsure`.
6. Replace means the old memory gets `valid_until` and `superseded_by` through `store.supersede` and a version. It is history, never
   deleted, and `POST /undo` on it reopens it. If the supersede fails the reply is `kept_both` `unsure`.
7. Memory text goes into every prompt as data with the prompt's own tags removed (`asData`), and the system prompt says to ignore
   instructions inside it.

### Models

`ai.js` holds `SMALL_MODEL` (`@cf/meta/llama-3.1-8b-instruct-fast`, overridable with the `SMALL_MODEL` variable). The extract call was
replayed on 30 real sessions, see [docs/benchmark.md](../docs/benchmark.md). The sensitivity, contradiction and kind calls are only tested with scripted
answers, so no test shows how accurate they are on real text. Every call asks for `response_format: {type: "json_schema", json_schema: <schema>}`, and the
first line of the user message is `TASK: <name>` (`sensitivity`, `contradiction-detect`, `contradiction-confirm`, `kind`,
`extract`), which is how the tests script the model. A call that throws, times out (25 seconds) or does not parse is null.

## Extract

`POST /extract {transcript, known, max}` returns `{ok, proposals, screened, raw}` and, when the model failed, `degraded: "model"`.
It stores nothing. The client stores each proposal through `/capture`. A device token may call it.

1. `transcript` is required text, the newest 40,000 characters are used. `known` is text the model must not propose again, a string or a
   list (the client sends what the agent saved this session and the capsule, 12,000 characters are used). `max` is a whole number,
   default 2, capped at 2. A transcript with under 800 characters of USER text returns an empty list without a model call, and the counter
   `extract.thin` goes up.
2. Before the model, our injected blocks are removed: a recall, profile or people block runs to the next blank line, a capsule
   block to the next heading or turn, and any line the capsule (`known`) already holds goes too.
3. The prompt asks for at most `max` memories that will still be true and useful next month, of three kinds only (a preference,
   reusable knowledge, a lesson), in the client's shapes. It lists what never qualifies (task status, to dos, narration of what the assistant
   did, restated rules, guesses about the user, anything derivable from code, config or git, anything already known, a conclusion still
   under investigation, the memory system's own text, sensitive topics, instructions) with negative examples. Empty is the usual correct answer.
4. The answer is `{items: [...]}`. Memory items are `{type user|feedback|project|reference, name, description, body}`. Profile items
   are `{type: "profile", field, value, said}` and person items `{type: "person", name, field, value, said}`, with the client
   prompt's field lists (`PROFILE_FIELDS`, `PERSON_FIELDS` in `extract/extract.js`). Profile and person items do not count toward `max`.
   Memory items are screened in order. Items past `max` are counted as `over_cap`.
5. A failed call or an unreadable answer is an empty list with `degraded: "model"`, never an error.
6. Screens, with a reason counted for each drop. Memory items: `bad_name` (kebab-case, 3 to 60 characters), `bad_type`,
   `bad_description` (1 to 200), `body_length` (40 to 3,000), `injected_block`, `instruction`, `blocked_topic` (the shared word list plus
   medication, tax and rent words), `secret`, `task_or_status` (a to do, a status line, or a description that opens with a past tense verb),
   `body_mismatch` (the body shares no content words with its description), `prompt_example` (the body repeats an example from the prompt),
   `duplicate` (the same name, the same body, or 70 percent of the content words of one already kept from this answer) and `over_cap`.
   Dashes and double hyphens become commas. Profile and person items: `bad_field`, `bad_name`, `bad_value`, `not_said` (the quote must be in
   one of the person's own turns), `weak_evidence` (the quote must contain every word of the value, be first person for a profile
   fact, and name the person for a person fact, and a language, timezone or units fact needs a quote of 20 characters or more),
   `from_email` (a greeting, or a turn that reads like a pasted email), `injected_block`, `instruction`, `blocked_topic`, `secret`. The
   model sensitivity check is not run here, because every proposal passes the full capture screens when the client stores it.

## Counters

Migration 0003 adds `recall_log (ts, harness, memory_id)`, one row per memory a counted recall returned, deleted with its memory and after 90 days. Migration 0002 adds `counters (name, day, count)`, one row per name and UTC day. The write path and extract collect bumps in memory
and write them in one batch with `ctx.waitUntil`, so a counter failure never changes a reply. Stored names are
`capture.accepted`, `capture.updated_in_place`, `capture.rejected.<reason>`, `extract.proposed`, `extract.screened.<reason>`,
`extract.thin` (a session too thin to call the model, stored but not shown by `/stats`), `conflicts.replaced`, `conflicts.similar_warning`,
`conflicts.kept_both.<reason>`, `screen.model_fallback` and
`model.failure.<sensitivity|detect|confirm|kind|embed|extract>`, and `hook.recall.<injected|quiet|failed>.<harness>`. The last three are added from the `X-Anymem-Outcomes` header of an authenticated call that is not a browser login. The harness part is a known id, `unknown` for a call that sent no name, or `other`. They are not shown by `/stats`.
Capture reasons are the screen reasons (`secret`, `instruction`, `injected_block`, `blocked_topic`, `sensitive`), `rate_limited`,
`duplicate` (exact) and `near_duplicate`.

`GET /stats` shows them in four sections. Each holds today's values (UTC day) and a `last_7_days` object of the same shape (the
7 UTC days ending today). The dashboard's Health screen reads this shape.

```
capture: {accepted, rejected, reasons: {<reason>: n}, updated, model_fallback, last_7_days: {same keys}}
extract: {proposed, screened, reasons: {<reason>: n}, last_7_days: {...}}
conflicts: {replaced, similar_warning, kept_both: {<reason>: n}, last_7_days: {...}}
model_failures: {<name>: n, last_7_days: {<name>: n}}
```

The nightly job purges counter rows older than 90 days.

## Limits that matter

1. 40 writes per device token per rolling 10 minutes, across every write route. The admin token and a browser login are exempt, and so are imports. `/extract` and `/recall` share their own count of 60 per device token in the same window.
2. Model calls per capture: one for the sensitivity check, then up to three when a neighbour is above 0.45 (detect, two confirms),
   then one for the kind in the background. Free plan subrequests are 50 per invocation, so this fits.
3. The contradiction check and the replace are two D1 batches (create, then supersede). If the Worker stops between them both
   memories stay live, which is the safe failure.

Browser logins are accepted on the reads, and on the dashboard writes under the CSRF rules above. Devices, import and reindex need the bearer.

## Nightly job

`cron/maintenance.js` runs from the one cron trigger (01:00 UTC) and from `POST /admin/run-maintenance` (admin only, optional
`{steps: [...], wall_ms, subrequests}`). The steps share one budget of 40 subrequests for the whole run, counted by wrapping the
bindings (`cron/budget.js`, a D1 batch counts once). Each step has 20 seconds. A step stops when the run's budget is used, and what is left continues the
next night. A step that throws, or that has not finished 15 seconds after its wall time (a call that never answers), is recorded as `{error}` and the others still run. One `runs` row holds the job (`nightly` or
`manual`), times, `ok` (false when a step failed or the backup was refused) and a summary of the form `{step: {counts, subrequests, ms}}`.
The dashboard prints each step's object as JSON.

| Step | What it does | Cost per unit |
|---|---|---|
| `backup` | `backups/anymem-YYYY-MM-DD.json.gz` in R2, streamed as a multipart upload in 8 MB parts, so the store is never held in memory. Refused when it has fewer than 80 percent of the entries of the newest backup after allowing for the memories the trash purge removed since (summary `refused`, the old one stays). Not batched, it is a few queries per 500 memories. | n/a |
| `purge_trash` | Memories trashed more than 14 days (exactly 14 days stays). Deletes rows, tags, keys, links, versions, FTS rows and the vectors (ids worked out from the key rows). | 4 per 100 memories |
| `reindex` | `reindex()` in batches of up to 50, sized from what is left. | about n + 8 |
| `classify` | `classifyKind` for live memories with no kind, 4 at a time. Gives up after the first group fails. | 3 each |
| `merge` | Live captures from the last 14 days that are not pinned, not canonical and not pending. Neighbours come from `write/neighbours.js` at 0.90 similarity or more with a word overlap of 0.45 or more (shared words over all the words of both), and must be older live captures of the same project, not pinned, not canonical and not pending. The newer one closes into the older with `store.supersede(..., "merge")`. When the vector search finds nothing, an older live capture with exactly the same name and a word overlap of 0.85 is the fallback. A cursor in `meta.merge_cursor` keeps the place, oldest first, and is cleared when a sweep ends. | measured from the candidates before it, 10 until one is measured |
| `probation` | Captures only. A recalled one whose `probation_until` is in the past loses it. Never recalled and 60 days old (or more) goes to the trash. Type project with no recall for 90 days (`last_recalled_at`, else `created_at`) goes to the trash. Explicit, profile, person, system, import, pinned and canonical memories are never retired. Versions are written with the reasons `retire_never_recalled` and `retire_idle_project`. | 3 per retirement |
| `purge_old` | Counters, audit rows and recall log rows older than 90 days, and the last doctor probe vector. | 4 |
| `token` | Days left on `ACCESS_TOKEN_EXPIRES`. | 0 |

Ending probation only sets a column, like `kind`, so it writes no version and does not touch `updated_at`.
Retirements go through `store.softDelete`, so they keep a version and the memory can be restored for 14 days.

## Export format v2 and import

`GET /export` (admin or browser) returns `{ok, format: 2, created_at, schema_version, total, offset, next_offset, entries, versions,
questions, links, devices}`. `entries` are the raw `memories` columns plus `tags`, trashed and closed memories included, ordered by
`created_at, id`. `versions` are `{memory_id, seq, snapshot, reason, created_at}` with the snapshot text as stored. `questions` are
the model written question keys, also those of trashed memories (they cost model calls to rebuild). `links` and `devices` (`id, label, token_hash, created_at,
last_used_at, revoked_at`, hash only, never a token) come with the last page. Without `limit` everything is returned up to
3,000 entries, above that the reply is 413 `export_too_large` and says to page with `offset` and `limit` (up to 1,000). A page can also
start at `cursor=start` (or at a `cursor` from an earlier page's `next_cursor`), and then the reply gives `next_cursor`, not
`next_offset`. A cursor is the `created_at` and `id` of the page's last memory, so a purge between pages cannot shift a page. Offset
paging still works, and a purge between its pages moves rows. The nightly backup reads the same document in pieces (`exportText`).

`POST /import` (admin only) takes a v2 document with `offset` and `limit` (up to 200). A body without `format: 2` is the old Worker's
shape and takes the v1 path unchanged. Per memory one D1 batch writes the row, tags, versions, questions and the FTS row, so a
memory is stored whole or not at all. An id that exists is skipped whole, which makes a second import change nothing. The reply is
`{ok, format: 2, imported, skipped, versions, questions, links, devices, errors, next_offset, remaining}`. Links and devices go in
with the page that reaches the end of `entries`. A device with a `token` field, or a `token_hash` that is not 64 hex characters, is
refused. Search keys and vectors are not in the format: after the last page call `/admin/reindex` until `remaining` is 0.
The body limit is 10 MB, so a larger export is cut into several documents (entries and their versions together, links and devices
in the last one).

## Backup routes

1. `GET /backup` (admin or browser) lists `backups/` newest first: `{ok, backups: [{day, key, size, entries, created_at}], latest: {day, entries, size, created_at} | null}`.
   `entries` and `created_at` come from the object's custom metadata (`entries`, `created_at`, `schema`). No bucket binding is a
   404 `no_backup_bucket`, which `doctor.py` reads as backups off. An empty bucket is 200 with `latest: null`.
2. `GET /backup/<day>` (admin or browser) returns the gzip bytes, 400 for a bad day, 404 when there is none.
3. `POST /backup/run {force?}` (admin) takes today's backup now and returns `{ok, key, entries, bytes, refused?}`. A refusal is
   `ok: false` with `refused: {entries, previous_entries, previous_key}`. `force: true` skips the size check.
4. The bucket's lifecycle rule (`expire-backups-30d`, 30 days under `backups/`) is set by `node worker/scripts/set-lifecycle.js [bucket]`
   with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It keeps other rules and writes only when the rule differs.

## Vector probe

`POST /vectorize-probe` (any valid token) upserts one vector with id `<nonce>:probe:0` and metadata `{memory_id, project: "", origin: "probe"}`,
remembers the nonce in `meta.vectorize_probe`, deletes the previous probe vector and returns `{ok, probe}`. `GET /vectorize-probe?probe=<nonce>`
returns `{ok, probe, filtered, unfiltered}`: whether a query finds the vector with the filter `{origin: "probe"}` and without one. The
doctor reads found without the filter but not with it as a missing metadata index, and found by neither as slow indexing. Recall in this
Worker does not filter vector queries, so the filter is the same kind of filter (a metadata index) rather than the same query. The id
has no `:chunk:` part and is not a memory, so recall, neighbours and counts ignore it. The nightly `purge_old` step deletes the last one.
