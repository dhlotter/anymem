"""`doctor`: one line per check, then a verdict. Exits 0 when every check passes, 1 otherwise.

Checks run in order: config, reachable (with the Worker's version and vector index from /health), auth, capsule, unsaved, capsule
cache, usage (counts and the last nightly run from /stats), backup, subjects (counts by status and whether the system acts on its own, only when the Worker has them), and with --probe the vector arm. The vector arm asks the Worker
to overwrite one probe vector (not a memory) and polls until a metadata filtered query finds it. It writes no memory.
Nothing here prints a token or any other secret.
"""
from __future__ import annotations

import json
import os
import time
from datetime import date
from dataclasses import asdict, dataclass
from typing import Callable, List, Optional
from urllib.parse import urlencode

from hm import adapter_roots, api, config, offline, shapes

COMMAND = "doctor"
HELP = "check config, the Worker, auth, the capsule, unsaved memories, the nightly job, backups and vector search (--probe)"

TIMEOUT = 15.0
PROBE_INTERVAL = 10.0
PROBE_WINDOW = 180.0  # a new vector took from 20 seconds to over 2 minutes to become searchable in live runs
CORE_SLOTS = 4
VECTOR_FIX = (
    "vector search is not working. The Vectorize index is probably missing its project and origin metadata indexes. "
    "Fix: run setup.py again, which creates any missing metadata index, then POST /admin/reindex until remaining is 0."
)
LABEL = {"ok": "ok", "warn": "WARN", "fail": "FAIL", "info": "info", "skip": "skip"}


@dataclass
class Check:
    name: str
    status: str  # ok, warn, fail, info or skip. Only fail makes the verdict fail.
    detail: str


SOURCE_NAME = {"env": "the environment", "file": "config.json", "plugin": "the plugin options", "command": "the credential command"}


def _sources(s: config.Settings) -> str:
    return "; ".join("%s from %s" % (k, SOURCE_NAME.get(s.source[k], s.source[k])) for k in ("url", "token") if k in s.source) or "no source"


def _unsendable_credential(s: config.Settings) -> Optional[str]:
    """The name of a credential that cannot go into an HTTP header, or None. urllib raises ValueError for a line break and
    UnicodeEncodeError for a character outside latin-1, and that message would echo the value, so it is checked up front."""
    for label, value in (("token", s.token), ("Access client id", s.access_client_id), ("Access client secret", s.access_client_secret)):
        if any(ch < " " or ch == "\x7f" for ch in value):
            return label
        try:
            value.encode("latin-1")
        except UnicodeEncodeError:
            return label
    return None


def _config_check(s: config.Settings) -> Check:
    if not s.configured():
        detail = "not configured, run setup or connect (missing: %s)" % ", ".join(s.missing())
        if any(k.startswith("HARNESS_MEMORY_") for k in os.environ):
            detail += ". The old HARNESS_MEMORY_* variables are not read any more, set ANYMEM_URL and ANYMEM_TOKEN instead"
        return Check("config", "fail", detail)
    problem = config.url_problem(s.url)
    if problem:
        return Check("config", "fail", "the url %r is not usable (%s). Fix: the url must start with https://, run connect again." % (s.url, problem))
    bad = _unsendable_credential(s)
    if bad:
        return Check("config", "fail", "the %s contains a character that cannot be sent, run connect again. The value is not shown." % bad)
    return Check("config", "ok", "url and token set (%s)" % _sources(s))


REDACT_MIN_LENGTH = 8  # a shorter value would blank ordinary letters out of every line, and no real token is that short


def _redact(checks: List[Check], s: config.Settings) -> List[Check]:
    """A Worker or proxy error can echo a secret back. Scrub the token and the Access secret from every detail before anything prints."""
    secrets_in_use = [v for v in (s.token, s.access_client_secret) if len(v) >= REDACT_MIN_LENGTH]
    for c in checks:
        for secret in secrets_in_use:
            c.detail = c.detail.replace(secret, "[redacted]")
    return checks


