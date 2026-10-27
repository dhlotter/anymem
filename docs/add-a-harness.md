# Add a harness

Six harnesses ship with Anymem. A seventh takes one adapter, a folder of small Python files. The shared code does the work. The adapter only translates between that code and the harness.

## What an adapter is for

The shared hooks in `hooks/` and the core in `client/hm/` already do recall, capture, the capsule, redaction, screening, project detection and the audit log. They speak the Claude Code hook protocol, which most harnesses copy. An adapter does the parts that differ.

1. **Install and uninstall.** Write Anymem's own entries into the harness config, and take exactly them out again.
2. **Normalise the payload.** Turn the harness's hook payload into `{hook_event_name, session_id, prompt, transcript_path, cwd}`. The prompt may have to be read from the transcript.
3. **Emit context.** Print the capsule or the recalled memories in the way the harness injects context.
4. **Read the transcript.** Turn the harness's session file into a list of `(ROLE, text)` turns for capture.
5. **Check.** Prove the wiring is in place and the hooks reach the Worker, with no side effects.

## Step by step

1. **Find out what the harness gives you.** Run it with a logging hook, as we did on 2026-10-08. Write down which events fire, what the payload holds, whether the prompt is in it, how context goes back in, where the session transcript lives and what it looks like, and how long a hook may run. The guides in `docs/harnesses/` show what we recorded for each of ours.
2. **Scaffold it.**

   ```bash
   install.py --new NAME
   ```

   It writes `adapter.py`, `payload.py`, `test_adapter.py` and a `fixtures/` folder in `~/.config/anymem/adapters/NAME/`. Every function is a working stub. `install.py --list` finds it straight away, as not found, with a note on what to fill in. A folder dropped into that directory by hand is found the same way. If a built in adapter already has the name, yours is listed as not loadable with that reason, so rename it.
3. **Fill in `adapter.py`**, one function at a time, in this order.

   ```python
   NAME = "myharness"          # the word in `install.py myharness`
   TITLE = "My Harness"        # shown to people

   def detect() -> dict:
       """{"found": bool, "version": str, "config_path": str, "notes": [str]}. Read only, no writes, no network."""

   def plan(options) -> list[str]:
       """Plain sentences saying exactly what install would change. Used by --dry-run and the confirmation."""

   def install(options) -> dict:
       """Write only this product's own entries. Refuse a config file that is not valid. Return {"changed": [paths], "notes": [str]}."""

   def check() -> dict:
       """{"ok": bool, "problems": [str], "pending": [str]}. Proves the wiring, with no side effects.
       "pending" holds things only the person can do next, such as approving hooks. They are shown as next steps and do not fail the check."""

   def uninstall() -> dict:
       """Remove only this product's own entries and leave everything else byte identical. Return {"changed": [paths]}."""
   ```

   `options` has `dry_run`, `yes`, `plugin_root` (the folder holding `hooks/` and `client/`) and `home`. Mark your entries so uninstall can find exactly them, as the DSH adapter does with `# anymem begin` and `# anymem end` lines. Back up a file once before the first change. Never rewrite a file you do not own.
4. **Write the hook entry script**, `hook.py EVENT`, that the harness runs. It reads the payload from standard input, normalises it, and calls the shared code. Its first line of work is to name the harness with `os.environ["ANYMEM_HARNESS"] = "myharness"` (an assignment, not `setdefault`, so a variable left in the environment cannot change it). Add the same id to `IDS` in `client/hm/harnesses.py` and to `HARNESSES` in `worker/harnesses.js`, with the name the dashboard should show. A test in each language fails when the two lists differ, and `client/tests/test_harness_names.py` shows how to check that your hook sends the name. Pass the same id as the format to `memory_capture.hook`, so a capture is saved under it.

   | Job | Call |
   |---|---|
   | Session start | `memory_capsule.block()` returns the capsule text, or `None` |
   | Each prompt | `memory_recall.run(payload)` returns the text to inject, or an empty string |
   | End of a session | `memory_capture.hook(payload, FORMAT)` starts a detached capture worker and returns at once |

   Print the result in the harness's format from an `emit.py`. The Codex, ZCode and agy adapters are short examples.
5. **Write `transcript.py`** if the harness's transcript is not Claude's format. It needs one function.

   ```python
   def read_turns(path: str, offset: int) -> tuple[list[tuple[str, str]], int]:
       """([(ROLE, text)], new byte offset). ROLE is USER or ASSISTANT."""
   ```

   It must leave out tool output, system messages, reasoning and anything the harness or a hook injected, so a recalled memory is never captured back as if you had said it. It must leave a partial last record for the next capture and return an offset that stops before it. The format name is the adapter's folder name and may use lowercase letters, digits and underscores, 30 characters at most. The capture hook finds the reader by that name in `adapters/NAME/transcript.py`. The capture hook looks in the repo's `adapters/` folder first, then in `adapters/` under your config folder (`~/.config/anymem`, or `ANYMEM_CONFIG_DIR` when set), the same two folders `install.py` uses. A reader in either one is found without moving it.
6. **Add recorded payloads and transcripts** under `fixtures/` as you learn them, and test against them. `test_adapter.py` runs offline.
7. **Install it and watch it work.** `install.py NAME --dry-run`, then `install.py NAME`, which runs your `check()`. Start a session and look at the capsule at session start, a recalled memory on a prompt, and `~/.cache/anymem/capture.log` after the session ends.

To share an adapter, move the folder into `adapters/` in this repo.

## Rules an adapter keeps

1. **Never raise, never write to standard error, exit 0 on any failure.** A hook must not wedge or slow a session.
2. **Keep capture off the harness's clock.** Capture starts a detached worker. Some harnesses clamp a hook to 3 seconds, Codex does on `SessionEnd`.
3. **No logic that belongs in the core.** Credentials, redaction, screening, project detection and recall selection stay in `client/hm` and `hooks/`.
4. **Touch only your own entries.** Stay inside the home folder. Refuse a config file that is not valid, and change nothing in that case.
5. **Respect the policy.** Use `hm.policy.allowed(session_id, cwd)` before you read a transcript or buffer a turn, as the ZCode adapter does.
6. **Do not read secrets from the payload into logs.** Print nothing from the environment.

## What the other adapters teach

1. **Codex** has a plugin with its own `hooks.json`, a trust step you must not bypass, a 3 second clamp on `SessionEnd`, and internal sessions of its own memory feature that must be skipped.
2. **Antigravity** has no prompt in its payload, so the adapter reads the newest message from the transcript.
3. **ZCode** deletes its transcript file when the hook returns, so the adapter keeps its own copy of the conversation and the capture hook copies a temporary transcript first.
4. **DSH** hides environment variables whose names contain TOKEN, SECRET, KEY or PASSWORD, refuses hook writes under the home folder, stores its log as Zstandard frames, and runs hooks through a bridge that glues the capsule in front of the prompt.
5. **Kilo** has no shell hooks and no transcript file, so the adapter is a JavaScript plugin that keeps a spool file of the conversation and calls the same Python hooks.
6. **Cline** is also a JavaScript plugin, installed by Cline's own `plugin install` command from a generated folder. Its hook limit is 3 seconds, so the plugin gives the hook script a 2 second deadline. Its `beforeRun` hook runs before the user's message is in the conversation, so recall happens in `beforeModel`, where the message is visible.
