# Claude Code

Claude Code is the first complete path. All its hook events were probed live on 2026-10-08. The plugin ships a skill, three slash commands (`/anymem:setup`, `/anymem:connect` and `/anymem:doctor`), the hooks and the scripts.

## Install

1. Add the plugin.

   ```
   claude plugin marketplace add dhlotter/anymem
   claude plugin install anymem@anymem
   ```

2. **Restart Claude Code.** It reads plugin hooks when it starts, so they do not fire until you do.
3. Create the server if you have not (`setup.py`), or connect to one (`connect.py <url>`). See [install](../install.md).
4. Run `doctor.py --probe`.

The agent runs the skill's scripts in `skills/anymem/scripts/` directly. Each slash command runs the matching script and tells the agent how to handle its output. The `connect` command tells the agent to ask you to paste the token in your own terminal and never in chat.

## The hooks

They are listed in `hooks/hooks.json`, which uses `${CLAUDE_PLUGIN_ROOT}` for paths and runs each script with `python3`.

| Event | Matcher | Script | Timeout | What it does |
|---|---|---|---|---|
| `SessionStart` | `startup`, `resume`, `clear`, `compact` | `session_start.py` | 10 s | Injects the always on capsule, up to 9,500 characters. Uses the cached copy when the Worker is unreachable, and says how old it is |
| `UserPromptSubmit` | any | `memory_recall.py` | 9 s | Recalls the closest memories for the prompt and injects up to three. Stops itself at 8 s (`ANYMEM_HOOK_DEADLINE`) and skips prompts the harness wrote |
| `PreCompact` | any | `memory_capture.py` | 5 s | Starts a detached capture worker when there is enough new transcript |
| `SessionEnd` | any | `memory_capture.py` | 5 s | The same, at the end of a session |
| `Stop` | any | `memory_capture.py` | 5 s | The same, as a backstop for long sessions. Needs 60 KB and 20 minutes |
| `Stop` | any | `memory_review.py` | 5 s | Asks the session's own agent for one more short turn to save what it missed (`{"decision": "block"}`). Needs 60 KB and 20 minutes since the last review and 150 characters from the person. Never in a headless run, never on the turn it started. Off with `ANYMEM_REVIEW=0` |
| `PreToolUse` | `Write`, `Edit`, `MultiEdit`, `Bash` | `native_memory_guard.py` | 5 s | Does nothing unless `ANYMEM_NATIVE=block`. See below |

Context reaches the model through `hookSpecificOutput.additionalContext`. The capture hooks return at once and do the work in a detached process, so they never hold up a session. Details are in [architecture](../architecture.md). A hook that fails prints nothing and lets the session carry on.

## The native memory switch

Claude Code has its own auto memory, which writes notes under `~/.claude/projects/<project>/memory/`. If both memories are on, you have two sources. There are two switches.

1. **Claude Code's own setting.** Set `autoMemoryEnabled` to `false` in your Claude Code `settings.json`.
2. **The guard.** Set `ANYMEM_NATIVE=block` in the environment Claude Code runs in. The `PreToolUse` hook then denies `Write`, `Edit` and `MultiEdit` calls into a native memory folder, and `Bash` commands that write into one with a redirect, `tee`, `mv`, `rm`, `mkdir` or `cp`. The denial tells the model to call `remember.py` instead. Reads are never blocked. A write hidden inside `python -c` or a subshell is not seen.

The guard is off until you set the variable, so wiring it changes nothing by itself.

## Credentials

The scripts and the hooks read the Worker address and token from the environment, then `~/.config/anymem/config.json`, then the plugin options, then a `credential_command`. The one exception is the address, where a value printed by the `credential_command` beats the file and the plugin options. The plugin declares two options, `url` and `token`, and the token is marked sensitive so Claude Code keeps it in the platform's credential store. Set them with:

```bash
claude plugin configure anymem
```

Commands the agent runs through the Bash tool do not receive plugin options, so the config file stays the main source for the scripts. The plugin options are an extra for the hooks. See [install](../install.md#configuration-reference).

## What to expect

1. At session start you may see a "Memory capsule" block. It is empty until you create capsule memories, and doctor says so as a warning.
2. Memories that come up in a prompt appear as "Relevant memories" in the context.
3. Captured memories are saved active. To see what was saved lately run `list.py --origin capture --days 7`, and `forget.py ID` removes one.
4. The skill's token cost is shown by `claude plugin details anymem`. We have not published a figure.

## Uninstall

Disable or uninstall the plugin in Claude Code. To remove the server as well, see [install](../install.md#uninstall).
