# Security

Anymem holds personal memory, so a flaw can expose it. Please report one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a security problem.

Include what you found, how to reproduce it, and which version (`doctor.py` prints it). You will get an answer within a few days.

## What is in scope

1. The Worker (`worker/`), including auth, device tokens, the dashboard and the backup and export routes.
2. The client, hooks and setup scripts (`client/`, `hooks/`, `setup/`, `skills/`).
3. The harness adapters (`adapters/`).

## Supported versions

Only the latest release gets fixes. Upgrade with the steps in `docs/install.md`.

## Good to know

1. Anymem runs in your own Cloudflare account. The dashboard sits behind Cloudflare Access, and device tokens are stored as hashes.
2. Never put a token, a connection string or a memory export in an issue or a pull request.
