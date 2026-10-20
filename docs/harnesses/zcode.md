# ZCode

Gives ZCode the same shared memory as your other agents: the always-on capsule at the start of a session, the closest memories on every prompt, and a capture of what was decided as the session goes on.

Tested on ZCode 0.16.9 (the command line inside ZCode app 3.14.4) on macOS. Windows and Linux are not covered.

## Install

You need ZCode installed in `/Applications/ZCode.app`, `node` on your PATH, and a working anymem Worker (`setup.py`, or `connect.py` on a second machine).

1. See what the install will do, without writing anything:

   ```
   install.py zcode --dry-run
   ```

2. Install:

   ```
   install.py zcode
   ```

   It writes a small ZCode plugin folder at `~/.zcode/anymem/plugin`, then asks ZCode to add and install it (`zcode plugins marketplace add`, `zcode plugins install anymem@anymem`). Before the first change it copies each ZCode plugin file that exists (`~/.zcode/cli/config.json`, `~/.zcode/cli/plugins/installed_plugins.json`, `~/.zcode/cli/plugins/known_marketplaces.json`) to `<file>.anymem.bak`.
3. Restart ZCode, or start a new session, so the hooks load.

Where ZCode is not in `/Applications`, set `ANYMEM_ZCODE_APP` to the app folder. To use a specific node, set `ANYMEM_ZCODE_NODE`.

The plugin runs `<the full path of the Python that ran the install> <your anymem folder>/adapters/zcode/hook.py`, so ZCode does not need python3 on its own PATH. If you move that folder, run the install again (`install.py zcode --check` tells you when a hook points at a missing file).

## What works

1. **Capsule at session start.** The always-on rules are added to the session's context.
2. **Recall on every prompt.** The memories closest to your prompt are added to the context, scoped to the project, and only the hits the Worker marks relevant. A memory already shown in the session is not shown again.
3. **Capture as a session goes on.** Your prompts and ZCode's replies are kept in a private file per session. When 8 KB of new conversation has built up, a detached worker condenses it, redacts secrets, asks for durable facts through the extraction that `ANYMEM_EXTRACTION` picks (the local `claude` command when it is installed, which sends the redacted transcript to Anthropic, otherwise the Worker), and saves them active, tagged so you can trace and remove them. [Where the transcript goes](../privacy.md#where-the-transcript-goes-for-extraction) has the details.
4. **The capture policy is respected.** With capture off, or for an excluded session or folder (`capture`, `exclude_paths` and `exclude_sessions` in `~/.config/anymem/config.json`, or `ANYMEM_CAPTURE=0`), nothing is kept at all.

Context reaches the model through ZCode's hook protocol (`hookSpecificOutput.additionalContext`). ZCode shows it to the model as a system reminder named after the event.

## Limits

1. **Only three of ZCode's events are used.** ZCode has SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure and Stop. It has no PreCompact and no SessionEnd.
2. **Capture runs when a turn ends.** With no session end to wait for, a finished turn (Stop) counts as the end of a segment, so capture is due after 8 KB of new conversation, the same bar a session end has. The 60 KB and 20 minute bar that the shared hook uses for Stop would leave nearly every ZCode session uncaptured. A short chat under 8 KB is never captured.
3. **The adapter keeps its own copy of the conversation.** The transcript file ZCode hands a hook is temporary and holds one message (see Verified). So each prompt and reply is appended to `~/.cache/anymem/zcode-sessions/<session>.jsonl` (mode 0600). These files hold your raw prompts. They are deleted after 14 days of no use, and by `install.py --uninstall zcode`.
4. **Project hooks do not work in ZCode.** ZCode removes the `hooks` key from a project's `.zcode/config.json` on purpose. That is why this is a plugin.
5. **ZCode ignores the `args` list of a Claude Code hooks file.** A ZCode hook is one `command` string, so the shared `hooks/hooks.json` cannot be used as it is. The adapter writes its own.
6. **ZCode's own Memory is not touched.** See the next section.
7. **The skill is not installed by this adapter.** It wires the hooks only.
8. **Not checked:** the desktop app's screens. Everything below was driven through ZCode's command line. The app and the command line keep their plugin state in the same `~/.zcode/cli` files, so the app is expected to load the same plugin, but nobody clicked through it.
9. **Not checked:** a real model. The proof runs used a local stand-in server as the model (see Verified), so what is shown is that the memory reached the model's request, not that a particular model used it well.

## ZCode's own Memory

ZCode has its own file based Memory, so two memory systems write to two places. This adapter reports it and never changes a ZCode setting. `install.py zcode --check` prints a `warning:` line while either of these is on.

1. **Command line.** On by default. ZCode adds a Memory section to the model's instructions that tells it to write memory files under `~/.zcode/cli/memories`. It is on unless `features.memory` or `memory.use` is `false` in `~/.zcode/cli/config.json`. To turn it off, add this to that file:

   ```json
   {
     "features": { "memory": false }
   }
   ```

   Checked on 2026-10-08: with `features.memory` false, and separately with `memory.use` false, the Memory section was gone from the system prompt ZCode sent to the model.
