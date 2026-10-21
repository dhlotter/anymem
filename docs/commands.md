# Commands

The client is a set of short scripts in `skills/anymem/scripts/`, one per job. They use only the Python standard library. Run one with `python3 SKILL_DIR/scripts/NAME.py`, where `SKILL_DIR` is `skills/anymem` in a clone and `${CLAUDE_SKILL_DIR}` inside Claude Code. Each answers `--help`.

Each script is a few lines that call `hm.skill.launch("name")`. The work lives in `client/hm/commands/NAME.py`. The scripts call the Worker's REST routes directly. Nothing is built from a Worker reply, and there is no MCP.

Output goes to standard out and one line of trouble goes to standard error. Exit 0 is success. Exit 1 is a failure, such as no configuration, an HTTP error or no network. Exit 2 means the input was refused before it was sent or by the Worker, such as a secret in the text, a blocked topic or a missing argument. A memory id can be its first 8 characters.

**The audit log.** Every call is noted in `~/.cache/anymem/audit.log`, one JSON line with the time, harness, script or hook, session, method, route without its query string, memory ids, HTTP status and milliseconds. It never holds text, a prompt, a token or a header. It is mode 0600. At 512 KB the old file is kept once as `audit.log.1`, so the log never passes about twice that. Each call also carries the `X-Anymem-Harness` and `X-Anymem-Script` headers, so the Worker's own audit table says who asked. The harness is the `ANYMEM_HARNESS` variable, else the note a hook left in the cache folder (`harness-hint.json`, valid for 4 hours), else blank. The recall hook also keeps a word per decision in `recall-outcomes-NAME.log` (injected, quiet or failed, no text) until a request carries the totals to the Worker in an `X-Anymem-Outcomes` header.

