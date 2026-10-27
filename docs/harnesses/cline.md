# Cline

Cline 3 (the `cline` command line and the Cline desktop app, both built on the Cline SDK) has no shell hooks anymem can use. It does run JavaScript plugins, and a plugin can add text to a model request and watch every run. Our adapter is a small plugin that calls the same Python hooks every other harness uses.

This guide is about Cline 3.0.74 (desktop app 0.0.49). The older Cline extension for VS Code is a different product and is not covered. We have not checked whether it loads these plugins.

## Install

```
install.py cline
```

1. **Generate.** Install writes a folder, `~/.config/anymem/cline-plugin`, that holds exactly two files. `anymem.js` is a copy of `adapters/cline/plugin.js` with our plugin root and the Python path written into it. `package.json` has the name, the version and one explicit plugin entry. The entry matters, because without one Cline's installer takes every `.js` file in the folder as a plugin.
2. **Install.** It runs `cline plugin install ~/.config/anymem/cline-plugin --force --json` with `HOME` set to the home folder install was given. Cline copies the folder to `~/.cline/plugins/_installed/local/cline-plugin-HASH/package/` and loads plugins from there. No Cline settings file is edited.
3. **Restart.** Cline reads plugins when a session starts. Restart Cline or start a new session.

`install.py cline --dry-run` prints the plan and writes nothing. Install needs Cline 3 or later. It finds the command line from `ANYMEM_CLINE_BIN`, then `cline` on PATH, then `/Applications/Cline.app/Contents/MacOS/cline-cli`, and the first one that reports version 3 or later wins. The first run of `cline plugin install` on a machine may create Cline's own `~/.npm` and cache folders. Uninstall leaves those alone.

Install is safe to repeat. A second run changes nothing and does not run the command again, unless Cline's copy differs from the generated one, in which case it is replaced. If the command fails, the generated folder is put back as it was and nothing else changes. Install refuses a `cline-plugin` folder that is not ours, which means one whose `anymem.js` does not start with the `// anymem begin` line or that holds any other file.

You also need the usual setup (`setup.py` or `connect.py`) so the hooks know your Worker URL and token. The plugin never holds a credential.

## What works

| What | How | Where |
|---|---|---|
| Recall per message | On the first model call of a run, `hook.py prompt` gets the user's message and the memories it returns are added to the model request as a `hook_context` message right after that message. Later model calls of the run, and of later runs, get the same block again in the same place, because Cline rebuilds each request from its own messages. | `beforeModel` |
| Always-on capsule | In the same call, in parallel, `hook.py session-start` runs once per conversation. Its text goes first in every request of that conversation. | `beforeModel` |
| Capture | After each run the plugin writes the new user and assistant text to `~/.cache/anymem/cline/CONVERSATION.jsonl`, only while the capture policy allows it, then starts `hook.py capture`, which starts the shared detached capture worker. `hook.py` sends `keep` with every session start and prompt reply. It is false when `ANYMEM_CAPTURE=0`, `capture` is off, or the folder or session is excluded, and then nothing is written. | `afterRun` |
| Redaction, screening, project scoping, the off switch | All of it lives in the shared core and applies unchanged. | `client/hm`, `hooks/` |

Nothing is stored in Cline's own messages, so a recalled memory can never be captured back as if you had said it. The spool reader also cuts out any recall or capsule block it finds, as a second guard. Sub agents and teammates (an agent with a parent, or the role `teammate`) never recall and never capture.

## Why recall is in beforeModel and not beforeRun

Cline calls the `beforeRun` hooks before it adds your message to the conversation (read in the shipped code, `callBeforeRunHooks` runs first, then the message is pushed). At that point the snapshot holds only earlier messages, so the new message is not there to recall for. The first model call of a run is the earliest hook that sees it, and `beforeModel` can return a replacement message list for that one request. We use that.

The message you type reaches the plugin wrapped as `<user_input mode="act">...</user_input>`. The plugin takes the wrapper off before recall and before writing the spool. It skips anything with `displayRole` system, text that starts with `<hook_context`, `[SYSTEM]` reminders and teammate updates when it looks for your message.

## The 3 second limit

Cline stops a plugin hook after 3 seconds, and counts a timeout as a failure. A plugin that fails five hooks in a row is turned off for the rest of the session. So the plugin never lets a hook run that long.

1. The child process is killed at 2.6 seconds. The whole hook gives up at 2.75 seconds, whatever the child does.
2. The plugin sets `ANYMEM_HOOK_DEADLINE=2` for `hook.py`, which is the shared deadline of the recall hook, and `ANYMEM_HOOK_TIMEOUT=2` for the capsule's network call. The deadline starts when Python is up, about 0.1 to 0.25 seconds after the spawn (measured, Python 3.14 and 3.9), so the reply lands at about 2.1 to 2.3 seconds, before the kill.
3. A slow one is dropped, the message goes through with no memory, and nothing is shown as an error. A reply that comes late is thrown away, never added in the middle of a run.
4. If the capsule did not arrive, the next run asks for it again, twice at most.
5. **The credential warm-up.** The first anymem call after a quiet spell is slow because the secret manager behind `credential_command` is cold. Measured on 2026-10-27 on this Mac, the capsule call took 2.3 seconds cold and 0.4 seconds warm, and a recall call took up to 3.1 seconds cold and about 1.6 seconds warm. A cold first prompt would miss Cline's limit almost every time. So the plugin starts `hook.py warm` in a detached child when a Cline session starts, and again before a run once 45 minutes have passed. `warm` only loads the settings, which runs the credential command and caches its answer. Every child the plugin starts uses `ANYMEM_CRED_TTL=3600`, so the cache lives an hour and not 15 minutes. The cache file is the same plain text file with mode 0600 that is described in [security](../security.md).

