#!/usr/bin/env python3
"""Runnable check for the dsh adapter. `python3 adapters/dsh/test_adapter.py`, exits non-zero on failure.

Offline: no dsh install and no real credentials are needed. Every folder the adapter or the hooks can touch is a temporary
one, the Worker is the fake one in client/hm/testing/fake_worker.py, and fake secrets are built at runtime. The recorded
samples in fixtures/ come from a throwaway headless run (see docs/harnesses/dsh.md, "Verified").
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIX = HERE / "fixtures"
TMP = Path(tempfile.mkdtemp(prefix="dsh-adapter-test-"))

# Isolate every folder before anything imports the client core, and build the fake credentials at runtime.
for key in list(os.environ):
    if key.startswith(("ANYMEM_", "CLAUDE_PLUGIN_OPTION_", "DSH_")):
        del os.environ[key]
os.environ["ANYMEM_CONFIG_DIR"] = str(TMP / "config")
os.environ["ANYMEM_CACHE_DIR"] = str(TMP / "cache")
os.environ["ANYMEM_EXTRACTION"] = "worker"
os.environ["ANYMEM_DSH_SESSIONS"] = str(TMP / "sessions")
os.environ["HOME"] = str(TMP / "realhome")  # anything that wrongly reaches for the real home lands in a folder we can inspect
(TMP / "realhome").mkdir()

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "client"))
import adapter  # noqa: E402
import dsh_zstd  # noqa: E402
import emit  # noqa: E402
import payload  # noqa: E402
import transcript  # noqa: E402
from hm.testing import fake_worker  # noqa: E402

failures: list = []


def check(name: str, cond: bool, extra: str = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else (" :: " + extra if extra else "")))
    if not cond:
        failures.append(name)


def fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def snapshot(root: Path) -> dict:
    """Every path under root with a hash of its bytes (a folder is marked dir), so 'byte identical' is a comparison."""
    snap = {}
    for p in sorted(root.rglob("*")):
        snap[str(p.relative_to(root))] = "dir" if p.is_dir() else hashlib.sha256(p.read_bytes()).hexdigest()
    return snap


def opts(home: Path, dry_run: bool = False):
    return types.SimpleNamespace(dry_run=dry_run, yes=True, plugin_root=ROOT, home=home)


def raises(fn, *args) -> str:
    """The message of the RuntimeError fn raises, or "" when it does not raise one."""
    try:
        fn(*args)
    except RuntimeError as exc:
        return str(exc)
    return ""


TEMPLATE = ("# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries\n"
            "# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n")
OTHER_BRIDGE = ('- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-account\n'
                '- insert:\n    - id: hooks-claude-code\n      name: "@deepseek-ai/dsh-hooks-claude-code"\n      config:\n        configPath: /somewhere/else.json\n')
PROFILES = {
    "template": TEMPLATE,
    "template-no-newline": TEMPLATE.rstrip("\n"),
    "with-bridge": "# patch\n" + OTHER_BRIDGE,
    "no-final-newline": ("# patch\n" + OTHER_BRIDGE).rstrip("\n"),
    "comments-only": "# nothing here yet\n\n",
    "empty-file": "",
    "block-with-script": "- id: x\n  config:\n    run: |\n      echo one\n      - not an entry\n",
}


def make_home(name: str, profiles: dict = None) -> Path:
    home = TMP / name / "home"
    for profile, text in (PROFILES if profiles is None else profiles).items():
        folder = home / ".dsh" / "profiles" / profile
        folder.mkdir(parents=True)
        (folder / "cordis.patch.yml").write_bytes(text.encode("utf-8"))
        (folder / "package.json").write_text("{}\n")
    (home / ".config").mkdir(parents=True, exist_ok=True)
    return home


def use_home(home: Path) -> None:
    os.environ["ANYMEM_HOME"] = str(home)


def set_worker(url: str) -> str:
    """Point the client at `url` through the config file, the way connect.py does. Returns the fake token."""
    token = "test-token-" + secrets.token_hex(6)
    Path(os.environ["ANYMEM_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["ANYMEM_CONFIG_DIR"]) / "config.json").write_text(json.dumps({"url": url, "token": token}))
    return token


def clear_worker() -> None:
    try:
        (Path(os.environ["ANYMEM_CONFIG_DIR"]) / "config.json").unlink()
    except OSError:
        pass


# ---------------------------------------------------------------- payload

def test_payload() -> None:
    start, prompt, stop = fixture("payload-session-start.json"), fixture("payload-prompt.json"), fixture("payload-stop.json")
    keys = {"hook_event_name", "session_id", "prompt", "transcript_path", "cwd"}
    for name, raw, event in (("session-start", start, "SessionStart"), ("prompt", prompt, "UserPromptSubmit"), ("stop", stop, "Stop")):
        got = payload.normalise(raw)
        check("payload %s: shared keys only, all strings" % name, set(got) == keys and all(isinstance(v, str) for v in got.values()))
        check("payload %s: event is %s" % (name, event), got["hook_event_name"] == event)
        check("payload %s: session id and cwd carried over" % name, got["session_id"] == raw["session_id"] and got["cwd"] == raw["cwd"])
    got = payload.normalise(prompt)
    check("payload prompt: the capsule DSH glues in front is cut off", got["prompt"].startswith("I am testing a memory system") and "capsule" not in got["prompt"][:40], got["prompt"][:80])
    clean = dict(prompt, prompt="What is the ferry codename?")
    check("payload prompt: a prompt without the capsule is unchanged", payload.normalise(clean)["prompt"] == "What is the ferry codename?")
    check("payload: no log yet, no transcript path", payload.normalise(stop)["transcript_path"] == "")
    check("payload: the event argument fills a missing event name", payload.normalise({"session_id": "s"}, "Stop")["hook_event_name"] == "Stop")
    check("payload: an event name in another case is accepted", payload.normalise({"hook_event_name": "sessionend"})["hook_event_name"] == "SessionEnd")
    check("payload: an event the adapter does not handle falls back to the argument", payload.normalise({"hook_event_name": "SubagentStop"}, "Stop")["hook_event_name"] == "Stop")
    for junk in (None, [], "text", 7, {"prompt": 5, "session_id": ["x"], "cwd": None}):
        got = payload.normalise(junk)
        check("payload: junk %r gives empty strings" % (junk if not isinstance(junk, dict) else "dict",), set(got) == keys and all(v == "" for v in got.values()))
    # the session log is found from the session id, wherever dsh keeps it
    folder = TMP / "sessions" / "--tmp-project--" / stop["session_id"]
    folder.mkdir(parents=True)
    log = folder / payload.SESSION_FILE
    shutil.copy(FIX / "session.v4.jsonl.zstd", log)
    check("payload stop: transcript_path found from the session id", payload.normalise(stop)["transcript_path"] == str(log))
    check("payload: a transcript_path that exists wins", payload.normalise(dict(stop, transcript_path=str(HERE / "fixtures" / "payload-stop.json")))["transcript_path"].endswith("payload-stop.json"))
    check("payload: a session id that is a path finds nothing", payload.find_transcript("../../etc") == "" and payload.find_transcript("") == "")
    os.environ["DSH_HOME"] = str(TMP / "dshhome")
    saved = os.environ.pop("ANYMEM_DSH_SESSIONS")
    check("payload: sessions root follows DSH_HOME", payload.sessions_root() == TMP / "dshhome" / "sessions")
    del os.environ["DSH_HOME"]
    os.environ["ANYMEM_DSH_SESSIONS"] = saved


# ---------------------------------------------------------------- emit

def test_emit() -> None:
    expected = '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "hello"}}\n'
    check("emit: UserPromptSubmit bytes", emit.context("UserPromptSubmit", "hello") == expected, repr(emit.context("UserPromptSubmit", "hello")))
    session = emit.context("SessionStart", "capsule text")
    body = json.loads(session)["hookSpecificOutput"]
    check("emit: SessionStart is the same shape", body["hookEventName"] == "SessionStart" and body["additionalContext"].startswith("capsule text"))
    check("emit: SessionStart closes with the line payload.py looks for", body["additionalContext"].endswith(payload.CAPSULE_END))
    check("emit: one JSON line, ends with a newline", session.endswith("\n") and session.count("\n") == 1)
    check("emit: no text, no output", emit.context("UserPromptSubmit", "") == "" and emit.context("SessionStart", "") == "")
    check("emit: non ASCII text survives the round trip", json.loads(emit.context("UserPromptSubmit", "caf\u00e9 \u2013 ok"))["hookSpecificOutput"]["additionalContext"] == "caf\u00e9 \u2013 ok")


# ---------------------------------------------------------------- transcript and decoder

def frame_starts(data: bytes) -> list:
    out, i = [], -1
    while True:
        i = data.find(dsh_zstd.MAGIC, i + 1)
        if i < 0:
            return out
        out.append(i)


def test_transcript() -> None:
    log = FIX / "session.v4.jsonl.zstd"
    data = log.read_bytes()
    turns, end = transcript.read_turns(str(log), 0)
    roles = [r for r, _ in turns]
    check("transcript: one user turn and one assistant turn", roles == ["USER", "ASSISTANT"], str(roles))
    check("transcript: the user turn is what was typed", turns[0][1].startswith("I am testing a memory system. Read notes.txt"), turns[0][1][:60])
    check("transcript: the assistant turn is the final answer", turns[1][1].startswith("codename=HM"), turns[1][1][:60])
    blob = "\n".join(t for _, t in turns)
    check("transcript: the injected memory block is never captured back", "Relevant memories" not in blob and "ferry-codename" not in blob)
    check("transcript: the injected capsule is never captured back", "Memory capsule" not in blob and "capsule check word" not in blob)
    check("transcript: runtime context and policy text are left out", "file policy" not in blob and "Approval policy" not in blob)
    events = [json.loads(line) for line in b"".join(dsh_zstd.decode_frames(data, 0)[0]).splitlines()]
    reasoning = [b["text"][:40] for e in events if e["type"] == "assistant/message" for b in e["data"]["message"]["content"] if b.get("type") == "reasoning" and b.get("text")]
    calls = [e["data"]["name"] for e in events if e["type"] == "tool/call"]
    check("transcript: the fixture really has reasoning, tool calls and tool results to leave out", len(reasoning) >= 2 and len(calls) >= 1)
    check("transcript: reasoning, tool calls and tool output are left out", not any(r in blob for r in reasoning) and "<path>" not in blob and "trimmed for the fixture" not in blob and "wc -l" not in blob)
    check("transcript: the offset is the end of the file, on a frame boundary", end == len(data))
    again, end2 = transcript.read_turns(str(log), end)
    check("transcript: reading from the end gives nothing and keeps the offset", again == [] and end2 == end)
    starts = frame_starts(data)
    check("transcript: the fixture holds several frames", len(starts) >= 4, str(starts))
    # a frame still being written stays for the next capture
    part = TMP / "partial.zstd"
    part.write_bytes(data[:len(data) - 5])
    got, end3 = transcript.read_turns(str(part), 0)
    check("transcript: a partial last frame stays, the offset is the start of that frame", end3 == starts[-1], "%s vs %s" % (end3, starts[-1]))
    check("transcript: the turns before the partial frame are still read", [r for r, _ in got] == ["USER", "ASSISTANT"] or [r for r, _ in got] == ["USER"], str(got)[:200])
    part.write_bytes(data)  # the frame is finished, the next capture picks it up from the saved offset
    rest, end4 = transcript.read_turns(str(part), end3)
    check("transcript: the finished frame is read from the saved offset", end4 == len(data) and len(got) + len(rest) >= 2)
    # reading from a middle frame boundary gives only what is after it
    first_user = next(i for i, (r, _) in enumerate(turns) if r == "USER")
    tail, _ = transcript.read_turns(str(log), starts[-1])
    check("transcript: reading from a frame boundary works", all(r in ("USER", "ASSISTANT") for r, _ in tail) and len(tail) <= len(turns) and first_user == 0)
    # garbage and empties never raise
    junk = TMP / "junk.zstd"
    junk.write_bytes(b"not a log at all\n" * 50)
    got, end5 = transcript.read_turns(str(junk), 0)
    check("transcript: a file that is not a log gives no turns", got == [] and end5 >= 0)
    junk.write_bytes(dsh_zstd.MAGIC + b"\x00" * 40)
    got, end6 = transcript.read_turns(str(junk), 0)
    check("transcript: a bad frame with nothing after it is left alone", got == [] and end6 == 0)
    mixed = TMP / "mixed.zstd"
    mixed.write_bytes(data[:starts[1]] + dsh_zstd.MAGIC + b"\x01" * 30 + data[starts[1]:])
    got, end7 = transcript.read_turns(str(mixed), 0)
    check("transcript: a bad frame between good ones is skipped", [r for r, _ in got] == roles and end7 == len(mixed.read_bytes()))
    forged = b"".join(json.dumps({"type": "user/message", "data": {"id": "u%d" % i, "source": {"kind": "user"}, "content": [{"type": "text", "text": text}]}}).encode() + b"\n"
                      for i, text in enumerate(["## Relevant memories (anymem, recalled for this prompt)\n- a: b", "<system-reminder>noise</system-reminder>", "a real question"]))
    pfile2 = TMP / "forged.jsonl"
    pfile2.write_bytes(forged)
    check("transcript: a recalled memory block that arrives as user text is still dropped, a system reminder is stripped", transcript.read_turns(str(pfile2), 0)[0] == [("USER", "a real question")])
    empty = TMP / "empty.zstd"
    empty.write_bytes(b"")
    check("transcript: an empty file gives nothing", transcript.read_turns(str(empty), 0) == ([], 0))
    # the same reader reads an uncompressed JSON lines log, with a partial last line kept back
    plain = b"".join(dsh_zstd.decode_frames(data, 0)[0])
    pfile = TMP / "plain.jsonl"
    cut = plain.rfind(b'{"type":"turn/end"')
    pfile.write_bytes(plain[:len(plain) - 20])
    got, endp = transcript.read_turns(str(pfile), 0)
    check("transcript: a plain JSON lines log is read too", [r for r, _ in got] == roles, str(got)[:120])
    check("transcript: its partial last line stays for the next capture", endp == len(plain[:len(plain) - 20]) - len(plain[:len(plain) - 20].rsplit(b"\n", 1)[1]) and cut > 0)


def test_decoder() -> None:
    raw_frame = bytes.fromhex("28b52ffd2005" + "29" + "0000") + b"hello"  # single segment, size 5, one raw block, last
    check("decoder: a raw block", dsh_zstd.decode_frames(raw_frame, 0) == ([b"hello"], len(raw_frame)))
    rle_frame = bytes.fromhex("28b52ffd2007") + bytes([(7 << 3) | 3, 0, 0]) + b"x"  # one RLE block, size 7
    check("decoder: an RLE block", dsh_zstd.decode_frames(rle_frame, 0) == ([b"x" * 7], len(rle_frame)))
    skippable = bytes.fromhex("5a2a4d18") + (3).to_bytes(4, "little") + b"abc"
    frames, end = dsh_zstd.decode_frames(skippable + raw_frame + rle_frame, 0)
    check("decoder: a skippable frame is stepped over, frames follow in order", frames == [b"hello", b"x" * 7] and end == len(skippable + raw_frame + rle_frame))
    frames, end = dsh_zstd.decode_frames(raw_frame + rle_frame[:-1], 0)
    check("decoder: a frame cut short is left out and the offset stays before it", frames == [b"hello"] and end == len(raw_frame))
    frames, end = dsh_zstd.decode_frames(raw_frame + rle_frame, len(raw_frame))
    check("decoder: decoding can start at a later offset", frames == [b"x" * 7] and end == len(raw_frame + rle_frame))
    wrong = bytes.fromhex("28b52ffd2009" + "29" + "0000") + b"hello"  # declares 9 bytes, holds 5
    check("decoder: a size that disagrees with the declared size is refused", dsh_zstd.decode_frames(wrong, 0) == ([], 0))
    check("decoder: no frames in empty or tiny input", dsh_zstd.decode_frames(b"", 0) == ([], 0) and dsh_zstd.decode_frames(b"abc", 0) == ([], 0))
    try:
        dsh_zstd.Huffman([3, 1])  # weights that do not leave a power of two for the last symbol
        refused = False
    except dsh_zstd.Corrupt:
        refused = True
    check("decoder: Huffman weights that cannot form a prefix code are refused", refused)
    for n in range(0, 40):  # random garbage after a magic number never raises
        blob = dsh_zstd.MAGIC + bytes((n * 31 + i * 17) % 256 for i in range(n * 3))
        dsh_zstd.decode_frames(blob, 0)
    check("decoder: garbage after a magic number never raises", True)
    # the real recorded frames, compared with the zstd command line when it is installed
    data = (FIX / "session.v4.jsonl.zstd").read_bytes()
    frames, end = dsh_zstd.decode_frames(data, 0)
    check("decoder: every frame of the recorded log decodes", len(frames) == len(frame_starts(data)) and end == len(data))
    lines = b"".join(frames).splitlines()
    check("decoder: the decoded log is JSON lines", all(json.loads(line)["type"] for line in lines) and len(lines) >= 20)
    exe = shutil.which("zstd")
    if not exe:
        print("skip decoder: round trip against the zstd command line (not installed)")
        return
    import random
    rng = random.Random(3)
    text = (HERE / "adapter.py").read_bytes() + (HERE / "dsh_zstd.py").read_bytes()
    samples = [text, text * 4, bytes(rng.getrandbits(8) for _ in range(30000)), b"\0" * 100000, b"ab" * 40000, text[:100], b"x"]
    samples += [bytes(b if rng.random() > 0.2 else rng.getrandbits(8) for b in text[i:i + 5000]) for i in range(0, 20000, 5000)]
    bad = 0
    for sample in samples:
        for level in ("-1", "-3", "-12", "-19"):
            packed = subprocess.run([exe, "-c", "-q", level], input=sample, capture_output=True).stdout
            got, end = dsh_zstd.decode_frames(packed, 0)
            bad += not (b"".join(got) == sample and end == len(packed))
    check("decoder: matches the zstd command line on %d inputs at four levels" % len(samples), bad == 0, "%d differ" % bad)


# ---------------------------------------------------------------- install, check, uninstall

def block_count(text: str) -> int:
    return text.count(adapter.BEGIN)


def test_install() -> None:
    srv = fake_worker.start()
    set_worker(srv.url)
    try:
        home = make_home("full")
        use_home(home)
        before = snapshot(home)
        plan = adapter.plan(opts(home))
        patches = [home / ".dsh" / "profiles" / n / "cordis.patch.yml" for n in PROFILES]
        check("plan: one sentence per profile plus the hooks file", len(plan) == len(PROFILES) + 1, str(len(plan)))
        check("plan: names the hooks file and every patch file", str(adapter._hooks_file(home)) in plan[0] and all(any(str(p) in line for line in plan) for p in patches))
        check("plan: says nothing is changed when asked for a plan", snapshot(home) == before)
        dry = adapter.install(opts(home, dry_run=True))
        check("install: dry run writes nothing and changes nothing", dry["changed"] == [] and snapshot(home) == before)
        result = adapter.install(opts(home))
        changed = set(result["changed"])
        check("install: reports the hooks file, every patch file and every backup", str(adapter._hooks_file(home)) in changed and all(str(p) in changed for p in patches) and all(str(p) + adapter.BACKUP_SUFFIX in changed for p in patches))
        for name, text in PROFILES.items():
            patch = home / ".dsh" / "profiles" / name / "cordis.patch.yml"
            new = patch.read_text()
            backup = Path(str(patch) + adapter.BACKUP_SUFFIX)
            check("install %s: exactly one marked block" % name, block_count(new) == 1 and new.count(adapter.END) == 1)
            check("install %s: the backup is the original, byte for byte" % name, backup.read_bytes() == text.encode("utf-8"))
            check("install %s: the block names the bridge and the hooks file" % name, adapter.BRIDGE_ID in new and json.dumps(str(adapter._hooks_file(home))) in new)
            if name in ("with-bridge", "no-final-newline"):
                check("install %s: the user's own entries are untouched" % name, new.startswith(text.rstrip("\n")) and "configPath: /somewhere/else.json" in new)
        hooks = json.loads(adapter._hooks_file(home).read_text())
        check("install: the hooks file marks itself as ours", isinstance(hooks.get("anymem"), dict))
        events = hooks["hooks"]
        check("install: hooks for session start, prompt and stop", sorted(events) == sorted(["SessionStart", "UserPromptSubmit", "Stop"]))
        commands = [events[e][0]["hooks"][0]["command"] for e in ("SessionStart", "UserPromptSubmit", "Stop")]
        check("install: each command is one hook.py call with its event", [c.split()[-1] for c in commands] == ["session-start", "prompt", "capture"] and all(str(ROOT / "adapters" / "dsh" / "hook.py") in c for c in commands))
        check("install: every hook has a timeout", all(events[e][0]["hooks"][0].get("timeout", 0) > 0 for e in events))
        check("install: every hook runs under the Python that installed it", all(c.startswith(sys.executable + " ") for c in commands), str(commands))
        ok = adapter.check()
        check("check after install: ok, the hooks start and the Worker answers", ok["ok"] and ok["problems"] == [], str(ok))
        check("check: reached the Worker's health endpoint", any(path == "/health" for _, path, _ in srv.requests))
        after_install = snapshot(home)
        again = adapter.install(opts(home))
        check("install twice: nothing changes the second time", again["changed"] == [] and snapshot(home) == after_install)
        # something the user added after our block is theirs and survives an uninstall
        edited = patches[2]
        edited.write_text(edited.read_text() + "- id: later\n  disabled: true\n")
        gone = adapter.uninstall()
        check("uninstall: reports what it removed", str(adapter._hooks_file(home)) in gone["changed"] and str(edited) in gone["changed"])
        check("uninstall: a later edit of the user survives", "- id: later" in edited.read_text() and block_count(edited.read_text()) == 0)
        check("uninstall: a backup that no longer matches is kept", Path(str(edited) + adapter.BACKUP_SUFFIX).exists())
        os.unlink(str(edited) + adapter.BACKUP_SUFFIX)
        edited.write_bytes(PROFILES[edited.parent.name].encode("utf-8"))  # put the edited file back so the whole tree can be compared
        check("uninstall: every other file is back to the byte", snapshot(home) == before, str({k for k in set(before) | set(snapshot(home)) if before.get(k) != snapshot(home).get(k)}))
        bad = adapter.check()
        check("check after uninstall: not ok, the wiring is gone", not bad["ok"] and any("no anymem block" in p for p in bad["problems"]), str(bad))
        check("uninstall twice: nothing left to do", adapter.uninstall() == {"changed": []})
        # a clean round trip, then the compare the contract asks for
        adapter.install(opts(home))
        adapter.uninstall()
        check("install then uninstall: byte identical to before, no backup and no folder left", snapshot(home) == before)
        sibling = TMP / "full" / "elsewhere.txt"
        sibling.write_text("x")
        adapter.install(opts(home))
        adapter.uninstall()
        outside = sorted(p.name for p in (TMP / "full").iterdir())
        check("install writes only inside the home folder", outside == ["elsewhere.txt", "home"], str(outside))
        check("install never touched the real home", not list((TMP / "realhome").iterdir()))
    finally:
        srv.stop()
        clear_worker()


def test_uninstall_classifies_first() -> None:
    """One profile whose markers no longer pair up must not stop the others from being cleaned, and it keeps the hooks file it still mounts."""
    home = make_home("bad-profile", profiles={"broken": PROFILES["template"], "good": PROFILES["template"]})
    use_home(home)
    adapter.install(opts(home))
    broken = home / ".dsh" / "profiles" / "broken" / "cordis.patch.yml"
    good = home / ".dsh" / "profiles" / "good" / "cordis.patch.yml"
    broken.write_text(broken.read_text().replace(adapter.END + "\n", ""), encoding="utf-8")  # the end marker is gone
    res = adapter.uninstall()
    check("uninstall with a broken profile: the other profile is cleaned anyway", block_count(good.read_text()) == 0, str(res))
    check("uninstall with a broken profile: the broken file is left as it is", broken.read_text().count(adapter.BEGIN) == 1)
    check("uninstall with a broken profile: the hooks file stays, the profile still mounts it", adapter._hooks_file(home).exists())
    check("uninstall with a broken profile: the note names the file and says why", any(str(broken) in n for n in res.get("notes", [])), str(res))
    broken.write_text(broken.read_text() + adapter.END + "\n", encoding="utf-8")  # repaired by hand
    res = adapter.uninstall()
    check("uninstall after the repair: the broken profile is cleaned and the hooks file goes", block_count(broken.read_text()) == 0 and not adapter._hooks_file(home).exists(), str(res))


def test_remove_keeps_later_entries() -> None:
    """An entry the user adds after our block survives uninstall: the template's [] returns only when nothing else is left
    (a flow list followed by block items is invalid YAML), and the user's last line keeps its newline."""
    home = make_home("later", {"template": TEMPLATE, "template-no-newline": TEMPLATE.rstrip("\n"), "list-no-newline": "# patch\n- id: a\n  x: 1"})
    use_home(home)
    later = "- id: later\n  disabled: true\n"
    expected = {
        "template": TEMPLATE[:-len("[]\n")] + later,
        "template-no-newline": TEMPLATE[:-len("[]\n")] + later,
        "list-no-newline": "# patch\n- id: a\n  x: 1\n" + later,
    }
    adapter.install(opts(home))
    for name in expected:
        patch = home / ".dsh" / "profiles" / name / "cordis.patch.yml"
        patch.write_text(patch.read_text(encoding="utf-8") + later, encoding="utf-8")
    adapter.uninstall()
    for name, want in expected.items():
        patch = home / ".dsh" / "profiles" / name / "cordis.patch.yml"
        got = patch.read_text(encoding="utf-8")
        check("uninstall with a later entry, %s: our block is out, the entry is kept byte for byte" % name, got == want, repr(got))
        check("uninstall with a later entry, %s: the file is still a plain block list" % name, adapter.classify(got) == ("list", ""), repr(got))


