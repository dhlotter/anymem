# Install

This page takes you from nothing to a working Anymem. It then covers a second machine, upgrading, uninstalling and every setting.

## The short way

```bash
bash scripts/bootstrap.sh
```

On a machine with nothing, bootstrap fetches the repo to `~/.local/share/anymem` and runs `init.py`. Run from a clone, it uses that clone. It needs Python 3.9 or newer and git. It does not need Node.js or Wrangler. Setup talks to the Cloudflare API with Python's standard library and uploads the Worker's plain JavaScript files as they are.

`init.py` does three things and skips whatever is already done, so rerunning it is safe.

1. **Store.** If this machine has no Worker address and token, it asks whether to create a store in your Cloudflare account (`setup.py`) or connect to one that exists (`connect.py`).
2. **Harnesses.** It lists what is installed here and wires each one it finds (`install.py --all`).
3. **Check.** It runs `doctor.py` and lists the next steps only you can do. That is restarting sessions that were already open, and approving the hooks once in Codex.

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the plan and run nothing |
| `--connect STRING` | Connect to an existing store with this connection string |
| `--create` | Create a new store without asking (works with `--yes`) |
| `--name`, `--domain`, `--access`, `--email`, `--plan` | Passed to `setup.py` for a new store |
| `--yes` | Skip every confirmation |

Claude Code takes its hooks from the plugin, not from `install.py`.

```bash
claude plugin marketplace add dhlotter/anymem
claude plugin install anymem@anymem
```

Restart Claude Code afterwards. It reads plugin hooks when it starts. Inside Claude Code the slash commands `/anymem:setup`, `/anymem:connect` and `/anymem:doctor` run the matching scripts.

There is no `anymem` command on a PATH. Every job is a script in `skills/anymem/scripts/`, run as `python3 skills/anymem/scripts/NAME.py` from a clone, or by the agent through the skill. The rest of this page gives the script name only.

## Prerequisites

Setup checks these and names what is missing before it creates anything.

1. **A Cloudflare account** with Workers AI available.
2. **A Cloudflare API token** with the permissions below. Create it at https://dash.cloudflare.com/profile/api-tokens as a custom token. Set it as `CLOUDFLARE_API_TOKEN`, or paste it when setup asks (the input is hidden). **Setup never stores the token on disk.** `setup.py --scopes` prints the list. Setup reads one list per permission first and names any permission the token lacks before it creates anything.

   | Permission | Needed for |
   |---|---|
   | Account, Workers Scripts Edit | the Worker, its cron and its address |
   | Account, D1 Edit | the database and its schema |
   | Account, Vectorize Edit | the vector index |
   | Account, Workers R2 Storage Edit | the backup bucket and its 30 day rule |
   | Zone, Workers Routes Edit and DNS Edit | only with `--domain`, on the one zone that holds the domain (Include: Specific zone) |
   | Account, Access Apps and Policies Edit, and Access Service Tokens Edit | only with `--access` |
   | Account, Access Organizations, Identity Providers, and Groups Read | only with `--access`, reads the Zero Trust team name |

   Give the token one account, not all of them. If the token sees several accounts anyway, set `CLOUDFLARE_ACCOUNT_ID` or pass `--account-id`.
3. **Python 3.9 or newer.** macOS ships 3.9. The client, the hooks and setup use only the standard library.
4. **git**, only to fetch or update the repo, and so the client can find a project folder.
5. **A harness to wire.** At least one of Claude Code, Codex, Antigravity, DSH, Kilo, ZCode or Cline. `install.py --list` shows what was found.
6. **Cloudflare Zero Trust**, free for up to 50 users, only if you choose `--access`.

macOS and Linux are the targets. Windows is out of scope.

## Setup

```bash
setup.py --access --email you@example.com
```

**Access and the domain are kept.** A rerun reads the Access email and the custom domain back from `deploy.json`, so a plain rerun keeps Access on and workers.dev off. `--no-access` is the only way to drop Access, and setup prints a warning when you use it. There is no flag to go back to workers.dev on a store that has a custom domain. To move to another domain, pass `--domain` with the new name.

