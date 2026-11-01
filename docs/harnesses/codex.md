# Codex CLI

Anymem connects to OpenAI's Codex CLI as a Codex plugin. Once it is installed and you have approved its hooks, Codex gets your always-on memory at session start, relevant memories on every prompt, and a capture of durable facts when a session ends. The `anymem` skill comes along, so you can also ask Codex to recall or remember something by name.

Tested on Codex CLI 0.157.1, macOS, Python 3.9.6. Anything not listed under "Verified" below was not tried.

## Install

1. Connect this machine to your Worker first (`setup.py` for a new one, `connect.py` for a second machine). The hooks stay silent until the client has a URL and a token.
2. See what the install would change, then install:

   ```
   install.py codex --dry-run
   install.py codex
   ```

3. Start `codex`. It asks you to approve the new hooks. Read them, approve them, then start a new session. You can review them any time with `/hooks`.

What the install does, exactly:

1. Checks that `config.toml` in your Codex folder (`CODEX_HOME`, default `~/.codex`) is valid. If it is not, it stops and changes nothing.
2. Copies `config.toml` to `config.toml.anymem.bak`, once, before the first change.
3. Runs `codex plugin marketplace add <this package>` and `codex plugin add anymem@anymem`. Codex itself writes two tables to `config.toml` (`[marketplaces.anymem]` and `[plugins."anymem@anymem"]`) and copies the package, with its hooks and skill, into `plugins/cache/anymem/` in the Codex folder.

It never approves the hooks for you. Codex runs a hook only after you approve it, and the install leaves that choice to you. Until you do, `install.py --check codex` reports "Codex has not trusted the anymem hooks yet", and that is the one problem it should show.

If a marketplace named `anymem` already points at a different folder, the install refuses and tells you how to remove it.

## What works

| Codex event | What Anymem does |
|---|---|
| SessionStart (startup, resume) | Adds your always-on capsule (identity, preferences, constraints, principles) to the session context. |
| UserPromptSubmit | Recalls the closest memories for the prompt and adds them to the context for that turn. |
| Stop | Starts a detached capture worker when enough new transcript has built up (60 KB and 20 minutes since the last capture). |
| Stop | The same hook also asks the agent for the in session review (`hooks/memory_review.py`): one more short turn to save what it missed, after 60 KB and 20 minutes since the last review. Codex 0.164 honours the `{"decision": "block"}` answer as Claude Code does (proved live 2026-10-31). Never in a `codex exec` run or a subagent, whose rollout says so in its first record. |
| SessionEnd | Starts the same worker when at least 8 KB of new transcript exists. The hook only starts a detached worker and returns, so Codex's 3 second limit on this hook is no problem, and the capture finishes after Codex has exited. |

Captured memories land active, tagged `auto-capture`, and are recalled like any memory (`forget.py ID` removes one). Recall, redaction and project scoping are the shared client's, nothing here changes them.

## Limits