HOOK_FILES = ("memory_capture.py", "memory_recall.py", "session_start.py", "memory_capsule.py")
SKILL_FILE = "skills/anymem/SKILL.md"  # what an agent is told to do, so a stale copy of it is as wrong as a stale hook


def _version_key(path) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in path.name.split("."))


def _copies_check(home=None, repo=None) -> Check:
    """Claude Code and Codex copy the plugin into a cache folder at install and keep running that copy. Compare each tool's
    newest copy of the hook files and the skill with the repo's, and warn when they differ. Skipped when this client has no repo beside it."""
    from pathlib import Path
    home = Path(home) if home else Path.home()
    repo = Path(repo) if repo else adapter_roots.PLUGIN_ROOT
    if not all((repo / "hooks" / f).exists() for f in HOOK_FILES):
        return Check("plugin copies", "skip", "no repo beside this client to compare against")
    stale, seen = [], 0
    for tool, base in (("Claude Code", home / ".claude" / "plugins" / "cache" / "anymem" / "anymem"),
                       ("Codex", home / ".codex" / "plugins" / "cache" / "anymem" / "anymem")):
        versions = sorted((d for d in base.glob("*") if d.is_dir()), key=_version_key) if base.exists() else []
        if not versions:
            continue
        seen += 1
        newest = versions[-1]
        pairs = [("hooks/" + f) for f in HOOK_FILES] + [SKILL_FILE]
        if any((newest / f).exists() and (repo / f).exists() and (newest / f).read_bytes() != (repo / f).read_bytes() for f in pairs):
            stale.append((tool, newest.name))
    if stale:
        names = ", ".join("%s (copy %s)" % t for t in stale)
        return Check("plugin copies", "warn", "%s runs a copy of the hooks or skill that differs from the repo. Fix: raise version in .claude-plugin/plugin.json and .codex-plugin/plugin.json, then run claude plugin update anymem@anymem, and for Codex codex plugin remove then add anymem@anymem and approve the hooks again in Codex (/hooks). See docs/install.md, Upgrading." % names)
    return Check("plugin copies", "ok" if seen else "info", "installed plugin copies match the repo" if seen else "no installed plugin copies found")


def _codex_trust_check(home=None) -> Optional[Check]:
    """Codex 0.164 runs a plugin's approved hooks only while the installed plugin folder hashes to what it was at approval, so any
    change to Codex's copy turns every anymem hook off with no message outside Codex. None when Codex has no anymem copy."""
    from pathlib import Path
    from hm.commands import install
    try:
        cx = install.load_module(install.adapters_dir() / "codex")  # the built in adapter only, not every adapter folder
        home_dir = cx.codex_home(Path(home) if home else cx.default_home())
        if cx.active_copy(home_dir) is None:
            return None
        trusted = cx.state(home_dir)["trusted"]
        if not trusted:
            return Check("codex hooks", "warn", "Codex has not approved the anymem hooks, so they do not run. Fix: start codex and approve them (review with /hooks).")
        stale = cx.stale_trust(home_dir, trusted)
    except Exception as e:  # a broken adapter or an odd Codex folder must not stop the other checks
        return Check("codex hooks", "warn", "could not check Codex's approval of the anymem hooks: %s" % e)
    if stale:
        return Check("codex hooks", "warn", "%s Fix: %s" % (stale, cx.REAPPROVE[0].lower() + cx.REAPPROVE[1:]))
    return Check("codex hooks", "ok", "Codex's approval of the anymem hooks matches its copy of the plugin")