| Flag | Meaning | Default |
|---|---|---|
| `--name NAME` | Name prefix for every resource. 1 to 42 lowercase letters, digits or hyphens, starting and ending with a letter or digit | `anymem` |
| `--domain DOMAIN` | Custom domain for the Worker, for example `memory.example.com`. It must be on your Cloudflare account. workers.dev is then turned off for the Worker. A rerun keeps it | a workers.dev address |
| `--rotate-access` | With `--access`, replace the Access service token. The old one is deleted, and every connection string made before stops passing Access. Make new ones with `devices.py add LABEL --share` | off |
| `--second-machine` | Also make one connection string for a second machine, written to a 0600 file. Setup asks once when this is left out, and the answer is kept so a rerun does not make another | off |
| `--subdomain NAME` | Your account's workers.dev name, only for an account that has none yet | none |
| `--access` and `--email EMAIL` | Put Cloudflare Access in front (recommended). The email is the one you log in with in a browser. A rerun keeps both once they are recorded | off |
| `--no-access` | Turn Access off on a store that has it. The only way to drop Access. Setup prints a warning | off |
| `--plan free` or `--plan paid` | Your Cloudflare plan, asked when left out | asked |
| `--account-id ID` | The Cloudflare account to use | `CLOUDFLARE_ACCOUNT_ID`, else the only account the token sees |
| `--scopes` | Print the API token permissions and stop | off |
| `--dry-run` | Print every API call, send nothing, need no token | off |
| `--yes` | Do not ask "Go ahead?" | off |

A dry run needs no token and no network.

```bash
setup.py --dry-run --name demo --access --email you@example.com
```

### What it creates, in order

The resources as one table, what setup never creates, and how to run without a domain are in [Cloudflare resources](cloudflare.md).

1. **Preflight.** Prints what you need, reads the token, picks the account and checks one permission at a time.
2. **D1 database** `NAME-db`. The migrations in `worker/db/migrations` are applied, and the version is kept in the `meta` table, so a rerun applies nothing twice.
3. **Vectorize index** `NAME-vectors`, 384 dimensions, cosine.
4. **Metadata indexes on `project` and `origin`.** Created one at a time and read back before any vector can be written. A filtered query on a property with no metadata index returns nothing and says nothing, and two requests sent back to back once lost one of them on 2026-10-17.
5. **R2 bucket** `NAME-backups`, with a rule that deletes objects under `backups/` after 30 days.
6. **Access, with `--access`.** A service token named `NAME-machines` (a one year life), an Access application on the address, and two policies. One lets the service token through. One lets your email through in a browser. Cloudflare shows the service token secret once, and setup saves it to the local config only.
7. **The Worker.** Every `.js` file in `worker/` except tests, dev tools, scripts and `migrate.js` goes up as a module. `worker/ui` goes up as static assets. Bindings are D1, Vectorize, AI, R2 and the assets. One cron trigger runs at 01:00 UTC. A newly generated `AUTH_TOKEN` secret is set. Settings come from `worker/wrangler.jsonc`, and the `ACCESS_*` values come from the Access step.
8. **The address.** The workers.dev name by default. With `--domain`, the custom domain, and workers.dev is turned off. Without `--domain` workers.dev stays on, and Access, when you asked for it, sits on that address.
9. **Client config.** The address and token go to `~/.config/anymem/config.json` (mode 0600). Names and ids, never a secret, go to `deploy.json`.
10. **Proof.** Setup waits up to 240 seconds for the Worker to answer, then runs `doctor.py --probe`. It asks whether to make a connection string for a second machine, made with `devices.py add second-machine --share` (default no, or pass `--second-machine`). Setup makes one per store, so a rerun does not add another.
11. **Plan limits.** It prints what your plan allows and asks which plan you are on, because the token cannot read billing. See [limits](limits.md).

Every step looks first and creates only what is missing. It never deletes anything. If a resource with its name exists and setup did not create it, setup stops and says so rather than adopt it. If a run stops part way, run the same command again. A rerun on a finished store uploads the current Worker code and keeps your token, Access and the custom domain, so it is also how you update the Worker.

**Expect a wait.** On 2026-10-17 provisioning took 5 minutes 28 seconds. The new workers.dev Worker answered HTTP 401 for 4 to 6 minutes after upload, longer than setup's 240 second wait, so setup printed a timeout and exited 1 although every resource existed. Run `doctor.py --probe` a few minutes later. See [troubleshooting](troubleshooting.md).

### Without Access

Without `--access`, `REQUIRE_ACCESS` is set to `false` and the bearer token is the only lock. Setup says so. Add Access later by running setup again with `--access --email you@example.com`. See [security](security.md).

## Check it works

```bash
doctor.py --probe
```

Doctor prints one line per check and a verdict. It exits 0 when no check failed and 1 otherwise. The checks are config, reachable, auth, capsule, unsaved, capsule cache, plugin copies, prerequisites, usage, backup and vector.

