# Kilo

Kilo (the `kilo` command, built on OpenCode) has no shell hooks and no transcript file, so our adapter is a small JavaScript plugin. It calls the same Python hooks every other harness uses.

## Install

```
install.py kilo
```

That writes one file, `~/.config/kilo/plugin/anymem.js`, and nothing else. Kilo loads every plugin in that folder, so we do not edit any Kilo config file. Start a new Kilo session afterwards.

1. `install.py kilo --dry-run` prints exactly what would change and writes nothing.
2. The file starts with a `// anymem begin` line. Install refuses to overwrite a `anymem.js` that does not start with it.
3. Reinstalling backs our own file up once as `anymem.js.anymem.bak`.
4. The plugin has our plugin root and the Python path baked in, so move the checkout or the Python and you run install again. `install.py --check kilo` tells you when that is needed.

You also need the usual setup (`setup.py` or `connect.py`) so the hooks know your Worker URL and token. The plugin never holds a credential.

## What works

| What | How | Where |
|---|---|---|
| Always-on capsule | The first model call of a session runs `hook.py session-start`. The plugin pushes the capsule onto the system prompt on every call of that session, because Kilo rebuilds the system prompt on each call. | `experimental.chat.system.transform` |
| Recall per prompt | `chat.message` runs `hook.py prompt` with the user's text (8 second limit). The result goes onto the system prompt for the model calls of that turn and is dropped when the turn ends. | `chat.message`, then the same system hook |
| Capture | The plugin keeps a spool file of the conversation (the user's messages and the assistant's finished text, nothing else), and only while the capture policy allows it. `hook.py` sends `keep` with every session start and prompt reply. It is false when `ANYMEM_CAPTURE=0`, `capture` is off, or the folder or session is excluded, and then nothing is written. When a turn ends (`session.idle`) it starts `hook.py capture`, which starts the shared detached capture worker on the spool. Compaction does the same with the PreCompact event. | `event`, `experimental.session.compacting` |
| Redaction, screening, project scoping, the off switch | All of it lives in the shared core and applies unchanged. | `client/hm`, `hooks/` |

Injected memory goes into the system prompt, never into a message, so a recalled memory can never be captured back as if you had said it. The spool reader also cuts out any recall or capsule block it finds, as a second guard.

## Limits

1. **Kilo 7.7.5 is the only version we have run.** Two of the hooks we use are marked experimental by Kilo (`experimental.chat.system.transform`, `experimental.session.compacting`), so a new Kilo release can change them. Run `install.py --check kilo` after an upgrade.
2. **Capture follows the end of a turn.** Kilo has no session end event, so the end of a turn is reported as SessionEnd and the shared rule applies: a capture only runs once at least 8 KB of new conversation text has built up since the last one. A short session captures nothing, and that is on purpose.
3. **Recall adds time before the model call.** Up to 8 seconds by default for the whole hook (`ANYMEM_HOOK_DEADLINE`, with the recall call itself capped at 6 by `ANYMEM_RECALL_TIMEOUT`), and the plugin gives up at 8 too. Set `ANYMEM_HOOK_DEADLINE` to 7 if you want the hook to finish first. On a timeout or an error the prompt goes through unchanged.
4. **No transcript file means the spool is the record.** Only conversation that happens while the plugin is loaded is captured. Spool files older than 14 days are deleted at session start.
5. **Kilo installs its own dependencies.** The first time Kilo sees a global plugin folder it creates `~/.config/kilo/node_modules` and a few package files. That is Kilo's doing and uninstall leaves it alone.
6. **Global only.** Install puts the plugin in your home folder. To try it on one project, copy the installed file into that project's `.kilo/plugin/` folder.
7. **A tool loop repeats the recall block.** The system prompt is rebuilt on every model call, so a turn with several tool calls carries the recalled memories on each one. We have not measured that cost live.
8. **A working Kilo account and model are your side of it.** The adapter cannot make a model answer.

## How to check

1. `install.py --check kilo` reads the installed file, checks the paths baked into it, and asks your Worker `GET /health`. It writes nothing.
2. In a new session, ask about something only a memory knows. The recalled memory shows up in the model's answer.
3. `~/.cache/anymem/capture.log` gets one line per capture, and `~/.cache/anymem/kilo/` holds the spool files.
4. To run the whole thing against a real Kilo with a fake Worker and a throwaway home, use the script that produced the output below: `/usr/bin/python3 adapters/kilo/live_proof.py` (it needs Kilo and a model Kilo can reach, and touches nothing real).

## Uninstall

```
install.py --uninstall kilo
```

That deletes the plugin file, our backup, and any folder install had to create, when it is empty. Everything else stays as it was. `check` must then report the wiring gone. The spool files and your memories are not touched.

## Verified