def _reachable_check(s: config.Settings) -> Check:
    try:
        resp = api.request("GET", "/health", timeout=TIMEOUT, settings=s)
    except api.ApiError as e:
        if e.status < 500:
            return Check("reachable", "ok", "the Worker answered HTTP %d, the token is checked next" % e.status)
        return Check("reachable", "fail", "the Worker answered HTTP %d: %s. Fix: check the Worker in the Cloudflare dashboard, or open the Worker's logs there." % (e.status, e.message))
    except api.NetworkError as e:
        return Check("reachable", "fail", "cannot reach %s: %s. Fix: check the url (the config check shows where it comes from) and your network." % (s.url, e))
    return _health_detail(resp if isinstance(resp, dict) else {}, s)


def _health_detail(resp: dict, s: config.Settings) -> Check:
    """The /health fields: the Worker's version and schema, and whether the vector index has the dimensions search needs.
    An old Worker sends neither, and is only reported as reachable."""
    version = resp.get("version")
    base = "the Worker answered at %s" % s.url + (", version %s" % version if version else "")
    if resp.get("schema_version") is not None:
        base += ", schema %s" % resp["schema_version"]
    vec = resp.get("vectorize")
    if isinstance(vec, dict) and not vec.get("ok"):
        return Check("reachable", "warn", "%s. The vector index is not ready (dimensions %s, search needs 384). Fix: check the Vectorize index in the Cloudflare dashboard." % (base, vec.get("dimensions")))
    return Check("reachable", "ok", base)


def _auth_check(s: config.Settings) -> Check:
    try:
        resp = api.request("GET", "/count", timeout=TIMEOUT, settings=s)
    except api.ApiError as e:
        if e.status == 401:
            return Check("auth", "fail", "the token was rejected (HTTP 401). Fix: check the token in your config, or run connect again with a current token.")
        if e.status == 403:
            return Check("auth", "fail", "access was refused (HTTP 403). Fix: check the Cloudflare Access service token pair, and the token's permissions.")
        return Check("auth", "fail", "HTTP %d while checking the token: %s" % (e.status, e.message))
    except api.NetworkError as e:
        return Check("auth", "fail", "lost the connection while checking the token: %s. Run doctor again." % e)
    count = resp.get("count") if isinstance(resp, dict) else None
    if not isinstance(count, int):
        return Check("auth", "fail", "unexpected answer from /count. Fix: check the Worker version this client was built for.")
    return Check("auth", "ok", "token accepted, %d memories" % count)


def _capsule_check(s: config.Settings) -> Check:
    try:
        resp = api.request("GET", "/prompt-capsules/core", timeout=TIMEOUT, settings=s)
    except (api.ApiError, api.NetworkError) as e:
        return Check("capsule", "fail", "the core capsule did not answer: %s. Fix: check the Worker version, then run doctor again." % e)
    filled = shapes.sections(resp if isinstance(resp, dict) else {})  # the core sections with content, None for any other shape
    if filled is None:
        return Check("capsule", "fail", "the core capsule came back in an unexpected format. Fix: update the Worker to the version this client was built for.")
    if not filled:
        return Check("capsule", "warn", "the core capsule is empty, 0 of %d sections have content. Fix: save a canonical memory tagged capsule:core and capsule-slot:<identity, preferences, constraints or principles>." % CORE_SLOTS)
    return Check("capsule", "ok", "core capsule has %d of %d sections with content" % (len(filled), CORE_SLOTS))


def _unsaved_check() -> Check:
    recs = offline.failures()
    if not recs:
        return Check("unsaved", "ok", "no unsaved memories")
    n = len(recs)
    newest = recs[-1]
    return Check("unsaved", "warn", "%d unsaved memor%s, newest reason: %s. Fix: check the network and the Worker, then run the resave script. The list is in %s."
                 % (n, "y" if n == 1 else "ies", newest.get("reason", "unknown"), offline.path()))


def _cache_check() -> Check:
    try:
        ts = (config.cache_dir() / "capsule.json").stat().st_mtime
    except OSError:
        return Check("capsule cache", "info", "no capsule cache yet, it is written at the first session start")
    return Check("capsule cache", "info", "capsule cache: %s" % offline.age_label(ts))