`--probe` asks the Worker to write one probe vector, which is not a memory, and waits up to 3 minutes for a filtered query to find it. The check covers the metadata index only, because recall sends no filter. Each run deletes the previous run's probe vector, so nothing builds up and it is safe on every device. Without `--probe` the vector check is skipped. A line that starts with `FAIL` names its fix. An empty capsule is a warning, because a new store has no capsule memories yet.

## Install the hooks for other harnesses

`install.py --list` shows every adapter your copy has and whether it found that harness. `install.py NAME` prints a plan, asks to confirm, installs, then runs the adapter's check. `--dry-run` prints the plan and writes nothing, `--yes` skips the question, `--check` verifies, `--uninstall NAME` removes only this product's own entries, and `--new NAME` writes a starter adapter for a harness we do not ship (see [add a harness](add-a-harness.md)). The guides are in `docs/harnesses/`.

Cline is installed through its own command line. `install.py cline` generates a small plugin folder, `~/.config/anymem/cline-plugin`, and runs `cline plugin install` on it, so Cline makes its own copy under `~/.cline/plugins/_installed/local`. Restart Cline or start a new session afterwards. It needs Cline 3 or later, from the `cline` command on your PATH, the Cline desktop app, or `ANYMEM_CLINE_BIN`. See [cline](harnesses/cline.md).

## Connect another machine

A new machine, or a new tool on one, needs no server work.

1. **On the machine that owns the store**, make a connection string.

   ```bash
   devices.py add work-laptop --share
   ```

   It prints one line starting `hm1.` that holds the Worker address, a token for this machine only, and the Access pair if there is one. It is shown once and it is a secret. Carry it through a password manager or a one time secret link, never chat or email. `devices.py revoke ID` stops that one machine and leaves the others alone.
2. **On the new machine**, install the plugin or run `bootstrap.sh`, then `connect.py`, and paste the string when asked (the input is hidden). Or run `pbpaste | connect.py` on macOS, `wl-paste | connect.py` or `xclip -o | connect.py` on Linux. `connect` proves the token works before it saves anything, and never prints the secret.
3. **Check** with `doctor.py --probe`, then restart the tool.

You can use the admin token on a second machine, but a device token is better because you can revoke it alone. Revoking stops that device's bearer token only. The Access pair in its string is shared with every device of the store, so when a string may have leaked, run setup with `--rotate-access`, which replaces the pair and breaks the other strings too. Without the string, `connect.py https://your-worker.example` asks for the token with the input hidden, and takes `--access-client-id` and `--access-client-secret-file` when Access is in front.

## Upgrading

**The Worker.** Pull the repo and run `setup.py` again, with `--name` if you used one. It finds what exists, applies any new migration, uploads the current Worker code and keeps your token, Access and the custom domain. Do not uninstall and set up again to upgrade, because uninstall deletes your memories.

**The flags are remembered.** Setup reads the Access email and the custom domain back from `deploy.json`, so a plain rerun leaves `REQUIRE_ACCESS` true and workers.dev off. A store recorded before this was kept is read from its Access record. Only `--no-access` drops Access. This has not been run against real Cloudflare. Check `doctor.py` and the dashboard after any rerun.

**The client.** Update the plugin through your harness's plugin manager, or pull the repo.