1. **Hooks need your approval, and any change to the plugin copy needs it again.** Codex trusts a hook by a hash of its definition. From 0.164 it also hashes the whole installed plugin folder (every file except `__pycache__`, `.venv`, `*.pyc` and `*.egg-info`) before every hook runs, and compares it with the hash pinned at approval (`codex-rs/hooks/src/engine/plugin_trust.rs` and `plugin_fingerprint.rs` at `rust-v0.164.0`). An approval stores the pin as `trusted_content_hash` in `config.toml`. An approval made before 0.164 gets it in `CODEX_HOME/.hook-trust/<sha256 of the config path and anymem@anymem>` the first time a hook runs. So an upgrade, a reinstall, or `codex plugin add` copying new files (one changed README is enough) turns every anymem hook into `hook: Stop Failed` with no other message. Seen 2026-10-30 to 2026-10-31: the copy moved from 2.1.1 to 2.1.3 and the Worker saw no Codex call for two days. `install.py --check codex` and `doctor.py` now compute the same hash and say when the approval no longer matches. They judge exactly the hooks the active copy's `adapters/codex/hooks.json` declares, each under the key Codex builds for it (`anymem@anymem:adapters/codex/hooks.json:<event>:<group>:<handler>`). Approvals that Codex before 0.157 keyed by file path count as no approval, because current Codex does not read them. The fix is to approve the hooks again with `/hooks`.
2. **No compaction event.** Codex has no equivalent of Claude Code's PreCompact, so a very long session that never ends cleanly is only captured through the throttled Stop hook.
3. **Codex ignores the `args` list form of a hook command.** The shared `hooks/hooks.json` uses it (it is the Claude Code form), and Codex 0.157.1 drops the list: it ran a bare `python3` with no script, the Stop hook reported Failed and the Worker saw no request. The Codex plugin therefore points at `adapters/codex/hooks.json`, which uses plain command strings.
4. **Codex runs a second, internal session for its own memory feature** (no transcript file, working folder named `memories`). The hooks skip it, so your memories are not injected into Codex's own notes agent and nothing is captured from it.
5. **The plugin copy is a snapshot** taken when you install. After you update Anymem, raise `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then run `scripts/upgrade-plugins.sh`. Do not uninstall first: `codex plugin remove` deletes the old version's folder, and an open Codex chat still runs its hooks from that folder until Codex restarts.
6. **Codex keeps its own approval records** in `config.toml` (`[hooks.state...]`). Uninstall does not edit them. They are harmless, and Codex or you can delete them. This was not exercised, because approval can only be given from inside Codex.
7. The hooks run `python3` (3.9 or newer, standard library only) from your `PATH`. Windows is not covered.

## Check it

```
install.py --check codex
```

It reports, with no side effects: the plugin installed and enabled, its hooks file present, Codex's approval recorded, `python3` on the path, and the Worker answering `GET /health` with your credentials. It exits 1 and says what is missing when any of those is not true.

To watch it work, run `codex exec "say hi"` and look for the `hook: SessionStart`, `hook: UserPromptSubmit` and `hook: Stop` lines on stderr. After a session ends, `~/.cache/anymem/capture.log` gets one JSON line per capture: what was proposed, stored or skipped, and why.

## Uninstall

```
install.py --uninstall codex
```

It runs `codex plugin remove anymem@anymem` and `codex plugin marketplace remove anymem`, deletes the backup when `config.toml` matches it again, and removes the empty folders Codex made for the plugin. If you changed `config.toml` after the install, your changes stay and so does the backup. Your memories on the Worker are not touched.

## Settings

| Variable | Effect |
|---|---|
| `CODEX_HOME` | The Codex folder to install into. Must be inside your home folder. |
| `ANYMEM_CODEX_BIN` | Full path to the `codex` command, when it is not on `PATH`. |
| `ANYMEM_RECALL=0` | No recall on prompts. |
| `ANYMEM_CAPSULE=0` | No capsule at session start. |
| `ANYMEM_CAPTURE=0` | No capture. |

## How it is built

| File | Job |
|---|---|
| `adapters/codex/adapter.py` | detect, plan, install, check and uninstall, all through the `codex plugin` commands. |
| `adapters/codex/hooks.json` | The plugin's hooks: plain command strings that call `hook.py` through `CLAUDE_PLUGIN_ROOT`. |
| `adapters/codex/hook.py` | The one entry script. Reads the Codex payload, calls the shared recall, capsule and capture code, prints Codex's protocol, never raises and never writes to stderr. |
| `adapters/codex/payload.py` | Codex payload to the shared keys, and the internal session check. |
| `adapters/codex/emit.py` | The `hookSpecificOutput.additionalContext` output. |
| `adapters/codex/transcript.py` | Reads Codex rollout files for capture, leaving out developer messages, tool output, Codex's own blocks and anything our hooks injected. |
| `adapters/codex/test_adapter.py` | Offline tests, with a fake `codex` command and recorded samples in `adapters/codex/fixtures/`. |

Codex files an injected hook context as a developer message in the rollout, so it is excluded by role. The reader also strips our own recall and capsule blocks by heading, in case a Codex version files them as user text.

## Verified

Version 1 of the client tagged captures `status:draft` and held them until you promoted them. In version 2 a capture is saved active and carries the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, so the tag lists in the output below differ from what you would see today.

Run on 2026-10-08 with `codex-cli 0.157.1`, Python 3.9.6 (the macOS system Python), in throwaway folders only. The real home was compared before and after: `~/.cache/anymem`, `~/.config/anymem`, `~/.codex/config.toml` and `~/.codex/plugins` were identical. Paths below are shortened to `<tmp>`.

The setup: a temp home with a copy of a working Codex `config.toml` and a link to its login, the fake Worker from `client/hm/testing/fake_worker.py` serving one memory whose text holds a marker word made at runtime (`zq955f5f0c33` in this run), a capsule, and one extraction proposal. The plugin package was a copy of the repo with one line changed, `.codex-plugin/plugin.json` `hooks` pointing at `./adapters/codex/hooks.json`. `HOME`, `CODEX_HOME`, `ANYMEM_HOME`, `ANYMEM_CONFIG_DIR` and `ANYMEM_CACHE_DIR` all pointed into the temp folder.

**1. Install, check and uninstall leave the Codex folder byte identical.** Commands, and what they printed (a snapshot of every file hash and folder in the Codex folder, before install and after uninstall, compared equal: `True`):

```
$ install.py codex --dry-run
...
codex: dry run, nothing written                       (folder unchanged)
$ install.py codex --yes
  changed: <tmp>/home/.codex/config.toml
  changed: <tmp>/home/.codex/config.toml.anymem.bak
  changed: <tmp>/home/.codex/plugins/cache/anymem
  Codex does not run the new hooks until you approve them. Start codex and approve the anymem hooks when it asks (review them with /hooks). ...