def test_refuse() -> None:
    """A file that is not a plain block list is never touched, and nothing else is written either."""
    base = PROFILES["with-bridge"]
    cases = {
        "a mapping": "key: value\n- id: x\n",
        "a flow mapping": "{a: 1}\n",
        "a flow list with entries": "[{id: a}]\n",
        "a document start": "---\n- id: a\n",
        "a list that is not first": "key: 1\n",
        "windows line endings": "- id: a\r\n- id: b\r\n",
        "markers that do not pair up": "- id: a\n" + adapter.BEGIN + "\n- id: b\n",
        "our end marker alone": "- id: a\n" + adapter.END + "\n",
        "a foreign entry with our id": "- id: hooks-anymem\n  name: x\n",
        "a flow list on several lines": "[\n  a,\n  b\n]\n",
    }
    for name, text in cases.items():
        home = make_home("refuse-" + str(abs(hash(name))), {"headless": base, "bad": text})
        use_home(home)
        before = snapshot(home)
        message = raises(adapter.install, opts(home))
        check("refuse %s: install raises with the file and the manual block" % name, "cordis.patch.yml" in message and adapter.BEGIN in message, message[:160])
        check("refuse %s: nothing at all was written, not even for the good profile" % name, snapshot(home) == before)
        lines = adapter.plan(opts(home))
        check("refuse %s: plan says so" % name, any(l.startswith("refuse to touch") for l in lines), str(lines))
    home = make_home("refuse-binary", {"headless": base})
    bad = home / ".dsh" / "profiles" / "headless" / "cordis.patch.yml"
    bad.write_bytes(b"- id: a\n- \xff\xfe\n")
    use_home(home)
    before = snapshot(home)
    check("refuse: a file that is not UTF-8", raises(adapter.install, opts(home)) != "" and snapshot(home) == before)
    home = make_home("refuse-hooks", {"headless": base})
    use_home(home)
    foreign = adapter._hooks_file(home)
    foreign.parent.mkdir(parents=True)
    foreign.write_text('{"hooks": {}}\n')
    before = snapshot(home)
    check("refuse: a hooks file that is not ours", "not written by anymem" in raises(adapter.install, opts(home)) and snapshot(home) == before)
    home = make_home("refuse-none", {})
    use_home(home)
    check("refuse: no dsh profile at all", "no dsh profile" in raises(adapter.install, opts(home)) and adapter.plan(opts(home))[0].startswith("refuse"))
    check("check: no profile is a problem", not adapter.check()["ok"])
    home = make_home("refuse-root", {"headless": base})
    use_home(home)
    check("refuse: a plugin root without the hook script", "plugin_root is wrong" in raises(adapter.install, types.SimpleNamespace(dry_run=False, yes=True, plugin_root=TMP / "nowhere", home=home)))
    os.environ["DSH_HOME"] = str(TMP / "outside-dsh")
    (TMP / "outside-dsh" / "profiles" / "x").mkdir(parents=True)
    (TMP / "outside-dsh" / "profiles" / "x" / "cordis.patch.yml").write_text("[]\n")
    check("install ignores a DSH_HOME outside the home folder", [p.parent.name for p in adapter._patch_files(home)] == ["headless"])
    del os.environ["DSH_HOME"]


