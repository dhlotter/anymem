# Changelog

## [2.0.7] 2026-10-20

People fold into Subjects. A person is a subject of kind person, so the People screen no longer lists them.

1. **Dashboard.** The People screen is now Profile, with your own facts and the changes waiting for you. The people you talk about are on the Subjects screen, filter Kind to person. The address `#/people` still works.
2. **Existing people.** Run `scripts/subjects-from-people.mjs` (dry run first) to make a subject for each saved person memory.

## [2.0.6] 2026-10-20

Subjects, made by hand. A subject is a thing memories are about, a person, a pet, an asset, a project, an area or a topic. It has a card (a memory holding a short brief), fields, aliases and a scope. Nothing files memories under a subject by itself yet, you link a memory to a card with an `about` link. Migration 0006.

1. **Routes and scripts.** `POST /subject`, `POST /subject/update`, `GET /subjects` and `GET /subject`, and the `subject.py` script (list, show, add, set, alias, scope, retire). Only the admin token and a browser login can create or change a card, and a person subject can never hold health or money fields.
2. **Private subjects.** A subject can be private. A device token whose device has `allow_private` off never sees a private subject, its card, or a memory whose only `about` links go to private subjects, on recall, list, entry, history and links. `devices.py allow-private ID on|off` sets the flag, and it is yours to run, not the agent's.
3. **Recall.** With the Worker setting `SUBJECTS` on, a recall that finds a relevant memory of a subject also returns its card, and the hook prints it above the memories. `GET /recall?subject=SLUG` lists a subject's members. With `SUBJECTS` off, which is the default, nothing about recall changes.
4. **Dashboard.** A Subjects screen with a table, a card drawer, a New subject form, and a Subjects row on the memory drawer.
5. **Hardened by an independent review.** A device token cannot write to a memory it may not see, change a subject card, or link to one. A capture from a device cannot probe a hidden memory. The list, the count and the people list leave hidden memories out for a device, and the trash purge keeps the card of a private subject that still has members.
6. **Backup.** Export and import carry subjects and each device's `allow_private`. A script, `scripts/subjects-from-people.mjs`, turns the saved people memories into person subjects (a dry run unless you pass `--apply`).

## [2.0.5] 2026-10-20

Links between memories get a closed list of types, a record of who made each link, and a way to take one back. This is the first step toward grouping memories by subject, and nothing recalls or ranks by a link yet.

1. **Types.** A link is `about`, `part_of`, `owns`, `affects`, `decided`, `supersedes`, `contradicts`, `derived_from`, `about_person` or `related`. A type outside the list is refused with the list in the message, and `supersedes` and `derived_from` are written by the system only. Links with any other text, made before this version, are kept and shown as `related`. Migration 0005.
2. **Unlink.** `POST /unlink` removes a link. When the system made it, the removal is remembered so the system does not make that link again. A device token can remove only links a person made, and no device can add or remove a link on a memory that holds capsule tags or the canonical status.
3. **Reading links.** `GET /links?id=` lists the links of a memory, both directions, grouped by type in the scripts. New scripts `unlink.py` and `links.py`, and `link.py` checks the type before it sends.
4. **Dashboard.** The memory drawer shows its links grouped by type, with add, remove, and a "Not this" button on a link the system made.
5. **Backup.** Export and import carry who made a link, how sure the system was, and the removed links. An older backup still imports.

## [2.0.4] 2026-10-20

The nightly job's limits are settings now. They were fixed at the Free plan's 40 subrequests and 20 seconds a step, so on a Paid store the backup took 17 of the 40 and the reindex got a handful of memories a night while the merge step got none. `NIGHTLY_SUBREQUESTS` and `NIGHTLY_WALL_MS` set them, the defaults are unchanged, and `setup.py` sets 400 and 120 seconds when the plan is Paid. A store that already runs needs the two settings added to the Worker, or a rerun of `setup.py --plan paid`.

## [Unreleased]

Preparation for a public repository. The benchmark sets that came from a private store are now small placeholder seeds with made up names, and the real ones live in gitignored `bench/sets/NAME.local.json` files, which a default run reads first. A default benchmark run skips any set that is still a seed. Real ticket ids, a person's name and an employer's ticket prefix are gone from the examples in docs and tests, and the shipped files check now fails on the owner's surname outside the license and on the names that used to sit in tests.

## [2.0.3] 2026-10-19

The medium and low findings of the repo review, 125 of them, and the new defects the first fix wave found. Migration 0004 adds an index for the Activity page.

