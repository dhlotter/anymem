"""The anymem installer. Python standard library only, no Node and no Wrangler.

It talks to the Cloudflare REST API and provisions a store in the person's own account (plan section 6).

    cf.py         the REST client, with --dry-run and plain error classes
    preflight.py  what the person needs, the token scope list, the account and scope checks
    resources.py  D1, Vectorize and R2
    worker.py     the Worker upload, the cron, the secret and the address
    access.py     the optional Cloudflare Access app, service token and policies
    limits.py     the plan limits table and the plan question
    run.py        `setup`, in order
    teardown.py   `uninstall`

Every step looks first and creates only what is missing. Nothing here deletes, except teardown.py.
"""