def _usage_check(s: config.Settings) -> Check:
    """Counts from GET /stats, informational. That route is admin only, so a 403 or 404 is a skip, not a failure."""
    try:
        resp = api.request("GET", "/stats", timeout=TIMEOUT, settings=s)
    except api.ApiError as e:
        if e.status in (403, 404):
            return Check("usage", "skip", "usage counts need an admin token (GET /stats answered HTTP %d), skipped" % e.status)
        return Check("usage", "warn", "usage counts unavailable: HTTP %d. Fix: check the Worker, then run doctor again." % e.status)
    except api.NetworkError as e:
        return Check("usage", "warn", "usage counts unavailable: %s. Fix: run doctor again." % e)
    if not isinstance(resp, dict) or not isinstance(resp.get("count"), int):
        return Check("usage", "warn", "usage counts: unexpected answer from /stats. Fix: check the Worker version this client was built for.")
    failed = isinstance(resp.get("last_run"), dict) and not resp["last_run"].get("ok")
    return Check("usage", "warn" if failed else "info", "%d memories, %d not vectorized, %d not classified%s%s"
                 % (resp["count"], resp.get("unvectorized") or 0, resp.get("unclassified") or 0, _capture_note(resp.get("capture")), _run_note(resp.get("last_run"))))


def _capture_note(cap) -> str:
    """Today's capture numbers from /stats, when this Worker reports them."""
    if not isinstance(cap, dict) or "accepted" not in cap:
        return ""
    return "; capture today %d saved, %d refused" % (cap.get("accepted") or 0, cap.get("rejected") or 0)


def _run_note(run) -> str:
    """The last nightly job from /stats. A job that failed is said plainly, the details are in the dashboard."""
    if not isinstance(run, dict):
        return ""
    return "; last %s job %s" % (run.get("job", "nightly"), "ok" if run.get("ok") else "FAILED, see the dashboard health page")


def _prereq_check() -> Check:
    """What the client needs, for the person to read. Python is running or this would not print."""
    import shutil
    import sys
    bits = ["Python %d.%d" % sys.version_info[:2],
            "claude found" if shutil.which("claude") else "claude not found (fine for Codex and the others, capture extraction then uses the Worker)"]
    return Check("prerequisites", "info", "; ".join(bits))


BACKUP_STALE_DAYS = 2


def _backup_check(s: config.Settings, today=None) -> Check:
    """The Worker's nightly R2 backup, from GET /backup. Admin only, so a 403 is a skip. A 404 means the Worker has no bucket."""
    try:
        resp = api.request("GET", "/backup", timeout=TIMEOUT, settings=s)
    except api.ApiError as e:
        if e.status == 403:
            return Check("backup", "skip", "the nightly backup needs an admin token (GET /backup answered HTTP 403), skipped")
        if e.status == 404:
            return Check("backup", "warn", "nightly backups are off: the Worker has no BACKUP_BUCKET. Fix: run setup.py again, which adds the R2 bucket binding and redeploys.")
        return Check("backup", "warn", "backup status unavailable: HTTP %d. Fix: check the Worker, then run doctor again." % e.status)
    except api.NetworkError as e:
        return Check("backup", "warn", "backup status unavailable: %s. Fix: run doctor again." % e)
    latest = resp.get("latest") if isinstance(resp, dict) else None
    if not isinstance(latest, dict) or not isinstance(latest.get("day"), str):
        return Check("backup", "warn", "no nightly backup yet. It runs at 01:00 UTC, or run the backup script with --from-worker --now to take one now.")
    try:
        age = ((today or date.today()) - date.fromisoformat(latest["day"])).days
    except ValueError:
        return Check("backup", "warn", "backup status unreadable: the latest backup has no valid date.")
    if age > BACKUP_STALE_DAYS:
        return Check("backup", "warn", "the latest nightly backup is %d days old (%s). Fix: check the Worker's cron triggers and logs, or run the backup script with --from-worker --now." % (age, latest["day"]))
    return Check("backup", "ok", "latest nightly backup %s, %s memories" % (latest["day"], latest.get("entries", "?")))


