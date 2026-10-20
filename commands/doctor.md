---
description: Check that Anymem is configured, reachable and recalling
---

Run the anymem skill's `doctor.py --probe` and report each check it prints.

For a failed check, the output names the fix. Apply it when it is a local change, and tell the user what to do when it needs their account or their Cloudflare login. The probe overwrites one test vector and writes no memory.