1. **Setup.** `setup --rotate-access` replaces the shared Access service token. A rerun keeps the Access app it recorded and refuses an unrecorded app of the same name instead of adopting it. The second machine device is made only when you ask for it. Worker readiness waits on the Worker's own `/health` answer and no longer follows a redirect. The token guidance asks for fewer permissions. A restored backup brings devices back revoked unless you name them.
2. **Worker.** `/update` and `/append` run the secret screen. `/extract` and `/recall` take a rate slot per device token. A contradiction never replaces a canonical memory, and a same name capture only updates a memory of its own project. The nightly merge examines more candidates inside its budget. The backup streams to R2 in parts and allows for what the trash purge deleted. An export pages by a key cursor, so a purge between pages skips nothing. The sensitivity check reads the whole text. The certificate fetch is limited to one a minute.
3. **Client and hooks.** The client refuses redirects and plain http to anything but localhost, and refuses `--token` and `--access-client-secret` on the command line (use the `-file` forms). A failed credential command is remembered for a minute. Failed captures that the Worker refuses are dropped and a rate limit keeps the rest. Project names are slugged before they are sent. Interpreters in the hook commands come from one rule.
4. **Adapters.** DSH, Kilo, agy and ZCode share one gate for the capture switches. Kilo files messages under the session id and ignores subagent sessions. ZCode rotates a session file past 4 MB. Uninstall for agy, DSH and ZCode removes only what install created.
5. **Dashboard.** The drawer is a modal dialog with focus held inside it. Stale answers no longer overwrite newer ones on Audit, Trash, Activity and Memories. Activity filters run in SQL. Most used ranks per tool. Capsule and trash figures come from the Worker. Dashboard files answer a conditional request with 304.
6. **Tests and docs.** Many tests now fail when the code they guard is removed, the suite runs faster, and the docs match the code on the probe, limits, the Codex upgrade path, capture settings and error codes.

## [2.0.2] 2026-10-19

A review of the whole repo, and the 34 critical and high findings fixed.

1. **Setup.** The Access service token name was written with a doubled suffix, so a fresh install behind Access refused every machine request. A rerun of setup now keeps Access and the custom domain the store recorded, and `--no-access` is the only way to drop Access. The token secret is saved the moment Cloudflare shows it, and Access policies follow a recreated token or a changed email.
2. **The Worker.** Every write route takes a write slot for device tokens, not only `/capture`. A device token can no longer write capsule tags, canonical status or the profile, person, system and import origins, and can no longer update, append to, undo or forget a memory that already holds them, or reach one through a same name capture. A contradiction never replaces a canonical memory. Duplicate and contradiction checks stay within one project. The nightly job shares one subrequest budget for the whole run, an AI outage no longer marks memories as having no questions, and an imported id that Vectorize would refuse is refused at import.
3. **Capture and hooks.** Extraction runs from a private folder with no settings loaded, not from /tmp. Session start has one deadline and always prints the capsule. Claude's compaction summary is no longer read as your words. The Kilo plugin keeps no text when capture is off.
4. **The dashboard.** The pending count, Search scope, Never recalled and the Undo the undo button now do what their text says.
5. **Repo.** The shipped files check reads every tracked file, the personal benchmark prompts are untracked, and the secret scan allowlist is pinned.

## [2.0.1] 2026-10-18

The dashboard shows which tool saved and recalled each memory, with a per tool quiet rate. The hooks send the harness name and what they did with each recall, and the Worker keeps a 90 day recall log (migration 0003). The skill scripts now name their own tool instead of calling every save Claude Code. Raising the version is what makes Claude Code and Codex replace their old copies of the hooks.

## [2.0.0] 2026-10-18

Anymem now runs on a Worker of its own, written for this project, and the client has been cut down to match. It is a rewrite, and nothing from version 1 is read under its old name. The plugin says 2.0.0.

### Changed