def test_markers() -> None:
    """Block add and remove round trip for every shape of file the adapter accepts, without the install machinery."""
    hooks = Path("/tmp/hooks.json")
    for name, text in PROFILES.items():
        kind, why = adapter.classify(text)
        check("classify %s: accepted (%s)" % (name, kind), kind in ("empty", "empty-list", "list"), why)
        new = adapter.add_block(text, kind, hooks)
        check("markers %s: adding then removing the block is byte identical" % name, adapter.remove_block(new) == text, repr(adapter.remove_block(new))[:80])
        check("markers %s: classify sees the block as present" % name, adapter.classify(new)[0] == "present")
    check("markers: removing from a file without a block changes nothing", adapter.remove_block(PROFILES["with-bridge"]) == PROFILES["with-bridge"])


def test_detect() -> None:
    home = make_home("detect")
    use_home(home)
    before = snapshot(home)
    real_which = shutil.which
    shutil.which = lambda name, *a, **k: None if name == "dsh" else real_which(name, *a, **k)
    try:
        info = adapter.detect()
        check("detect: a dsh folder counts as found even without the command", info["found"] and info["version"] == "" and info["config_path"].endswith("profiles"))
        check("detect: lists the profiles", "template" in " ".join(info["notes"]), str(info["notes"]))
        check("detect: read only", snapshot(home) == before)
        use_home(make_home("detect-none", {}))
        check("detect: nothing there, not found", not adapter.detect()["found"])
    finally:
        shutil.which = real_which


