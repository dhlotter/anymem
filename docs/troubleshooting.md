# Troubleshooting

Start with `doctor.py --probe`. It checks the config, the connection, the token, the capsule, unsaved memories, the plugin copies, the nightly job, backups and vector search. A line that starts with `FAIL` names its fix. Each entry below gives the symptom, the cause and the fix. Doctor shows where each setting came from and never prints a secret.

## Setup

**Before you run setup again.** A rerun keeps the Access and the custom domain the store already recorded, so a plain rerun is safe. Only `--no-access` turns Access off, and setup warns when you use it. Many fixes below say to run setup again, so repeat `--name` if you used one.

**No API token given.** Create a token with the permissions `setup.py --scopes` prints, then set `CLOUDFLARE_API_TOKEN` or paste it when asked. Setup never stores it.

**The API token is missing a permission, or Cloudflare refused the API token at a step.** The token lacks a permission. Setup reads one list per permission first, so nothing was created. Add the named permission, or make a new token from `setup.py --scopes`, and run setup again. It picks up where it stopped.

**Cloudflare says this API token is not valid.** It was mistyped, expired or deleted. Create a new one.

**This token can see N accounts.** Set `CLOUDFLARE_ACCOUNT_ID`, or pass `--account-id`, to the account you want and run setup again.

**An earlier run used a different Cloudflare account than this one.** Set `CLOUDFLARE_ACCOUNT_ID` to the first account, or run `uninstall.py` there first.

**A resource already exists in this account and setup did not make it, so it was left alone.** A D1 database, Vectorize index, R2 bucket or Worker with that name exists. Setup will not adopt it and will not overwrite another Worker. Pick another name with `--name`. If you meant to use an existing Anymem, run `connect.py`.

**Cloudflare refused because a plan limit was reached.** Free up or raise that limit, then run the same setup command. It keeps what it already created.

**The domain is not in a zone on this Cloudflare account.** Add the domain to Cloudflare first, or leave out `--domain` to use a workers.dev address. A custom domain also needs the token permission Zone, Workers Routes Edit and DNS Edit.

**The domain is already attached to another Worker.** Choose another `--domain`, or remove the custom domain from that Worker in the Cloudflare dashboard and run setup again. Setup cannot take a hostname over from another Worker, because the attach call has no field for it.

**This account has no workers.dev name yet.** Run setup with `--subdomain NAME`, or open Workers in the Cloudflare dashboard once.

**Zero Trust has no team name yet, or Access is not set up for this account.** Open Zero Trust in the Cloudflare dashboard once and pick a team name (the free plan is enough), then run setup again. If the message names the permission "Access: Organizations, Identity Providers, and Groups Read", add that permission to the API token. Or leave out `--access`.

**A store with another name is already recorded.** `deploy.json` records a different name than your `--name`. Run setup with the recorded name, or run `uninstall.py` first.

**The Worker did not answer /health within 240 seconds.** A new workers.dev Worker answered HTTP 401 for 4 to 6 minutes after upload on 2026-10-17, so setup timed out and exited 1 although every resource existed. Wait a few minutes and run `doctor.py --probe`. Nothing needs redoing.

**The Access service token exists but its secret is not on this machine.** Cloudflare shows a secret once. Delete that service token in Zero Trust and run setup again with the same flags.