**Credentials** from a `credential_command` are cached per session for 900 seconds by default (`ANYMEM_CRED_TTL`), so a script does not run your secrets manager or the command every time. See [install](install.md#where-each-value-comes-from).

**The Worker address** can live in the same place as the token. If the secrets that your `credential_command` prints include `ANYMEM_URL`, the client uses it as the address, ahead of the `url` in `config.json`. Keep it next to the token in your secrets manager and a changed hostname is one edit there, not one per machine. The `ANYMEM_URL` environment variable still wins over both.

| Script | Job |
|---|---|
| `recall.py` | search, best match first |
| `remember.py` | save one memory |
| `get.py`, `list.py`, `history.py` | read one memory, browse, show its changes |
| `append.py`, `update.py`, `status.py` | change a memory |
| `forget.py`, `restore.py`, `undo.py` | trash, bring back, revert |
| `link.py`, `unlink.py`, `links.py` | link two memories, remove a link, list a memory's links |
| `subject.py` | the things memories are about: list, show, add and change subjects. `accept` and `dismiss` decide a proposed subject and are the person's to run |
| `profile.py`, `person.py` | the person's own facts, and the people they talk about |
| `usage.py` | what memory adds to prompts |
| `backup.py` | a local copy of the store |
| `resave.py` | retry captures that failed to save |
| `devices.py` | device tokens |
| `doctor.py` | check the setup |
| `setup.py`, `connect.py`, `install.py`, `init.py`, `uninstall.py` | the installer |

## Memory scripts

### recall.py

```
recall.py QUERY [--limit N] [--all] [--json]
```

Search, best match first. `--limit` is 1 to 50 and defaults to 5. In a project it sends `scope=project:SLUG`, which the Worker answers with that project plus the global memories. `--all` searches everything. It sends `count=1`, so a recall counts toward probation. A hit the Worker marks not `relevant` prints as `(weak match)`. A `degraded` reply says search was weaker than usual. When the Worker's reply carries `subjects` (its `SUBJECTS` variable is on), each card prints above the memories as one `<memory>` line, `[card] NAME (KIND)` and then the brief on one line, at most 1200 characters a card and 1800 for all of them, and only when a relevant result it was reached through is in the list. A reply without `subjects` prints exactly the memories. See [recall](recall.md).

### remember.py

```
remember.py [CONTENT] [--tag TAG] [--project NAME|global]
```

Saves one memory through `POST /capture` with `source` set to `claude`, so it is stored with origin `explicit`. Text comes from the argument or standard input, and `-` reads standard input. `<private>` text is removed first. Text that looks like a secret is refused before anything is sent (exit 2). The project defaults to the current repo, and `global` means none.

The reply says one of these.

1. `saved ID`, with `updated in place` when a memory of the same name and origin was updated.
2. `already stored as ID`, an exact or near copy (0.95 similarity or more) was refused.
3. `warning, similar to ID`. It was saved, and a close memory exists.
4. `It replaces memory ID`. The new memory clearly contradicts that one, which is now closed history. `undo.py ID` brings it back.
5. `Both stay live`, with the older id and a reason (`pinned`, `too_long` or `unsure`).

A Worker refusal (HTTP 422) exits 2 with the reason. A rate limit (40 writes per 10 minutes) exits 1 and says how many seconds to wait.

### get.py, list.py, history.py

```
get.py ID [--version N] [--deleted] [--json]
list.py [--tag T]... [--status S] [--origin O] [--type T] [--project P] [--days N] [--max-recalls N] [--deleted] [-n N] [--json]
history.py ID [--json]
```

`get.py` prints one memory in full, a past state with `--version`, a trashed one with `--deleted`. `list.py` is newest first, `-n` defaults to 20 and goes up to 500, and `--deleted` shows the trash of the last 14 days. Origins are `explicit`, `capture`, `profile`, `person`, `system` and `import`. `history.py` prints one line per change, newest first.

### append.py, update.py, status.py, forget.py, restore.py, undo.py, link.py, unlink.py

```
append.py ID [TEXT]
update.py ID [CONTENT] [--tag T]... [--if-updated-at MS]
status.py ID canonical|active|deprecated|pending
forget.py ID
restore.py ID
undo.py ID
link.py SOURCE TARGET [TYPE]
unlink.py SOURCE TARGET TYPE
```

Each is one Worker call. `forget.py` moves a memory to the trash for 14 days and `restore.py` brings it back in that time. `undo.py` reverts the last change, again to go forward, and reopens a memory a newer one replaced. `update.py` with `--tag` replaces the whole tag list, and `--if-updated-at` refuses the write when the memory changed since. `link.py` makes an explicit link. The type is one of `about`, `part_of`, `owns`, `affects`, `decided`, `contradicts`, `about_person` and `related`, and defaults to `related`. `--type TYPE` works too. Another word is refused with the list, and so are `supersedes` and `derived_from`, which only the system writes. `unlink.py` removes one link and prints `removed` or `no such link`. When the link was made by the system it is also remembered, so the system never makes it again, and a device token may not remove one (use the admin token or the dashboard). `draft` is not a status.

### links.py

```
links.py ID [--json]
```

One line per link, grouped by type: `type  out|in  other_id  other_name`. `out` means this memory is the source, `in` means it is the target. Memories in the trash are not listed. A type outside the list, left by an older version, shows as `related`. `no links` when there are none.

### subject.py

```
subject.py list [--kind KIND] [--status STATUS]
subject.py show SLUG
subject.py add KIND SLUG NAME [--brief TEXT | --brief-file PATH]
subject.py set SLUG FIELD VALUE
subject.py alias SLUG NAME
subject.py scope SLUG shared|private
subject.py retire SLUG
subject.py accept SLUG
subject.py dismiss SLUG
```

A subject is a thing memories are about. Its card is an ordinary memory that holds a short brief, plus a row with a kind, a status, a scope, fields and aliases. The Worker writes the card, so there is no script that writes one by hand. A memory is a member of a subject when a link of type `about` runs from the memory to the card (`link.py MEMORY CARD_ID about`). The kinds are `person`, `pet`, `asset`, `project`, `area` and `topic`.

| Action | Meaning |
|---|---|
| `list` | One line per subject: `slug  kind  status  scope  N members  name`. `--kind` and `--status` filter, and the status is `proposed`, `active`, `stale` or `retired`. `no subjects` when there are none. Retired subjects are listed too |
| `show SLUG` | The slug, kind, status, scope and name, then the card id, the aliases, one `field: value` line per field, the brief, and the members (memory id and name), newest first |
| `add KIND SLUG NAME` | Makes an active subject. The slug is 2 to 40 characters, lowercase letters and digits with single dashes. The name is up to 80 characters. The brief comes from `--brief`, or from `--brief-file`, where `-` reads standard input. Text between `<private>` tags is removed, and a brief that looks like it holds a secret is refused (exit 2) before anything is sent |
| `set SLUG FIELD VALUE` | Sets one field. An empty VALUE removes it. The allowed fields depend on the kind (person: `relationship`, `known_as`, `work`, `contact`, `birthday`. pet: `name`, `species`, `breed`, `born`, `vet`, `status`, `health_note`. asset: `type`, `name`, `identifier`, `acquired`, `status`, `value_note`. project: `what`, `status`, `owner`, `repo`. area: `what`, `status`. topic: `what`). The Worker refuses any other field, and a value is up to 200 characters |
| `alias SLUG NAME` | Adds another name the subject goes by, stored in lowercase |
| `scope SLUG shared\|private` | A private subject, its card and the memories only about it are hidden from a device token whose device is set off with `devices.py allow-private`. Only the admin token or a browser login may change a scope |
| `retire SLUG` | Marks the subject retired. Nothing is deleted |
| `accept SLUG` | The person's click on a proposed subject. It becomes active, its card memory becomes active, and recall can offer it. It prints `accepted SLUG`. Any other status is refused by the Worker, 409 `not_proposed` |
| `dismiss SLUG` | The person's click that turns a proposed subject down. It is retired, nothing is deleted, and the slug stays taken so the same proposal does not come back. It prints `dismissed SLUG` |

The system can propose a subject on its own when `SUBJECTS_AUTO` is on (and write briefs when `SUBJECTS_BRIEFS` is on too), and `list --status proposed` shows what waits. `accept` and `dismiss` are for the person to run in their own terminal, never for an agent. See [subjects](subjects.md). Only the admin token and a browser login may write a card, so with a device token every change except reading is refused by the Worker with one plain line (exit 1). `list` and `show` work with a device token, and leave out a private subject the device may not see. See [recall](recall.md) for how a card reaches a prompt.

### backup.py

```
backup.py [--dir DIR] [--keep DAYS] [--markdown DIR] [--from-worker [--now]] [--quiet]
```

A copy on this machine, outside Cloudflare. See [backups and restore](backups.md).

### resave.py

```
resave.py [--dry-run]
```

Retries automatic captures that failed to save while the Worker was unreachable. `doctor.py` lists them. A capture a screen refuses is dropped and the rest stay until they save.

### devices.py

Lists, adds and revokes per device tokens. It needs the admin token.

```
devices.py list
devices.py add LABEL [--share]
devices.py revoke ID
devices.py allow-private ID on|off
```

| Action | Meaning |
|---|---|
| `list` | Every device that is not revoked, with id, label, created and last used |
| `add LABEL` | Creates a device token and shows it once. The label is at most 64 characters. With `--share` it prints one connection string for `connect.py` on the new machine. Treat it like a password |
| `revoke ID` | Stops that token at the next request. A unique prefix of the id is enough. The Access pair in the connection strings is shared, so it is not revoked by this (see `setup --rotate-access`) |
| `allow-private ID on\|off` | Lets a device see private subjects, or keeps them from it. A device starts on. A device set off never sees a private subject, its card, or a memory that is only about private subjects. `list` marks such a device with `private subjects off`. The admin token only, the person runs it and an agent never does |

### profile.py

```
profile.py [show]
profile.py get FIELD
profile.py set FIELD VALUE [--derived-from WHAT]
profile.py confirm FIELD
profile.py unset FIELD
profile.py pending
profile.py accept FIELD
profile.py dismiss FIELD
```

The one memory that holds facts specific to you. Fields are `name`, `preferred-name`, `last-name`, `email`, `phone`, `address`, `postal-address`, `work`, `work-address`, `language`, `timezone` and `units`. See [profile and people](profile-design.md).

### person.py

```
person.py [list]
person.py show NAME
person.py set NAME FIELD VALUE [--derived-from WHAT]
person.py confirm NAME FIELD
person.py forget NAME
```

One small memory per person you talk about. Fields are `relationship`, `name`, `last-name`, `known-as`, `email`, `phone`, `work`, `birthday`, `language`, `contact-preference` and `note`. A person needs a relationship first. See [profile and people](profile-design.md).

### usage.py

```
usage.py [--days N]
```

What memory adds to your prompts, from this machine's own record, over 7 days by default. The session start and recall hooks note how many characters they added, how many memories, and how similar those were. `usage.py` reports tokens per session start and per prompt (about, at four characters each), and how often a prompt got anything at all. It cannot say whether an injected memory helped. Only counts go in `injection.log` in the cache folder, never prompt or memory text. One machine only.

### doctor.py

```
doctor.py [--probe] [--json]
```

One line per check, then a verdict. Exit 0 when no check failed, warnings allowed, and 1 when any failed.

| Check | What it looks at |
|---|---|
| config | address and token set, where each came from, no character that cannot go in a header |
| reachable | `GET /health`, the Worker version, the schema version and whether the vector index has 384 dimensions |
| auth | `GET /count` accepts the token |
| capsule | the core capsule answers and has content |
| unsaved | captures waiting in `failed.jsonl` |
| capsule cache | how old the cached capsule is |
| plugin copies | whether the installed Claude Code and Codex copies match the repo |
| prerequisites | Python version, whether the `claude` command exists |
| usage | counts from `GET /stats` (admin token), today's capture numbers and the last nightly job |
| backup | the latest nightly backup, a warning when it is over 2 days old or the bucket is missing |
| subjects | `3 active, 1 proposed, 0 stale, 0 private, auto on, briefs off` from `GET /subjects`. Proposed subjects wait for your click, and a stale subject has a brief that failed a check, whose memories changed, or that the model could not build 3 nights in a row. The last part says whether the system acts on subjects by itself, from the switches in `GET /stats` (admin token). It reads `auto off` when `SUBJECTS_AUTO` is not on, `auto on, briefs on` or `auto on, briefs off` for the third switch, `SUBJECTS_BRIEFS`, and `auto set but SUBJECTS is off, so it does nothing` when only the automation switch is set. A Worker that does not report the switches gets the counts and nothing more. No line at all when the Worker does not answer `GET /subjects` |
| vector | with `--probe`, whether a probe vector is found through the metadata filter, waiting up to 3 minutes |

`--json` prints the checks and the verdict as one object. The probe writes one vector and no memory, and waits up to 3 minutes.

## Checks the hooks run

These two are command modules with no skill script. The capture hook runs the recall check about once a month. Run either by hand with the test launcher, which is not a product entry point.

```
python3 client/tests/run_command.py recall_check [--quiet] [--reset-baseline]
python3 client/tests/run_command.py capsule_check [--json]
```

**recall check.** Samples 40 active memories, searches for each by its own name and description, and reports how often it comes back first and in the top five. The first run is the baseline. It warns when the top five rate falls more than 0.08 below the baseline or under 0.80, and the session start then prints the warning. The searches use `count=0`, so they do not count as recalls.

**capsule check.** Read only. For each line of the always on capsule it searches memory for the same subject, keeps what was saved or edited after that section last changed, and asks the `claude` command one question, whether a newer memory shows the line is no longer right. Only a clear answer that names a memory it was shown is listed, and nothing is rewritten. It only sees what search finds, so a clean result is not proof that every line is current.

## Installer scripts

### setup.py

Creates Anymem in your Cloudflare account. Safe to rerun, never deletes anything. Flags and steps are in [install](install.md#setup).

```
setup.py [--name NAME] [--domain DOMAIN] [--subdomain NAME] [--access --email EMAIL | --no-access] [--plan free|paid]
         [--account-id ID] [--rotate-access] [--second-machine] [--scopes] [--dry-run] [--yes]
```

Exit 0 when set up, or on a dry run. Exit 1 on a bad option, a declined confirmation or a failed step.

### connect.py

Points this machine at an existing Worker. It checks the token before it saves anything.

```
connect.py [--token-file FILE] [--access-client-id ID] [--access-client-secret-file FILE] [url]
pbpaste | connect.py
```

`url` is the Worker address. A connection string starting `hm1.` is read from standard input or asked for without echo, never taken from the command line. The token and the Access secret come from `--token-file` and `--access-client-secret-file` (the first line of each file), standard input or a hidden prompt, never from a flag that takes the value. Give both Access values or neither. Exit 0 when connected and saved, 1 otherwise, and nothing is saved.

### install.py

Installs, checks or uninstalls a harness adapter.

```
install.py [--list] [--all] [--check] [--uninstall] [--new] [--dry-run] [--yes] [NAME]
```

| Flag | Meaning |
|---|---|
| `NAME` | Adapter name, see `--list` |
| `--list` | Every adapter with its detect result |
| `--all` | Install into every adapter whose detect says found |
| `--check` | Run the check for NAME, or for every found adapter |
| `--uninstall` | Remove NAME's own entries and prove it with the check |
| `--new` | Write a starter adapter for NAME in `~/.config/anymem/adapters/` |
| `--dry-run` | Print the plan and write nothing |
| `--yes` | Skip the confirmation question |

Adapters are found by importing `adapter.py` from the repo's `adapters/` folder and from `~/.config/anymem/adapters/`. Claude Code does not use `install`, its hooks come with the plugin.

### init.py

The first run in one command, see [install](install.md#the-short-way).

### uninstall.py

```
uninstall.py [--delete-resources] [--include-backups] [--yes]
```

With no flags it lists what setup created. With `--delete-resources` it deletes the Worker, the Access application and service token, the Vectorize index and the D1 database, in that order, after you type `delete`. `--include-backups` also deletes the R2 bucket, which must be empty. Deleting removes every memory in them. Exit 0 on success or when there is nothing to remove. Exit 1 when you decline or a deletion fails, and a rerun continues.