def test_check_problems() -> None:
    srv = fake_worker.start()
    token = set_worker(srv.url)
    try:
        home = make_home("problems", {"headless": PROFILES["with-bridge"]})
        use_home(home)
        adapter.install(opts(home))
        hooks = adapter._hooks_file(home)
        good = hooks.read_text()
        check("check: healthy to start with", adapter.check()["ok"], str(adapter.check()))
        data = json.loads(good)
        data["hooks"].pop("Stop")
        hooks.write_text(json.dumps(data))
        check("check: a missing hook is reported", any("no Stop hook" in p for p in adapter.check()["problems"]))
        hooks.write_text("{not json")
        check("check: a hooks file that is not JSON is reported", any("not valid JSON" in p for p in adapter.check()["problems"]))
        hooks.unlink()
        check("check: a missing hooks file is reported", any("is missing" in p for p in adapter.check()["problems"]))
        hooks.write_text(good.replace(str(ROOT / "adapters" / "dsh" / "hook.py"), str(TMP / "gone" / "hook.py")))
        check("check: a hook script that is gone is reported", any("hook script" in p for p in adapter.check()["problems"]))
        hooks.write_text(good)
        token = set_worker("http://127.0.0.1:9")
        problems = adapter.check()["problems"]
        check("check: a Worker that does not answer is reported", problems and "cannot reach the Worker" in problems[0], str(problems))
        check("check: a problem never carries the token", all(token not in p for p in problems))
        clear_worker()
        check("check: an unconfigured client is reported", any("not configured" in p for p in adapter.check()["problems"]))
        env_token = "test-token-" + secrets.token_hex(6)
        os.environ["ANYMEM_URL"], os.environ["ANYMEM_TOKEN"] = srv.url, env_token
        problems = adapter.check()["problems"]
        check("check: a token that only lives in the environment is explained, DSH hides it from hooks", len(problems) == 1 and "removes variables" in problems[0] and env_token not in problems[0], str(problems))
        (Path(os.environ["ANYMEM_CONFIG_DIR"])).mkdir(parents=True, exist_ok=True)
        (Path(os.environ["ANYMEM_CONFIG_DIR"]) / "config.json").write_text(json.dumps({"url": srv.url, "token": env_token}))
        check("check: the same token also in the config file is fine", adapter.check()["ok"])
        for key in ("ANYMEM_URL", "ANYMEM_TOKEN"):
            os.environ.pop(key, None)
        set_worker(srv.url)
        patch = home / ".dsh" / "profiles" / "headless" / "cordis.patch.yml"
        patch.write_text(patch.read_text().replace(adapter.BEGIN, "# marker lost").replace(adapter.END, "# gone"))
        problems = adapter.check()["problems"]
        check("check: markers lost but our entry still there is explained", any("markers are gone" in p for p in problems), str(problems))
    finally:
        srv.stop()
        clear_worker()
        for key in ("ANYMEM_URL", "ANYMEM_TOKEN"):
            os.environ.pop(key, None)


