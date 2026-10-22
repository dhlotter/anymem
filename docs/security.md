# Security and audit

This page says what protects your memories, what an automatic capture can and cannot do, what the audit trail records, and what is not protected. The threat model names its own gaps.

## The two locks

1. **Cloudflare Access, recommended.** Every request passes the Access application first. Machines use a service token. A browser uses a login for an email on the allow list.
2. **A bearer token.** A machine must also send `Authorization: Bearer TOKEN`. That is the admin token (the `AUTH_TOKEN` secret) or a device token. A browser login needs no bearer, and only works on the routes the dashboard uses.

Setup generates the admin token itself (32 random bytes, url safe base64), sends it to Cloudflare as the Worker secret on the API call, and writes it to your client config. It never goes in a command line argument and is never printed. The config folder is created with mode 0700 and `config.json` with mode 0600.

### What the Worker checks itself

With `REQUIRE_ACCESS` true, which is the default, the Worker does not trust that Access ran. It verifies the `Cf-Access-Jwt-Assertion` header with WebCrypto.

1. RS256 signature against the team's signing keys from `https://TEAM/cdn-cgi/access/certs`, kept in memory for at most an hour, so a key Cloudflare retires stops being trusted. An unknown key id triggers one refetch, never more than one a minute. If the keys are older than an hour and cannot be fetched, the request fails closed with a 503.
2. The issuer, the audience, the expiry and the not before time, with 30 seconds of leeway.
3. A service token JWT carries a `common_name` and no email. The name must be in `ACCESS_SERVICE_COMMON_NAMES`. The request then goes on to the bearer check.
4. A browser JWT carries an email. It must be in `ACCESS_ALLOWED_EMAILS`. The request then counts as admin, on a read route or a dashboard write route only. Any other route answers 403 `browser_not_allowed`.
5. The bearer is compared as a SHA-256 hash in constant time, against the admin token and against every device hash where `revoked_at` is empty. A device token on an admin route is a 403. A device token also cannot save an origin of `profile`, `person`, `system` or `import`, or set the `capsule:core` or `capsule-slot:*` tags or the `canonical` status, on `/capture`, `/update` or `/status`. That is a 403 `admin_only`. The admin token and a browser login can.