1. **A new Worker.** Plain JavaScript modules in `worker/`, no dependencies, no bundler, no build step. It replaces the earlier Worker. It answers REST routes only. The `/mcp` endpoint, OAuth and the KV namespace are gone.
2. **Scripts instead of a command line tool.** `bin/anymem` and the commands it built from the server's tool list are gone. The skill ships one fixed Python script per job in `skills/anymem/scripts/`, and every call is noted in a local audit log.
3. **Recall is rebuilt.** It searches by meaning and by keyword, merges the two, and scores relevance with a reranker. The Worker now says per hit whether it is `relevant`, and the hook injects only those. Memories carry a project, and a recall inside a project sees that project plus the global memories. Only a relevant hit that was asked for with `count=1` counts as a recall. On a copy of the author's store the benchmark score went from 0.69 to 0.853 and the share of prompts that should inject nothing but did fell from about half to one in ten. A recall takes about 1.3 seconds instead of about 3. Bare identifier prompts are slightly worse at being injected, 16 of 20 against 17 of 20.
4. **No drafts and no review.** A capture is saved active. `promote`, `reject`, `review`, `tidy` and the `capture_drafts` setting are gone, and a `status:draft` tag is refused. The status `pending` remains, for a profile change that waits for you.
5. **The Worker settles contradictions and duplicates when it writes.** An exact copy is refused, a near copy is refused or flagged, a capture with the name of an earlier capture updates it in place, and a memory that clearly contradicts an older one closes that one as history when two separate model answers agree and quote the clash. Otherwise both stay and the reply says why. `undo` reopens a replaced memory.
6. **Capture saves what your agent did not.** The skill now tells the agent to save at corrections, decisions, preferences and outside locations, as it goes. At the end of a session the capture hook lists what the agent saved and asks its model only for what is missing. It uses Haiku through the `claude` command when that exists, and the Worker's extractor when it does not. The Worker's extractor returns at most 2 memories and nothing for a thin session.
7. **Probation and a nightly merge for captures.** A capture never recalled in 60 days goes to the trash, where you can restore it for 14 days. A project note idle for 90 days goes the same way. Near duplicate captures from the last 14 days are merged overnight when they reach 0.90 similarity and share 0.45 of their words.
8. **The capsule reply is a flat list of sections.** Hooks read `sections`, one per memory.
9. **A dashboard.** Served by the Worker to a browser login behind Cloudflare Access, with a left sidebar and light and dark themes. Home with a status line and the week in numbers, search that shows the exact text the hook would add and why each hit counted, memories with a side panel and a diff of each change, what the system did on its own with an undo, trash, capsule, people, health and the audit trail filtered by harness.
10. **Backups and restore.** The Worker backs itself up to R2 every night at 01:00 UTC and keeps 30 days. `GET /export` and `POST /import` use one documented format. `backup.py` pulls a local copy.
11. **An audit trail on both sides.** Every call from a script or hook goes to `~/.cache/anymem/audit.log`, and every authenticated request to the Worker goes to its `audit` table for 90 days. Neither holds text or secrets.
12. **Setup is a Python installer** that talks to the Cloudflare API. No Node.js and no Wrangler. It creates the D1 database, the Vectorize index with its metadata indexes first, the R2 bucket, optionally Access, the Worker, its cron and its address, then proves recall with `doctor.py --probe`. It prints the plan limits and asks which plan you are on.
13. **Device tokens and Access.** Each machine can have its own revocable token, and a connection string moves it to another machine. The Worker checks the Access token itself and does not trust that Access ran.
14. **Docs rewritten** for all of the above.
15. **Dashboard security pass.** An optional `ALLOWED_HOSTS` setting makes the Worker refuse any other host name with a 404. Anonymous traffic and dashboard file loads write no audit row. A browser login cannot raise recall counts, and gets neither `/export` nor a downloaded backup with the device token hashes in it. Access signing keys expire from the cache after an hour, refused tokens get one generic reply, and JSON replies carry nosniff.
16. **The dashboard says where a memory came from.** Every memory row names the harness (Claude Code, Codex, Antigravity, DSH, Kilo, ZCode, or Imported or Unknown for a blank one). Memories can be filtered by harness, and its panel says who saved the memory and which tools were given it. Home shows where memories come from, recall activity by tool, and which memories each tool was given most. A new table, `recall_log` (migration 0003), keeps one short row per memory a counted recall returned for 90 days, with no query text.
17. **Every harness names itself.** A skill script run inside Codex, ZCode, Kilo, DSH or Antigravity used to be labelled Claude Code, because only Claude Code exported the harness name. Each adapter now claims its own name, hooks leave a note that scripts read, and a blank harness is blank, not Claude Code. `worker/harnesses.js` and `client/hm/harnesses.py` hold the one list, with a test that they match. `migration/harness_backfill.py` fills in blanks whose tags name a harness, through the new admin route `POST /admin/harness`.
18. **A real quiet rate.** The recall hook reports what it did with each prompt (injected, quiet or failed) in a header on its next request, and Home shows the quiet share over 7 and 30 days, or says no hook has reported yet.
19. **The capsule cap is 9,500 characters**, the size the session start hook cuts at, instead of 12,000.

### Removed