**Installed plugin copies do not follow the repo.** Claude Code and Codex copy the plugin into their own cache folder at install and keep running that copy. Changing a hook in the repo does nothing for them until the plugin version changes and they update. After a hook change, raise `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then run `scripts/upgrade-plugins.sh`. It runs `claude plugin marketplace update anymem`, `claude plugin update anymem@anymem`, and for Codex `codex plugin remove` then `codex plugin add`. It also puts back the older Codex versions that `remove` deletes, because a Codex chat that is already open keeps running its hooks from the old version's folder. The doctor's `plugin copies` check warns when the newest installed copy of the hooks or the skill differs from the repo.

**From the old name, `harness-memory`.** There are no aliases. The old command, variables and folders are not read, and the doctor says so when it finds `HARNESS_MEMORY_*` variables. Remove the old install first. The config file is now `~/.config/anymem/config.json` and the variables are `ANYMEM_*`. Copy the file across by hand, then delete `~/.config/harness-memory` and `~/.cache/harness-memory`.

**From version 1.** The data moves with the migration scripts, see [migration](migration.md).

## Uninstall

Remove things in three layers.

1. **Hooks.** In Claude Code, disable or uninstall the plugin. For the others, `install.py --uninstall NAME`.
2. **The server.**

   ```bash
   uninstall.py
   ```

   With no flags it lists what setup recorded and deletes nothing. To delete, add `--delete-resources`. It deletes the Worker, the Access application and service token, the Vectorize index and the D1 database, in that order, and asks you to type `delete`. It reads your API token the same way setup does. It deletes only what `deploy.json` recorded, and only names that start with the recorded prefix. It keeps the R2 backup bucket, because that is where your backups are. Add `--include-backups` to delete it too (the bucket must be empty, uninstall never empties it). `--yes` skips the question. **This deletes every memory in them.** If a setup run stopped while creating something, uninstall reports it and does not delete it by guess, so check the Cloudflare dashboard.
3. **Local files.** Uninstall leaves `~/.config/anymem/` and `~/.cache/anymem/`. Delete them yourself. The capture log and `failed.jsonl` hold memory text.

## Backup and restore

See [backups and restore](backups.md).

## Configuration reference

### Where each value comes from

For the Worker address and the token, the client uses the first of these that has a value.

1. The environment variable.
2. The config file `~/.config/anymem/config.json`.
3. Claude Code plugin options, `CLAUDE_PLUGIN_OPTION_URL` and `CLAUDE_PLUGIN_OPTION_TOKEN`, set by `claude plugin configure anymem`. The file wins when both are set.
4. The `credential_command` in the config file. It runs in three cases. Something is still missing after the first three. Or the address did not come from the environment, because the command may print a newer one. Or exactly one of the two Access values is set, so the command can supply the other. Its result is cached for 900 seconds by default in `credentials/` under the cache folder, one file per command and session. The session start hook names the session for Claude Code, so one run serves every hook and script call of a session. Set `ANYMEM_CRED_TTL` to a number of seconds to change the window, or to `0` to turn the cache off. A failed, timed out or empty result is never kept as a value, but the command is not run again for 60 seconds, and a 401 or 403 from the Worker drops the entry. **While the entry lives, the values the command printed sit on disk in plain text,** in a file with mode 0600 inside a folder with mode 0700. Set `ANYMEM_CRED_TTL=0` if you do not want that.

The address has one exception to that order. When the `credential_command` prints an `ANYMEM_URL` (or `url`), that value beats the config file and the plugin option, and only the `ANYMEM_URL` environment variable beats it. So you can keep the address next to the token in your secrets manager, and a changed hostname is one edit there and not one edit on every machine. Machines that print no address keep using the `url` in their config file.

`doctor.py` shows where the address and the token came from and never prints a secret.

### Config file keys

`~/.config/anymem/config.json`, or `config.json` in the folder named by `ANYMEM_CONFIG_DIR`.

| Key | Meaning | Default |
|---|---|---|
| `url` | Worker address | written by `setup` or `connect` |
| `token` | Bearer token | written by `setup` or `connect` |
| `access_client_id`, `access_client_secret` | Cloudflare Access service token pair. Used only when both are present | none |
| `credential_command` | A command that prints the values. It can print a JSON object, whose keys are the names above or the environment variable names (`ANYMEM_URL` included), or a single line holding just the token | none |
| `capture` | `proposals` or `off`. `true` means `proposals` and `false` means `off`. Any other value, `on` included, is treated as off | `proposals` |
| `exclude_paths` | Absolute folder prefixes or globs. A session whose folder or a parent matches is not captured | none |
| `exclude_sessions` | Session id prefixes that are not captured | none |
| `extraction` | `auto`, `local` or `worker` | `auto` |

An example `credential_command` for the macOS keychain, which prints one line, the token.

```json
{
  "url": "https://your-worker.example",
  "credential_command": "security find-generic-password -s anymem -w"
}
```

`deploy.json` in the same folder is setup's record of what it created. It is not a setting.

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `ANYMEM_URL`, `ANYMEM_TOKEN` | Worker address and bearer token | none |
| `ANYMEM_ACCESS_CLIENT_ID`, `ANYMEM_ACCESS_CLIENT_SECRET` | Cloudflare Access pair | none |
| `ANYMEM_CONFIG_DIR`, `ANYMEM_CACHE_DIR` | Config and cache folders | `~/.config/anymem`, `~/.cache/anymem` |
| `ANYMEM_PROJECT` | Force a project slug, or `global`, `none` or empty for no project | the git root's folder name |
| `ANYMEM_CAPTURE` | `0` turns capture off, beating the config file | on |
| `ANYMEM_CAPTURE_MODEL` | Model for local extraction through `claude -p` | `haiku` |
| `ANYMEM_CAPTURE_CHILD` | Set by the hook on its own extraction call so it cannot trigger capture again. Do not set it | unset |
| `ANYMEM_EXTRACTION` | `auto`, `local` or `worker`. Beats the config key. `auto` is local when a `claude` command exists, else the Worker | `auto` |
| `ANYMEM_TRANSCRIPT_FORMAT` | Transcript format the capture hook reads when it is not told one. Claude transcripts are sniffed, and Codex rollouts are detected from their first line | `claude` |
| `ANYMEM_RECALL` | `0` turns the per prompt recall off | on |
| `ANYMEM_RECALL_TIMEOUT` | Seconds the recall call may take at most. The hook gives it the smaller of this and what is left of `ANYMEM_HOOK_DEADLINE` | `6` |
| `ANYMEM_HOOK_DEADLINE` | Seconds the whole per prompt hook may take, under the 9 second limit in `hooks/hooks.json`. Whatever is still slow at the deadline is dropped and the prompt goes through | `8` |
| `ANYMEM_RECALL_MIN_SIM` | The closeness cutoff the client applies only when the Worker sends no `relevant` flag, which is the old Worker kept readable for a week of rollback. The v2 Worker decides for itself, see `RECALL_MIN_SIM` in [worker/README.md](../worker/README.md) | `0.6` |
| `ANYMEM_HOOK_TIMEOUT` | Seconds for the capsule call, and for a `credential_command` run by the capsule hook | `4` |
| `ANYMEM_CAPSULE` | `0` turns the session start capsule off | on |
| `ANYMEM_SAVE_RULES` | `0` leaves the save rules (when the agent should save a memory itself, and the script to run) out of the capsule | on |
| `ANYMEM_NATIVE` | `block` makes the native memory guard deny writes into Claude Code's own memory folder | off |
| `ANYMEM_HARNESS`, `ANYMEM_SESSION` | Which harness and session a script call belongs to, sent to the Worker's audit table and kept on a memory the script saves. The session start hook sets them for Claude Code. Every other adapter names itself in its own hooks and leaves a small note in the cache folder (`harness-hint.json`), which a script run without the variable reads for up to 4 hours | none, so a call with neither the variable nor a fresh note has a blank harness |
| `ANYMEM_CRED_TTL` | Seconds a `credential_command` result is reused. `0` turns the cache off | `900` |
| `ANYMEM_ADAPTERS_DIR` | Where `install` looks for built in adapters | the repo's `adapters/` |
| `ANYMEM_HOME` | The home folder `install` treats as the limit for what adapters may change | your home folder |
| `ANYMEM_CF_API` | The Cloudflare API base address, for tests against a fake | `https://api.cloudflare.com/client/v4` |
| `ANYMEM_REPO`, `ANYMEM_HOME_DIR` | Where `bootstrap.sh` fetches from and to | `https://github.com/dhlotter/anymem.git`, `~/.local/share/anymem` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Read by `setup` and `uninstall`. The token is never written to disk | none |

