# Worker architecture

Version 2.1.0. This file says how the Worker is built and why. The routes and settings are in [README.md](README.md). Plain JavaScript modules, no dependencies and no build step.

## Module map

| File | Job |
|---|---|
| `index.js` | `createWorker()` builds the fetch and scheduled handlers. It holds the route table, runs the host check and auth, calls the handler, and writes the audit row for an authenticated call. The default export is the real Worker. |
| `hosts.js` | The optional `ALLOWED_HOSTS` check. Another host gets a 404 before auth and before any audit write. |
| `auth.js` | Access JWT check with WebCrypto, bearer and device token check, auth settings. |
| `http.js` | `HttpError`, JSON replies, bounded body reader, integer query parameters. |
| `audit.js` | Writes, lists and purges audit rows. `auditStatement` builds a row without running it, so a caller can put several rows in one batch. |
| `devices.js` | Device token routes, including `POST /devices/private`. |
| `memory/parse.js` | Frontmatter, hashtags, reserved tags, content hash, the 30,000 character limit. Pure, no database. |
| `memory/store.js` | The storage layer on D1. `createStore(db, now)` gives create, get, getVersion, update, append, setStatus, softDelete, restore, supersede, undo, history, link and list. `update` also takes a version reason, extra statements that join the same batch, and a quiet flag that skips the read of the new state, which the brief step uses. |
| `subjects/store.js`, `subjects/routes.js` | Subjects: the store (create, update, get, list, field checks) and the handlers for `/subject`, `/subject/update`, `/subjects`. See "Subjects" below. |
| `subjects/private.js` | The one place that decides which memories and subjects a device kept from private subjects may not see. |
| `subjects/auto.js` | `autoOn(env)`, the flag check every automatic subject step starts with. |
| `subjects/assign.js`, `subjects/after.js`, `subjects/assign-routes.js` | Assignment. `assign.js` decides which subjects a memory is about, `after.js` writes the links and the audit rows after a write, and `assign-routes.js` is `GET /admin/subjects/assign-preview`. See "Assignment" below. |
| `subjects/hint.js`, `subjects/propose.js`, `subjects/proposal-routes.js` | Proposals. `hint.js` checks the extractor's subject hint, `propose.js` makes a proposed subject, and `proposal-routes.js` holds `POST /subject/accept` and `POST /subject/dismiss`. See "Proposals" below. |
| `subjects/brief.js` | The brief of a subject. `memberHash` hashes the members a brief was built from. `buildBrief` asks the small model for the lines, with the members as data. `checkBrief` refuses a brief that fails one of the checks. `renderBrief` writes the card text. |
| `subjects/cluster-routes.js` | `GET /admin/subjects/cluster-preview`. |
| `memory/diff.js` | The one line summary of what a version changed, used by history. |
| `memory/routes.js` | The handlers for `/entry`, `/list`, `/history`, `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`, `/unlink`, `/links`. |
| `search/chunk.js` | Cuts a memory into chunks (1,600 characters, 200 overlap, at paragraph, sentence or word breaks), builds the search keys, and makes the vector ids. |
| `search/embed.js` | Workers AI `@cf/baai/bge-small-en-v1.5`, 384 dimensions, batches of 50. |
| `search/indexer.js` | Keeps `memory_keys` and Vectorize in step with the memories. Also `reindex`. |
| `search/fts.js` | Keyword search over `memory_fts` weighted by word rarity. |
| `search/query.js` | Cleans a prompt into a query, the same rules the hook had. |
| `search/recall.js`, `search/routes.js` | The recall pipeline and `GET /recall`. |
| `search/relevance.js` | Decides `relevant` per hit. |
| `search/questions.js` | Likely questions per memory from `granite-4.0-h-micro` in JSON mode. |
| `subjects/private.js` | The private rule: `hiddenIds`, `canSee` and `visibleOnly`. The one place it lives, see "The private rule" below. |
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
| `harnesses.js` | The list of harness ids, aliases and proper names, and the label rules (Imported or Unknown for a blank harness, by origin, and Anymem for the `system` caller of the Worker's own background work). The client keeps the same list in `client/hm/harnesses.py` and a test in each language fails when they differ. |
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
| `cron/cluster.js` | The nightly clustering step. Exports `clusterStep` and the grouping the preview route reuses. See "Clustering" below. |
| `cron/briefs.js` | The nightly brief step. Exports `briefsStep`. See "The brief step" below. |
| `backup/export.js`, `backup/import.js`, `backup/backup.js` | Export format v2, its importer, the R2 backup and the routes `GET /export`, `GET /backup`, `GET /backup/<day>`, `POST /backup/run`. |
| `search/probe.js` | `POST` and `GET /vectorize-probe` for the skill's `doctor.py --probe`. |
| `scripts/set-lifecycle.js` | Development tool, not part of the Worker. Sets the R2 lifecycle rule for `backups/`. `setup.py` sets the same rule itself. |
| `migrate.js` | Applies `db/migrations` over the D1 REST API. Not part of the Worker. `setup.py` does the same itself. |
| `db/schema.sql`, `db/migrations/` | The schema. A change is a new numbered migration, and `schema.sql` is updated to match. |
| `db/migrations/0007_subject_briefs.sql` | `member_hash`, `built_at` and `stale_reason` on `subjects`. |
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

Routes with `browserWrite: true`: `/capture`, `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`, `/unlink`.
`/capture` is wrapped by `profileSavesOnly`. A browser may only save `origin` or `source` of `profile` or `person`
through it (403 `browser_capture_scope` otherwise), because that is all the Profile screen needs. Every other write route has neither flag, so it stays bearer only. That covers
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
| `ui/screens/home.js` | `#/home`. `/ui/api/home`, `growth`, `recalls`, `probation`, `/list` and `/subjects?status=proposed` for the Subjects waiting for you list, whose Accept and Dismiss call `POST /subject/accept` and `POST /subject/dismiss` |
| `ui/screens/search.js` | `#/search`. `GET /recall?explain=1&checks=1&count=0`, and the text the hook would add |
| `ui/screens/memories.js` | `#/memories` and `#/memories/<id>`. `GET /list` with filters and sort. The drawer (`lib/drawer.js`) uses `/entry`, `/history`, `/ui/api/memory-extras`. Edit with `if_updated_at`, append, status, link, undo, forget, restore. A lost race shows a clear message and a reload button |
| `ui/screens/activity.js` | `#/activity`. `GET /ui/api/activity`, undo through `POST /undo` |
| `ui/screens/trash.js` | `#/trash`. `GET /list?deleted=1`, the last 14 days, restore |
| `ui/screens/capsule.js` | `#/capsule`. `GET /prompt-capsules/core` and `/entry` for the name of each source |
| `ui/screens/people.js` | The Profile screen, `#/people`. `GET /ui/api/people`. Accept writes the field into the profile memory (`/update`, or `/capture` with `source: profile` when there is none) then forgets the pending item. Dismiss forgets it, with an undo |
| `ui/screens/health.js` | `#/health`. `/ui/api/home`, `overview`, `usage`, `runs`, `token-expiry` and `GET /backup` |
| `ui/screens/audit.js` | `#/audit`. `GET /audit` and `/ui/api/audit-facets` |

### Read routes added for the dashboard

All of these are `GET` and write nothing but their own audit row. Most need the admin token or a browser login. `people`, `token-expiry` and `memory-extras` also take a device token.

| Route | Reply |
|---|---|
| `GET /ui/api/overview` | Everything `/stats` returns, plus `now`, `by_project`, `by_kind`, `by_type`, `pending`, `trash` (forgotten in the last 14 days), `vectors` (`{count, dimensions}` when Vectorize reports it), `capture` (whatever `/stats` carries under `capture`, else null). |
| `GET /ui/api/home` | `{owner, headline, nav, checks, summary}`. `headline` has the live count, memories saved this week and the week before (both leave out subject cards, which are not memories the person wrote), memories recalled this week, recall calls from machines this week and before, and memories closed by the system this week and before. `nav` has the numbers beside the sidebar items, and the capsule cap. `nav.subjects_proposed` is the number of subjects whose status is `proposed` and whose card is not in the trash. `nav.pending`, the changes waiting for you, leaves out any pending memory tagged `subject`, because a proposed subject has a pending card and that card is counted under Subjects. `checks` are `{id, label, state, detail, href}` with state `ok`, `warn`, `fail` or `off`, worked out in `dashboard-status.js` |
| `GET /ui/api/growth?days=30\|90\|365` | Memories saved per day (per week for a year), counted by origin, every bucket present |
| `GET /ui/api/recalls` | Recall calls from machines per day for 30 days with how many returned no memory, the count by harness, the most recalled memories used in the last 30 days, and the memories older than a week that were never recalled (a subject card is never in that list) |
| `GET /ui/api/probation` | Captures on probation with `days_left`, `recall_count`, `retires` (false for a memory the nightly job never retires, such as a pinned or canonical one) and `retire_at` for one nobody recalled |
| `GET /ui/api/activity?kind=&state=&n=&cursor=` | `state` is `all`, `open`, `closed`, `trashed` or `changed_since`, and the filter runs on the Worker, so every page answers it. What the system changed, from version rows with the reasons `supersede`, `merge`, `retire_never_recalled` and `retire_idle_project`. Each has `state`, `can_undo` (true while the change is the latest version and undo still works), `purge_at` and `replaced_by`. Also the counts of the last 30 days and how many trashed memories go for good within 3 days |
| `GET /ui/api/runs?n=` | The latest runs with each step as `{name, state, headline}` |
| `GET /ui/api/usage` | Database size, vector counts and stored dimensions against `plan-limits.js`, the write limit by token, and the capture counters per day for 14 days |
| `GET /ui/api/audit-facets?days=` | The harnesses and routes seen lately with counts, and the calls per day |
| `GET /ui/api/people` | `{ok, profile, people, pending, pending_total}`, full entries. Pending are `status: pending` memories of origin profile or person, or tagged `profile-proposal`, but never one tagged `subject`, at most 500 of them, and `pending_total` is the same count as the Home badge. |
| `GET /ui/api/token-expiry` | `{ok, configured, expires, days_left, warn}` from `ACCESS_TOKEN_EXPIRES` (a date). `warn` is true at 30 days or fewer. |
| `GET /ui/api/memory-extras?id=` | `{ok, probation_until, purge_at, links: [{direction, id, type, name, created_at}], saved_by, recalled_by, recall_log_since}`. The entry does not carry these. `saved_by` is `{at, by, kind, script}` found in the audit trail by the memory's creation time, null when the trail does not hold the save, and left out for a device token. `recalled_by` is `[{harness, label, times}]` from `recall_log` and `recall_log_since` the oldest row there. |
| `GET /ui/api/harnesses` | `{ok, now, days, sources, recalls, used, outcomes}`, see "Harness views". `used.by_harness[].top` ranks inside each tool, three per tool. |
| `GET /ui/api/sources` | `{ok, sources}`, the same `sources` as `/ui/api/harnesses`, and nothing else. The Memories screen reads its filter options from here. |
| `GET /ui/api/trash?sort=&origin=&project=` | `{ok, window_days, entries, shown, matching, total, soon, older, projects}`. The restorable trash, closest to the end first (`sort=forgotten` for newest forgotten first), filtered and capped at 500 on the Worker. Each entry has `purge_at`. `total` counts everything restorable, `matching` what the filters keep, `older` what is past the window. |

Other routes gained optional read parameters for the dashboard. `GET /list` takes `harness` (an id, an alias, or `none` for the memories with no harness). `GET /audit` takes `harness` and `result` (`ok`, `refused`, `limited`, `denied` or `failed`, classes of HTTP status). `GET /list` takes `sort` (`created`, `updated` or `recalls`) and its cursor then carries the order. `GET /recall` takes `checks=1` with `explain=1` and adds `why.checks`, every relevance rule with whether it held and a sentence saying why. The recall hook does not ask for it, so its reply does not grow.

A step that reports `refused` shows its own reason on the Health screen when it gives one as text, for example the brief step says "the model did not answer". The backup step keeps its own wording about fewer entries than the last backup. A run is still not ok when the brief step refuses because the model is down. The Health screen reads the capture counters per day from `/ui/api/usage` and the model failures of the last 7 days from `/ui/api/overview`. It reads the backup list as `{backups: [...]}` (or `entries` or `objects`), each with a `day` or a name holding `YYYY-MM-DD`, and links to `/backup/<day>`.

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

The Worker's own background work writes audit rows too, and its `actor_kind` is `system`. The `actor_id` is the step (`assign`, `propose`, `cluster` or `brief`), the `method` is `SYSTEM`, and the `route` is the action, such as `assign.link`, `assign.ambiguous`, `propose.subject`, `cluster.propose`, `brief.build` or `brief.retire`. They are not requests, so they have no duration. The `script` column says how the action was decided, for example `how:alias.conf:1.0`. Every one of these rows carries the harness `system`, which the dashboard names Anymem, so `?harness=system` and `?actor=assign` find them. That covers the assignment, proposal, cluster and brief rows. They keep the same 90 days.

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
4. The nightly `purge_trash` step deletes a memory 14 days after it was trashed, with its rows, tags, keys, links, link rejections, subject row (the foreign key cascade removes it), versions, FTS row and vectors.

### Validity and lists

1. A closed memory (`valid_until` set by `supersede`) is not in `/list`. It is still readable with `/entry` and `/history`.
   `pending` and `deprecated` memories are in `/list`, filter them with `status`.
2. The FTS table holds every memory that is not in the trash. Search joins `memories` and applies `LIVE`.
3. Pinned is set from the tags `capsule:core` and `capsule-slot:*`, and from the origins `profile` and `person`.
   It is recomputed on every content or tag update.
4. `store.supersede(oldId, newId, at, reason)` has no route. The write pipeline and the nightly merge call it.

### Links

1. A link is `(source_id, target_id, link_type)` between two live memories, plus `created_at`, `made_by` (`user` or `system`, default `user`) and `confidence` (a number the system sets, null for a user link). Migration 0005 added the last two. Links that existed before are the user's. An `about` link to a subject card makes the memory a member of that subject.
2. The link types are `about`, `part_of`, `owns`, `affects`, `decided`, `supersedes`, `contradicts`, `derived_from`, `about_person` and `related` (`LINK_TYPES` in `memory/parse.js`). `POST /link` takes any of them except `supersedes` and `derived_from`, which only the system writes. An unknown type is 400 `bad_link_type` and the message lists the types. A reserved type is 400 `reserved_link_type`. Rows with another free text type from before the list stay as they are, and `GET /links` returns the stored type. A client shows a type outside the list as `related`.
3. `POST /unlink {source_id, target_id, type}` replies `{ok, removed}`. Removing a link with `made_by = 'system'` also inserts `(source_id, target_id, link_type, created_at)` into `link_rejections` in the same batch, so the system never makes that link again. Removing a user link writes no rejection.
4. A device token may remove only user links. A system link is 403 `admin_only`, and the link stays. A link with either end holding capsule tags or the canonical status is refused to a device token with the same 403 as an edit of that memory (`guardDevice`). The admin token and a browser login may remove any link.
5. `GET /links?id=` is `{ok, id, links: [{type, direction, other_id, other_name, made_by, confidence, created_at}]}`, sorted by type and then newest first. `direction` is `out` when the memory is the source and `in` when it is the target. Only ends that are not in the trash are listed. An id that exists nowhere is 404. Every token kind that reads memories may call it.
6. `/link` and `/unlink` audit both memory ids, and `/links` the one id. `/unlink` takes a write slot from a device token like `/link` does.
7. The trash purge deletes the links and the `link_rejections` rows of a purged memory, in both directions.

## Subjects

A subject is a thing memories are about: a person, pet, asset, project, area or topic. A person makes a subject by hand. With `SUBJECTS_AUTO` on, the Worker can also link memories to subjects, propose subjects and build briefs by itself, which the parts below describe. Those parts do nothing while the switch is off.

1. A subject is a row in `subjects` plus a card, an ordinary memory with the same id. The card holds the brief. It is made through the memory store with origin `system`, type `project`, and the tags `subject`, `subject:<slug>` and `subject-kind:<kind>` (`kind:` is a reserved tag prefix, so the kind tag has another name). Its content is a frontmatter note: name is the slug, description is `<kind> card for <display name>`, the body is the brief. The display name is read back from that description, so it has no column. A card is searchable and versioned like any memory, and only the admin token or a browser login can write one (a device token cannot write origin `system`).
2. The row holds `slug` (unique, 2 to 40 characters of lowercase letters and digits with single dashes), `kind`, `status` (`proposed`, `active`, `stale`, `retired`), `scope` (`shared` or `private`), `fields` and `aliases` as JSON, and the two times. A subject made by hand starts `active`. `proposed` is for a subject the system suggested and `stale` is for a subject whose last brief failed a check, whose brief was cleared because its members changed, or that the model could not build 3 nights in a row. `POST /subject/update` refuses both, and a proposed subject is decided only through `POST /subject/accept` and `POST /subject/dismiss`. Bringing a retired subject back to `active` with `POST /subject/update` also makes its card memory active when the card is still pending, so a dismissed proposal that comes back is offered by recall again. It also clears the brief when that is still the one line the system wrote, as accepting does. Deleting the card cascades to the row, so the trash purge needs no step of its own.
3. `fields` is `{key: {value, confirmed_at, source}}` with `source` `user` for a value a person set. The keys each kind may hold are `FIELD_KEYS` in `subjects/store.js`, and every kind may also hold `brief_pinned`, which marks a brief a person wrote. Another key is 400 `bad_field`, and a value is a string of 1 to 200 characters. A person has no health or money key. An update merges: a string sets and confirms the key again, `null` removes it. Saving a non empty brief that differs from the stored one through `POST /subject/update`, or creating a subject with a brief through `POST /subject`, also sets `brief_pinned` to `yes`, unless the same request names `brief_pinned` itself. `aliases` are lowercase names, an update replaces the list, at most 20. The brief and every field value go through the same secret screen as an explicit write.
4. A memory is a member when an `about` link runs from it to the card (`POST /link`). Members are live memories, newest change first, and `GET /subject` returns at most 200 while `member_count` is the real number. A subject whose card is in the trash is a 404 until the card is restored, and its slug stays taken.
5. A new brief or name writes a new version of the card through `store.update` (reason `update`), so `/history` and `/undo` work on the card. An undo of the card does not change the subject row, so after one the brief shown by `/subject` follows the card and the name follows its description.
6. `devices.allow_private` (default 1) says whether a device token may see private subjects. `POST /devices/private` sets it, admin token only. The rule that uses it lives in `subjects/private.js` and exports `hiddenIds`, `canSee` and `visibleOnly`. What it hides from a device kept from private subjects is set out under "The private rule" below. The admin token and a browser login see everything. `GET /subjects` and `GET /subject` call it, and a hidden subject is a 404, never a 403.
7. The subject routes audit the card id. The write routes are admin only with browser write. The read routes take any token and a browser login.
8. The `SUBJECTS` variable (`on` or `off`, default off) turns on subject cards in recall. The subject routes ignore it.
9. `SUBJECTS_AUTO` (`on` or `off`, default off) is the switch for everything the system does to subjects on its own. `subjects/auto.js` exports `autoOn(env)`, which is true only when `SUBJECTS_AUTO` and `SUBJECTS` are both `on`. Every automatic step asks it first and does nothing when it says no. The admin preview routes and the accept and dismiss clicks do not ask, because they write nothing the system decided or they are the person's own click.
10. Migration 0007 adds `member_hash` (a hash of the members a brief was built from, empty until built), `built_at` (when the brief was last built, null until then) and `stale_reason` (the check a new brief failed, empty when the subject is not stale). Export and import carry the three columns, and an export from 2.0.8 imports as a subject whose brief was never built. `GET /subject` and `GET /subjects` return `built_at` (in milliseconds, or null) and `stale_reason` (a check name, `model.fail.N`, `members_changed`, or an empty string) with the other keys of a subject.

### Assignment

1. After a write has replied, the write path links the new memory to the subjects it is about. `afterWrite` indexes and classifies, and then calls `afterSubjects` (`subjects/after.js`). That is inside `ctx.waitUntil`, so it adds nothing to the reply. It never throws. A failure bumps the counter `subjects.failed` and is swallowed. It runs for a new memory, and for a capture that updates a memory in place. The update has no neighbours, so only the name match can link it.
2. `assignMemory` (`subjects/assign.js`) only decides. It returns `{links, ambiguous, ambiguous_ids, skipped}` and writes nothing. `afterSubjects` writes. A profile, person or system memory is never assigned, and neither is a card.
3. Alias match. The slug (also with spaces for dashes), the name and every alias of an `active` or `stale` subject are looked for in the memory's description and body. Case does not matter. The term must stand as a whole word or phrase, so Pip matches `Pip's` and `Pip,` but not `Pipeline`. A term shorter than 3 characters never matches. A match gives confidence 1.0.
4. Neighbour vote. Of the 5 nearest neighbours the write already found, if at least 3 are members of the same subject and the nearest of those is at least 0.6 similar, the memory is linked with confidence (votes divided by 5) times that best similarity, rounded to 2 places. A hidden neighbour and a card never count, because the write path removes them before the list is passed on. An alias match for a subject wins over a vote for the same subject.
5. The floor is 0.5. A link under it is never made. Three votes reach it only when the best similarity is about 0.84 or more.
6. A memory is never linked to a subject twice, never to a pair in `link_rejections`, and never to itself.
7. A memory may belong to several subjects. At most 3 are linked, best confidence first, which also keeps the step inside its subrequest budget.
8. Ambiguity. When two subjects have the same alias and that alias is in the text, neither is linked. A name that only one of them has (Rowan the dog against Rowan Lee) settles the tie for that one. A tied subject is not linked by a vote either. The step writes one audit row, route `assign.ambiguous`, and bumps `subjects.ambiguous`.
9. Private subjects. Assignment may link to them, because scope only says who sees. A device whose private access is off is never linked to a private subject by assignment, so a private subject cannot be inferred from the writer's own memories. The admin token, a browser login and a device with `allow_private` see them as candidates. A memory that belongs to a private subject, or that assignment is about to link to one, gets its private links only. A shared link would make the memory visible to every device, so the shared candidates, from a name match or from a vote, are dropped for that memory. The insert checks the same thing, so a person who links the memory to a private subject a moment later cannot be overtaken.
10. Budget. Each D1 call and each batch counts as one subrequest. Deciding costs at most 3 reads (the candidate subjects, the neighbours' memberships, the pairs already linked or rejected). The links and their audit rows go in one `db.batch`, so a memory that makes 3 links and one ambiguity row uses at most 4 calls. A link is made only when both ends are live, the pair is not in `link_rejections`, and the private rule above holds. An audit row is written only for a link that was made. A link that was decided but not made counts as `subjects.failed`.
11. Every system link that is made writes one audit row, route `assign.link`, with the memory and the card in `memory_ids` and the way it was decided in `script`, as `how:alias.conf:1.0` or `how:vote.conf:0.54`. The column keeps letters, digits and `._:-` only. The Audit screen and `GET /audit` show these rows like any other.
12. The counters are `subjects.assigned` (one per link), `subjects.ambiguous` and `subjects.failed`.
13. Undo. A system link is made with `made_by` `system` and a confidence. `POST /unlink` on it removes it and writes a `link_rejections` row, and assignment never makes that link again. A device token cannot remove a system link.
14. `GET /admin/subjects/assign-preview?days=7&cursor=&limit=3` (admin token only, a device token gets 403) shows what assignment would do and writes nothing. It works whatever `SUBJECTS` and `SUBJECTS_AUTO` say. It pages through live captured and explicit memories of the last `days` days (1 to 365, default 7), newest first, with neighbours from the same search the write uses. A page is at most 4 memories (default 3), so one request stays inside the request's subrequest limit. A larger `limit` is cut to 4 and the reply says `limit`. The reply is `{ok, days, limit, memories: [{id, name, snippet, links: [{slug, confidence, how}], ambiguous, skipped}], next_cursor}`. The snippet is 160 characters on one line. A link a memory already has is not shown again. `scripts/subjects-replay.mjs` walks the pages.

### Proposals

1. A proposal is a subject row with status `proposed` and scope `shared`, plus a card memory with origin `system` and status `pending`. The card holds one line, "Proposed from conversation, waiting for your click." Recall, search, the memory count and the Profile pending list do not see a pending memory, so a proposal is invisible until it is accepted. `GET /recall?subject=` answers 404 for a proposed subject, and also for a dismissed one, because its card memory is still `pending`. It is served again when the subject is brought back. A slug that exists in any status is never proposed again, and neither is a name an existing subject already answers to as an alias.
2. `createProposed` in `subjects/propose.js` makes one. It refuses a name that cannot make a slug of 2 to 40 characters, a generic name (a list of more than 80 words such as the, it, user, thing, project, work, home, team, me), a name that holds a secret or reads as an instruction, a name that is not plain text (item 4), and a kind outside the list. It writes the card, the subject row and one batch of `about` links from the evidence memories (made_by `system`, with a confidence), then one audit row. The unique slug is the guard when two calls race. The loser gets reason `exists` and its card goes to the trash. A proposal of kind person is allowed and never sets a field. The reasons are `bad_name`, `bad_kind`, `generic`, `secret`, `instruction`, `no_evidence`, `exists`, `too_many` and `failed`.
3. `proposeFromHint` takes the extractor's hint for one memory. It does nothing unless `autoOn(env)`. The kind must be one of the six. The name must stand as a whole word or phrase in the memory's description or body, never in the front matter, so Pip is not found in Pipeline, and a hint of `metadata` is not satisfied by a memory's front matter. Only a live capture or explicit memory can be the evidence. `afterSubjects` calls it only when assignment linked nothing, the memory has no `about` link at all (it may belong to a private subject, and a link to a new shared card would make it visible to every device), and the writer is not a device kept from private subjects (for that writer the answer `exists` would tell it whether a private subject has that name, so its hint is ignored).
4. A name is plain text. It is 2 to 60 characters and at most 5 words, starting with a letter or a digit. It may hold letters of any script with their marks, digits, a plain space, an apostrophe, a period, a hyphen and an ampersand, and nothing else. A colon, a comma, a slash, an at sign, brackets, a link, an address and every invisible character (format, line separator and paragraph separator characters, such as a zero width space or a right to left override) are refused, so a name cannot carry an instruction, a link or hidden text. `plainName` in `subjects/hint.js` is the one rule, `createProposed` applies it to every caller, and `hooks/memory_capture.py` (`plain_name`) applies the same rule before it sends a hint. The Worker checks again.
5. At most 25 proposals wait at once (`MAX_PROPOSED`, exported by `subjects/propose.js`). The check is part of the `INSERT INTO subjects` statement, so many proposals made at the same moment cannot all pass it. `createProposed` answers `too_many` and trashes the card it made, and the cluster step reads the same constant to stop early.
6. A proposal that fails after its card was made, or whose evidence could not be linked (the memory is gone, is a card, or belongs to a private subject), is not kept. The subject row is deleted and the card goes to the trash, so the slug is free again and a retry is not told `exists` for ever. The answer is `failed` or `no_evidence`.
7. The hint is data. `POST /capture` and the extractors keep a hint only when it is well formed, a device token may send one because the Worker makes the proposal and the device does not, and a hint that fails any check is dropped while the memory is saved as usual. `POST /extract` puts the hint on a memory proposal when its name also stands in the proposal's own text.
8. The audit row of a proposal has actor_kind `system`, actor_id `propose`, harness `system`, method `SYSTEM`, route `propose.subject`, status 200 (500 on a failure) and the card and evidence ids. The script column holds `how:hint.conf:1.0`. The clustering step passes the step `cluster` and gets actor_id `cluster`, route `cluster.propose` and `how:cluster.conf:` followed by the mean confidence.
9. Accept and dismiss are in `subjects/proposal-routes.js`. Each is one guarded UPDATE that only changes a subject whose status is still `proposed`, so two clicks cannot both win, and anything else is 409 `not_proposed`. Accept sets the subject `active` and then the card memory `active`, and keeps the evidence links. If the brief is still the one line the system wrote, accept clears it with a normal versioned update, so it can be undone. A brief the person edited stays. Dismiss sets the subject `retired` and deletes nothing, so the slug stays taken and the same proposal never comes back. A proposal whose card was trashed is a 404, as a missing subject is, and a card that is trashed between the click and the card update makes accept answer 404 and puts the proposal back to waiting.

### Clustering

The cluster step proposes subjects from notes that no subject has claimed yet. It runs before `merge`, see "Nightly job".

1. Which notes. Live captures and explicit notes from the last 90 days that are not cards and have no `about` link to any subject. A note that belongs to a private subject has an `about` link, so it is never a candidate and a proposal never pulls it into a shared subject.
2. How they are grouped. A shared project, a shared plain tag, or a shared first word of the note name. The tags the system writes itself (`auto-capture`, `captured-by`, `session`, `subject`, `capsule`) never group. A first word under four letters, or a common word such as update or session, never groups. A group name that matches the stop list is dropped as generic. The memory type words `feedback`, `reference`, `user` and `project` are on that list, so they never name a group. A group needs five notes.
3. The cohesion check. The step reads the stored vectors of up to the 20 newest notes in a group with one Vectorize `getByIds` call and takes the mean cosine of every pair. Below 0.55 the group is dropped. A group with fewer than five indexed notes waits for the indexer. When the budget cannot pay for the check and the proposal together, the group is dropped and counted as `skipped_budget`. It is never proposed unchecked. At most 6 groups are checked in a night. A group that fails the cohesion check is remembered for 7 days in the `meta` table (key `cluster_memo`, one JSON value that maps a group name to the day it was last checked and the day it was dropped). The step skips such a group without a vector call and reports it as `recently_dropped`. Entries older than 14 days are forgotten, and at most 200 are kept. A group that only waits for the indexer is not skipped the next night. The groups are taken biggest first, and groups of the same size take turns, the one checked longest ago first, so a few big loose groups cannot use every night's checks.
4. The proposal. The name is the tag, word or project slug. A project makes a project proposal, anything else a topic. The step calls `createProposed` with the checked notes as evidence, each with the cohesion as its confidence. At most 3 proposals a night. The step also stops when 25 proposals already wait for a click (`MAX_PROPOSED` in `subjects/propose.js`), or when `createProposed` answers `too_many`. The rest of the groups are then reported as `waiting_full` and cost no vector call. The slug must not exist in any status, and no existing alias may match it, so a dismissed proposal does not return. A group also counts as existing when its name is a whole dash separated word of an existing slug or alias, so `corolla` is not proposed while `toyota-corolla` exists.
5. The summary. The step reports `memories`, `groups`, `checked`, `proposed`, `slugs`, `skipped_budget`, `failed`, and a count of dropped groups by reason (`exists`, `generic`, `recently_dropped`, `low_cohesion`, `not_indexed`, `vectors_failed`, `waiting_full`, `over_cap`, `check_limit`, `skipped_budget`, and the reason `createProposed` gave for a refusal). With the switch off it reports `skipped: "off"`.
6. Cost. A night with nothing to propose costs 2 subrequests. The step reserves 1 for each check and 10 for each proposal, and it needs 3 for its first reads, so on a night where earlier steps used most of the budget it does nothing and tries again the next night. The memo is read in the same batch as the subject names and the count of waiting proposals, so the three opening reads stay three. It is written once at the end, only when a check ran and one subrequest is left.
7. `GET /admin/subjects/cluster-preview` (admin token only) runs the same grouping with nothing written and works whatever the switches say. It returns `candidates` (name, slug, kind, source, size, cohesion, evidence with note ids and names), `dropped` (name, slug, kind, size, reason, and cohesion when it was measured), `counts` (memories, groups, checked, subrequests) and `cap`. A browser login and a device token are refused.

### The brief step

1. Who is rebuilt. Subjects with status `active` or `stale` that have at least one live member, and either are `stale` or have a `member_hash` that differs from the hash of their newest 20 live members now. Subjects whose `fields.brief_pinned` is set are never touched. The pin is set by hand, and also by saving a brief through `POST /subject/update` or creating a subject with a brief. At most 8 a night. Healthy subjects go first, then the oldest `built_at`, with a subject that was never built counted as the oldest. A subject that failed goes after the healthy ones, the one the model failed on least first, so one that keeps failing cannot hold up the rest. A subject whose brief was only cleared (item 5) has not failed.
2. What the model sees. The subject name, kind and fields, and its members' text, each with its id and date, inside a `memory` tag. The text is passed through `asData`, so it cannot close the tag, and the standing instruction says the text is data and never an order. The prompt holds this subject's members only. A shared subject also leaves out any member that belongs to a private subject, so private text never reaches a card that every device can read.
3. What the model answers. `{lines: [{section, text, ids}]}`. The section is `now` or `history`. The step cleans the lines (plain text, no bullets, no hashtags), puts Now before History, and drops whole lines past 12 lines or 900 characters. A line whose `text` is not a string, or whose `ids` are not a list of strings, is dropped, never turned into text. The answer may take 1815 tokens (`BRIEF_MAX_TOKENS`), which is 900 characters at about 3 characters a token plus 12 lines of 3 ids of 36 characters each and their JSON, with a fourth added, so the longest allowed brief is never cut off in the middle.
4. The checks. A brief is saved only when every one passes, and the name of a failed check goes into `stale_reason`. Anything the model wrote that fails is thrown away whole. A line may cite at most 3 members.
   1. `bad_shape`, a line has no text or its ids are not a list of strings, or it cites more than 3 members.
   2. `too_long`, more than 12 lines or 900 characters.
   3. `no_citation`, a line cites nothing.
   4. `foreign_id`, a line cites an id that is not a member the model was shown.
   5. `trashed_member`, a cited member was trashed, closed by a newer memory or is pending. The members are read again after the model answers, so a member trashed while the model worked is caught.
   6. `uncited_number`, a number or date in a line is not written in a memory the line cites. This check is exact about the words it reads. Both texts are folded with NFKC first, and a line with a digit other than 0 to 9 (an Arabic-Indic digit, for example) is refused. A comma is a thousands mark only in the form `1,450`, so `1,5` is 1.5 and never 15, and `1,2,3` is never 123. A number word from zero to twenty, the tens, hundred, thousand and million is the same number as its digits, and `half`, `dozen`, `twice`, `quarter` and a written fraction such as `1/2` must appear as written. A number is compared with the word after it, so `12 grams` is not backed by `12 kilos`, and a unit written once covers a range (`5 to 12 kilos`). A month name in any case, May included, must appear in a cited memory, a day with a month must be in a cited memory, and a whole date must match a whole date in any written form (`19 October 2026` backs `2026-10-19`). A memory's own written date counts as a date only. Its year, day or month never counts as a loose number.
   7. `unbacked_claim`, a line says something its cited memories do not. It fails when the line has a negation (not, never, no, none, nothing, nobody, neither, nor, cannot, without, n't) and no cited memory has one, when a capitalised word that does not start a sentence appears in no cited memory, or when the line shares fewer than 2 content words with them (all of them when it has fewer than 2). A negation a cited memory has and the line drops is allowed. This is a heuristic on words, not proof. It stops a claim that came from nowhere, and it cannot tell that a sentence turns a memory round. A person who reads a brief should still treat it as a summary written by a model.
   8. `instruction`, a line reads as an order or holds a recalled block. Also `bad_card`, which is not a check on the lines. It means the card text has no front matter to put a brief under.
5. Clearing. Before any rebuild is tried, a brief that was built (`built_at` is set) is cleared when the hash of the members that may feed it is not the stored one. That covers a member that was edited, trashed, forgotten, taken out of the subject, or linked to a private subject, and a subject left with no member at all. One batch writes the card text without its brief (a normal versioned update with the reason `brief`, so the person can undo it from the card's history), deletes the `derived_from` links of the card, resets `built_at` and `member_hash`, sets the subject `stale` with `stale_reason` `members_changed`, and writes one audit row with the route `brief.clear`. It does not wait for the card to be unedited, because a privacy clear must not lose to an edit. A rebuild that then fails, runs out of budget or never comes leaves the subject with no brief, never with the old text.
6. Saving. One batch writes the new card text (a normal versioned update with the reason `brief`, so it can be undone), replaces the `derived_from` links from the card to each cited member (made by the system), sets `built_at`, `member_hash` and status `active`, clears `stale_reason`, and writes one audit row. If the card was edited since the step read it, nothing is saved and the subject waits for the next night.
7. Failing. A failed check sets the subject `stale` with the check name in `stale_reason` and writes one audit row with status 500. A model that does not answer is counted for that subject in `stale_reason` as `model.fail.1`, `model.fail.2` and so on, with one audit row with status 500 each time. At the third in a row the subject becomes `stale`, and a subject that failed is tried after the healthy ones. The count restarts when a build succeeds. Builds run four at a time, because the model is the slow part and the step has a time limit. After two builds in a row that got no answer, the step stops. When every build it tried failed, the run summary carries `refused` ("the model did not answer", or "no brief could be saved" when the writes failed), which makes the whole run not ok, the same way a refused backup does.
8. Retiring. A subject that is `active` or `stale`, has fewer than 3 live members, has not changed for 60 days and has no pinned brief becomes `retired`, but only when its kind is project, area or topic. The 60 days run from the later of its creation and its last update, so a proposal that is accepted late is not retired the same night. A person, a pet or an asset has few memories by nature and is never retired this way. One audit row with the route `brief.retire`. At most 8 are retired in a night.
9. Audit rows. Actor kind `system`, actor id `brief`, harness `system`, method `SYSTEM`, route `brief.build`, `brief.clear` or `brief.retire`, status 200 or 500, the card id and the cited ids in the memory ids. The script column says how it was decided, for example `how:model.lines:5` or `how:check.uncited.number`.
10. Cost. A night with nothing to do costs 1 subrequest. A build costs at most 4 (the model, a fresh read of the members, and the card update with its batch), a failed check costs less, a clear costs 2, and the two reads that open the step cost 2 more. A night with 8 builds costs 34. The step takes at most half of the budget that is left when it starts, so `merge` always has some. On the default budget of 40 that is about 4 builds, fewer when earlier steps used part of it, and what is left waits for the next night. At the default time limit of 20 seconds the model is also likely to end the step before the subrequests do. Every build checks the budget first, so the step never goes over it.

### The private rule

1. A subject has a scope, `shared` or `private`. A device token whose device has `allow_private = 0` must not see a private subject, its card memory, a proposal (see item 2), or a memory whose only `about` links go to private subjects. The admin token, a browser login and a device with `allow_private = 1` see everything.
2. `subjects/private.js` is the only place that says this. For a memory the rule is that it is the card of a private subject or of a proposal, or it has at least one `about` link to a private subject and no `about` link to a shared subject that counts. A link to a proposal (a subject with status `proposed`, or a dismissed one whose card is still pending) never counts, so it cannot make a private memory visible. An `about` link to a memory that is not a subject counts for neither side. The module exports `hiddenIds(db, ids, actor)` (a Set), `canSee(db, id, actor)` and `visibleOnly(db, rows, actor, idOf)`. For pieces of SQL that need the same gate it also exports `SEES_PRIVATE_SQL`, the device flag as an `EXISTS`, which fails closed when the device row cannot be found.
3. Every call is one query whatever the number of ids, a `json_each` over the ids with the links and subjects read by `EXISTS`. The admin token and a browser login cost no query, and a device costs the one query even when nothing is private.
4. Where it is applied: `GET /entry` (also an old version, and the trash), `GET /history` and `GET /links` answer 404 for a hidden memory with the text of a missing one, so a device cannot tell the two apart. `GET /links` also drops the links whose other end is hidden, using one check for the memory and all other ends. `GET /list` drops hidden entries after the page is read. `GET /ui/api/memory-extras` does the same as `GET /links` for its links, since they carry the names of the other ends. Recall applies it to its candidates before ranking, and to the subject cards. The subject routes call the same exports for the subject lists and the 404 on a private subject. The actor comes from the route's `actor`. A call to `recall()` with no actor hides nothing, which is how the nightly job and tests call it. A proposal is invisible to a device kept from private subjects in every one of these reads. Its card is a 404, the subject lists and `GET /subject` leave it out, and `GET /links` drops the link from a memory to it, so such a device cannot learn that a subject was proposed or dismissed. Together with the rule that its own hints make no proposal, it cannot probe for a private subject through a proposal.
5. A device token never writes to a memory it may not see (404, the same as a missing id), never changes a subject card, and never adds or removes a link on one. A capture from a device is told "duplicate" without an id when its match is hidden, a hidden memory is never updated in place by a same name capture, and the warning and the contradiction check look only at visible memories. The list pages past hidden rows in SQL, so a cursor never names one. `GET /count` leaves hidden memories out for a device, `GET /ui/api/people` is for the admin token and a browser login only, and the trash purge keeps the card of a private subject that still has members, because deleting it would remove the links that keep them private.
6. Not covered, on purpose. A memory tagged as a capsule rule is served to every device from the shared capsule cache, so never link one to a private subject. A private card is made as an ordinary memory a moment before its subject row, and the window is closed by making the card and the row in one batch in a later phase.

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
| `POST /unlink` | `{ok, removed}`, false when there was no such link |
| `GET /links?id=` | `{ok, id, links: [{type, direction, other_id, other_name, made_by, confidence, created_at}]}`, see Links under Storage rules |

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
8. Reply: `{ok, query, results}` and, with the `SUBJECTS` variable set to `on`, `subjects` (see step 11). A result has `id, name, description, type, content (whole), tags, project, origin, harness, harness_label, status,
   created_at, updated_at, score, similarity, rerank (when scored), relevant`, and with `explain=1` `why {dense_score,
   dense_rank, keyword_rank, coverage, query_words, keyword_terms [{term, level, idf}]}` plus `took_ms` and `timings` (ms, embed, vectorize and keyword are since the
   start, load and rerank are the step itself). `degraded: "vector"` marks a reply made without the vector search.
9. `recall_count` and `last_recalled_at` change only with `count=1`. Only hits marked relevant are counted, and each one also gets a `recall_log` row with the time and the harness of the caller (see "Counters" below), written in its own statement so a failure there never undoes the count. A plain recall writes nothing but its audit row, which lists the
   returned ids. Query parameters are `query, topK (1 to 50, default 5), scope, exclude_ids, tag, kind, type, origin, after,
   before, min_recalls, as_of, capsule, explain, count, subject`. `synthesize` is ignored.
10. The private rule runs on the rows the filter step loaded, before ranking, so the cut to `topK`, the order and every relevance check see only what the caller may see. A recall by a device without private access ranks the same as one by the admin token over the visible memories, and a page is still full.
11. With `SUBJECTS` set to `on`, one query after ranking finds the cards of the relevant results: `about` links from those results to a subject with status `active` or `stale` whose card memory is live, and for a device without private access only a shared subject. The best ranked result's subject comes first, then the one with more `via` results, and two at most are returned. A reply with no cards has `subjects: []`. The reply never has the key when the variable is off or unset. This is the only place recall reads the `subjects` table.
12. `GET /recall?subject=SLUG` skips search. It reads the card by slug (one query, the private rule in its SQL) and the live members newest updated first, capped by `topK` (a second query), then the text and tags of those members like a recall does. It is not ranked, not counted and takes no part in `recall_log`. Private members need no filter of their own: a member of a visible subject has an `about` link to a subject the caller sees, so the rule never hides it. A subject the caller may not see is 404, like a missing slug. A subject whose card memory is still `pending` is not served either, so a dismissed proposal is a 404 until it is brought back.

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

`POST /capture {content, tags?, project?, source?, origin?, harness?, session?, subject?}` runs `write/pipeline.js`. `subject` is the extractor's hint `{name, kind}`, kept only for a capture or explicit write and only when `subjects/hint.js` finds it well formed. The order matters.
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
   `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`, `/unlink`), not only captures. The reply is
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
10. **After.** In `ctx.waitUntil`: index the memory (`indexMemories`) and classify its kind, then link the memory to its subjects
    (`SUBJECTS_AUTO`, see "Assignment" under Subjects). Either of the first two can fail alone. A memory without
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
4. The answer is `{items: [...]}`. Memory items are `{type user|feedback|project|reference, name, description, body, subject?}`. `subject` is `{name, kind}`, the model's hint that the memory introduces a named person, pet, vehicle, property, project or topic. A hint that fails `subjects/hint.js`, or whose name does not stand in the description or body, is dropped and the memory is kept. Profile items
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
`conflicts.kept_both.<reason>`, `subjects.assigned`, `subjects.ambiguous`, `subjects.failed`, `screen.model_fallback` and
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
`{steps: [...], wall_ms, subrequests}`). The steps share one budget of 40 subrequests for the whole run (`NIGHTLY_SUBREQUESTS`, 400 on a Paid store), counted by wrapping the
bindings (`cron/budget.js`, a D1 batch counts once). Each step has 20 seconds. A step stops when the run's budget is used, and what is left continues the
next night. A step that throws, or that has not finished 15 seconds after its wall time (a call that never answers), is recorded as `{error}` and the others still run. One `runs` row holds the job (`nightly` or
`manual`), times, `ok` (false when a step failed or the backup was refused) and a summary of the form `{step: {counts, subrequests, ms}}`.
The dashboard prints each step's object as JSON.

| Step | What it does | Cost per unit |
|---|---|---|
| `backup` | `backups/anymem-YYYY-MM-DD.json.gz` in R2, streamed as a multipart upload in 8 MB parts, so the store is never held in memory. Refused when it has fewer than 80 percent of the entries of the newest backup after allowing for the memories the trash purge removed since (summary `refused`, the old one stays). Not batched, it is a few queries per 500 memories. | n/a |
| `purge_trash` | Memories trashed more than 14 days (exactly 14 days stays). Deletes rows, tags, keys, links, link rejections, versions, FTS rows and the vectors (ids worked out from the key rows). | 4 per 100 memories |
| `reindex` | `reindex()` in batches of up to 50, sized from what is left. | about n + 8 |
| `classify` | `classifyKind` for live memories with no kind, 4 at a time. Gives up after the first group fails. | 3 each |
| `cluster` | Proposes subjects from live captures and explicit notes of the last 90 days that no subject has claimed, at most 3 a night, and none while 25 proposals wait for a click. Does nothing unless `SUBJECTS_AUTO` and `SUBJECTS` are both `on`, and then reports `skipped: "off"`. See "Clustering" under Subjects. | 1 per group checked, 10 per proposal, 2 for a night with nothing to propose |
| `briefs` | Rebuilds the brief of a subject whose members changed, at most 8 a night, clears a brief whose members changed, and retires a project, area or topic with fewer than 3 live members that has not changed for 60 days. Does nothing unless `SUBJECTS_AUTO` and `SUBJECTS` are both `on`. See "The brief step" under Subjects. | 4 per build, 1 for a night with nothing to do |
| `merge` | Live captures from the last 14 days that are not pinned, not canonical and not pending. Neighbours come from `write/neighbours.js` at 0.90 similarity or more with a word overlap of 0.45 or more (shared words over all the words of both), and must be older live captures of the same project, not pinned, not canonical and not pending. The newer one closes into the older with `store.supersede(..., "merge")`. When the vector search finds nothing, an older live capture with exactly the same name and a word overlap of 0.85 is the fallback. A cursor in `meta.merge_cursor` keeps the place, oldest first, and is cleared when a sweep ends. | measured from the candidates before it, 10 until one is measured |
| `probation` | Captures only. A recalled one whose `probation_until` is in the past loses it. Never recalled and 60 days old (or more) goes to the trash. Type project with no recall for 90 days (`last_recalled_at`, else `created_at`) goes to the trash. Explicit, profile, person, system, import, pinned and canonical memories are never retired. Versions are written with the reasons `retire_never_recalled` and `retire_idle_project`. | 3 per retirement |
| `purge_old` | Counters, audit rows and recall log rows older than 90 days, and the last doctor probe vector. | 4 |
| `token` | Days left on `ACCESS_TOKEN_EXPIRES`. | 0 |

The two subject steps run before `merge`, in the order `cluster`, `briefs`, `merge`, because merge keeps going until the shared subrequest budget is gone. A step placed after merge could find the budget already gone.

Ending probation only sets a column, like `kind`, so it writes no version and does not touch `updated_at`.
Retirements go through `store.softDelete`, so they keep a version and the memory can be restored for 14 days.

## Export format v2 and import

`GET /export` (admin or browser) returns `{ok, format: 2, created_at, schema_version, total, offset, next_offset, entries, versions,
questions, links, link_rejections, devices}`. `entries` are the raw `memories` columns plus `tags`, trashed and closed memories included, ordered by
`created_at, id`. `versions` are `{memory_id, seq, snapshot, reason, created_at}` with the snapshot text as stored. `questions` are
the model written question keys, also those of trashed memories (they cost model calls to rebuild). `links` (`source_id, target_id, link_type, created_at, made_by, confidence`), `link_rejections` (`source_id, target_id, link_type, created_at`) and `devices` (`id, label, token_hash, created_at,
last_used_at, revoked_at`, hash only, never a token) come with the last page. Without `limit` everything is returned up to
3,000 entries, above that the reply is 413 `export_too_large` and says to page with `offset` and `limit` (up to 1,000). A page can also
start at `cursor=start` (or at a `cursor` from an earlier page's `next_cursor`), and then the reply gives `next_cursor`, not
`next_offset`. A cursor is the `created_at` and `id` of the page's last memory, so a purge between pages cannot shift a page. Offset
paging still works, and a purge between its pages moves rows. The nightly backup reads the same document in pieces (`exportText`).

`POST /import` (admin only) takes a v2 document with `offset` and `limit` (up to 200). A body without `format: 2` is the old Worker's
shape and takes the v1 path unchanged. Per memory one D1 batch writes the row, tags, versions, questions and the FTS row, so a
memory is stored whole or not at all. An id that exists is skipped whole, which makes a second import change nothing. The reply is
`{ok, format: 2, imported, skipped, versions, questions, links, link_rejections, devices, errors, next_offset, remaining}`. Links, link rejections and devices go in
with the page that reaches the end of `entries`. A link without `made_by` or `confidence`, and a document without `link_rejections`, are from an older backup and take the defaults (a user link, no confidence, no rejections). A `made_by` other than `user` or `system` is 400. A device with a `token` field, or a `token_hash` that is not 64 hex characters, is
refused. Search keys and vectors are not in the format: after the last page call `/admin/reindex` until `remaining` is 0.
The body limit is 10 MB, so a larger export is cut into several documents (entries and their versions together, links, link rejections and devices
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