The shared recall hook also looks up your profile and people before the search, inside the same deadline. We left the shared hook as it is. Even warm, a recall can take close to the 2 second deadline, so some prompts get no recall block. The capsule still tells the model to run `anymem recall` itself, and in a live test the model did that.

## Limits

1. **Cline 3.0.74 is the only version we read.** The plugin relies on the shape of the hook arguments in that build (`snapshot.messages`, `request.messages`, `metadata.displayRole`, the `<user_input>` wrapper). A new release can change them. Run `install.py --check cline` after an upgrade.
2. **No session start event.** The capsule rides on the first model call of a conversation, so that call waits for it, up to 2.6 seconds.
3. **Recall adds time before the first model call of a run.** About 1.6 seconds when the credentials are warm, up to the 2 second deadline.
4. **Capture follows the end of a run.** Cline has no session end event, so the end of a run is reported as SessionEnd and the shared rule applies. A capture only runs once at least 8 KB of new conversation text has built up since the last one. A short session captures nothing, on purpose.
5. **A recalled block lives in the plugin's memory.** It is added again to every request while the message it was recalled for is still in the conversation. If Cline compacts that message away, or the Cline process restarts, the block is gone and is not recalled again, because the recall hook does not repeat a memory it already showed in a session.
6. **Resumed conversations.** The capsule is fetched again in a new process, and the spool starts at the first new run, not at the old history.
7. **Cline discards a plugin's console output** (its plugin documentation says so), so a problem shows up as missing memory, not as a message. `install.py --check cline` and `~/.cache/anymem/audit.log` are the places to look.
8. **Spool files** older than 14 days are deleted at session start.
9. **Global only.** Install puts the plugin in your home folder. To try it on one project, install it with `cline plugin install FOLDER --cwd PROJECT` yourself.
10. **A working Cline account and model are your side of it.** The adapter cannot make a model answer.

## How to check

1. `install.py --check cline` checks that the generated folder is ours, that the paths baked into it exist, that Cline's copy is there and the same as the generated one, that `hook.py session-start` answers with valid JSON, and that your Worker answers `GET /health`. It writes nothing in your real folders, and it tells you to restart Cline.
2. `cline config --json` lists the plugin as `anymem` with `enabled` true. That command creates Cline's data folders if they are missing, so install does not run it.
3. In a new session, ask about something only a memory knows. The recalled memory shows up in the model's answer.
4. `~/.cache/anymem/capture.log` gets one line per capture, and `~/.cache/anymem/cline/` holds the spool files.

## Uninstall

```
install.py --uninstall cline
```

That runs `cline plugin uninstall` on our copy by its path, then deletes the generated folder and any folder install had to create, when it is empty. Another plugin of Cline's is never touched. If the Cline command is gone, it removes the one install folder that is verified to be ours. If `cline plugin uninstall` fails, the generated folder stays, so uninstall can be run again. The spool files and your memories are not touched.

## What was measured, and what was not

Checked on 2026-10-27 on macOS with Cline CLI 3.0.74 and Python 3.9.6 and 3.14, Node 26.

1. **Read in the shipped code.** The order of `callBeforeRunHooks` and the message push, the arguments of the `beforeRun`, `beforeModel` and `afterRun` hooks, what `beforeModel` may return (`messages`, `tools`, `options`), the `<user_input>` wrapper, the 3 second hook timeout and the failure count, the plugin manifest rule (hooks need the `hooks` capability).
2. **Run for real, against a throwaway home.** `cline plugin install FOLDER --force --json` and `cline plugin uninstall PATH` with `HOME` set to a temporary folder. The install folder, the answer fields (`installPath`, `entryPaths`) and the uninstall by path behave as the adapter assumes, and `cline config --json` listed the plugin. The real `~/.cline` was not touched.
3. **Offline tests.** `adapters/cline/test_adapter.py` (a stub `cline` command, a fake home, the fake Worker) and `adapters/cline/plugin.test.mjs` (29 tests of the plugin with a fake child process boundary). They include a Worker that never answers, which `hook.py` answers inside 2.6 seconds.
4. **Not verified.** A live Cline session (that the plugin loads, that the `hook_context` message reaches the model, that returning `messages` from `beforeModel` is honoured in that build, that the model uses the memory). The hook arguments in `fixtures/run.json` were written from the code, not recorded. The Cline desktop app. Whether the plugin loads in the VS Code extension. Recall latency against a Worker through Cline's own process, and the cost of Cline sending the whole snapshot to the plugin on every hook. Cline versions other than 3.0.74.

Offline tests, no Cline needed:

```
/usr/bin/python3 adapters/cline/test_adapter.py
node --test adapters/cline/plugin.test.mjs
```