Version 1 of the client tagged captures `status:draft` and held them until you promoted them. In version 2 a capture is saved active and carries the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, so the tag lists in the output below differ from what you would see today.

Checked on 2026-10-08 with Kilo 7.7.5 (model `kilo/kilo-auto/free`), macOS, Python 3.9.6 (`/usr/bin/python3`), Node v26. The live run used a fake Worker, a fresh `HOME` for Kilo, a throwaway project, and throwaway anymem config and cache folders. Both words below were generated at run time and exist only in the fake Worker, so the model could only have got them from our hooks.

Command:

```
/usr/bin/python3 adapters/kilo/live_proof.py
```

Output (`$T` is the throwaway folder, `<repo>` the checkout):

```
throwaway folder: $T
step 1: priming run, no plugin
step 2: install
PROVEN  bare install then uninstall leaves ~/.config byte identical
  plan:
    - Write one Kilo plugin file: $T/home/.config/kilo/plugin/anymem.js. Kilo loads every plugin in that folder, so no Kilo config file is edited.
    - Create the folder $T/home/.config/kilo/plugin (uninstall removes it again when it is empty).
    - The plugin calls the shared hooks in <repo>: the capsule at the first model call of a session, recall for each prompt, and capture when a turn ends. It keeps a spool of the conversation in the anymem cache folder.
    - Uninstall deletes the plugin file and leaves everything else as it was.
  changed: .config/kilo/plugin/anymem.js
PROVEN  check() ok and the Worker answered /health: {"ok": true, "problems": []}
step 3: a prompt about a memory only the fake Worker holds
  model answer: The ferry route codename is `ferryoeyallz`, and the project mascot is the ottergzyhrse.  > code · kilo-auto/free
PROVEN  recall marker reached the model: ferryoeyallz
PROVEN  capsule marker reached the model: ottergzyhrse
PROVEN  the Worker saw GET /recall and GET /prompt-capsules/core
step 4: the same question padded past the 8 KB capture floor
PROVEN  the Worker received POST /extract from the capture worker
PROVEN  the Worker received POST /capture: {"content": "---\nname: ferry-route-codename-live\ndescription: \"Codename agreed for ", "source": "session-capture", "tags": ["auto-capture", "status:draft"]}
  capture.log: {"ts": "2026-10-08T13:28:33+0200", "session": "ses_ee4b", "event": "SessionEnd", "bytes": 10860, "user_chars": 10709, "proposed": 1, "memories": [{"name": "ferry-route-codename-live", "result": "stored fake-000"}], "redactions": {"transcript": 0, "proposals": 0, "kinds": []}}
  spool files: ses_ee4ba72d5ffeSBgGxUHtSc0142.jsonl (10860 bytes), ses_ee4ba9310ffe12kyz7CrAIjIu3.jsonl (292 bytes)
step 5: a short session, the capture hook should decline
PROVEN  the short session started no capture worker: spool 92 bytes, floor 8000, state offset 0
PROVEN  the capture state saw the session and recorded no worker run
step 6: uninstall
  changed: .config/kilo/plugin/anymem.js, .config/kilo/plugin
PROVEN  check() reports the wiring gone
PROVEN  our plugin file and folders are gone
PROVEN  after the live run and uninstall, ~/.config differs from the snapshot only by Kilo's own dependency install: 3928 paths Kilo added itself (kilo/node_modules and its package files), ours left behind: none
PROVEN  the real home was not touched (kilo plugin folder and anymem config folder listings unchanged)
summary: {"ok": true, "requests": ["GET /health", "GET /recall", "GET /prompt-capsules/core", "GET /recall", "GET /prompt-capsules/core", "POST /extract", "GET /recall", "POST /capture", "GET /prompt-capsules/core", "GET /recall", "GET /prompt-capsules/core"]}
```

What that proves:

1. **Recall and capsule reach the model.** The answer to a question about the ferry route and the project mascot holds both unique words.
2. **Capture reaches the Worker.** A padded session crossed the 8 KB floor, the detached worker called `POST /extract`, then `POST /capture`, and the capture log records `stored`.
3. **A short session is declined.** 92 bytes of spool against a floor of 8000, so no worker started and the capture state shows offset 0.
4. **Uninstall is clean.** A bare install then uninstall leaves `~/.config` byte identical. After the live run, the only difference left is Kilo's own `node_modules` install, and nothing of ours remains. Our listing of the real `~/.config/kilo/plugin` and `~/.config/anymem` folders was identical before and after.

Not proven live: compaction capture (`experimental.session.compacting` never fired in a short run), a turn with several tool calls, and any Kilo version other than 7.7.5.

Offline tests, no Kilo needed:

```
/usr/bin/python3 adapters/kilo/test_adapter.py
node --test adapters/kilo/plugin.test.mjs
```
