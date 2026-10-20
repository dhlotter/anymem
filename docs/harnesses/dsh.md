# DeepSeek Harness (dsh)

DeepSeek Harness is the agent runtime you start with the `dsh` command (and the desktop app built on it). This page covers connecting it to your Anymem Worker: install, what works, the limits we found, how to check it, and how to remove it. The code is in `adapters/dsh/`.

With the adapter installed, a dsh session gets three things from your Worker:

1. **The capsule** at session start: your always-on rules.
2. **Recalled memories** with each prompt: the closest few, injected as context before the model answers.
3. **Capture** when a turn ends: durable facts from the session are saved to the Worker, active, tagged so you can trace and remove them.

## Install

You need Python 3.9 or later, and a Worker that `setup.py` or `connect.py` has already configured on this machine.

```
install.py dsh --dry-run     # prints exactly what would change
install.py dsh               # asks, installs, then runs the check
```

Then start a new dsh session. DSH reads its hook files when it starts, so a running session does not pick them up.

Install changes two things, nothing else:

1. **Our own hooks file**, `~/.config/anymem/dsh-hooks.json`. It holds three hooks (session start, prompt, stop), each one command that runs `adapters/dsh/hook.py`.
2. **One marked block at the end of each profile's patch file**, `~/.dsh/profiles/<profile>/cordis.patch.yml`. The block mounts a second copy of DSH's Claude Code hook bridge on our hooks file:

```
# anymem begin
- insert:
    - id: hooks-anymem
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: "/home/you/.config/anymem/dsh-hooks.json"
# anymem end
```

Hooks you already have keep running. A second bridge instance with its own id sits beside the first (proved below). The first install of a patch file also saves a copy as `cordis.patch.yml.anymem.bak`.

We never parse or rewrite your YAML. We only append text, so your comments, order and formatting stay as they are. Install refuses, changes nothing at all, and prints the block to add by hand when a patch file is not a plain block style list: a mapping, a flow list with entries, a `---` document start, Windows line endings, unpaired markers, bytes that are not UTF-8, or an existing entry that already uses the id `hooks-anymem`. It also refuses when `dsh-hooks.json` exists and is not ours. The template DSH writes (comments and a lone `[]`) is accepted: the `[]` line is replaced by the block, and uninstall puts it back.

Everything is written under your home folder. `$DSH_HOME` is honoured when it points inside it.

## What works

| DSH event | Our hook | What it does |
|---|---|---|
| `SessionStart` | `hook.py session-start` | Prints the capsule as context, from the Worker or the cached copy |
| `UserPromptSubmit` | `hook.py prompt` | Recalls memories for the prompt, prints them as context, under the shared 8 second deadline (`ANYMEM_HOOK_DEADLINE`) |
| `Stop` | `hook.py capture` | Starts a detached capture worker when enough has happened, and returns at once |

All three speak the Claude Code contract through DSH's bridge: the payload comes in as JSON on stdin and context goes out as `{"hookSpecificOutput": {"hookEventName": ..., "additionalContext": ...}}`. The hook never raises, never writes to stderr and always exits 0, so memory cannot break or slow a session.

Capture reads DSH's own session log (`session.v4.jsonl.zstd`, see the limits below). It keeps what the person typed and what the model answered in text. It leaves out reasoning, tool calls and results, the system prompt, the workspace instructions, and everything a hook injected, so a recalled memory is never captured back as if you had said it.

## Limits

