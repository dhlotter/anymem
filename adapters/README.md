# Harness adapters

One folder per harness: `adapters/<name>/`. An adapter connects the shared client core (`client/hm`) and the shared hook logic
(`hooks/`) to one harness. The `install` command (`client/hm/commands/install.py`) finds adapters by importing
`adapters/<name>/adapter.py`, so nothing else registers them.

## Adding a harness we do not ship

Run `install.py --new NAME`. It writes a working starter in `~/.config/anymem/adapters/NAME/` (`adapter.py`, `payload.py`,
`test_adapter.py` and a `fixtures/` folder). `install.py --list` finds it straight away, as not found, with a note on what to
fill in. Fill in `detect`, `plan`, `install`, `check` and `uninstall` one at a time, add the harness's real payloads under
`fixtures/`, and `install.py NAME` then works like any built in adapter. A folder dropped into that directory by hand is
found the same way. If a built in adapter already uses the name, yours is listed as not loadable with that reason, so rename it.
To share an adapter, move the folder into `adapters/` in this repo.

## The contract

`adapters/<name>/adapter.py` defines:

```python
NAME = "codex"                      # the word in `install.py codex`
TITLE = "OpenAI Codex CLI"          # shown to people

def detect() -> dict:
    """{"found": bool, "version": str, "config_path": str, "notes": [str]}. Read only, never writes, never needs the network."""

def plan(options) -> list[str]:
    """Plain sentences describing exactly what install would change, for --dry-run and for the confirmation."""

def install(options) -> dict:
    """Write ONLY this product's own entries, refuse to touch a config file that is not valid, return {"changed": [paths], "notes": [str]}."""

def check() -> dict:
    """{"ok": bool, "problems": [str], "pending": [str]}. Proves the wiring is in place and the hooks reach the Worker, without
    side effects. "pending" holds things only the user can do next (for example approving hooks inside the harness): they are
    shown as next steps and do not fail the check."""

def uninstall() -> dict:
    """Remove only this product's own entries, leave everything else byte identical. Returns {"changed": [paths]}."""
```

`options` is a small object with `dry_run`, `yes`, `plugin_root` (the folder holding hooks/ and client/) and `home`.

## What an adapter must do for the harness

1. **Normalise the payload** to `{hook_event_name, session_id, prompt, transcript_path, cwd}` before it reaches shared code
   (`adapters/<name>/payload.py`). The prompt may have to be read from the transcript.
2. **Emit context** in the harness's own protocol (`adapters/<name>/emit.py`).
3. **Read the transcript** into `[(role, text)]` for capture (`adapters/<name>/transcript.py`), skipping tool output,
   system messages and anything the harness injected itself.
4. **Keep capture off the harness's clock**: detach a worker, as `hooks/memory_capture.py` already does.
5. Hold **no logic that belongs in the core**: credentials, redaction, screening and recall selection all stay in `client/hm` and `hooks/`.

What was recorded for each harness is in `docs/harnesses/`, and the step by step guide is [docs/add-a-harness.md](../docs/add-a-harness.md). Tests live in `adapters/<name>/test_adapter.py` and run offline
with recorded sample payloads and transcripts in `adapters/<name>/fixtures/`.