1. From the earlier version, digests and weekly insights, teams and invites, integrations and push, decision reviews, commitments and reminders, the inferred graph, the staleness pass, review quarantine, OAuth, the earlier dashboard and its desktop installer.
2. From our client, the `anymem` command and its generated commands, `_conflicts.py`, drafts mode, the merge and draft parts of `tidy`, the second recall in the recall annotation, the prose parsing in `sync`, and the MCP header helper.
3. `sync`, `grep`, `health` and `config` as commands.
4. The old Worker's source, tests, dashboard and desktop installer, the root build files, the developer scripts, three workflows and the planning notes. The Worker was rewritten.

### Known problems

1. Recall is short of the 0.80 hook hit bar on the holdout set (11 of 16) and on exact identifier prompts (16 of 20).
2. The Worker's extractor still proposes mostly junk, 71 percent of 21 memories on 30 real sessions. Haiku proposed 36 percent junk on the same sessions before this release.
3. A memory saved through `/capture` gets no question keys until `POST /admin/questions` runs again.
4. A store with a custom domain has no setup flag to go back to workers.dev.
5. Setup has not been run from a brand new Cloudflare account, and its Access and custom domain steps have not been run against real Cloudflare.

### Moving from version 1

See [docs/migration.md](docs/migration.md). The data moves with the scripts in `migration/`, and the old store is only read. Trash items arrive as previews, history changes that rewrote content are not carried, and device tokens have to be made again.

## Before 2.0.0

Everything below is the history of version 1, kept for the record. It describes MCP tools, drafts, teams and other things that no longer exist. The release notes for 4.0.0 and older were removed with the old Worker's code, and stay in git history.

## [Unreleased]

### Changed
- **Breaking:** the product is now called Anymem, and every name follows it, with no aliases. The command is `anymem` (and `anymem-backup`), the plugin and marketplace are `anymem`, the skill and slash commands are `anymem`, the environment variables are `ANYMEM_*`, the config and cache folders are `~/.config/anymem` and `~/.cache/anymem`, the setup state folder is `.anymem/`, the harness hook entries are keyed `anymem`, and the default resource names `setup` creates are `anymem`, `anymem-db`, `anymem-vectors`, `anymem-oauth` and `anymem-backups`. The old names are not read. An install under the old name must be removed first, see Upgrading in `docs/install.md`. The R2 object keys of existing backups keep the old `backups/harness-memory-` prefix until the bucket itself moves, because renaming it would hide every existing backup from the list.
- `doctor --probe` no longer writes a memory. The Worker has a `/vectorize-probe` route that writes one vector under a fresh id in a reserved workspace and deletes the previous run's, and the doctor polls it for up to 3 minutes until it comes back through the same workspace filter recall uses. Nothing is trashed, so repeated runs and other devices cannot block each other. A probe that finds the vector only without the filter names the missing metadata index and fails. A probe that finds it nowhere is a warning, because Vectorize indexing takes from seconds to a couple of minutes. A Worker without the route still gets the older memory probe.

### Fixed
- Plugin 1.0.18 (client only, no Worker change). The prompt hook now has `import time`, so the people lines appear again. It skips harness generated prompts such as task notifications, and stops itself at one 8 second deadline (`ANYMEM_HOOK_DEADLINE`) instead of running past its 9 second limit. Capture, tidy and doctor lookups send `count=0`, so only a real prompt recall counts toward retirement. `anymem resave` saves active and keeps the `captured-by:` and `session:` tags. A failed capture now records its tags so that works. `bench/` can score a `real` set, with quiet rows.
- An explicit `remember` that contradicts a canonical memory is no longer held as a draft for two days. It now replaces the old memory when two separate answers agree that it breaks it, and each names one sentence from each memory that cannot both be followed. The old memory is kept as history and `undo` reopens it. A memory kept through its own command (capsule, profile, person), a long memory, or any unsure answer keeps both live, and the reply says so. Automatic captures are unchanged.
- A memory in the trash no longer blocks writing the same text again. The duplicate check used to match the trashed memory's vector (the trash keeps it for restore) and refuse the new write as "Near-exact duplicate", pointing at a memory that could no longer be opened. It now ignores matches that are in the trash.

### Added
- The `credential_command` result is cached for 15 minutes in `~/.cache/anymem/credentials/`, mode 0600 in a 0700 folder, so a hook no longer runs it on every call. `ANYMEM_CRED_TTL` changes the window and `0` turns it off. See the security note in `docs/security.md`.
- Nightly backup to R2. The Worker writes its own export to the `BACKUP_BUCKET` bucket every night as the last step of the maintenance run, keeps 30 days and refuses a much smaller export. `GET /backup`, `GET /backup/<date>` and `POST /backup/run` (admin). `harness-memory setup` creates the bucket, `uninstall` keeps it, `doctor` reports the latest backup, and `harness-memory-backup --from-worker [--now]` pulls a copy to a local folder.