1. **Capture only runs on Stop, with a lower bar than other tools.** DSH has no `SessionEnd` or `PreCompact` event, so the shared capture hook runs on `Stop` only. Other harnesses wait for 60 KB of new text and 20 minutes. DSH gets 8 KB and 5 minutes (`STOP_RULES` in `hooks/memory_capture.py`), so an ordinary chat is captured. A one prompt headless run is still too short. To save what a very short session said, ask the agent to save it with the anymem skill, or run the worker by hand (see Verified).
2. **DSH hides secret looking environment variables from hooks.** Variables whose names contain `TOKEN`, `SECRET`, `KEY` or `PASSWORD` do not reach a hook process (measured). `ANYMEM_URL` does, `ANYMEM_TOKEN` does not. Keep the token in `~/.config/anymem/config.json` (`setup` and `connect` write it there) or use a `credential_command`. The check says so when the token is only in the environment.
3. **DSH runs hooks inside its file sandbox, which refuses writes outside the session folder and the temp area.** In the default `workspace-write` mode a hook cannot write `~/.cache` or `~/.config`, and capture cannot save where it stopped. The hook detects this and moves its cache to a private folder in the OS temp area (`<temp>/anymem-<uid>`, mode 0700) unless you set `ANYMEM_CACHE_DIR`. Reading is not restricted, so the config file is found as usual. A capture that fails to save is recorded in that temp folder, and `doctor.py` and `resave` fold it into the main failure list when they run, so it is listed (checked 2026-10-10). A temp folder can also be cleaned by the operating system, which costs the capsule cache and the capture bookkeeping. `DSH_PERMISSION_MODE=danger-full-access` lifts the restriction, we do not recommend it for this.
4. **The capsule can miss the first request.** DSH's bridge runs `SessionStart` hooks detached, and its README says their context can miss the first request. It reached the model in every run we did (see Verified), but treat it as best effort.
5. **DSH puts the capsule inside the prompt it reports.** The bridge builds `prompt` from every message waiting for the turn, so the first prompt arrives as the capsule followed straight by what you typed. Left alone, recall would search with the capsule text. The capsule we print ends with the line `(end of the anymem capsule)`, and the adapter cuts everything up to it off before recall sees the prompt. Context another hook injects ahead of ours would stay in the prompt.
6. **DSH keeps its session log as Zstandard frames, and `transcript_path` is always empty.** DSH's bridge says so itself. Python only gets a zstd module in 3.14, so the adapter ships a small pure Python decoder (`dsh_zstd.py`, tested against the `zstd` tool). It finds the log by session id under `$DSH_HOME/sessions` (or `ANYMEM_DSH_SESSIONS`), reads only the frames added since the last capture, and leaves a frame that is still being written for next time. No `zstd` tool is needed.
7. **The desktop profile is not tested.** The CLI refuses to load it (the Electron app owns it), so we could not run it. Install wires it the same way as any profile, and the real desktop patch file on the machine we tested on was classified as a plain list and survived an in memory add and remove unchanged, but no desktop session ran our hooks. The desktop app may also rewrite its patch file through its own settings screen. If it drops comments, our markers go with them: the check then reports "markers are gone", and you remove the leftover entry by hand and install again.
8. **Linux and Windows are untested.** We ran macOS only. The sandbox and the temp area behave differently elsewhere.

## Check

```
install.py --check dsh
```

It proves, with no side effects: every profile has our block, the hooks file is valid and holds all three hooks, the hook script starts under the recorded Python and loads the shared hooks (`hook.py ping` prints `ok`), the client is configured with a token the hooks can see, and `GET /health` on your Worker answers. It exits 1 and lists each problem otherwise.

To see it work yourself, start dsh and ask for something a stored memory answers. The recalled block is in the session log as a message from `hooks-claude-code`.

## Uninstall

```
install.py --uninstall dsh
```

It cuts out exactly the marked block (putting back a `[]` it replaced and a missing final newline), deletes the backup when the file is back to what it saved, deletes our hooks file, and removes `~/.config/anymem` only if it is then empty. Anything you added to a patch file after install stays. Afterwards the check reports the wiring gone.

By hand: delete the lines from `# anymem begin` to `# anymem end` in each patch file, and delete `~/.config/anymem/dsh-hooks.json`.

## Verified

Version 1 of the client tagged captures `status:draft` and held them until you promoted them. In version 2 a capture is saved active and carries the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, so the tag lists in the output below differ from what you would see today.

Run on 2026-10-08. DSH 0.2.0-rc.2, macOS, Python 3.9.6 (the system one), anymem at this branch. Everything below ran in a throwaway folder against a fake Worker (`client/hm/testing/fake_worker.py`), with fake credentials built at run time. The model calls used DSH's own sign in (the `deepseek-flash` model) on a harmless prompt, with the real `~/.dsh` only read, never written.

