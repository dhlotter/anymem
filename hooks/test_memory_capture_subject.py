#!/usr/bin/env python3
"""Runnable check for the subject hint in memory_capture.py. `python3 test_memory_capture_subject.py`, exits non-zero on failure.

No network, no model call. The Worker calls and the cache and config folders are replaced. Every subject here is invented.
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ENVROOT = pathlib.Path(tempfile.mkdtemp()).resolve()
for _name in [k for k in os.environ if k.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_"))]:
    del os.environ[_name]
os.environ["ANYMEM_CONFIG_DIR"] = str(ENVROOT / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(ENVROOT / "cache")

spec = importlib.util.spec_from_file_location("memory_capture", str(HERE / "memory_capture.py"))
cap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cap)
from hm import api as hm_api, offline as hm_offline  # noqa: E402
from hm.commands import resave as hm_resave  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


BODY = "Pip is a small beagle who is afraid of thunder.\n**Why:** storms upset him.\n**How to apply:** keep the windows closed during storms."
PIP = {"name": "pip-fears-thunder", "type": "user", "description": "Pip is the user's dog and is afraid of thunder", "body": BODY}
HINT = {"name": "Pip", "kind": "pet"}

# the prompt
check("the prompt asks for a subject hint and still formats", "Set it only when the memory introduces a named person, pet, vehicle, property, project or topic" in cap.PROMPT and "At most one subject per memory" in cap.PROMPT)
check("the prompt says never for a general rule or a company or tool", "Never set it for a general rule or preference" in cap.PROMPT and "never for a company or a tool unless it is the user's own project" in cap.PROMPT)
filled = cap.PROMPT % (5, "known", "USER: hello")
check("the filled prompt keeps the subject element in the JSON line", '"subject": {"name"' in filled and "USER: hello" in filled)
check("the prompt has no dash connectors", "—" not in cap.PROMPT and "–" not in cap.PROMPT)

# screening keeps a good hint and drops a bad one without losing the memory
kept, why = cap.screen({**PIP, "subject": HINT})
check("a good hint is kept on the screened proposal", kept is not None and kept["subject"] == HINT)
check("a proposal without a hint has no subject key", "subject" not in cap.screen(PIP)[0])
bad = ["Pip", 5, [], {}, {"name": "Pip"}, {"name": "Pip", "kind": "cat"}, {"name": "P", "kind": "pet"}, {"name": "x" * 61, "kind": "pet"},
       {"name": "Pi\np", "kind": "pet"}, {"name": "Pip<b>", "kind": "pet"}, {"name": ["Pip"], "kind": "pet"}, {"name": "Rex", "kind": "pet"},
       {"name": "Pipeline", "kind": "project"}, {"name": "the user", "kind": "person"}, {"name": "work", "kind": "area"}, {"name": "2024", "kind": "topic"}]
for hint in bad:
    clean, _ = cap.screen({**PIP, "subject": hint})
    check("a bad hint is dropped and the memory stays: %r" % (hint,), clean is not None and "subject" not in clean)
secret_name = "AKIA" + "ABCDEFGHIJKLMNOP"
check("a secret shaped name is dropped, even when the text holds it", cap.clean_subject({"name": secret_name, "kind": "topic"}, "The id is " + secret_name + " in the drawer.") is None)
check("and a plain name with the same text is kept", cap.clean_subject({"name": "Pip", "kind": "pet"}, "Pip is here") == {"name": "Pip", "kind": "pet"})
clean, _ = cap.screen({**PIP, "subject": {"name": "  pip  ", "kind": "pet"}})
check("the name is trimmed and found in any case", clean is not None and clean["subject"] == {"name": "pip", "kind": "pet"})

# redaction
red, n, kinds = cap.redact_proposal({**PIP, "subject": HINT})
check("a clean hint passes the redaction as it is", red["subject"] == HINT and n == 0)
red, n, kinds = cap.redact_proposal({**PIP, "subject": {"name": "token=lime42xx", "kind": "topic"}})
check("a hint name that needed redacting is dropped and counted, the memory stays", "subject" not in red and n >= 1 and red["name"] == PIP["name"])

# the save
sent = {}
cap._api = lambda method, path, body=None, timeout=30: sent.update(method=method, path=path, body=body) or {"ok": True, "id": "abc12345-0000"}
cap.store(cap.screen({**PIP, "subject": HINT})[0])
check("store sends the hint in the POST /capture body", sent["path"] == "/capture" and sent["body"]["subject"] == HINT)
sent.clear()
cap.store(cap.screen(PIP)[0])
check("store sends no subject key when there is no hint", "subject" not in sent["body"])


def fail(exc):
    def _api(method, path, body=None, timeout=30):
        raise exc
    return _api


hm_offline.clear()
cap._api = fail(hm_api.NetworkError("timed out"))
cap.store(cap.screen({**PIP, "subject": HINT})[0])
saved = hm_offline.failures()
check("a failed save keeps the hint for the resave", len(saved) == 1 and saved[0]["payload"].get("subject") == HINT)
hm_offline.clear()
cap._api = fail(hm_api.ApiError(503, "unavailable"))
cap.store(cap.screen({**PIP, "subject": HINT})[0])
check("an API error keeps the hint too", len(hm_offline.failures()) == 1 and hm_offline.failures()[0]["payload"].get("subject") == HINT)
cap._api = fail(hm_api.NetworkError("timed out"))
hm_offline.clear()
cap.store(cap.screen({**PIP, "subject": HINT})[0])
resent = {}
hm_api.request = lambda method, path, body=None, timeout=30: resent.update(body=body) or {"ok": True}


class NS:
    dry_run = False


hm_resave.api = hm_api
hm_resave.run(NS())
check("resave sends the hint again", resent.get("body", {}).get("subject") == HINT)
hm_offline.clear()
hm_offline.record_failure("capture", "network: timed out", {"name": "x", "content": "---\nname: x\n---\nbody text here", "tags": ["auto-capture"], "subject": {"name": 5, "kind": "pet"}})
resent.clear()
hm_resave.run(NS())
check("resave drops a damaged hint and still saves the memory", "subject" not in resent.get("body", {}) and resent.get("body", {}).get("content"))
hm_offline.clear()

# a Worker side extraction returns the hint on the proposal and it goes through the same screen
cap.extract_worker = lambda transcript, known_text=None: [{**PIP, "subject": HINT}]
check("a proposal from the Worker's extractor keeps its hint through screening", cap.screen(cap.extract_worker("t")[0])[0]["subject"] == HINT)

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