# ---------------------------------------------------------------- hook.py

def run_hook(event: str, stdin, env_extra: dict = None, timeout: float = 30) -> subprocess.CompletedProcess:
    env = {**os.environ, **(env_extra or {})}
    data = stdin if isinstance(stdin, (bytes, str)) else json.dumps(stdin)
    return subprocess.run([sys.executable, str(HERE / "hook.py"), *([event] if event is not None else [])], input=data.encode() if isinstance(data, str) else data,
                          env=env, capture_output=True, timeout=timeout)


def test_hook_never_raises() -> None:
    samples = [b"", b"garbage", b"\xff\xfe\x00", b"{", b"[1,2]", b"null", b'{"prompt": 5}', b'{"session_id": "../../x", "prompt": "x" }', b"{" * 5000]
    bad = []
    for event in ("session-start", "prompt", "capture", "ping", "nonsense", ""):
        for sample in samples:
            p = run_hook(event, sample)
            if p.returncode != 0 or p.stderr != b"" or (p.stdout != b"" and event != "ping"):
                bad.append((event, sample[:12], p.returncode, p.stdout[:40], p.stderr[:80]))
    check("hook: exits 0 with no output and no stderr on garbage, for every event", not bad, str(bad[:3]))
    p = run_hook(None, b"{}")
    check("hook: no event argument is fine too", p.returncode == 0 and p.stdout == b"" and p.stderr == b"")
    unconfigured = {"ANYMEM_CONFIG_DIR": str(TMP / "empty-config"), "ANYMEM_CACHE_DIR": str(TMP / "empty-cache")}
    outputs = []
    for event, name in (("session-start", "payload-session-start.json"), ("prompt", "payload-prompt.json"), ("capture", "payload-stop.json")):
        p = run_hook(event, fixture(name), unconfigured)
        outputs.append((event, p.returncode, p.stdout, p.stderr))
    check("hook: an unconfigured client prints nothing and exits 0 for every event", all(rc == 0 and out == b"" and err == b"" for _, rc, out, err in outputs), str(outputs))
    p = run_hook("ping", b"")
    check("hook: ping loads the shared hooks and says ok", p.returncode == 0 and p.stdout == b"ok\n", str(p.stdout))
    import hook
    check("hook: handle() on an unknown event is empty", hook.handle("nonsense", "{}") == "")
    import io
    import contextlib
    seen = io.StringIO()
    real_handle = hook.handle
    hook.handle = lambda event, raw: print("a library chattering", file=sys.stderr) or ""
    saved_in = sys.stdin
    sys.stdin = io.StringIO("{}")
    try:
        with contextlib.redirect_stderr(seen):
            hook.main(["prompt"])
    finally:
        hook.handle, sys.stdin = real_handle, saved_in
    check("hook: anything a library prints to stderr is swallowed", seen.getvalue() == "", seen.getvalue())
    saved_err, saved_in = sys.stderr, sys.stdin
    sys.stdin = io.StringIO("not json")
    try:
        check("hook: main() swallows a failure and returns 0", hook.main(["prompt"]) == 0)
    finally:
        sys.stderr, sys.stdin = saved_err, saved_in