**Setup.** A throwaway home with two profiles: `headless` (a patch file that already holds another hooks bridge, id `hooks-claude-code`, standing in for hooks you already have) and `scratch` (DSH's untouched template, comments and `[]`). The fake Worker held one recall result whose body carries a marker generated at run time, and a capsule whose text carries a second one. The token sat in the config file, not the environment.

**1. Install, check, patch files.**

```
$ install.py dsh --yes
  DeepSeek Harness (dsh) plan:
    write $P/home/.config/anymem/dsh-hooks.json with the capsule, recall and capture hooks (this file is ours alone)
    back up $P/home/.dsh/profiles/headless/cordis.patch.yml once as cordis.patch.yml.anymem.bak, then add one marked block ...
    back up $P/home/.dsh/profiles/scratch/cordis.patch.yml once as cordis.patch.yml.anymem.bak, then add one marked block ...
    changed: $P/home/.config/anymem/dsh-hooks.json
    changed: $P/home/.dsh/profiles/headless/cordis.patch.yml.anymem.bak
    changed: $P/home/.dsh/profiles/headless/cordis.patch.yml
    changed: $P/home/.dsh/profiles/scratch/cordis.patch.yml.anymem.bak
    changed: $P/home/.dsh/profiles/scratch/cordis.patch.yml
    wired 2 profile(s): headless, scratch
  dsh: installed
  dsh: ok
$ install.py --check dsh
  dsh: ok
```

`headless` ended with its own entries untouched and our block appended after them. `scratch` ended as its three comment lines, then `# anymem begin replaces-empty-list`, our block, and the end marker (the `[]` is gone until uninstall). DSH accepts the result. On a second throwaway home holding DSH's untouched headless template, after install:

```
$ DSH_HOME=$P/home/.dsh dsh --profile headless --dump-config
...
# == $P/home/.dsh/profiles/headless/cordis.patch.yml
- id: hooks-anymem
  name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: >-
      $P/home/.config/anymem/dsh-hooks.json
```

and after `install.py --uninstall dsh --yes` that patch file compared equal (`cmp`) to the original and `~/.config` was empty again.

**2. Two bridge instances coexist, from the installed patch file.** The throwaway `DSH_HOME` has nobody signed in, so the model call fails, but hooks run before it:

```
run 1 (throwaway DSH_HOME, not signed in) rc=1 dsh: ACCOUNT_SIGN_IN_REQUIRED: Sign in to DeepSeek to use the account provider. ...
   the profile's own bridge saw: ['SessionStart', 'UserPromptSubmit']
   fake Worker saw: [('GET', '/prompt-capsules/core'), ('GET', '/recall')]
```

Both bridges fired from one profile: the one that was already there (`hooks-claude-code`) and ours (`hooks-anymem`), which reached the Worker.

**3. The marker reaches the model.** To get an answer from the model, the signed in profile ran with the exact block install wrote, as a `--patch` overlay (plus two overrides that send the session log and storage into the throwaway folder, and the other bridge again). Prompt: "tell me the codename of the ferry timetable project and the capsule check word, using only the context you were given".

```
run 2 (signed in profile, install's block as overlay) rc=0
   model answer: codename=HM170F0E66 capsule=CAPE1D9B1
   marker in answer: True | capsule word in answer: True
   the profile's own bridge saw: ['SessionStart', 'UserPromptSubmit', 'Stop']
   fake Worker saw: [('GET', '/prompt-capsules/core'), ('GET', '/recall')]
   recall query sent to the Worker: ['I am testing a memory system. Using only the context you were given in this session (the recalled memories and the capsule), tell me two things on one line: ...']
   prompt as the bridge reported it to the profile's own hook starts with: ['## Memory capsule (anymem Worker, live)\n\nAlways-on r']
```

The model repeated both words, so `additionalContext` works for `UserPromptSubmit` and for `SessionStart`. The session log shows the two injected messages with source `hooks-claude-code`, each holding its marker. The last line is limit 5: the bridge hands every hook the capsule glued in front of the prompt, and the recall query above is the question, not the capsule.

**4. Capture.** The Stop hook fired live and, as expected for a 32 KB session, declined:

```
   Stop hook state (capture-state.json): {"session-...": {"offset": 0, "ts": 1791460081.18, "started": 0, "done": 0}}
   capture.log: none (no worker was started)
```

It first saw the session at that Stop, and the shared rule needs 20 minutes and 60 KB after that. So the worker was run by hand, the way the hook starts it, on the real log DSH had just written:

```
$ python3 hooks/memory_capture.py --worker <session log> <session id> Stop <workspace> --format dsh
   transcript.read_turns: [('USER', 'I am testing a memory system. Using only the context you wer'), ('ASSISTANT', 'codename=HM170F0E66 capsule=CAPE1D9B1')] offset 32087 of 32087
   capture.log: {"event": "Stop", "bytes": 32087, "user_chars": 347, "proposed": 1, "memories": [{"name": "ferry-codename-note", "result": "stored fake-000"}], ...}
   Worker requests: ... ('POST', '/extract'), ('GET', '/recall'), ('POST', '/capture')
   POST /capture body tags: ["auto-capture", "status:draft"]
```

Only the two real turns were read: the injected capsule and recalled memory in the log were left out. To exercise the hook path itself, a third run made a longer session (a tool result of about 1,400 lines, log 68,194 bytes). The live Stop hook declined again, then the recorded Stop payload was replayed through `hook.py capture` after moving that session's first sight 60 minutes back in the throwaway cache:

```
run 3 (long session with a big tool result) rc=0 answer: codename=HM170F0E66 lines=1400
   replayed the recorded Stop payload through hook.py capture: rc=0 stdout='' stderr=''
   POST /capture received after the replay: 1 | capture.log: {"event": "Stop", "bytes": 68194, "user_chars": 344, "proposed": 1, "memories": [{"name": "ferry-codename-note", "result": "stored fake-000"}], ...}
```

The hook returned at once, silently, and the detached worker it started reached the Worker with `POST /capture`. The 20 minute wait was simulated by editing the throwaway state file, nothing else was faked. In this run the hooks' cache sat in the temp folder (limit 3): `capsule.json`, `capture-state.json`, `capture.log` and `recall-seen.json` were all written there from inside DSH's sandbox.

**5. Uninstall leaves nothing.**

```
$ install.py --uninstall dsh --yes
    changed: $P/home/.dsh/profiles/headless/cordis.patch.yml
    changed: $P/home/.dsh/profiles/headless/cordis.patch.yml.anymem.bak
    changed: $P/home/.dsh/profiles/scratch/cordis.patch.yml
    changed: $P/home/.dsh/profiles/scratch/cordis.patch.yml.anymem.bak
    changed: $P/home/.config/anymem/dsh-hooks.json
  dsh: removed, check() no longer finds the wiring
$ install.py --check dsh        (rc=1)
  dsh: not ok
    profile headless has no anymem block
    profile scratch has no anymem block
    the hooks file $P/home/.config/anymem/dsh-hooks.json is missing
throwaway home identical to before install: True (9 entries before, 9 after, compared by file hash)
```

Nothing was left in the real home: the real `~/.dsh` credential, storage, session and patch files kept their modification times, nothing in `~/.dsh` was newer than the start of the run, there is no `dsh-hooks.json` under the real `~/.config/anymem`, and the real recall cache does not mention the test memory.

**What we measured about DSH on the way** (each with a throwaway hook that logged what it saw): hooks fire for `SessionStart`, `UserPromptSubmit` and `Stop` in a headless run; the payload is Claude Code shaped and `transcript_path` is empty; DSH's own log is `session.v4.jsonl.zstd`, a file of independent Zstandard frames that each end on a line; secret named environment variables are removed from hooks; the sandbox refuses hook writes under the home folder but allows the temp area, localhost and the internet, and lets a hook start processes (including a detached one and `claude -p`).

**Offline tests**, which need no dsh and no network: `python3 adapters/dsh/test_adapter.py` (payload and event handling for every recorded sample, the emit bytes, the transcript reader with the injected block excluded and a partial last frame, the decoder against the `zstd` tool when it is installed, install, check and uninstall round trips with a byte identical restore for seven shapes of patch file, ten shapes of refused patch file plus a file that is not UTF-8, `plan()`, and `hook.py` on garbage and on an unconfigured client).

**Not verified:** the desktop app profile, Linux, Windows, whether the desktop app rewrites the patch file, and any `dsh` version other than 0.2.0-rc.2.
