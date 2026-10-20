#!/usr/bin/env python3
"""Runnable check for the install script with fake adapters. No network, no real harness config.
Each case builds a temporary adapters folder and home folder, then runs the install command against them.
`python3 client/tests/test_install.py`, exits non-zero on failure."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CLI = str(ROOT / "client" / "tests" / "run_command.py")
failures = []

FAKE_ONE = '''
import json, os
from pathlib import Path

NAME = "fakeone"
TITLE = "Fake one"
KEY = "anymem"


def _file():
    return Path(os.environ["ANYMEM_HOME"]) / ".fakeone" / "settings.json"


def _load():
    return json.loads(_file().read_text(encoding="utf-8"))


def _save(data):
    _file().write_text(json.dumps(data, indent=2) + "\\n", encoding="utf-8")


def detect():
    f = _file()
    return {"found": f.exists(), "version": "1.0", "config_path": str(f), "notes": []}


def plan(options):
    return ["add the " + KEY + " entry to " + str(_file())]


def install(options):
    data = _load()
    data[KEY] = {"command": "anymem capsule"}
    _save(data)
    return {"changed": [str(_file())], "notes": []}


def check():
    try:
        data = _load()
    except (OSError, ValueError):
        return {"ok": False, "problems": ["settings file missing or invalid"]}
    if KEY in data:
        return {"ok": True, "problems": []}
    return {"ok": False, "problems": [KEY + " entry missing"]}


def uninstall():
    data = _load()
    if KEY in data:
        del data[KEY]
        _save(data)
    return {"changed": [str(_file())]}
'''

FAKE_PENDING = '''
import json, os
from pathlib import Path

NAME = "fakepending"
TITLE = "Fake pending"


def _file():
    return Path(os.environ["ANYMEM_HOME"]) / ".fakepending.json"


def detect():
    return {"found": True, "version": "1", "config_path": str(_file()), "notes": []}


def plan(options):
    return ["write the entry"]


def install(options):
    _file().write_text("{}", encoding="utf-8")
    return {"changed": [str(_file())], "notes": []}


def check():
    if not _file().exists():
        return {"ok": False, "problems": ["entry missing"], "pending": []}
    return {"ok": True, "problems": [], "pending": ["approve the hooks inside the harness when it asks"]}


def uninstall():
    _file().unlink()
    return {"changed": [str(_file())]}
'''

FAKE_BROKEN = '''
NAME = "fakebroken"
TITLE = "Fake broken"


def detect():
    return {"found": True, "version": "0", "config_path": "none", "notes": []}


def plan(options):
    return ["break things"]


def install(options):
    raise RuntimeError("the config was on fire")


def check():
    raise RuntimeError("check exploded")


def uninstall():
    return {"changed": []}
'''

FAKE_LEAK = '''
import os

NAME = "fakeleak"
TITLE = "Fake leak"


def detect():
    return {"found": True, "version": "1", "config_path": os.environ["ANYMEM_TEST_OUTSIDE"], "notes": []}


def plan(options):
    return ["write outside home"]


def install(options):
    return {"changed": [os.environ["ANYMEM_TEST_OUTSIDE"]], "notes": []}


def check():
    return {"ok": True, "problems": []}


def uninstall():
    return {"changed": []}
'''

FAKE_STUBBORN = '''
import json, os
from pathlib import Path

NAME = "fakestubborn"
TITLE = "Fake stubborn"
KEY = "anymem"


def _file():
    return Path(os.environ["ANYMEM_HOME"]) / ".stubborn" / "settings.json"


def detect():
    return {"found": True, "version": "1", "config_path": str(_file()), "notes": []}


def plan(options):
    return ["add the " + KEY + " entry"]


def install(options):
    _file().parent.mkdir(parents=True, exist_ok=True)
    _file().write_text(json.dumps({KEY: 1}), encoding="utf-8")
    return {"changed": [str(_file())], "notes": []}


def check():
    ok = _file().exists() and KEY in json.loads(_file().read_text(encoding="utf-8"))
    return {"ok": bool(ok), "problems": [] if ok else [KEY + " entry missing"]}


def uninstall():
    return {"changed": []}
'''

FAKE_BADCHECK = '''
NAME = "fakebadcheck"
TITLE = "Fake bad check"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": []}


def plan(options):
    return ["write the entry"]


def install(options):
    return {"changed": [], "notes": []}


def check():
    return {"ok": False, "problems": ["check says no after install"]}


def uninstall():
    return {"changed": []}
'''

FAKE_STRPLAN = '''
NAME = "fakestrplan"
TITLE = "Fake string plan"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": []}


def plan(options):
    return "add the entry"


def install(options):
    return {"changed": [], "notes": []}


def check():
    return {"ok": True, "problems": []}


def uninstall():
    return {"changed": []}
'''

FAKE_BADPLAN = '''
import os
from pathlib import Path

NAME = "fakebadplan"
TITLE = "Fake bad plan"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": []}


def plan(options):
    return {"entry": "add it"}


def install(options):
    Path(os.environ["ANYMEM_HOME"], "badplan-ran").write_text("x", encoding="utf-8")
    return {"changed": [], "notes": []}


def check():
    return {"ok": True, "problems": []}


def uninstall():
    return {"changed": []}
'''

FAKE_SECRET = '''
NAME = "fakesecret"
TITLE = "Fake secret"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": []}


def plan(options):
    return ["fail on purpose"]


def install(options):
    raise RuntimeError("Bearer sk-SECRET123456 was rejected")


def check():
    return {"ok": True, "problems": []}


def uninstall():
    return {"changed": []}
'''

# Two layouts: `import payload` (sibling loaded from sys.path) and `from . import payload` (sibling loaded from the package).
FAKE_SIB_PLAIN = '''
import payload

NAME = payload.NAME
TITLE = "Fake sibling"


def detect():
    return {"found": True, "version": payload.VERSION, "config_path": "none", "notes": []}


def plan(options):
    return ["sibling plan"]


def install(options):
    return {"changed": [], "notes": []}


def check():
    return {"ok": True, "problems": []}


def uninstall():
    return {"changed": []}
'''

FAKE_SIB_REL = FAKE_SIB_PLAIN.replace("import payload", "from . import payload")

# Defines detect() only: plan, install, check and uninstall are missing.
FAKE_NOFN = '''
NAME = "fakenofn"
TITLE = "Fake missing functions"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": []}
'''

# Every text it returns carries a token-shaped value that must be masked wherever it is printed.
FAKE_LEAKY = '''
NAME = "fakeleaky"
TITLE = "Fake leaky"


def detect():
    return {"found": True, "version": "1", "config_path": "none", "notes": ["key sk-abcdefgh12345678 in use"]}


def plan(options):
    return ["write token=SECRETVALUE123 to the config"]


def install(options):
    return {"changed": [], "notes": ["used Bearer abcdefghij"]}


def check():
    return {"ok": False, "problems": ["token=SECRETVALUE123 left in place"]}


def uninstall():
    return {"changed": []}
'''

FAKES = {
    "fakepending": FAKE_PENDING,
    "fakenofn": FAKE_NOFN,
    "fakeleaky": FAKE_LEAKY,
    "fakeone": FAKE_ONE,
    "fakebroken": FAKE_BROKEN,
    "fakeleak": FAKE_LEAK,
    "fakestubborn": FAKE_STUBBORN,
    "fakebadcheck": FAKE_BADCHECK,
    "fakestrplan": FAKE_STRPLAN,
    "fakebadplan": FAKE_BADPLAN,
    "fakesecret": FAKE_SECRET,
    "fakesiba": FAKE_SIB_PLAIN,
    "fakesibb": FAKE_SIB_PLAIN,
    "fakesibrel": FAKE_SIB_REL,
}
EXTRA = {
    "fakesiba": {"payload.py": 'NAME = "sibling-a"\nVERSION = "sib-a"\n'},
    "fakesibb": {"payload.py": 'NAME = "sibling-b"\nVERSION = "sib-b"\n'},
    "fakesibrel": {"payload.py": 'NAME = "sibling-rel"\nVERSION = "sib-rel"\n'},
}
SETTINGS = json.dumps({"editor": {"theme": "dark", "tabs": 2}, "model": "x"}, indent=2) + "\n"


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


def setup(fakes, settings=True):
    """A temporary root with an adapters folder holding the named fakes, and a home folder. Returns (root, home, env)."""
    root = Path(tempfile.mkdtemp())
    adapters = root / "adapters"
    adapters.mkdir()
    for fake in fakes:
        (adapters / fake).mkdir()
        (adapters / fake / "adapter.py").write_text(FAKES[fake], encoding="utf-8")
        for rel, text in EXTRA.get(fake, {}).items():
            (adapters / fake / rel).write_text(text, encoding="utf-8")
    home = root / "home"
    (home / ".fakeone").mkdir(parents=True)
    if settings:
        (home / ".fakeone" / "settings.json").write_text(SETTINGS, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("ANYMEM_")}
    env.update(
        ANYMEM_ADAPTERS_DIR=str(adapters),
        ANYMEM_HOME=str(home),
        ANYMEM_CONFIG_DIR=str(root / "cfg"),
        ANYMEM_CACHE_DIR=str(root / "cache"),
        ANYMEM_TEST_OUTSIDE=str(root / "outside.txt"),
    )
    return root, home, env


def cli(args, env, stdin=""):
    p = subprocess.run([sys.executable, CLI, *args], input=stdin, capture_output=True, text=True, env=env, timeout=60)
    return p.returncode, p.stdout, p.stderr


def line_for(out, name):
    """The --list line that starts with NAME, or '' when there is none."""
    return next((line for line in out.splitlines() if line.split("  ")[0] == name), "")


settings_path = lambda home: home / ".fakeone" / "settings.json"  # noqa: E731

# 1. --list shows every adapter with detect() results
_, home, env = setup(["fakeone", "fakebroken"], settings=False)
rc, out, err = cli(["install", "--list"], env)
absent, broken = line_for(out, "fakeone"), line_for(out, "fakebroken")
check("--list shows fakeone as not found, with its version and config path",
      rc == 0 and "  not found  " in absent and "version 1.0" in absent and ".fakeone" in absent)
check("--list shows fakebroken as found, not as not found",
      "  found  " in broken and "not found" not in broken and "version 0" in broken)
check("--list prints no traceback", "Traceback" not in out + err)
_, home, env = setup(["fakeone"])
rc, out, err = cli(["install", "--list"], env)
check("--list shows fakeone as found once its config file exists",
      rc == 0 and "  found  " in line_for(out, "fakeone") and "not found" not in line_for(out, "fakeone"))

# 2. install with confirmation declined changes nothing
_, home, env = setup(["fakeone"])
before = settings_path(home).read_bytes()
rc, out, err = cli(["install", "fakeone"], env, stdin="n\n")
check("install declined at the question exits 1 and writes nothing",
      rc == 1 and "not installed" in out and settings_path(home).read_bytes() == before)
rc, out, err = cli(["install", "fakeone"], env, stdin="")
check("install with no answer (end of input) counts as declined and writes nothing",
      rc == 1 and settings_path(home).read_bytes() == before)

# 3. --dry-run prints the plan and writes nothing
_, home, env = setup(["fakeone"])
before = settings_path(home).read_bytes()
rc, out, err = cli(["install", "fakeone", "--dry-run"], env)
check("--dry-run prints the plan, writes nothing and exits 0",
      rc == 0 and "add the anymem entry" in out and "dry run" in out and settings_path(home).read_bytes() == before)

# 4. --yes installs, then check() reports ok
_, home, env = setup(["fakeone"])
rc, out, err = cli(["install", "fakeone", "--yes"], env)
data = json.loads(settings_path(home).read_text(encoding="utf-8"))
check("--yes installs without asking and check() then reports ok",
      rc == 0 and "anymem" in data and "fakeone: ok" in out)

# 5. --check is not ok before install and ok after
_, home, env = setup(["fakeone"])
rc, out, err = cli(["install", "--check", "fakeone"], env)
check("--check reports not ok with the problem before install, exit 1",
      rc == 1 and "not ok" in out and "entry missing" in out)
cli(["install", "fakeone", "--yes"], env)
rc, out, err = cli(["install", "--check", "fakeone"], env)
check("--check reports ok after install, exit 0", rc == 0 and "fakeone: ok" in out)

# 6. --uninstall removes only the product's entries, every other byte identical
_, home, env = setup(["fakeone"])
original = settings_path(home).read_bytes()
cli(["install", "fakeone", "--yes"], env)
rc, out, err = cli(["install", "fakeone", "--uninstall", "--yes"], env)
check("--uninstall restores the file byte identical and proves it with check()",
      rc == 0 and settings_path(home).read_bytes() == original and "removed" in out and "still wired" not in err)

# 7. a raising adapter is isolated in --all
_, home, env = setup(["fakeone", "fakebroken"])
rc, out, err = cli(["install", "--all", "--yes"], env)
data = json.loads(settings_path(home).read_text(encoding="utf-8"))
broken_lines = [line for line in err.splitlines() if line.startswith("fakebroken:")]
check("--all installs the good adapter even when another raises",
      "anymem" in data and "fakeone: ok" in out)
check("--all reports the raising adapter as one plain line with its name and message, exit 1",
      rc == 1 and broken_lines == ["fakebroken: install failed: the config was on fire"] and "Traceback" not in out + err)

# 8. --check over every found adapter exits 1 when one reports a problem
rc, out, err = cli(["install", "--check"], env)
check("--check with no name checks every found adapter and reports the raising one, exit 1",
      rc == 1 and "fakeone: ok" in out and "fakebroken: check failed: check exploded" in err)

# 9. unknown name lists the valid ones and exits 1
_, home, env = setup(["fakeone"])
before = settings_path(home).read_bytes()
rc, out, err = cli(["install", "nosuch", "--yes"], env)
check("unknown adapter name lists the valid names, exits 1 and writes nothing",
      rc == 1 and "nosuch" in err and "fakeone" in err and settings_path(home).read_bytes() == before)

# 10. the outside-home guard fails loudly
_, home, env = setup(["fakeleak"], settings=False)
rc, out, err = cli(["install", "fakeleak", "--yes"], env)
check("an adapter reporting a change outside home fails loudly, exit 1",
      rc == 1 and "reported changes outside" in err and "outside.txt" in err)

# 11. an empty adapters folder lists nothing and exits 0
root = Path(tempfile.mkdtemp())
env = {k: v for k, v in os.environ.items() if not k.startswith("ANYMEM_")}
env.update(ANYMEM_ADAPTERS_DIR=str(root), ANYMEM_CONFIG_DIR=str(root / "cfg"), ANYMEM_CACHE_DIR=str(root / "cache"))
rc, out, err = cli(["install", "--list"], env)
check("--list on an empty adapters folder says so and exits 0", rc == 0 and "no adapters found" in out)

# 12. a sibling payload.py loads under both import forms, and two adapters with the same file name stay apart
_, home, env = setup(["fakesiba", "fakesibb", "fakesibrel"], settings=False)
rc, out, err = cli(["install", "--list"], env)
check("sibling payload.py loads for `import payload` and `from . import payload`, and each adapter keeps its own",
      rc == 0 and "version sib-a" in line_for(out, "sibling-a") and "version sib-b" in line_for(out, "sibling-b")
      and "version sib-rel" in line_for(out, "sibling-rel") and "could not load" not in out + err)

# 13. a plan given as one string prints one line; a plan that is not a list stops before any write
_, home, env = setup(["fakestrplan"], settings=False)
rc, out, err = cli(["install", "fakestrplan", "--yes"], env)
check("a plan returned as one string prints as one line, exit 0", rc == 0 and "  add the entry" in out.splitlines())
_, home, env = setup(["fakebadplan"], settings=False)
rc, out, err = cli(["install", "fakebadplan", "--yes"], env)
check("a plan that is not a list is an error, exit 1, and install never runs",
      rc == 1 and "plan returned no list of lines" in err and not (home / "badplan-ran").exists())

# 14. a token in an adapter's error text is masked before it reaches the terminal
_, home, env = setup(["fakesecret"], settings=False)
rc, out, err = cli(["install", "fakesecret", "--yes"], env)
check("an adapter error that carries a token is masked on stderr, exit 1",
      rc == 1 and "SECRET123456" not in out + err and "Bearer [redacted]" in err)

# 15. --uninstall declined, --uninstall --dry-run, --all declined, the still-wired path, and check() failing after install
_, home, env = setup(["fakeone"])
cli(["install", "fakeone", "--yes"], env)
wired = settings_path(home).read_bytes()
rc, out, err = cli(["install", "fakeone", "--uninstall"], env, stdin="n\n")
check("--uninstall declined exits 1 and leaves the entry in place",
      rc == 1 and "not removed" in out and settings_path(home).read_bytes() == wired)
rc, out, err = cli(["install", "fakeone", "--uninstall", "--dry-run"], env)
check("--uninstall --dry-run removes nothing and exits 0",
      rc == 0 and "dry run" in out and settings_path(home).read_bytes() == wired)

_, home, env = setup(["fakeone", "fakebroken"])
before = settings_path(home).read_bytes()
rc, out, err = cli(["install", "--all"], env, stdin="n\nn\n")
check("--all with every confirmation declined installs nothing and exits 1",
      rc == 1 and out.count("not installed") == 2 and settings_path(home).read_bytes() == before)

_, home, env = setup(["fakestubborn"], settings=False)
cli(["install", "fakestubborn", "--yes"], env)
rc, out, err = cli(["install", "fakestubborn", "--uninstall", "--yes"], env)
check("--uninstall that leaves check() ok is reported as still wired, exit 1",
      rc == 1 and "still wired" in err and "removed" not in out)

_, home, env = setup(["fakebadcheck"], settings=False)
rc, out, err = cli(["install", "fakebadcheck", "--yes"], env)
check("an install whose check() fails afterwards exits 1 and says so",
      rc == 1 and "fakebadcheck: not ok" in out and "check says no after install" in out)

# 16. an adapter missing a contract function is reported by name, and --all still installs the others
_, home, env = setup(["fakeone", "fakenofn"])
rc, out, err = cli(["install", "--all", "--yes"], env)
data = json.loads(settings_path(home).read_text(encoding="utf-8"))
check("--all installs the good adapter when another lacks plan(), and names the missing function",
      rc == 1 and "anymem" in data and "fakeone: ok" in out and "fakenofn: plan failed: missing plan() function" in err
      and "Traceback" not in out + err)
rc, out, err = cli(["install", "--check"], env)
check("--check with no name reports the missing check() by adapter name and keeps going",
      rc == 1 and "fakeone: ok" in out and "fakenofn: check failed: missing check() function" in err)
rc, out, err = cli(["install", "fakenofn", "--uninstall", "--yes"], env)
check("--uninstall of an adapter missing uninstall() names it and exits 1",
      rc == 1 and "fakenofn: uninstall failed: missing uninstall() function" in err and "Traceback" not in out + err)

# 17. token-shaped text from an adapter is masked everywhere it is printed, not only in exception text
_, home, env = setup(["fakeleaky"], settings=False)
rc, out, err = cli(["install", "--list"], env)
check("detect() notes are masked in --list", "key [redacted] in use" in out and "abcdefgh12345678" not in out + err)
rc, out, err = cli(["install", "fakeleaky", "--yes"], env)
check("plan lines, install notes and check problems are masked, exit 1",
      rc == 1 and "token=[redacted]" in out and "Bearer [redacted]" in out and "SECRETVALUE123" not in out + err
      and "abcdefghij" not in out + err)

# 18. a pending next step is printed as a next step and does not fail the install or the check
_, home, env = setup(["fakepending"], settings=False)
rc, out, err = cli(["install", "fakepending", "--yes"], env)
check("an adapter with only a pending item installs ok, prints the next step, exits 0",
      rc == 0 and "fakepending: ok" in out and "next step: approve the hooks inside the harness" in out and "not ok" not in out)
rc, out, err = cli(["install", "--check", "fakepending"], env)
check("--check shows the pending item as a next step and exits 0", rc == 0 and "next step: approve the hooks" in out)
rc, out, err = cli(["install", "fakepending", "--uninstall", "--yes"], env)
check("--uninstall of a pending adapter still proves the removal", rc == 0 and "could not prove" not in out and "still wired" not in out and "Traceback" not in out + err)

# 19. your own adapters folder (~/.config/anymem/adapters) is read next to the plugin's, so dropping a folder in is enough
root, home, env = setup(["fakeone"])
mine = root / "cfg" / "adapters" / "fakemine"
mine.mkdir(parents=True)
(mine / "adapter.py").write_text(FAKE_ONE.replace('NAME = "fakeone"', 'NAME = "fakemine"').replace('TITLE = "Fake one"', 'TITLE = "Fake mine"'), encoding="utf-8")
rc, out, err = cli(["install", "--list"], env)
check("--list shows both the plugin's adapter and the one dropped in your folder", line_for(out, "fakeone") != "" and line_for(out, "fakemine") != "")
rc, out, err = cli(["install", "fakemine", "--yes"], env)
check("an adapter from your folder installs like any other", rc == 0 and "fakemine: ok" in out)

# 20. a name that a built in adapter already uses is refused with a reason, and the built in one still works
dup = root / "cfg" / "adapters" / "fakeone"
dup.mkdir(parents=True)
(dup / "adapter.py").write_text(FAKE_ONE, encoding="utf-8")
rc, out, err = cli(["install", "--list"], env)
check("a duplicate name is shown as not loadable, not silently replacing the built in one",
      "fakeone (yours): could not load: a built in adapter already uses the name 'fakeone'" in out and line_for(out, "fakeone") != "")

# 21. --new writes a starter adapter that loads, lists as not found, and passes its own test
root, home, env = setup([])
rc, out, err = cli(["install", "--new", "myharness"], env)
folder = root / "cfg" / "adapters" / "myharness"
check("--new writes adapter.py, payload.py, test_adapter.py and a fixtures folder",
      rc == 0 and all((folder / f).is_file() for f in ("adapter.py", "payload.py", "test_adapter.py")) and (folder / "fixtures").is_dir())
rc, out, err = cli(["install", "--list"], env)
check("the starter shows in --list as not found, with a note saying what to fill in",
      "myharness  Myharness  not found" in out and "not written yet" in out)
p = subprocess.run([sys.executable, str(folder / "test_adapter.py")], capture_output=True, text=True)
check("the starter's own test passes", p.returncode == 0 and p.stdout.strip() == "ok")
rc, out, err = cli(["install", "--new", "myharness"], env)
check("--new refuses a name that already exists and writes nothing more", rc == 1 and "already exists" in err)
rc, out, err = cli(["install", "--new", "Bad Name"], env)
check("--new refuses a name with spaces or capitals", rc == 1 and "lower case" in err)
rc, out, err = cli(["install", "--new"], env)
check("--new with no name says what to give", rc == 1 and "lower case" in err)
rc, out, err = cli(["install", "myharness", "--yes"], env)
check("installing the unfinished starter fails with one line, not a traceback", rc != 0 and "Traceback" not in out + err and "not written yet" in out + err)

# 22. a built in adapter folder that fails to import is named as the reason, and a good adapter of yours with that name is still listed
root, home, env = setup([])
(root / "adapters" / "brokenimport").mkdir()
(root / "adapters" / "brokenimport" / "adapter.py").write_text('raise RuntimeError("boom")\n', encoding="utf-8")
mine = root / "cfg" / "adapters" / "brokenimport"
mine.mkdir(parents=True)
(mine / "adapter.py").write_text(FAKE_ONE.replace('NAME = "fakeone"', 'NAME = "brokenimport"'), encoding="utf-8")
rc, out, err = cli(["install", "--list"], env)
check("a built in folder that fails to import is named as the reason, not called a loaded built in adapter",
      "brokenimport: could not load: boom" in out and "brokenimport (yours): could not load: a built in adapter folder that failed to load holds the name 'brokenimport'" in out)

# 23. --new honours --dry-run, refuses flag combinations, and refuses a name that ends in a newline
root, home, env = setup([])
rc, out, err = cli(["install", "--new", "dryone", "--dry-run"], env)
check("--new --dry-run writes nothing and says what it would write", rc == 0 and "dry run, would write" in out and not (root / "cfg" / "adapters" / "dryone").exists())
rc, out, err = cli(["install", "--new", "combo", "--list"], env)
check("--new with --list is refused and writes nothing", rc == 1 and "cannot be combined" in err and not (root / "cfg" / "adapters" / "combo").exists())
rc, out, err = cli(["install", "--new", "bad\n"], env)
check("a name ending in a newline is refused", rc == 1 and "lower case" in err and not any((root / "cfg" / "adapters").glob("*")) if (root / "cfg" / "adapters").exists() else rc == 1)

print("ok" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