**The first request after a rerun answers 403 on the dashboard, or the Worker stopped checking Access.** A rerun keeps Access unless `--no-access` was given. If Access is off, the last run used `--no-access`. Turn it back on with `setup.py --access --email you@example.com`. See [install](install.md#upgrading).

A setup that stopped part way is safe to run again. If it stopped while creating something and cannot say whether it exists, `uninstall.py` tells you which resources to look for in the Cloudflare dashboard.

## Connect

1. **Not connected, the Worker rejected that token (HTTP 401 or 403).** Wrong or revoked token, or the Access pair is missing or wrong.
2. **Not connected, could not reach the address.** Wrong address or no network.
3. **The address answered, but not the way an Anymem Worker does.** It is not an Anymem Worker.
4. **The address accepted a made up token.** Refused on purpose. It does not check tokens, so it is not an Anymem Worker or it has no lock.
5. **That does not look like a Worker address.** Use `https://` and no path.
6. **That connection string is damaged or incomplete.** Copy all of it again.

Nothing is saved in any of these cases.

## Doctor

**FAIL config, not configured.** No address or token from any source. Run `setup.py`, or `connect.py` on a machine that is not the first. If doctor adds that the old `HARNESS_MEMORY_*` variables are not read, set `ANYMEM_URL` and `ANYMEM_TOKEN` instead.

**FAIL config, the url is not usable.** It must start with `https://`. Run `connect.py` again.

**FAIL config, the token contains a character that cannot be sent.** A line break or a non Latin character got in, usually from pasting. Run `connect.py` again and paste only the token.

**FAIL reachable, cannot reach the address.** The address is wrong, the Worker is deleted, or you are offline. The lines after it show `skip`. Check the address in `~/.config/anymem/config.json` and your network.

**FAIL reachable, the Worker answered HTTP 5xx.** Open the Worker's logs in the Cloudflare dashboard. A 500 that says a setting is wrong comes from the Worker's auth settings. See below.

**WARN reachable, the vector index is not ready.** The index does not have 384 dimensions. Check the Vectorize index in the Cloudflare dashboard.

**FAIL auth, the token was rejected (HTTP 401).** The token is wrong or revoked. Run `connect.py` again with a current token. If you were given a device token, ask whether it was revoked.

**FAIL auth, access was refused (HTTP 403).** Cloudflare Access is in front and the service token pair is missing, wrong or expired, or the token lacks permission. Set `ANYMEM_ACCESS_CLIENT_ID` and `ANYMEM_ACCESS_CLIENT_SECRET`, or run `connect.py` with the two Access flags.

**WARN capsule, the core capsule is empty.** A new store has no capsule memories. The always on capsule is canonical memories tagged `capsule:core` and `capsule-slot:SLOT`, where the slot is `identity`, `preferences`, `constraints` or `principles`. Save one.

```bash
remember.py --tag capsule:core --tag capsule-slot:preferences --tag status:canonical <<'EOF'
---
name: working-preferences
description: how I like answers written
metadata:
  type: user
---
Short answers, lead with the result.
EOF
```

**WARN unsaved, N unsaved memories.** A save failed and its text sits in `~/.cache/anymem/failed.jsonl`. Check the network and the Worker, then run `resave.py` (`--dry-run` lists them first). A failed `remember.py` is not queued, so run it again. Nothing retries in the background.

**WARN plugin copies, a tool runs a copy that differs from the repo.** Claude Code and Codex run their own cached copy of the plugin. Raise `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then run `scripts/upgrade-plugins.sh`, then approve the anymem hooks again in Codex (`/hooks`).

**WARN codex hooks, Codex no longer runs the anymem hooks.** Codex 0.164 and later hash the whole installed plugin folder before every hook and compare it with the hash pinned when you approved the hooks. Any change to Codex's copy (an upgrade, a reinstall, `codex plugin add` copying new files) fails every hook as `hook: Stop Failed`, and nothing outside Codex says so. Start `codex`, approve the anymem hooks again with `/hooks`, then run `doctor.py` until the line reads ok.

**skip usage, usage counts need an admin token.** A device token cannot read `GET /stats`. Not a problem.

**WARN usage, last nightly job FAILED.** Open the dashboard Health screen. Each step shows its result, and a failed step shows its error. A backup refused for being too small also fails the run.

**WARN backup, no nightly backup yet.** It runs at 01:00 UTC. Take one now with `backup.py --from-worker --now`.

**WARN backup, the latest nightly backup is N days old.** Check the Worker's cron trigger and logs, then take one with `backup.py --from-worker --now`.

**WARN backup, nightly backups are off.** The Worker has no `BACKUP_BUCKET` binding. Run `setup.py` again with your flags, which adds it.

**FAIL vector, vector search is not working.** The probe found its vector without a metadata filter but not with one, so the Vectorize index is probably missing its `project` and `origin` metadata indexes. The probe checks the metadata index only. Recall sends no filter, so recall still finds memories by meaning, but any filtered query returns nothing until the index exists. Setup creates the indexes before any vector, so this shows on a store made some other way. Run `setup.py` again with your flags, which creates what is missing. Then call `POST /admin/reindex` with the admin token, repeating until `remaining` is 0, because vectors written before the metadata index existed are not covered by it.

**WARN vector, the probe vector was not searchable after 180 seconds.** Vectorize indexing takes from seconds to a few minutes, about two minutes was typical on 2026-10-17, so this is a warning and not proof of a fault. Run `doctor.py --probe` again in a few minutes and check the Worker's logs in the Cloudflare dashboard if it repeats.

## The Worker's own errors

Errors are JSON, `{error, code}`.

| Status and code | Meaning and fix |
|---|---|
| 400 `bad_request`, `bad_json`, `bad_tag`, `bad_scope`, `bad_cursor`, `unknown_harness` | A value is wrong, and the message says which. `bad_json` means the body is not a JSON object. `bad_tag` names the tag rule that failed. `bad_scope` wants `all` or `project:<slug>` |
| 500 `misconfigured` | An auth setting is wrong, and the message says which. `AUTH_TOKEN` needs 20 characters or more. With `REQUIRE_ACCESS` true it needs `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and at least one of `ACCESS_SERVICE_COMMON_NAMES` and `ACCESS_ALLOWED_EMAILS`. The Worker never runs open |
| 401 `unauthorized` | No bearer token was sent to a route that needs one |
| 401 `access_required` | Access did not pass its token. A request reached the Worker around Access, or Access is off on that address |
| 401 `invalid_access_token` | The Access token was refused. The message is the same for every reason. The reason, such as wrong audience or expired, is in the Worker log: run `wrangler tail` and look for `access token refused` |
| 401 `invalid_token` | The bearer is not the admin token or an active device token |
| 403 `forbidden` | The Access service token is not in `ACCESS_SERVICE_COMMON_NAMES`, the login email is not in `ACCESS_ALLOWED_EMAILS`, or a device token called an admin route |
| 403 `admin_only` | A device token tried a write only the admin token or a browser login may make: an origin of `profile`, `person`, `system` or `import`, a `capsule` tag, or the `canonical` status |
| 403 `browser_capture_scope` | A browser login can only save profile and person notes through `/capture` |
| 403 `browser_only` | The dashboard pages need a browser login, not a token |
| 403 `browser_not_allowed` | A browser login called a route the dashboard does not use |
| 403 `csrf_rejected` | A browser write did not come from the dashboard page |
| 404 `not_found`, `no_backup_bucket` | No such memory, route or backup. `no_backup_bucket` means the Worker has no `BACKUP_BUCKET` binding, so run `setup.py` again |
| 405 `method_not_allowed` | The route exists but not for that method. The `Allow` header lists the methods it takes |
| 409 `lost_race`, `stale_update` or `already_closed` | Someone changed the memory first, so read it again and retry. `already_closed` means the memory is already closed and there is nothing to change |
| 410 `restore_window_passed` | The memory has been in the trash more than 14 days |
| 413 `payload_too_large` | The body or the memory is too large. A memory is at most 30,000 characters |
| 422 `refused` | A screen refused a capture, with a reason in `secret`, `instruction`, `injected_block`, `blocked_topic` or `sensitive`. Nothing was saved. Do not rephrase around it |
| 429 `rate_limited` | More than 40 writes in 10 minutes. Wait the number of seconds it says |
| 500 `internal` | The Worker failed on its own side. The Worker log has the detail: run `wrangler tail` |

## Recall

**A memory exists but is never injected.** Check in this order.
1. **The Worker called it not relevant.** The Worker marks each hit `relevant` or not, and only relevant hits are injected. `recall.py QUERY --json` prints the Worker's reply with each hit's `relevant` flag and scores. `recall.py` does not ask for the reasons (`why`), but the dashboard's Search screen does. A hit that shares only words with the prompt is not injected. See [recall](recall.md).
2. **It is pending, or it is a capsule memory.** Neither is injected by the prompt hook. The capsule arrives at session start.
3. **It belongs to another project.** A memory of project `x` is injected only in project `x`. A session outside any git repo sees only global memories. `ANYMEM_PROJECT` overrides the project.
4. **It was already shown in this session.** A memory is injected once per session.
5. **The prompt is too short.** Under 20 characters, or a slash command, or written by the harness.
6. **It is not indexed yet.** A new memory is found by keyword at once and by meaning after about two minutes.
7. **Recall is off.** `ANYMEM_RECALL=0`.
8. **The hook timed out.** Nothing is injected, silently. The hook stops itself at 8 seconds (`ANYMEM_HOOK_DEADLINE`), under the 9 second limit in `hooks/hooks.json`.
9. **It was closed or trashed.** A memory a newer one replaced is history, and `get.py ID` still reads it.

**Unrelated memories get injected.** The Worker decides, with `RERANK_MIN` and `RECALL_MIN_SIM`. The defaults gave a quiet rate of 0.90 on 100 real prompts. Raise `RERANK_MIN` on the Worker to be quieter, at the cost of fewer hits. `ANYMEM_RECALL_MIN_SIM` on the client only matters against the old Worker.

**A one word identifier prompt injects nothing.** Known. See [recall](recall.md#where-it-falls-short). Run `recall.py` yourself.

## Capture

**Nothing is captured.** Look at `~/.cache/anymem/capture.log`, one JSON line per run. The `result` or `memories` field says why.
1. `skipped, capture policy`. Capture is off, or the session or folder is excluded.
2. `skipped, too little user text`. Fewer than 150 characters of your own text since the last capture. Most sessions yield zero or one memory, and that is normal.
3. The size gate. `PreCompact` and `SessionEnd` need 8 KB of new transcript, `Stop` needs 60 KB and 20 minutes.
4. `rejected` with `looks like a secret`, `bad name`, `bad description`, `body length`, `blocked topic` or `reads like an instruction to the assistant`. The client screen refused the proposal.
5. `not stored, refused` with a reason, or `not stored, duplicate of ID`. The Worker's screens or duplicate check refused it.
6. `error` from the extraction call. With local extraction check that the `claude` command runs. With Worker extraction an empty list and `degraded: model` means the model call failed.

To see what a transcript would produce without storing anything, `python3 hooks/memory_capture.py --dry-run PATH/TO/TRANSCRIPT.jsonl`. It still calls the extraction model.

**The Worker's extractor returns nothing for a session.** It makes no model call for under 800 characters of your own text, and it returns at most 2 memories.

**`remember.py` says too many writes.** The Worker allows 40 writes per token in 10 minutes. Wait, and do not loop `remember.py` over a list.

**A memory I saved is marked closed, and a newer one replaced it.** The Worker found a contradiction and two agreeing answers. `undo.py OLD_ID` reopens it.

## Unconfigured client

1. `anymem is not configured (missing url, token). Run ... setup.py or ... connect.py`. Printed by every script that needs the Worker, exit code 1.
2. Hooks print nothing at all when the client is not configured, so a session never waits on or fails because of memory.

## Hooks and harnesses

**Plugin hooks do not fire after install.** Claude Code reads plugin hooks when it starts. Restart it after installing or updating the plugin.

**The session starts with no capsule.** The capsule call timed out and there is no cache yet, or the capsule is empty.

**Codex does not run the hooks.** Codex trusts hooks by hash, so a new or changed hook has to pass Codex's own trust step. We never bypass it. Approve the hooks again after any edit. Codex also clamps `SessionEnd` to 3 seconds, which is why capture starts a detached worker and returns at once.

**Antigravity injects nothing.** The hooks must use Antigravity's own event names. The prompt is not in the payload, so it is read from the transcript.

**ZCode captures nothing.** ZCode deletes its transcript temp file as soon as the hook returns, so the ZCode adapter keeps its own copy of the conversation in `~/.cache/anymem/zcode-sessions/`, and capture reads that. Check the capture log (`~/.cache/anymem/capture.log`) for a line per run. ZCode also has its own memory feature, which you may want to switch off.

**`install.py NAME` says no adapter named.** The error lists the valid names. `install.py --list` shows every adapter your copy has, and any of yours that did not load with the reason.

**An agent keeps writing its own memory files.** Set `ANYMEM_NATIVE=block` so the guard denies writes into Claude Code's own memory folder, and turn off Claude Code's own memory with `autoMemoryEnabled` set to `false` in its settings.

## Uninstall

**Could not delete a resource.** The message names the cause. Run `uninstall.py --delete-resources` again. What was deleted is already out of `deploy.json`, and a resource that is already gone counts as deleted.