codex: installed
codex: not ok
  Codex has not trusted the anymem hooks yet, so they do not run. Start codex and approve them when it asks (review with /hooks).
$ diff config.toml.anymem.bak config.toml
> [marketplaces.anymem]
> source_type = "local"
> source = "<tmp>/pkg"
> [plugins."anymem@anymem"]
> enabled = true
$ install.py --uninstall codex --yes
  changed: <tmp>/home/.codex/plugins/cache/anymem
  changed: <tmp>/home/.codex/config.toml
  changed: <tmp>/home/.codex/config.toml.anymem.bak
codex: removed, check() no longer finds the wiring
byte identical to before install: True
```

**2. Hooks that are not approved do not run.** `codex exec -m gpt-5.5 --skip-git-repo-check --sandbox read-only -C <tmp>/ws "<prompt>"`, stdin closed, with the plugin installed and no bypass flag:

```
rc 0 | stdout: 'spring'            (the model guessed from the prompt text)
hook lines on stderr: []
requests the Worker saw: []
marker anywhere in the rollout: False
```

**3. With the hooks approved, the marker reaches the model, and a capture follows.** The same command with `--dangerously-bypass-hook-trust`, used in the throwaway only. The prompt asked for the launch codename of a made up project, told the model to answer from the context it was given and run no tools, and carried a few sentences of background so the session held enough user text to capture:

```
rc 0 | stdout: 'zq955f5f0c33'
hook lines on stderr: ['hook: SessionStart', 'hook: SessionStart Completed', 'hook: UserPromptSubmit', 'hook: UserPromptSubmit Completed', 'hook: Stop', 'hook: Stop Completed']
model answer contains the marker: True
requests the Worker saw: GET /prompt-capsules/core, GET /recall?query=What+is+the+launch+codename..., POST /extract, GET /recall?query=release+notes+style&topK=3&synthesize=false, POST /capture
  rollout[6]  developer  "## Memory capsule (anymem Worker, live) ... Capsule line: keep answers short."
  rollout[7]  user       "What is the launch codename for the aurora project? ..."
  rollout[9]  developer  "## Relevant memories (anymem, recalled for this prompt) ... The launch codename for the aurora project is zq955f5f0c33 ..."
  rollout[11] assistant  "zq955f5f0c33"
first rollout record holding the marker: 9 (the injected context, before the answer)
tool calls made by the model: 0
POST /capture received by the Worker: 1
  source: session-capture | tags: ['auto-capture', 'status:draft'] | content head: --- | name: release-notes-style | description: "We write release notes as ...
capture.log: {"session": "01a11b46", "event": "SessionEnd", "bytes": 47609, "user_chars": 425, "proposed": 1, "memories": [{"name": "release-notes-style", "result": "stored fake-000"}], "redactions": {"transcript": 0, ...}}
```

The marker came through the hook and nowhere else: it first appears in the rollout in the injected developer message, the model made no tool calls, and the answer matches. The capture ran from SessionEnd. The extraction request carried the user's words and none of the injected or developer text (this is also asserted in the offline test).

**4. Uninstall after real sessions.** After the two sessions above, `install.py --uninstall codex --yes` printed `codex: removed, check() no longer finds the wiring`, and then:

```
config.toml byte identical to its pre-install bytes: True
plugin cache folder gone: True
backup gone: True
anything with anymem in its name left under CODEX_HOME: []
```

Codex's own session files (`sessions/`, its databases, caches) stay, as they would without us.

**What this run did not cover.** The sessions ran with `--dangerously-bypass-hook-trust`, so approval through Codex's own prompt, the key format Codex stores for an approved plugin hook, and what uninstall does with such a record were not seen. The Worker was the fake, so recall quality, the relevance cutoff and real extraction were not tested. The run used `--sandbox read-only` instead of the full bypass flags, because an earlier attempt with the sandbox off showed the model searching the whole disk for the answer. In the recorder run Codex started its second, internal session, and in the proof the Worker saw exactly one capsule and one recall request, which fits the hooks skipping it, but that skip was proven by the offline test, not by watching Codex.

Offline: `python3 adapters/codex/test_adapter.py` runs without Codex installed.
