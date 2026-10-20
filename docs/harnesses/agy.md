# Antigravity CLI (agy)

Anymem connects to the Antigravity CLI (the `agy` command) through one entry in a `hooks.json` file. The entry does three jobs: it puts your always-on memory capsule into a conversation, it recalls the memories closest to each message you send, and it captures durable facts when a run ends.

Code: `adapters/agy/`. Tested against agy 1.3.1.

## Install

```
install.py agy
```

The command prints exactly what it will change, asks for a yes, writes, then runs a check. Add `--dry-run` to see the plan and write nothing, or `--yes` to skip the question.

What it writes, and only this:

1. The `anymem` entry in `~/.gemini/config/hooks.json` (created if the file does not exist). Every other hook name in the file stays exactly as it is.
2. A one time backup of an existing file, next to it, as `hooks.json.anymem.bak`.

It refuses to touch a `hooks.json` that is not a valid JSON object, and says so. Fix or move the file and run it again.

The entry looks like this (the path is the folder holding this plugin):

```json
{
  "anymem": {
    "PreInvocation": [{"type": "command", "command": "/path/to/python3 /path/to/adapters/agy/hook.py prompt", "timeout": 15}],
    "Stop":          [{"type": "command", "command": "/path/to/python3 /path/to/adapters/agy/hook.py capture", "timeout": 10}]
  }
}
```

You need `python3` (3.9 or newer) on the PATH that agy runs hooks with, and the client configured (`setup.py` or `connect.py`). Start a new agy session after installing. agy loads a global or workspace `hooks.json` without asking for trust.

Prefer one project only? The adapter can write `.agents/hooks.json` in a workspace instead of the global file. The install command always uses the global file, the workspace form is for tests and scripts (`options.workspace`).

## What works

1. **Capsule.** On the first model call of a conversation the hook injects your always-on memory capsule (identity, preferences, constraints, principles). It comes from the Worker, or from the cached copy when the Worker is unreachable, and says how old the cache is.
2. **Recall.** The prompt is not in agy's hook payload, so the hook reads your newest message from the conversation transcript. When that message is new, it asks the Worker for the closest memories and injects them, scoped to the project and with the shared relevance rules (only hits the Worker marks relevant, no pending memories, no repeats within a session). One user message usually means many model calls (a tool loop), so the hook remembers which message it already handled and prints nothing on the later calls.
3. **Capture.** When agy reports a run is fully idle, the hook hands the transcript to the shared capture code, which starts a detached worker and returns at once. The worker redacts, extracts, and posts each memory to `/capture`, which saves it active. Nothing waits for review.
4. **Nothing echoes back.** Context the hooks inject appears in the transcript as an `EPHEMERAL_MESSAGE` step. The transcript reader skips those, tool output, thinking and anything that did not come from you or the model's own answers, so a memory is never captured as if you had said it.

## Limits

1. **No SessionStart event.** agy has one in the binary but it is undocumented, so the capsule goes in on the first model call instead.
2. **Injected context stays.** agy stores an injected message as a step in the conversation, so it counts against that conversation's context from then on. Recall is capped at about 1,800 characters per message and the capsule at 9,500.
3. **Capture waits for an idle Stop.** It runs at the end of a run, and only when at least 8 KB of new transcript and 150 characters of your own text have piled up (30 when that text mentions a birthday) since the last capture. A run that is cut off hard (the terminal closes) is captured at the end of the next run in that conversation.
4. **Only your explicit messages and the model's answers are read.** A user step that did not come from you (a source other than `USER_EXPLICIT`) is ignored.
5. **Timeouts.** The first model call of a conversation can wait up to 15 seconds in the worst case (capsule fetch 4 seconds, the recall hook 8 seconds, both timing out). Later calls and a healthy Worker are fast (0.05 to 0.2 seconds per hook call, measured on a Mac against the fake Worker, interpreter start included).
6. **The default Python is whatever `python3` is on agy's PATH.** If that is older than 3.9 the hook does nothing and `install.py --check agy` says so.
7. **Not yet proven live:** a multi turn conversation in the interactive TUI, and a resumed conversation. The logic for both (per conversation state keyed by conversation id, a message counted as new by its step number) is covered by offline tests only.

## Check

```
install.py --check agy
```

It confirms the entry is in `hooks.json`, that `hook.py` exists and starts cleanly under `python3`, and that the Worker answers `/health`. It writes nothing. Other places to look:

1. In the agy TUI, `/hooks` lists the loaded hooks.
2. `~/.gemini/antigravity-cli/cli.log` prints `loaded N named hooks from M hooks.json file(s)` at start, and any parse error.
3. `~/.cache/anymem/capture.log` has one line per capture attempt, including why one was skipped.

## Uninstall

```
install.py --uninstall agy
```

Removes the `anymem` entry and nothing else. If the entry was the only change install made, the file goes back byte for byte (from the backup, which is then removed), and a file install created is deleted along with any empty folders it made. Anything you added to the file after installing is kept. The command then runs `check`, which must report the wiring gone.

## Files

