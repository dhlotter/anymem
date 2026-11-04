# Cline fixtures

Nothing here was recorded from a live Cline session. All text is invented.

1. `session-start.json`, `prompt.json`, `capture.json`: the JSON `plugin.js` pipes to `hook.py` for each event. The shape is
   what `plugin.js` writes, so the offline tests and the hook tests share one definition of it.
2. `spool.jsonl`: the spool file `plugin.js` writes for the run in `run.json`, one user line and one assistant line.
3. `run.json`: the arguments Cline hands to the `beforeRun`, `beforeModel` and `afterRun` hooks for one run, with a message
   history that has a reasoning part, a tool call, a tool result, a hook context message and a `[SYSTEM]` reminder. The shape
   was read from the shipped Cline code (`snapshot()`, the `<user_input mode="act">` wrapper Cline puts round what the person
   types, `<hook_context>` for hook text, `[SYSTEM]` for run reminders). `plugin.test.mjs` replays it into the plugin.

To replace these with a recording, run a throwaway Cline session with a plugin that writes its hook arguments to a file.