def _auto_text(s: config.Settings) -> str:
    """Whether the system acts on subjects by itself, and writes briefs, from the three switches GET /stats reports. Empty when the Worker does not say
    (an older Worker, or a stats reply this client cannot read): a line that guesses is worse than a line that is shorter."""
    try:
        stats = api.request("GET", "/stats", timeout=TIMEOUT, settings=s)
    except (api.ApiError, api.NetworkError):
        return ""
    if not isinstance(stats, dict) or not isinstance(stats.get("subjects_auto"), bool):
        return ""
    if not stats["subjects_auto"]:
        return ", auto off"
    # Automation needs the subject layer too. With SUBJECTS off the Worker does nothing new, so say that instead of "auto on".
    if stats.get("subjects_on") is not True:
        return ", auto set but SUBJECTS is off, so it does nothing"
    # Writing briefs has its own third switch. An older Worker does not report it, and then the line says nothing about briefs.
    briefs = stats.get("subjects_briefs")
    return ", auto on" + (", briefs on" if briefs is True else ", briefs off" if briefs is False else "")


def _subjects_check(s: config.Settings) -> Optional[Check]:
    """How many subjects there are by status, and whether the system proposes and links on its own. Informational. None, so no line
    at all, when the Worker does not answer GET /subjects (an older Worker, or a token that may not read it): a feature this Worker
    lacks is not something to report. Proposed subjects wait for a click, so their count is the one a person acts on."""
    try:
        reply = api.request("GET", "/subjects", timeout=TIMEOUT, settings=s)
    except (api.ApiError, api.NetworkError):
        return None
    if not isinstance(reply, dict) or not isinstance(reply.get("subjects"), list):
        return None
    rows = shapes.subjects(reply)
    count = lambda status: sum(r.get("status") == status for r in rows)
    detail = "%d active, %d proposed, %d stale, %d private" % (count("active"), count("proposed"), count("stale"), sum(r.get("scope") == "private" for r in rows))
    return Check("subjects", "info", detail + _auto_text(s))


def _probe(s: config.Settings, interval: float, window: float, sleep: Callable[[float], None]) -> List[Check]:
    """Overwrite the Worker's probe vector, then poll until it is found through the metadata filter or the window ends.
    Found without the filter but not with it is the missing metadata index. Found nowhere is a warning, not a failure, because
    indexing time varies. A 404 means an older Worker: use the memory probe."""
    try:
        started = api.request("POST", "/vectorize-probe", {}, timeout=TIMEOUT, settings=s)
    except api.ApiError as e:
        if e.status == 404:
            return [Check("vector", "skip", "this Worker has no /vectorize-probe route, it is the old Worker, so the vector arm cannot be checked")]
        return [Check("vector", "fail", "the vector probe could not be started: %s. Fix: check the Worker and the token, then run doctor --probe again." % e)]
    except api.NetworkError as e:
        return [Check("vector", "fail", "the vector probe could not be started: %s. Fix: check the Worker and the token, then run doctor --probe again." % e)]
    nonce = started.get("probe") if isinstance(started, dict) else None
    if not nonce:
        return [Check("vector", "fail", "the vector probe did not return an id. Fix: check the Worker version, then run doctor --probe again.")]
    waited = 0.0
    unfiltered = False
    try:
        while True:
            seen = api.request("GET", "/vectorize-probe?" + urlencode({"probe": nonce}), timeout=TIMEOUT, settings=s)
            if isinstance(seen, dict) and seen.get("filtered"):
                return [Check("vector", "ok", "vector search finds the probe vector through the metadata filter, after %d seconds" % waited)]
            unfiltered = unfiltered or bool(isinstance(seen, dict) and seen.get("unfiltered"))
            if waited >= window:
                break
            sleep(interval)
            waited += interval
    except (api.ApiError, api.NetworkError) as e:
        return [Check("vector", "fail", "vector search could not be checked: %s. Run doctor --probe again." % e)]
    if unfiltered:
        return [Check("vector", "fail", VECTOR_FIX)]
    # Not found with the filter or without it is not a fault by itself: Vectorize indexing time varies from seconds to minutes.
    # Only "found without the filter" (above) is evidence that search is broken.
    return [Check("vector", "warn", "the probe vector was not searchable after %d seconds. Vector indexing takes from seconds to a few minutes, so this is not proof of a fault. "
                  "Fix: run doctor --probe again in a few minutes, and check the Worker logs in the Cloudflare dashboard if it repeats." % window)]


