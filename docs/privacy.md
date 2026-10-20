# Privacy

This page lists exactly what leaves your machine, where it goes, what the redactor removes, how to switch things off and how to delete.

There is no Anymem service. Nothing is sent to us. Your machine talks to your own Worker in your own Cloudflare account, and in one configuration to the model provider behind the `claude` command.

## What leaves your machine

| What | When | Where it goes |
|---|---|---|
| The cleaned prompt, up to 240 characters | Every prompt, for recall | Your Worker, in the URL of `GET /recall`. The Worker embeds it and scores relevance with Workers AI, then looks it up in your D1 and Vectorize |
| The redacted, condensed transcript, up to 28,000 characters, plus up to 6,000 characters of what is already known (what the agent saved this session and your cached capsule) | At compaction, session end and the long session backstop, for capture | Either the local `claude` command, so the model provider behind it, or your Worker's `POST /extract`, which uses a Workers AI model in your account. See below |
| Each accepted proposal, redacted again | After extraction | Your Worker, `POST /capture`. It stores the text in D1 and its embeddings in Vectorize. The Worker's sensitivity and contradiction checks send the text to a Workers AI model in your account |
| What you save with `remember.py`, `append.py` and `update.py` | When you or the agent run them | Your Worker, the same way |
| The token, and the Access pair if set | With every request | Your Worker and Cloudflare Access only, in request headers |
| Cloudflare API calls | At setup and uninstall | Cloudflare, as you, with an API token you give it. It is never written to disk |

Things that stay on your machine are your files, your code, the raw transcript, tool output, and anything the redactor removed. The config, caches and logs are listed in [architecture](architecture.md).

The memories we inject come back from your Worker and become part of the prompt your agent sends to its own model provider. That provider sees them, as it sees everything else in the prompt.

## What the Worker records about use

The Worker's `audit` table keeps one row per authenticated request for 90 days. Refused and anonymous calls write no row, and neither do the dashboard's own file loads. It holds the time, who called (admin, a device id, or a browser login's email), the harness and script labels the client sent, the method, the route without its query string, the status, the duration and memory ids. It holds no text, no prompt and no token. The local `~/.cache/anymem/audit.log` is the same shape. A counted recall also leaves one row per relevant memory in a `recall_log` table (time, harness, memory id) for 90 days, and the hook reports how many prompts it left quiet as a daily count per harness. No query, prompt or memory text is in either. See [security](security.md).

## Where the transcript goes for extraction

Extraction runs in one of two places. `ANYMEM_EXTRACTION` or the config key `extraction` chooses.

1. **`local`.** The redacted transcript goes to the model behind the `claude` command, `haiku` by default (`ANYMEM_CAPTURE_MODEL` changes it). That is Anthropic, under your own account and terms.
2. **`worker`.** The redacted transcript goes to your Worker, which runs it through a Workers AI model in your Cloudflare account. The model is `@cf/meta/llama-3.1-8b-instruct-fast` unless you set `SMALL_MODEL` on the Worker.
3. **`auto`, the default.** `local` when a `claude` command exists on the machine, otherwise `worker`.

Whichever you pick, the transcript is redacted on your machine first.

## What the redactor removes

The redactor runs on the condensed transcript and again on each proposal. A replacement reads `[REDACTED:kind]`. It covers the following.

1. **Known token shapes.** Private key blocks, `sk-` style API keys, GitHub tokens, Slack tokens, AWS access key ids, Google API keys, JSON web tokens, `Bearer` and `Basic` credentials, npm and Hugging Face tokens, GitLab tokens, and credentials inside a URL such as `https://user:password@host`.
2. **Named values.** In `KEY=VALUE` and `"key": "value"` pairs the value is replaced when the key name contains secret, token, password, passwd, api key, auth or credential. The key stays. A key named `author` is left alone.
3. **Long runs.** A run of 32 or more letters and digits that mixes both, so most generated tokens. Hyphenated slugs, dates, names with underscores, runs of only letters or only digits, and a git sha written after the word commit are left alone.
4. **Home folders.** Absolute home folders on macOS and Linux, which contain your account name, become `~/`.

The redactor is idempotent. Running it twice changes nothing more. It does not remove names of people, projects, companies and customers, ordinary sentences, a short password written in prose, or any secret that matches none of the shapes above. The capture log records how many redactions happened and their kinds, never what was removed. The Worker checks for secrets again with the same shapes.

## The off switches

1. **Capture off in the config file.** Set `"capture": "off"` in `config.json`. Any value other than `proposals` is treated as off, so a typo never captures.
2. **Capture off for one shell or machine.** `ANYMEM_CAPTURE=0`. It beats the config file.
3. **Exclude folders.** `"exclude_paths": ["~/work/private", "~/clients/*"]`. Sessions whose folder, or a parent of it, matches are never read. Entries can be absolute prefixes or globs.
4. **Exclude sessions.** `"exclude_sessions": ["abc123"]`, matched as a session id prefix.
5. **Recall off.** `ANYMEM_RECALL=0` stops the per prompt recall, and the prompt is never sent.
6. **Capsule off.** `ANYMEM_CAPSULE=0` stops the session start injection.
7. **Mark text as not to be remembered.** Wrap anything in `<private>` and `</private>`, in a prompt or a reply. It is removed before the session is read for capture and before the prompt is used to search memory, so it is never extracted, saved, or sent to a model by Anymem. A tag that is opened and never closed hides the rest of that message. It works in every harness. One limit, if the assistant repeats the private text in its own reply without the tags, that copy is not hidden.
8. **Uninstall the hooks.** In Claude Code, disable or uninstall the plugin. For the others, `install.py --uninstall NAME`.

An example config that keeps capture on but away from private folders.

```json
{
  "capture": "proposals",
  "exclude_paths": ["~/work/private", "~/clients/*"],
  "exclude_sessions": []
}
```

## How to delete

1. **One memory.** `forget.py ID` moves it to the trash, where it stays 14 days and `restore.py ID` brings it back. After that the nightly job deletes it for good, with its tags, versions, links and vectors.
2. **An automatic capture.** `forget.py ID` does the same. `list.py --origin capture` lists them.
3. **Everything you stored.** `uninstall.py --delete-resources` deletes the Worker, the Access application and service token, the Vectorize index and the D1 database that setup recorded, including every memory in them. It asks you to type `delete`. The R2 backup bucket is kept unless you add `--include-backups`. Back up first if you might want them again. See [install](install.md).
4. **The local files.** Uninstall leaves your client config in place. Delete `~/.config/anymem/` and `~/.cache/anymem/` yourself. The capture log and `failed.jsonl` hold memory text, so remove them if you do not want it kept.
5. **Backups.** The nightly backups in R2 expire after 30 days. A copy made with `backup.py` is yours to delete. The audit log holds routes and ids, never text.

Deleting from your own Cloudflare account is governed by Cloudflare's own retention. We have no copy.