Harness specific variables (`ANYMEM_ZCODE_APP`, `ANYMEM_ZCODE_NODE`, `ANYMEM_DSH_SESSIONS`, `ANYMEM_CODEX_BIN`, `ANYMEM_CLINE_BIN`, `ANYMEM_PLUGIN_ROOT`, `ANYMEM_PYTHON`) are in the guide for each harness or its adapter.

### Limits fixed in the code

These are constants in the hooks, not settings.

| Where | Value |
|---|---|
| Recall hook | asks for 3 memories, injects them as name, description and 320 characters of body, about 1,800 characters in all, query capped at 240 characters. Skips prompts under 20 characters, slash commands and prompts the harness wrote. The profile and people lookups wait 3 seconds at most each, and a call with under 0.25 seconds of the deadline left is not made |
| Capture hook | `PreCompact` and `SessionEnd` need 8 KB of new transcript. `Stop` needs 60 KB and 20 minutes (DSH 8 KB and 5 minutes). At least 150 characters of your own text, or 30 when a birthday is mentioned. At most 5 memories per run, 28,000 characters of transcript |
| Hook timeouts in `hooks/hooks.json` | `SessionStart` 10 s, `UserPromptSubmit` 9 s, `PreCompact`, `SessionEnd`, `Stop` and `PreToolUse` 5 s each |
| Capsule | at most 9,500 characters in the injected block |
