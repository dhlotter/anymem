# Kilo fixtures

Recorded 2026-10-08 from throwaway runs of Kilo 7.7.5 (`kilo run -m kilo/kilo-auto/free "Reply with the single word OK"`)
in a temporary home and project, by `adapters/kilo/live_proof.py --record`. Nothing here comes from a real session.
The temporary folder name is replaced by `/tmp/hm-kilo-fixture`.

1. `session-start.json`, `prompt.json`, `capture.json`: the JSON the plugin piped to `hook.py` for each event (recorded).
2. `pre-compact.json`: same shape as `capture.json`, written by hand, because a short run never compacts.
3. `spool.jsonl`: the spool file the plugin wrote for that run, one user line and one assistant line.
4. `events.jsonl`: the hooks Kilo called in a second plain run, trimmed (session.updated, session.drained, deltas, status and
   diff events and bulky metadata removed). `plugin.test.mjs` replays it into the plugin.
