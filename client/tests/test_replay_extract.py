#!/usr/bin/env python3
"""Runnable check for bench/replay_extract.py. A fake Worker on 127.0.0.1, invented transcripts, no credentials, no real network.
The script must build the live hook's text, call /extract and only /extract, and print what came back."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
os.environ["ANYMEM_CONFIG_DIR"] = tempfile.mkdtemp()  # never the real config or cache
os.environ["ANYMEM_CACHE_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT / "bench"))
import replay_extract as replay  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def write_transcript(turns) -> str:
    path = Path(tempfile.mkdtemp()) / "session.jsonl"
    lines = []
    for role, text in turns:
        lines.append(json.dumps({"type": role, "message": {"content": [{"type": "text", "text": text}]}}))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = replay.main(argv)
    return code, out.getvalue(), err.getvalue()


LONG_USER = "We agreed the Acme unsubscribe redirect has to stay a 307 because old emails post to the first URL. " * 3
SECRET = "sk-" + "Ab12" * 6
transcript = write_transcript([
    ("user", LONG_USER + " <private>my private line</private> key " + SECRET),
    ("assistant", "Understood, I will keep the redirect as a 307."),
    ("user", "Thanks, that settles it for the demo app."),
])
tiny = write_transcript([("user", "hi"), ("assistant", "hello")])

proposals = [{"name": "unsubscribe-redirect-307", "type": "project", "description": "Keep the redirect a 307",
              "body": "The unsubscribe redirect must stay a 307.\n**Why:** old emails post to the first URL."},
             {"type": "profile", "field": "name", "value": "Sam", "said": "my name is Sam"}]
srv = fake_worker.start(proposals=proposals)
os.environ["ANYMEM_URL"] = srv.url
os.environ["ANYMEM_TOKEN"] = "test-token"
try:
    # --dry sends nothing
    code, out, _ = run([transcript, "--dry"])
    check("--dry prints sizes and exits 0", code == 0 and "text " in out and "chars" in out)
    check("--dry makes no request", srv.requests == [])

    # the text is the hook's own, redacted and with private text removed
    built = replay.build(transcript, "claude")
    check("the private text is removed", "my private line" not in built["transcript"])
    check("the secret is redacted before it is sent", SECRET not in built["transcript"] and "REDACTED" in built["transcript"])
    check("the same cap and max as the hook", built["max"] == replay.hook.MAX_MEMORIES and len(built["transcript"]) <= replay.hook.MAX_TRANSCRIPT_CHARS)

    # a real run
    code, out, err = run([transcript])
    check("a run exits 0 and prints the proposals", code == 0 and "unsubscribe-redirect-307" in out and "profile  name = Sam" in out)
    check("it posted exactly one request, to /extract", [(m, p) for m, p, _ in srv.requests] == [("POST", "/extract")])
    sent = srv.requests[0][2]
    check("the body has transcript, known and max, redacted", set(sent) == {"transcript", "known", "max"} and SECRET not in sent["transcript"] and sent["max"] == 5)
    check("nothing was captured", srv.captured == [])

    # a session the live hook would skip is not sent
    before = len(srv.requests)
    code, out, _ = run([tiny])
    check("a short session is skipped like the hook does", code == 0 and "skip" in out and len(srv.requests) == before)

    # --json
    code, out, _ = run([transcript, "--json"])
    check("--json prints the reply", code == 0 and json.loads(out)["proposals"][0]["name"] == "unsubscribe-redirect-307")

    # --url is only honoured for the configured Worker, so the token never goes to an address typed here
    before = len(srv.requests)
    code, _, err = run([transcript, "--url", "http://198.51.100.7:8787"])
    check("a --url that is not the configured Worker is refused before anything is sent", code == 2 and "not the Worker in your client config" in err and len(srv.requests) == before)
    code, out, _ = run([transcript, "--url", srv.url + "/"])
    check("a --url that matches the configured Worker is used", code == 0 and "unsubscribe-redirect-307" in out and len(srv.requests) == before + 1)

    # a missing file and an unreachable Worker are reported, not raised
    code, _, err = run(["/nonexistent/transcript.jsonl"])
    check("a missing file exits 2", code == 2 and "cannot read" in err)
    os.environ["ANYMEM_URL"] = "http://127.0.0.1:9"
    code, _, err = run([transcript])
    check("an unreachable Worker exits 1 with a message", code == 1 and "replay_extract:" in err)

    # the guard: the script has one network function and it only knows /extract
    src = (ROOT / "bench" / "replay_extract.py").read_text(encoding="utf-8")
    check("the script never mentions /capture as a route", '"/capture"' not in src and "'/capture'" not in src)
    check("the only route constant is /extract", replay.ROUTE == "/extract")
finally:
    srv.stop()

print(f"\n{len(failures)} failed")
sys.exit(1 if failures else 0)