def diagnose(probe: bool = False, interval: float = PROBE_INTERVAL, window: float = PROBE_WINDOW,
             sleep: Callable[[float], None] = time.sleep, settings: Optional[config.Settings] = None) -> List[Check]:
    s = settings or config.load()
    config_check = _config_check(s)
    checks = [config_check]
    online = config_check.status == "ok"
    for name, fn in (("reachable", _reachable_check), ("auth", _auth_check)):
        if not online:
            checks.append(Check(name, "skip", "skipped, fix the failing check above first"))
            continue
        check = fn(s)
        checks.append(check)
        online = check.status != "fail"
    if online:
        checks.append(_capsule_check(s))
    else:
        checks.append(Check("capsule", "skip", "skipped, fix the failing check above first"))
    checks.append(_unsaved_check())
    checks.append(_cache_check())
    checks.append(_copies_check())
    codex = _codex_trust_check()
    if codex:
        checks.append(codex)
    checks.append(_prereq_check())
    if online:
        checks.append(_usage_check(s))
        checks.append(_backup_check(s))
        subjects = _subjects_check(s)
        if subjects:
            checks.append(subjects)
    else:
        checks.append(Check("usage", "skip", "skipped, fix the failing check above first"))
        checks.append(Check("backup", "skip", "skipped, fix the failing check above first"))
    if not probe:
        checks.append(Check("vector", "info", "vector search not checked, run doctor --probe"))
    elif online:
        checks.extend(_probe(s, interval, window, sleep))
    else:
        checks.append(Check("vector", "skip", "skipped, fix the failing check above first"))
    return _redact(checks, s)


def emit(checks: List[Check], as_json: bool) -> int:
    failed = sum(c.status == "fail" for c in checks)
    warned = sum(c.status == "warn" for c in checks)
    if failed:
        state, summary = "fail", "%d check%s failed, fix the FAIL lines above" % (failed, "" if failed == 1 else "s")
    elif warned:
        state, summary = "pass", "passing with %d warning%s" % (warned, "" if warned == 1 else "s")
    else:
        state, summary = "pass", "all checks passed"
    if as_json:
        print(json.dumps({"verdict": state, "summary": summary, "checks": [asdict(c) for c in checks]}, indent=2))
    else:
        for c in checks:
            print("%-5s %-14s %s" % (LABEL[c.status], c.name, c.detail))
        print("verdict: " + summary)
    return 0 if state == "pass" else 1


def run(ns, interval: float = PROBE_INTERVAL, window: float = PROBE_WINDOW, sleep: Callable[[float], None] = time.sleep) -> int:
    checks = diagnose(probe=ns.probe, interval=interval, window=window, sleep=sleep)
    return emit(checks, ns.json_out)


def register(parser):
    parser.add_argument("--probe", action="store_true", help="write one probe vector, not a memory, and wait for vector search to find it (up to 3 minutes)")
    parser.add_argument("--json", dest="json_out", action="store_true", help="print the checks and the verdict as one JSON object")