def test_sandbox_cache() -> None:
    """DSH hooks cannot write under the home folder by default. The cache then moves to a private folder in the temp area."""
    import hook
    import tempfile as tf
    home = TMP / "sandboxed-home"
    (home / ".cache" / "anymem").mkdir(parents=True)
    os.chmod(home / ".cache" / "anymem", 0o500)
    tmpdir = TMP / "sandbox-tmp"
    tmpdir.mkdir()
    saved = {k: os.environ.pop(k, None) for k in ("ANYMEM_CACHE_DIR",)}
    saved_home, saved_tmp = os.environ["HOME"], tf.tempdir
    os.environ["HOME"], tf.tempdir = str(home), str(tmpdir)
    try:
        if os.getuid() == 0 or hook.writable(home / ".cache" / "anymem"):
            print("skip sandbox cache: this user can write to a read only folder")
            return
        hook.pick_cache_dir()
        chosen = Path(os.environ.get("ANYMEM_CACHE_DIR", "/nowhere"))
        check("sandbox: an unwritable cache folder moves to a private folder in the temp area", chosen.parent == tmpdir and chosen.is_dir() and (chosen.stat().st_mode & 0o777) == 0o700, str(chosen))
        before = os.environ["ANYMEM_CACHE_DIR"]
        hook.pick_cache_dir()
        check("sandbox: an explicit cache folder is left alone", os.environ["ANYMEM_CACHE_DIR"] == before)
        del os.environ["ANYMEM_CACHE_DIR"]
        os.chmod(home / ".cache" / "anymem", 0o700)
        hook.pick_cache_dir()
        check("sandbox: a writable cache folder is used as it is", "ANYMEM_CACHE_DIR" not in os.environ)
        # end to end: the session start hook caches the capsule in the fallback folder
        os.chmod(home / ".cache" / "anymem", 0o500)
        srv = fake_worker.start(capsule=[{"slot": "identity", "content": "rules"}])
        cfg = TMP / "sandbox-config"
        cfg.mkdir()
        (cfg / "config.json").write_text(json.dumps({"url": srv.url, "token": "test-token-" + secrets.token_hex(6)}))
        env = {"HOME": str(home), "TMPDIR": str(tmpdir), "ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": ""}
        p = subprocess.run([sys.executable, str(HERE / "hook.py"), "session-start"], input=json.dumps(fixture("payload-session-start.json")).encode(),
                           env={**{k: v for k, v in os.environ.items() if k != "ANYMEM_CACHE_DIR"}, **{k: v for k, v in env.items() if k != "ANYMEM_CACHE_DIR"}}, capture_output=True, timeout=30)
        srv.stop()
        cached = list(tmpdir.glob("anymem-*/capsule.json"))
        check("sandbox: the hook still prints the capsule and caches it in the temp folder", b"rules" in p.stdout and len(cached) == 1 and p.stderr == b"", str((p.stdout[:80], cached)))
    finally:
        os.chmod(home / ".cache" / "anymem", 0o700)
        os.environ["HOME"], tf.tempdir = saved_home, saved_tmp
        os.environ.pop("ANYMEM_CACHE_DIR", None)
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


