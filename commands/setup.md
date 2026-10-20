---
description: Set up Anymem: create the Cloudflare Worker, store the token and prove recall works
argument-hint: "[--name <resource-prefix>]"
---

Setup asks a question before it creates anything ("Go ahead? [y/N]"), and it reads the Cloudflare token without echo. This shell has no terminal to answer either, so the person runs setup in their own terminal (in Claude Code, type it with a `!` prefix): `! python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/setup.py $ARGUMENTS`. Give them that line and wait until they say it has finished. If they have already read the plan it prints and want no question, `--yes` skips the question and the plan: `! python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/setup.py --yes $ARGUMENTS`. Never put the Cloudflare token or any other secret on a command line. Setup reads it from `CLOUDFLARE_API_TOKEN`, or asks for it without echo.

Setup needs a Cloudflare API token (`setup.py --scopes` lists the permissions, and you can run that one here, it prompts for nothing) and no Node.js. It talks to the Cloudflare API directly. If it stops, read the message it prints, fix that one thing, and have them run it again. Rerunning is safe, it does not create anything twice. A rerun keeps the Access and the custom domain the store recorded. Only `--no-access` turns Access off, and setup prints a warning when you use it.

When it finishes, run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/doctor.py --probe` to confirm recall works, then tell the user what was created.