2. **Desktop app.** The switch is `memoryEnabled` in `~/.zcode/v2/setting.json` (default false). Switch Memory off in the app's settings. The label of the setting in the app was not checked.

## Check

```
install.py --check zcode
```

It asks ZCode for the plugin list and requires `anymem@anymem` to be installed and enabled with its three hooks runnable, requires each hook's `hook.py` to exist, and calls the Worker's health route with your configured credentials. `zcode plugins list` shows the same plugin with `hooks: 3`.

## Uninstall

```
install.py --uninstall zcode
```

It asks ZCode to uninstall the plugin and remove the marketplace, deletes the copies ZCode leaves behind, deletes `~/.zcode/anymem` and the per session conversation files, and puts each of the three ZCode files back from its `.anymem.bak` when nothing else in it changed. A file that changed for another reason in between (you installed a different plugin) stays as ZCode wrote it, only our entries are gone. If one of those three files did not exist before the install, ZCode leaves its own empty version of it behind.

## Verified

Version 1 of the client tagged captures `status:draft` and held them until you promoted them. In version 2 a capture is saved active and carries the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, so the tag lists in the output below differ from what you would see today.

Date 2026-10-08. ZCode command line 0.16.9 (app 3.14.4), macOS 26 (Darwin 25.6.0, arm64), node v26.8.2, Python 3.9.6 for the hooks and tests.

Everything ran in a throwaway home folder (`$LP`, with `HOME` and `ANYMEM_HOME` pointing at it), a temporary workspace, a local stand-in for the model (an OpenAI compatible server on 127.0.0.1 that answers `OK` to everything and logs every request, set as the default provider in the throwaway `provider_config.json`) and `client/hm/testing/fake_worker.py` as the Worker with one recall result holding a marker word made at runtime. No real credential was used and nothing was written to the real home folder.

A prompt run needs a copy of `zcode.cjs` with `provider/zcode-builtin.json` beside it (`$COPY`), because ZCode run from the app folder cannot find its built in provider config for a prompt. The `plugins` commands work from the app folder (`$ZCODE` below is `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`).

**1. Install, check, a real session, uninstall**

```
$ /usr/bin/python3 $REPO/skills/anymem/scripts/install.py zcode --yes
ZCode (zcode) plan:
  Write a small ZCode plugin folder at $LP/.zcode/anymem/plugin (plugin.json, marketplace.json, hooks/hooks.json). Its three hooks (SessionStart, UserPromptSubmit, Stop) run $REPO/adapters/zcode/hook.py.
  Copy each ZCode plugin file that exists to <file>.anymem.bak first (once): $LP/.zcode/cli/config.json, ...installed_plugins.json, ...known_marketplaces.json.
  Run `zcode plugins marketplace add ...` and `zcode plugins install anymem@anymem`. ...
  No ZCode setting is changed.
  changed: $LP/.zcode/anymem
  changed: $LP/.zcode/cli/config.json
  changed: $LP/.zcode/cli/plugins/installed_plugins.json
  changed: $LP/.zcode/cli/plugins/known_marketplaces.json
  changed: $LP/.zcode/cli/plugins/marketplaces/anymem
  changed: $LP/.zcode/cli/plugins/cache/anymem
  Restart ZCode, or start a new session, so the hooks load.
zcode: installed
zcode: ok
  warning: the ZCode command line has its own file memory on (features.memory and memory.use default to true ...
$ /usr/bin/python3 $REPO/skills/anymem/scripts/install.py --check zcode
zcode: ok
```

The session, with a 9,201 character prompt whose first line was `What is the deploy codename for the billing service? Answer in one short sentence.` followed by a fenced log, run as `node $COPY/zcode.cjs --cwd $LP/ws -p "<prompt>"` (exit 0, 1.5 s, the stand-in model answered `OK`).

(a) The marker reached the model. These are the two messages in the request the stand-in model received, neither of them typed by the person. The marker words are not in the typed prompt.

```
capsule marker: found in request message #3 (role user)
    <system-reminder>
    SessionStart hook additional context:
    #1
    ## Memory capsule (anymem Worker, live)
    ### identity
    Capsule marker hmzcl5dkz4ge. Always answer briefly.
    </system-reminder>
recall marker: found in request message #4 (role user)
    <system-reminder>
    UserPromptSubmit hook additional context:
    #1
    ## Relevant memories (anymem, recalled for this prompt)
    - billing-deploy-codename: the deploy codename of the billing service The deploy codename for the billing service is hmzcg40cu00d.
    </system-reminder>
marker reached the model request: True | marker is NOT in the typed prompt: True
```

(b) The Worker received a capture. What the fake Worker saw, in order, and the audit line the capture worker wrote:

