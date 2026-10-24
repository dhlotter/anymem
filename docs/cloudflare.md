# Cloudflare resources

anymem runs entirely on your own Cloudflare account. This page lists what setup creates there, what it never creates, and how to run it without a domain of your own. The steps in order are in [install](install.md). What each plan allows is in [limits](limits.md).

## What setup creates

`NAME` is the name you give setup, `anymem` by default.

| # | Resource | Default name | When it is created | What it holds or does |
|---|---|---|---|---|
| 1 | D1 database | `NAME-db` | always | Memories, versions, links, subjects, devices, the audit trail and counters |
| 2 | Vectorize index | `NAME-vectors` | always | One 384 dimension cosine vector per memory chunk, with metadata indexes on `project` and `origin` |
| 3 | R2 bucket | `NAME-backups` | always | The nightly backup. A rule deletes objects under `backups/` after 30 days |
| 4 | Worker | `NAME` | always | All of the code, with bindings to the database, the index, the bucket, Workers AI and the dashboard files, and the secret `AUTH_TOKEN` |
| 5 | Cron trigger | `0 1 * * *` | always | The nightly job at 01:00 UTC |
| 6 | Address | `NAME.SUBDOMAIN.workers.dev` | always | The workers.dev address of your account, unless you pass `--domain` |
| 7 | Access service token | `NAME-machines` | with `--access` | The credential your machines send to Access. It lives one year |
| 8 | Access application | `NAME` | with `--access` | Sits on the address, with two policies. One lets the service token in and one lets your email in through a browser |
| 9 | Custom domain | your domain | with `--domain` | Attached to the Worker. workers.dev is then turned off |

A store set up by an earlier version may carry other names. `deploy.json` in your config folder records the names and ids that setup made, and never a secret.

Items 1 to 5 are the whole of anymem. Workers AI is not a separate resource, only a binding on the Worker. It does the embeddings that search needs and four small model jobs on a save. Cloudflare gives Workers AI a free daily allowance and bills past it on a paid plan. See [Cloudflare's pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) for the current figures.

## What it never creates

1. No KV namespace, Durable Object, Queue, AI Gateway, Pages project or Hyperdrive.
2. No DNS record of its own. When you attach a custom domain, Cloudflare adds the proxied record that points the name at the Worker. Setup makes no DNS call, but the token needs DNS edit permission on that zone for the attach to work.
3. No deletion. Setup looks first and creates only what is missing, and it stops rather than adopt a resource that already has its name and was not made by setup. Uninstall removes only what `deploy.json` says setup made. See [install](install.md).

## Running without a domain of your own

You do not need a domain, a zone or any DNS to run anymem.

1. **The default.** Leave out `--domain`. The Worker answers on `https://NAME.SUBDOMAIN.workers.dev`, where the subdomain is your account's workers.dev name. Setup creates one if the account has none, and `--subdomain` chooses it.
2. **Access works there too.** With `--access`, the Access application sits on the workers.dev address, so the dashboard and the browser login work the same way. Without Access the bearer token is the only lock and the dashboard is unavailable. See [security](security.md).
3. **What a domain adds.** A name you choose, and workers.dev switched off so the Worker has one address only. You can also add the setting `ALLOWED_HOSTS` to the `vars` block of `worker/wrangler.jsonc`, which makes the Worker refuse any other name even if workers.dev is turned back on. Setup does not set it for you. A domain needs a zone on your account and a token that can edit Workers routes and DNS on that zone.
4. **What you give up without one.** Nothing functional. The address is longer and chosen by Cloudflare, and workers.dev stays on.
5. **What has been measured.** The author's store runs on a custom domain. A workers.dev store was set up and checked on 2026-10-17, and the long wait for it to answer is in [install](install.md). Whether Access on a workers.dev address behaves exactly like Access on a custom domain has not been checked separately.

## Moving between the two

A plain rerun of setup keeps the address and Access it recorded. To move a workers.dev store onto a domain, rerun setup with `--domain`. workers.dev is then turned off for the Worker. A connection string carries the Worker address, so every machine needs a new one, made with `devices.py add NAME --share` and connected again. This move has not been rehearsed, so run `doctor.py --probe` afterwards and check that Access answers on the new name.
