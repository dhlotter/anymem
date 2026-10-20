#!/usr/bin/env python3
"""The one entry point DSH's hook bridge calls. The first argument names the event:

    hook.py session-start   print the memory capsule as context
    hook.py prompt          print the memories recalled for the prompt as context
    hook.py capture         start a detached capture worker when enough has happened (Stop)
    hook.py ping            print "ok" after loading everything, for `install.py --check`

It reads the bridge's JSON payload on stdin, normalises it (payload.py), calls the shared hook code in hooks/, and prints in
the bridge's protocol (emit.py). It never raises, never writes to stderr and always exits 0, so memory can never break or
slow a DSH session: recall runs under the shared hook deadline (8 seconds by default, ANYMEM_HOOK_DEADLINE), its own call is capped at 6 seconds, and capture only starts a worker and returns.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
EVENT_FOR = {"session-start": "SessionStart", "prompt": "UserPromptSubmit", "capture": "Stop"}


def writable(folder: Path) -> bool:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tempfile.TemporaryFile(dir=str(folder)).close()
        return True
    except OSError:
        return False


def pick_cache_dir() -> None:
    """DSH runs hooks inside its file sandbox, which by default refuses writes outside the session folder and the operating
    system's temp areas. Measured with a probe hook: ~/.cache and ~/.config were refused, the temp folder was not. When the
    usual cache folder cannot be written, keep the cache in a private folder in the temp area instead. Without that, capture
    cannot save where it stopped and never starts, and the capsule is never cached. An explicit ANYMEM_CACHE_DIR wins."""
    if os.environ.get("ANYMEM_CACHE_DIR") or writable(Path.home() / ".cache" / "anymem"):
        return
    fallback = Path(tempfile.gettempdir()) / ("anymem-%d" % os.getuid())
    try:
        fallback.mkdir(mode=0o700, exist_ok=True)
        info = fallback.lstat()
        if not fallback.is_symlink() and info.st_uid == os.getuid() and writable(fallback):
            os.chmod(str(fallback), 0o700)
            os.environ["ANYMEM_CACHE_DIR"] = str(fallback)
    except OSError:
        pass


def shared():
    """The shared hook modules, imported late so that a failure here is caught by main(). The cache folder is chosen first,
    because they read it when they load."""
    pick_cache_dir()
    hooks = str(ROOT / "hooks")
    if hooks not in sys.path:
        sys.path.insert(0, hooks)
    import memory_capsule
    import memory_capture
    import memory_recall
    return memory_capsule, memory_capture, memory_recall


def handle(event: str, raw: str) -> str:
    """The text to print for this event, "" for nothing. Raises on trouble, main() swallows it."""
    import json
    import emit
    import payload
    if event == "ping":
        shared()
        return "ok\n"
    if event not in EVENT_FOR:
        return ""
    data = payload.normalise(json.loads(raw) if raw.strip() else {}, EVENT_FOR[event])
    capsule, capture, recall = shared()
    import adapter_gate
    if event == "session-start":
        if not capsule._settings().configured():
            return ""
        return emit.context("SessionStart", (capsule.block() or "")[:capsule.MAX_CHARS])
    if event == "prompt":
        if adapter_gate.child() or adapter_gate.off("ANYMEM_RECALL"):
            return ""
        return emit.context("UserPromptSubmit", recall.run(data))
    if adapter_gate.child() or adapter_gate.off("ANYMEM_CAPTURE"):
        return ""
    capture.hook(data, "dsh")
    return ""


def main(argv: list = None) -> int:
    os.environ["ANYMEM_HARNESS"] = "dsh"  # the audit log and the Worker say which harness called, whatever the environment held
    try:
        sys.stderr = open(os.devnull, "w")
        args = sys.argv[1:] if argv is None else argv
        event = args[0] if args else ""
        raw = "" if event == "ping" or sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
        out = handle(event, raw)
        if out:
            sys.stdout.write(out)
            sys.stdout.flush()
    except BaseException:
        pass  # a memory hook must never wedge a session
    return 0


if __name__ == "__main__":
    sys.exit(main())