```
  GET /health
  GET /prompt-capsules/core
  GET /recall
  POST /extract body: transcript 2521 chars, max 5
  GET /recall
  POST /capture
  POST /capture body: source='session-capture' tags=['auto-capture', 'status:draft'] content='---\nname: billing-deploy-codename-note ...
transcript sent for extraction holds the user's question: True | holds the injected marker: False
capture.log: {"event": "SessionEnd", "bytes": 9469, "user_chars": 9201, "proposed": 1, "memories": [{"name": "billing-deploy-codename-note", "result": "stored fake-000"}], "redactions": {"transcript": 0, "proposals": 0, "kinds": []}}
```

Uninstall, then a comparison of every path under the throwaway home taken before the install and after the uninstall (ZCode's own `log`, `db`, `rollout`, `exec` and `runtime` folders and the client's `.cache` folder are not part of it, because ZCode and the hooks write to them on any run):

```
$ /usr/bin/python3 $REPO/skills/anymem/scripts/install.py --uninstall zcode --yes
  changed: $LP/.zcode/cli/plugins/marketplaces/anymem
  changed: $LP/.zcode/cli/plugins/cache/anymem
  changed: $LP/.zcode/anymem
  changed: $LP/.cache/anymem/zcode-sessions
  changed: $LP/.zcode/cli/config.json
  changed: $LP/.zcode/cli/plugins/installed_plugins.json
  changed: $LP/.zcode/cli/plugins/known_marketplaces.json
zcode: removed, check() no longer finds the wiring
snapshot B vs snapshot A: only before: [] | only after: [] | changed: []
BYTE IDENTICAL: True (565 paths compared)
leftover .anymem.bak files: []
anything named anymem left under .zcode: []
nothing left in the real home: True
```

The state files existed before the install in that run (a different plugin had been installed and removed first), which is the case the byte comparison covers.

**2. ZCode's temporary transcript, and why the adapter keeps its own file**

A probe plugin called the shared capture hook from ZCode's UserPromptSubmit hook with the thresholds lowered in a test copy (the shipped ones are 8 KB and up), passing ZCode's own temporary file. Observed:

```
{"step": "hook start", "event": "UserPromptSubmit", "temp_file": "/var/folders/.../T/zcode-claude-hook-LGN2WK/transcript.jsonl", "exists": true, "bytes": 538}
{"step": "hook returned", "copies_in_cache": ["eph-sess_2b5ff908-...-1791459167.jsonl"]}
--- afterwards: ZCode's temporary file still exists: False
--- afterwards: copies left in the cache folder: []
--- capture.log: {"session": "sess_2b5", "event": "SessionEnd", "bytes": 538, "user_chars": 471, "proposed": 1, "memories": [{"name": "billing-deploy-codename-note", "result": "stored fake-000"}], ...}
--- Worker got POST /capture: True
```

That probe was run against `keep_ephemeral()` in `hooks/memory_capture.py`, which copied the file before ZCode deleted it. The copy step has since been removed. The ZCode adapter does not need it: its hook hands the shared capture hook its own per session file, so capture never reads ZCode's temporary file.

The format of that file is not Claude's. Each hook gets a file with only the message the event is about (UserPromptSubmit: the prompt, Stop: the reply, SessionStart: an empty file), one JSON line shaped like this, with no top level `type` key:

```
{"message":{"content":[{"text":"Reply with the single word OK","type":"text"}],"role":"user"}}
```

The shared Claude reader finds nothing in it (`adapters/zcode/test_adapter.py` asserts that), so this adapter has its own reader, `adapters/zcode/transcript.py`. And because each file holds one message, a size based capture could never fire from them, which is why `hook.py` keeps its own per session file.

**3. Other things observed on ZCode 0.16.9**

1. A hook written with an `args` list ran as the bare command and failed (36 ms, `hook.run.failed` in ZCode's log). The same hook as one `command` string ran, with `${CLAUDE_PLUGIN_ROOT}` expanded.
2. A hook `timeout` is in seconds: a `sleep 4` hook with `"timeout": 1` was stopped after 1,002 ms and the prompt went through.
3. `plugins list --json` counted 5 runnable hooks for a probe plugin that declared 7 events: PreCompact and SessionEnd are not ZCode events.
4. Hook cost, 7 runs each against a local Worker: session start median 182 ms, prompt 192 ms, capture 181 ms (a Python start plus one local request each). Nothing on stderr.
5. In a headless run SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop fired. No SessionEnd.

**4. Tests, offline**

```
/usr/bin/python3 adapters/zcode/test_adapter.py
```

covers payload normalisation of every recorded fixture, the emitted bytes, the transcript reader (injected blocks excluded, a partial last record kept for the next capture), install, check and uninstall on a temporary home with a byte identical restore (against a stand-in `zcode` that behaves like the real one, `adapters/zcode/fixtures/fake_zcode.py`), the refusal of a ZCode file that is not valid JSON, the plan, and `hook.py` staying silent and exiting 0 on garbage and on an unconfigured client.