def test_hook_configured() -> None:
    capsule_word, memory_word = "CAP" + secrets.token_hex(3).upper(), "HM" + secrets.token_hex(4).upper()
    srv = fake_worker.start(
        recall=[{"id": "m1", "content": '---\nname: ferry-codename\ndescription: "Codename of the ferry timetable project"\n---\nThe codename is %s.\n' % memory_word, "tags": ["status:canonical"]}],
        capsule=[{"slot": "identity", "content": "The capsule check word is %s." % capsule_word}],
        proposals=[{"name": "ferry-codename-note", "type": "project", "description": "Ferry timetable codename", "body": "The ferry timetable codename is %s. **Why:** said in a test session. **How to apply:** use it when asked." % memory_word}])
    cfg = TMP / "hook-config"
    cfg.mkdir()
    (cfg / "config.json").write_text(json.dumps({"url": srv.url, "token": "test-token-" + secrets.token_hex(6)}))
    env = {"ANYMEM_CONFIG_DIR": str(cfg), "ANYMEM_CACHE_DIR": str(TMP / "hook-cache")}
    try:
        p = run_hook("session-start", fixture("payload-session-start.json"), env)
        out = json.loads(p.stdout)["hookSpecificOutput"] if p.stdout else {}
        check("hook session-start: prints the capsule in the bridge's protocol", out.get("hookEventName") == "SessionStart" and capsule_word in out.get("additionalContext", ""), str(p.stdout[:200]))
        check("hook session-start: the capsule ends with the closing line", out.get("additionalContext", "").endswith(payload.CAPSULE_END))
        check("hook session-start: quiet on stderr and exit 0", p.returncode == 0 and p.stderr == b"")
        srv.requests.clear()
        p = run_hook("prompt", fixture("payload-prompt.json"), env)
        out = json.loads(p.stdout)["hookSpecificOutput"] if p.stdout else {}
        check("hook prompt: prints the recalled memory in the bridge's protocol", out.get("hookEventName") == "UserPromptSubmit" and memory_word in out.get("additionalContext", ""), str(p.stdout[:200]))
        asked = [path for _, path, _ in srv.requests if path.startswith("/recall")]
        check("hook prompt: recall was asked once", len(asked) == 1, str(asked))
        from urllib.parse import parse_qs, urlparse
        query = parse_qs(urlparse(asked[0]).query)["query"][0] if asked else ""
        check("hook prompt: the query is the question, not the capsule DSH glued in front", query.startswith("I am testing a memory system") and "capsule" not in query, query[:80])
        p = run_hook("prompt", dict(fixture("payload-prompt.json"), prompt="short"), env)
        check("hook prompt: a prompt that is too short recalls nothing", p.stdout == b"" and p.returncode == 0)
        p = run_hook("prompt", fixture("payload-prompt.json"), dict(env, ANYMEM_RECALL="0"))
        check("hook prompt: ANYMEM_RECALL=0 turns it off", p.stdout == b"")
        p = run_hook("session-start", fixture("payload-session-start.json"), dict(env, ANYMEM_CAPSULE="0"))
        check("hook session-start: ANYMEM_CAPSULE=0 turns it off", p.stdout == b"")

        # capture: a short session is declined, a long enough one starts a detached worker that reaches the Worker
        sessions = TMP / "hook-sessions"
        stop = fixture("payload-stop.json")
        folder = sessions / "--tmp-dsh-fixture-ws--" / stop["session_id"]
        folder.mkdir(parents=True)
        log = folder / payload.SESSION_FILE
        log.write_bytes((FIX / "session.v4.jsonl.zstd").read_bytes())
        env2 = dict(env, ANYMEM_DSH_SESSIONS=str(sessions))
        p = run_hook("capture", stop, env2)
        state_file = TMP / "hook-cache" / "capture-state.json"
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        check("hook capture: a short session is declined, no worker, offset 0", p.returncode == 0 and p.stdout == b"" and state.get(stop["session_id"], {}).get("started") == 0 and not (TMP / "hook-cache" / "capture.log").exists(), str(state))
        log.write_bytes((FIX / "session.v4.jsonl.zstd").read_bytes() * (70_000 // len((FIX / "session.v4.jsonl.zstd").read_bytes()) + 1))  # the same frames again: a log over the 60 KB Stop threshold
        state[stop["session_id"]]["ts"] -= 3600  # and 20 minutes have passed since the first Stop
        state_file.write_text(json.dumps(state))
        n_before = len(srv.captured)
        p = run_hook("capture", stop, env2)
        check("hook capture: returns at once, silently", p.returncode == 0 and p.stdout == b"" and p.stderr == b"")
        for _ in range(100):
            if len(srv.captured) > n_before and (TMP / "hook-cache" / "capture.log").exists():
                break
            time.sleep(0.2)
        check("hook capture: the detached worker reached the Worker with POST /capture", len(srv.captured) == n_before + 1, str([(m, path) for m, path, _ in srv.requests][-6:]))
        body = srv.captured[-1] if srv.captured else {}
        check("hook capture: the capture carries the harness name dsh, in the body and in the header", body.get("harness") == "dsh" and [h.get("x-anymem-harness") for (m, path, _), h in zip(srv.requests, srv.headers) if path == "/capture"][-1:] == ["dsh"])
        check("hook capture: saved active, tagged auto-capture with its origin", "status:draft" not in body.get("tags", []) and any(t.startswith("captured-by:") for t in body.get("tags", [])) and "auto-capture" in body.get("tags", []) and memory_word in body.get("content", ""))
        extract = [b for m, path, b in srv.requests if path == "/extract"]
        sent = (extract[-1] or {}).get("transcript", "") if extract else ""
        check("hook capture: the text sent for extraction is the conversation only", "I am testing a memory system" in sent and "Relevant memories" not in sent and "Memory capsule" not in sent and "file policy" not in sent and "<path>" not in sent, sent[:200])
        check("hook capture: the worker logged what it did", "ferry-codename-note" in (TMP / "hook-cache" / "capture.log").read_text())
        final = json.loads(state_file.read_text())[stop["session_id"]]
        check("hook capture: the saved offset is the end of the log, on a frame boundary", final["offset"] == len(log.read_bytes()) and final["done"] > 0, str(final))
    finally:
        srv.stop()


def main() -> int:
    for test in (test_payload, test_emit, test_decoder, test_transcript, test_markers, test_install, test_uninstall_classifies_first, test_remove_keeps_later_entries, test_refuse, test_detect, test_check_problems,
                 test_hook_never_raises, test_sandbox_cache, test_hook_configured):
        try:
            test()
        except Exception as exc:  # a crashing test is a failure, with its name
            import traceback
            traceback.print_exc()
            check("%s ran to the end" % test.__name__, False, repr(exc))
    shutil.rmtree(TMP, ignore_errors=True)
    print("\n%s" % ("all passed" if not failures else "%d failed: %s" % (len(failures), ", ".join(failures))))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