A bad setting stops every request with a 500 that says what is wrong. The Worker never falls back to open access. A refused Access token always gets the same 401 `invalid_access_token` text, whatever was wrong with it, and the exact reason goes only to the Worker log. Every JSON reply carries `x-content-type-options: nosniff`. A browser login gets `/export` and a downloaded backup (`/backup/<day>`) without the device `token_hash` values. The backup is unzipped, stripped and zipped again for it, and a bearer caller gets the stored bytes, because a restore needs the hashes. Errors are JSON, `{error, code}`, and the codes, with the fix for each, are in [troubleshooting](troubleshooting.md#the-workers-own-errors).

### Host name check

Access protects the hostname it is attached to. If the Worker is also reachable on another address, such as a workers.dev name, a request there never passes through the Access application, and the Worker can only check the token it is handed. So turn workers.dev off. As a second layer, set the optional `ALLOWED_HOSTS` variable to a comma list of host names, for example `memory.example.com`.

1. When it is set, a request whose host name is not in the list gets a plain 404. This happens before authentication and before any audit write, so a caller on the wrong address learns nothing and writes nothing.
2. When it is not set, nothing changes. The default workers.dev install keeps working.
3. A value with no usable host name, or one that holds a port or a scheme, is a 500 that names the setting. The Worker does not fall back to serving everything.
4. `setup.py` builds the Worker settings from the `vars` block of the committed `worker/wrangler.jsonc` (everything except the `ACCESS_*` values), so an `ALLOWED_HOSTS` entry there is carried on every setup run and every rerun. A value set by hand on the Worker only is not read back, because setup uploads its own list of settings and keeps just the `AUTH_TOKEN` secret from the old Worker. Put the value in the file, then check it after any rerun. This has not been run against real Cloudflare.

### Browser writes

A browser sends its login cookie on any request to the site, including one a hostile page triggers. So a dashboard write is accepted only when the `Origin` header is the Worker's own origin, `Sec-Fetch-Site` is `same-origin` when the browser sends it, and the `X-Anymem-UI` header is `1`. Through `/capture` a browser may only save profile and person notes. Devices, import, reindex, maintenance and backup runs are bearer only. The dashboard serves a Content Security Policy that allows nothing from another site. The page keeps one choice in the browser, the theme, and nothing else. It never stores a token or any memory text.

### Without Access

Without Access, `REQUIRE_ACCESS` is `false` and the bearer token is the only lock. The Worker answers on a workers.dev address, or on a custom domain if you gave one. Anyone who finds the address can try tokens, and nothing rate limits that except the long random token. The dashboard is unavailable, because it needs a browser login. Setup says so and recommends Access.

### What was measured through Access

On 2026-10-07, on the author's account and the old Worker, against a hostname with an Access application.

| What the request carried | Result |
|---|---|
| No credentials | 302, a redirect to the Access login |
| Bearer token only | 302 |
| Access service token only | 401, the Worker refuses it |
| Access service token and a wrong bearer token | 401 |
| Wrong Access secret | 302 |
| Both correct | 200 |
| The old workers.dev address, with or without credentials | 404 |

Access answers first. A 302 means Access did not let the request through. A 401 means Access let it through and the Worker's own check refused it. The v2 Worker has not been put through this table again. It has been called through Access with the service token many times in the benchmarks on the author's Worker. The browser login path of the dashboard has not been exercised on a real hostname, and the shape of a real browser JWT is untested.

### Service token expiry and rotation

A service token expires. Setup creates it with a one year life. Set `ACCESS_TOKEN_EXPIRES` on the Worker to the date (setup writes it) and the dashboard Health screen warns 30 days before. The nightly job also records the days left in its run summary. The doctor does not warn about it. Put the date in your calendar.

To rotate by hand, in this order.

1. Create a new service token in Zero Trust.
2. Add its client id, which already ends in `.access`, to `ACCESS_SERVICE_COMMON_NAMES` on the Worker. The setting takes a comma list, so both can be allowed during the switch.
3. Add the new token to the application's service token policy.
4. Put the new id and secret on every machine (`access_client_id`, `access_client_secret`, or wherever your `credential_command` reads them).
5. Remove the old token from the policy and from the setting, then delete it.

Setup does not rotate the token on its own. If you delete the service token and run setup again with `--access`, it makes a new token, points the machines policy at it, and updates the owner policy when `--email` changed. This has not been run against real Cloudflare.

## Device tokens

One shared token is a poor fit for several machines, so each machine gets its own.

1. `devices.py add LABEL` makes a token with the prefix `amd_` and 32 random bytes, and shows it once. The Worker stores only its SHA-256 hash.
2. `devices.py list` shows each device's id, label, creation time and last use.
3. `devices.py revoke ID` stops that token at the next request. Other devices are not affected.
4. A device token cannot reach the admin routes, so a compromised device cannot mint more tokens. Admin routes are `/stats`, the `/devices` routes, `/audit`, `/export`, `/import`, `/backup` and its run route, `/admin/*` and the dashboard routes that read the audit trail and the whole store, `/ui/api/overview`, `home`, `growth`, `recalls`, `probation`, `activity`, `runs`, `usage`, `audit-facets` and `harnesses`, and `POST /admin/harness`, which fills in the harness of a memory that has none and is refused for a device token and for a browser login.

Keep the admin token on one trusted machine and give every other machine a device token.

## The audit trail

Two logs, one on each side. Neither holds memory text, a prompt, a token or a query string.

**On your machine.** `~/.cache/anymem/audit.log`, mode 0600. One JSON line per Worker call from a script or a hook. It holds the time, harness, script or hook name, session, method, route, memory ids, HTTP status and milliseconds. At 512 KB the file is kept once as `audit.log.1`. The capture hook also reads it, to find which memories the agent saved itself this session.

**In the Worker.** The `audit` table in D1. A request that was authenticated writes one row after the reply has gone, so it never slows a reply, and a failed audit write never changes a reply. A row holds the time, the actor kind and id (`admin`, a device id, or `browser` with the email), the harness and script labels from the `X-Anymem-Harness` and `X-Anymem-Script` headers, the method, the route without its query string, the status, the duration, and up to 100 memory ids. A request with no valid login (a refused token, an unknown route, a wrong method, a host name that is not allowed) writes nothing, so anonymous traffic cannot fill the table. A successful load of a dashboard file writes nothing either, but the dashboard's own API calls do. Labels are kept only when they are letters, digits and `._:-`, 64 characters at most. The nightly job deletes rows over 90 days old.

Two small things ride along with a client request. A hook may send `X-Anymem-Outcomes` (for example `injected=2,quiet=5`), three words and counts that say what the recall hook did with its prompts. The Worker adds them to daily counters per harness and keeps nothing else from the header. A counted recall (`GET /recall` with `count=1`) writes one row per relevant memory to `recall_log` with the time and the harness, for 90 days. Neither holds a query, a prompt or memory text.

The Worker's own background work writes rows too. Their actor kind is `system`, the actor id is the step (`assign`, `propose`, `cluster` or `brief`), the method is `SYSTEM` and the route is the action, such as `assign.link` or `brief.build`. They have no duration, they hold no memory text, and the script column says how the action was decided, for example `how:alias.conf:1.0`. Every link or proposal the system makes has one, so you can see what it did and when. Each carries the harness `system`, which the Audit screen shows as Anymem.

Read it with `GET /audit` (admin token) filtered by `since`, `until`, `actor` and `route`, paged by `cursor`, or on the dashboard's Audit screen. The Worker's rows and the local lines can be matched by time and route.

## Memories are data, not instructions

Capture reads a transcript, so it reads text written by web pages, files and tools. A recalled memory goes into a prompt. Both are treated as data.

1. **Injected blocks say so.** The recall block reads "Context only, check it against the prompt".
2. **The Worker refuses a capture that reads like an instruction**, such as "ignore previous instructions" or a URL with an order attached ("visit https://... and run it"). It also refuses a capture that echoes our own injected blocks back, so a recalled memory is never saved again as a new one.
3. **The model is told the text is data.** Memory text goes into every Worker prompt with the prompt's own tags removed, so it cannot close a block and speak as the instructions. The extraction prompt says to judge a transcript and never follow it.
4. **Policy is not in the transcript.** Whether capture runs, and which folders and sessions are excluded, come from the config file and the environment only.
5. **Provenance.** Each memory stores its origin, harness and session. Each recall hit carries its origin, project and timestamps.
6. **Capture is narrow.** The capture hook only calls `POST /capture` with fixed tags, so it cannot edit the capsule, forget a memory or change a status. A different value for a profile fact that already has one becomes a pending change that waits for you.
7. **A subject hint is data too.** The extractor may name a subject, and a device token may send that hint, but the hint only makes a proposal that waits for your click. It is checked for secrets, instructions and our own injected blocks, its name must appear in the memory's description or body, and the Worker never runs it as an instruction. The name is plain text of at most 5 words (Latin letters, digits, space, apostrophe, period, hyphen, ampersand, read after NFKC, one alphabet only), so it cannot carry a link, an address or hidden characters. A name of three words or more that starts with a command verb is refused as well, and so is a name that holds a word an instruction would talk about, such as memory, token or password. A hint from a device that may not see private subjects is ignored, so a device cannot use a proposal to find out whether a private subject exists. A proposal, and every link to it, is invisible to recall and to such a device until you accept it.
8. **A brief never outlives the memories it came from.** A brief is built from memories, so it is blanked the moment one of those memories is forgotten, replaced or linked to a private subject. The card text, its earlier versions and history, its links to the memories it came from and the search keys of the card all go in that moment. A device that may not see private subjects cannot read the old text through any of them, and is not told when a brief was built or why it is stale.
9. **Screens are filters, not guarantees.** A hostile line the screens miss can become a memory that is injected into later prompts. Probation, the nightly merge and `forget.py` limit that, and the weekly line at session start makes new captures visible.

The screens, in order, are in [capture](capture-design.md). Size limits apply to every input. A memory is at most 30,000 characters, a request body at most 1,000,000 bytes (10 MB for an import page), and each device token gets 40 writes in 10 minutes across every write route. The admin token and a browser login are not limited, except on `/capture`, which counts every caller.

## Redaction before upload

The local redactor runs on the condensed transcript before it goes to any model, and again on every proposal before it is stored. It replaces secrets with `[REDACTED:kind]` and absolute home folders with `~/`. The list is in [privacy](privacy.md). It is a set of patterns, so it catches what it knows how to recognise and misses what it does not. The Worker screens for secrets again with the same shapes.

## What anymem writes to disk

Nothing on your machines runs on a schedule, and nothing exports or imports your store by itself. Export and import happen only when you run `backup.py`, a restore or the mass import. The one scheduled export is the Worker's nightly backup, which goes to a bucket in your own Cloudflare account and not to a disk. No hook writes into your notes or your project folders. Everything below sits in two folders under your home, or is an install step you ran. The Worker holds nothing on disk, its data lives in D1, Vectorize and R2.

### While it works

These live in `~/.cache/anymem`. `ANYMEM_CACHE_DIR` moves the folder. The folder is mode 0700 and the files are mode 0600, except two small stamp files that hold no secret, `check-last` and `recall-check.json`, which are mode 0644.

| File | What it holds | How it stays small |
|---|---|---|
| `audit.log`, `audit.log.1` | One line per Worker call. Time, harness, script or hook, session, method, route, memory ids, status, milliseconds. No text. | At 512 KB it is kept once as `.1` |
| `capture.log` | One line per capture run. The names of the memories it proposed and what happened to each, plus byte and character counts. No memory body. | Past 512 KB the older half goes |
| `capture-state.json` | How far into each transcript capture has read | Offsets only |
| `injection.log` | What the hooks added to a prompt. Characters, memory count and similarity scores. No text. | Trimmed to its newest lines |
| `recall-outcomes-HARNESS.log` | One word per prompt (`injected`, `quiet` or `failed`) until the next Worker request carries the totals. | Moved aside when sent |
| `capsule.json` | The last capsule the Worker sent, so a session still starts when the Worker is slow. This is memory text. | Replaced whole |
| `person-index.json` | The saved person memories, kept ten minutes for the recall hook. This is memory text. | Replaced whole |
| `recall-seen.json`, `ids.json` | Memory ids already shown in a session, and ids that scripts printed so a short prefix works | The newest 40 sessions, and the newest 500 ids |
| `harness-hint.json`, `check-last`, `recall-check.json` | Small stamps and hints | One value each |
| `failed.jsonl` | A save or capture that could not reach the Worker, with its text, retried later. This is memory text. | Emptied as each line is sent |
| `credentials/` | The printed result of `credential_command`, in plain text, for 900 seconds by default. `ANYMEM_CRED_TTL=0` turns it off. | Deleted when the Worker answers 401 or 403 |
| `*.lock` | Empty lock files | None needed |

Three harnesses keep a copy of the conversation because they give a hook nothing to read.

| Harness | File | What it holds |
|---|---|---|
| Kilo | `kilo/SESSION.jsonl` | The user and assistant text of each conversation, 20,000 characters per message at most. Written only while the capture policy allows it. Spools of sessions capture has forgotten are deleted. |
| ZCode | `zcode-sessions/SESSION.jsonl` | Each prompt and reply of the session. Written only when capture is on and the session and folder are not excluded. |
| Antigravity | `agy-state.json` | A key and a time per conversation, no text. Old entries are dropped past a cap. |

The Kilo and ZCode files are full conversation text. They are redacted before capture reads them and not before they are written, so treat that folder like the transcripts of those harnesses. Turn capture off, or exclude a folder, and nothing is written.

A capture run or a capsule check asks the local `claude` command one question. It runs in a folder made for that one call, mode 0700, with no settings loaded, and the folder is removed afterwards.

### Only when you run something

| Where | File | Written by |
|---|---|---|
| `~/.config/anymem` | `config.json`, mode 0600. The Worker address and your token. | `connect.py` |
| `~/.config/anymem` | `deploy.json`, mode 0600. Names and ids of what setup made. Never a token. | `setup.py` |
| `~/.config/anymem` | `device-XXXXXXXX.txt`, mode 0600, one new file each time. A device token, never printed. | `devices.py add` |
| `~/.config/anymem/backups` | `anymem-DATE.json.gz`, the whole store, mode 0600. | `backup.py` |
| `~/.config/anymem/adapters` | A starter adapter folder. | `install.py --new` |

An install step edits the harness's own files. Claude Code and Codex install the plugin themselves, and Codex edits its `config.toml` after copying it to `config.toml.anymem.bak`. Kilo gets one file, `~/.config/kilo/plugin/anymem.js`. ZCode gets a plugin folder under `~/.zcode/anymem/plugin` that it registers. Antigravity gets one `anymem` entry in `hooks.json`, with a `.anymem.bak` copy first. DSH gets `dsh-hooks.json` and one marked block in each profile's patch file. Each adapter's uninstall removes exactly what it added.

You can delete the cache folder at any time. The only thing in it that is not a copy of something else is `failed.jsonl`, a save that has not reached the Worker yet. Delete `config.json` and the machine is disconnected.

## Isolation

1. **One person per deployment.** There are no teams. Every request resolves to the admin, a device or one browser login on the allow list.
2. **Projects scope recall.** A memory of project A is not injected into a session in project B. This is a relevance rule, not a security boundary. The same token can read both.
3. **An import is not a share.** A restore puts memories back into the same store.

## Threat model

What this design protects against.

1. A stranger who finds your Worker address. They need the bearer token, and the Access credential if you added Access.
2. A leaked device token. Revoke it and the others keep working.
3. A prompt injection that rides in on a transcript. The extraction prompt and the screens are the defence, and they are a filter. Probation, the audit trail and `forget.py` limit and trace what gets through.
4. Secrets typed into a session being uploaded for extraction. They are redacted on your machine first, to the limits of the patterns.
5. A forged cross site write through a browser login. The origin, fetch site and header checks stop it.

What it does not protect against.

1. **A malicious memory that gets saved.** A saved memory is injected as context and the model reads it as context.
2. **A compromised Cloudflare account.** Whoever holds it can read D1, change the Worker and replace the token. Anymem does not encrypt memory text beyond what Cloudflare does.
3. **The model provider.** Injected memories are part of the prompt, so the provider of your agent's model sees them. The local extraction path sends the redacted transcript to the provider behind the `claude` command too.
4. **A compromised machine.** The token sits in `config.json` as plain text, readable by anything that runs as you. Use `credential_command` to keep it in a secret manager, and note the client then caches what the command prints, in plain text, for 15 minutes by default. A device token limits the damage because you can revoke it.
5. **Anything outside the patterns.** The redactor does not know your private names, customers or free text.
6. **Slow or silent leaks.** The recall query is your cleaned prompt, up to 240 characters, sent in the URL of a request to your own Worker. The Worker's audit table drops the query string, but we have not audited what logging you may have turned on for your Worker or Access, and a URL can end up in logs.