| File | Job |
|---|---|
| `adapter.py` | detect, plan, install, check, uninstall |
| `hook.py` | the one script the hooks call, with `prompt`, `capture` or `check` as its first argument |
| `payload.py` | agy's camelCase payload to the shared keys |
| `emit.py` | prints `{"injectSteps":[{"ephemeralMessage":"..."}]}` |
| `transcript.py` | reads `transcript_full.jsonl` for capture and for the newest user message |
| `fixtures/` | payloads and a transcript recorded from a throwaway run |
| `test_adapter.py` | offline tests, `python3 adapters/agy/test_adapter.py` |

## Verified

Version 1 of the client tagged captures `status:draft` and held them until you promoted them. In version 2 a capture is saved active and carries the tags `auto-capture`, `captured-by:HARNESS` and `session:ID`, so the tag lists in the output below differ from what you would see today.

Run on 2026-10-08 with agy 1.3.1 on macOS, model `gemini-3.7-flash-high`, hooks started by `python3` 3.14.7 on the PATH (the offline tests run under macOS Python 3.9.6 and 3.14.7). Everything below used a throwaway folder as home and workspace, the fake Worker from `client/hm/testing/fake_worker.py` (one recall result whose body holds a marker word generated at run time, a capsule, and one extraction proposal), and a throwaway config and cache folder. No real credential and no real Worker were involved.

Install with the adapter into the throwaway workspace (`TMP` stands for the temp folder):

```
plan:
   Create TMP/agy-live-g8luiv3n/home/ws/.agents/hooks.json, which does not exist yet.
   Add the "anymem" entry ... PreInvocation hook that runs python3 .../adapters/agy/hook.py prompt (capsule and recall, 15 second limit).
   The same entry gets a Stop hook that runs python3 .../adapters/agy/hook.py capture (capture when a run ends, 10 second limit).
   Nothing else is written. `install.py --uninstall agy` removes exactly this entry.
check: {'ok': True, 'problems': []}
```

Two runs of the real harness, each from the throwaway workspace with stdin closed and the Worker address in the environment:

```
agy --dangerously-skip-permissions --model gemini-3.7-flash-high --print="What is the release codename for the staging cluster? Answer with just the codename."
agy --dangerously-skip-permissions --model gemini-3.7-flash-high --print="<a 454 character prompt about release notes ending in the same question>"
```

Observed:

```
RUN 1: rc=0  stdout='quillferndb657a'   marker in answer: True   stderr=''
RUN 2: rc=0  stdout='quillferndb657a'   marker in answer: True   stderr=''

transcript steps (each conversation):
    0 USER_EXPLICIT USER_INPUT       '<USER_REQUEST> What is the release codename for the staging cluster? A...'
    1 SYSTEM_SDK    EPHEMERAL_MESSAGE '## Memory capsule (anymem Worker, live)  Always-on rules from ...'
    2 MODEL         PLANNER_RESPONSE 'quillferndb657a'

fake Worker saw, in order:
    GET /health                       (from check)
    GET /prompt-capsules/core         run 1
    GET /recall?query=What+is+the+release+codename+for+the+staging+cluster%3F
    GET /prompt-capsules/core         run 2
    GET /recall?query=We+are+tidying+our+release+notes+today+and+I+want+the+wo
    POST /extract
    GET /recall?query=staging+codename+note
    POST /capture
```

1. **Marker reached the model.** The marker was random, appeared only in the Worker's recall result, and the model answered with it. The transcript shows our injected step (type `EPHEMERAL_MESSAGE`) between the request and the answer.
2. **Capture, declined path.** Run 1 had 8,690 bytes of transcript, so the capture hook did start a worker. `capture.log` says why it stopped: `"event": "SessionEnd", "bytes": 8690, "user_chars": 84, "result": "skipped: too little user text"`. Nothing was posted.
3. **Capture, stored path.** Run 2 (454 characters of user text) ended with `"proposed": 1, "memories": [{"name": "staging-codename-note", "result": "stored fake-000"}]`, and the fake Worker received `POST /capture` with `"source": "session-capture"` and the tags `auto-capture`, `status:draft`. The injected capsule was not in the posted text.
4. **A tool loop.** A separate recorded run asked the model to run `echo hello` first. agy made two model calls (`invocationNum` 0 and 1). The Worker saw one `/prompt-capsules/core` and one `/recall`, and the model still answered with the marker after the tool call, so injected context survives the loop. (The fixtures in `fixtures/` come from that run.)
5. **Uninstall and the home folder.**

```
uninstall: changed only TMP/.../home/ws/.agents/hooks.json
check after uninstall: ok False, problems: 'TMP/.../hooks.json has no "anymem" entry.'
throwaway HOME is byte identical to before: True      (tree after: {'ws': 'dir'})
real ~/.gemini/config/hooks.json existed before: False, after: False
real ~/.gemini/config listing, ~/.cache/anymem and ~/.config/anymem: unchanged (hashes compared before and after)
```

One thing the runs did leave: agy keeps its own conversation history under `~/.gemini/antigravity-cli/brain/<conversationId>/` for every run, with or without this adapter. That is the harness's own state, not something the adapter writes.

Offline tests: `/usr/bin/python3 adapters/agy/test_adapter.py` prints `ok` after 106 passing checks, covering payload normalisation, the emit bytes, the transcript reader (including the injected block and a partial last record), install then check then uninstall with a byte identical restore, refusal of invalid config, the accuracy of `plan()`, and `hook.py` on garbage input and with an unconfigured client.
