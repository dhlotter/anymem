"""`setup.py`, in order. Idempotent, never deletes, and --dry-run prints every API call first and sends nothing.

Order matters. Database and schema, vector index and its metadata indexes (before any vector can be written), the backup bucket,
the address name, Access, then the Worker with its bindings, the cron and the address. Then local config, doctor --probe, the
connection string for other machines, and the plan limits.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from hm import config, deploy, scripts

from . import access as access_mod, cf, limits, preflight, resources, worker

NAME_PATTERN = r"[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?"
LABELS = {"d1": "D1 database", "vectorize": "Vectorize index", "r2": "R2 backup bucket", "worker": "Worker", "access": "Access application"}
ORDER = ("d1", "vectorize", "r2", "access", "worker")
SCRIPTS = deploy.plugin_root() / "skills" / "anymem" / "scripts"


@dataclass
class Options:
    name: str = deploy.DEFAULT_NAME
    domain: str = ""
    subdomain: str = ""
    access: bool = False
    no_access: bool = False      # the only way to drop Access on a store that has it
    email: str = ""
    plan: str = ""
    dry_run: bool = False
    yes: bool = False
    rotate_access: bool = False  # replace the Access service token this store made; connection strings made before stop working
    second_machine: bool = False  # make a connection string for a second machine now (one device token and the Access pair)
    account_id: str = ""
    root: Path = field(default_factory=deploy.plugin_root)
    say: object = print
    ask: object = None          # prompt text -> typed text, "" when nobody can answer
    run_cli: object = None      # list of arguments -> exit code
    harnesses: object = None    # () -> [(name, found)]
    confirm: object = None      # () -> bool, asked after the plan and the checklist and before anything is sent
    wait: float = 240.0
    healthy: object = None      # (url, token, wait, sleep) -> "" when up, else a reason, replaced in tests
    sleep: object = time.sleep
    token: str = ""

    def rerun(self) -> str:
        parts = [scripts.cmd("setup")]
        if self.name != deploy.DEFAULT_NAME:
            parts.append("--name " + self.name)
        if self.domain:
            parts.append("--domain " + self.domain)
        if self.access:
            parts.append("--access --email " + self.email)
        return " ".join(parts)


def option_problem(opts: Options) -> str:
    if not re.fullmatch(NAME_PATTERN, opts.name or ""):
        return "%r is not a usable --name. Use 1 to 42 lowercase letters, digits or hyphens, starting and ending with a letter or digit." % (opts.name,)
    if opts.domain and not worker.valid_domain(opts.domain):
        return "%r does not look like a domain name. Use something like memory.example.com." % (opts.domain,)
    if opts.access and opts.no_access:
        return "--access and --no-access cannot be used together. --access keeps Access on, --no-access turns it off."
    if opts.access and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", opts.email or ""):
        return "Access needs the email you will log in with in a browser. Add --email you@example.com."
    if opts.rotate_access and not opts.access:
        return "--rotate-access replaces the Access service token of a store that has Access. Add --access --email you@example.com with it."
    if opts.plan and opts.plan not in limits.PLANS:
        return "--plan is free or paid."
    return ""


def recorded_access(recorded: dict) -> bool:
    """Whether Access was on the last time setup ran here. A store set up before access_enabled was kept is read from its Access record."""
    return bool(recorded.get("access_enabled", bool(recorded.get("access"))))


def keep_recorded(opts: Options, recorded: dict) -> None:
    """A plain rerun keeps the Access and the custom domain the store recorded, so it cannot drop them by accident."""
    if recorded.get("name") not in (None, "", opts.name):
        return  # another store, run_setup refuses it by name
    if recorded_access(recorded) and not opts.access and not opts.no_access:
        opts.access = True
        opts.email = opts.email or recorded.get("access_email") or (recorded.get("access") or {}).get("email", "")
    if recorded.get("domain") and not opts.domain:
        opts.domain = recorded["domain"]


def plan_text(opts: Options) -> list:
    n = resources.names(opts.name)
    address = "https://%s (custom domain, workers.dev off)" % opts.domain if opts.domain else "a workers.dev address chosen by Cloudflare"
    lines = [
        "Setup will use your Cloudflare account to create or reuse:",
        "  1. D1 database       %s, with the schema applied" % n["d1"],
        "  2. Vectorize index   %s (%d dimensions, %s), metadata indexes %s made first" % (n["vectorize"], resources.DIMENSIONS, resources.METRIC, ", ".join(resources.METADATA_INDEXES)),
        "  3. R2 bucket         %s, backups deleted after 30 days" % n["r2"],
        "  4. Worker            %s, bindings D1, Vectorize, AI, R2 and the dashboard files, cron 01:00 UTC, a new AUTH_TOKEN" % n["worker"],
        "  5. Address           %s" % address,
    ]
    if opts.access and opts.rotate_access:
        lines.append("  6. Access            application on the address, service token %s-machines REPLACED (the old one is deleted now), allow rule for %s" % (opts.name, opts.email))
    elif opts.access:
        lines.append("  6. Access            application on the address, service token %s-machines, allow rule for %s" % (opts.name, opts.email))
    else:
        lines.append("  6. Access            not requested. Without it the bearer token is the only lock (add --access --email you@example.com, recommended)")
    lines.append("It never deletes anything and skips whatever already exists, so rerunning it is safe. A rerun keeps the Access and the custom domain the store recorded, and uploads the current Worker code.")
    return lines


def default_cli(args, stdin=None) -> int:
    return subprocess.run([sys.executable, str(SCRIPTS / (args[0] + ".py")), *args[1:]], input=stdin, text=True if stdin is not None else None).returncode


def _ask_default(prompt: str) -> str:
    try:
        return input(prompt)
    except EOFError:
        return ""


class Steps:
    """Prints a line per step with the seconds since setup began, so a slow step is easy to see."""

    def __init__(self, say):
        self.say, self.t0 = say, time.time()

    def head(self, text: str) -> None:
        self.say("[%5.1fs] %s" % (time.time() - self.t0, text))


def kept_text(state: dict) -> str:
    items = [(k, state[k]["name"]) for k in ORDER if isinstance(state.get(k), dict) and state[k].get("name")]
    return "Already created and kept: %s." % ", ".join("%s %s" % (LABELS[k], n) for k, n in items) if items else "Nothing was created."


def failure_line(err: Exception, step: str, state: dict, opts: Options) -> str:
    kept, rerun = kept_text(state), opts.rerun()
    if isinstance(err, preflight.Problem):
        return str(err)
    if isinstance(err, resources.NameTaken):
        return ("%s %s already exists in this account and setup did not make it, so it was left alone. %s Choose another name with --name, "
                "or to use an existing store run `%s`, then run `%s`." % (err.what, err.name, kept, scripts.cmd("connect"), rerun))
    if isinstance(err, access_mod.AccessUnavailable):
        return "%s. %s Or leave out --access to continue without it, or add --no-access on a store that already has Access." % (err, kept)
    if isinstance(err, cf.CfError):
        text = " ".join([err.message] + [str(c) for c in err.codes]).lower()
        if err.status == 0 and not err.codes:
            return "%s failed: %s. %s Run `%s` to resume, nothing that exists is made twice." % (step, err.message, kept, rerun)
        if err.denied:
            return ("Cloudflare refused the API token at the step %s (%s). %s Add the permission for that step, see `%s`, "
                    "then run `%s`, it picks up where it stopped." % (step, err.message, kept, scripts.cmd("setup", "--scopes"), rerun))
        if re.search(r"quota|limit|exceeded|too many|maximum", text):
            return "Cloudflare refused at the step %s because a plan limit was reached (%s). %s Free up or upgrade that limit, then run `%s`." % (step, err.message, kept, rerun)
        return "The step %s failed (%s). %s Run `%s` to resume, nothing that exists is made twice." % (step, err.message, kept, rerun)
    return "The step %s failed (%s). %s Run `%s` to resume." % (step, cf.clean(str(err)), kept, rerun)


class _Redirected(Exception):
    def __init__(self, location: str):
        super().__init__(location)
        self.location = location


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer here, not a place to follow. Behind Access it is the login page, and the admin token must not go there."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _Redirected(cf.clean(newurl, 120))


def _is_health(body: bytes) -> bool:
    """Our Worker's /health: a JSON object with ok true and a version string. A login page or any other 200 does not count."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError):
        return False
    return isinstance(data, dict) and data.get("ok") is True and isinstance(data.get("version"), str)


def wait_healthy(url: str, token: str, wait: float, sleep, access_id: str = "", access_secret: str = "") -> str:
    """A new workers.dev name can take a little while to answer. Polls /health until our Worker's reply or the time is up. The
    Access pair goes with the bearer, redirects are refused, and a redirect ends the wait at once. Returns an empty string when it
    answered, else what the last try saw."""
    opener = urllib.request.build_opener(_NoRedirects)
    headers = {"Authorization": "Bearer " + token, "User-Agent": cf.USER_AGENT}
    if access_id and access_secret:
        headers.update({"CF-Access-Client-Id": access_id, "CF-Access-Client-Secret": access_secret})
    deadline, delay, seen = time.time() + wait, 2.0, "no answer"
    while True:
        req = urllib.request.Request(url + "/health", headers=headers)
        try:
            with opener.open(req, timeout=15) as resp:
                if resp.status == 200 and _is_health(resp.read(65536)):
                    return ""
                seen = "HTTP %d, not the Worker's /health reply" % resp.status
        except _Redirected as e:
            return "redirected to %s, so this is not the Worker. Check the address and the Access pair" % e.location
        except urllib.error.HTTPError as e:
            seen = "HTTP %d" % e.code
        except (urllib.error.URLError, OSError) as e:
            seen = cf.clean(getattr(e, "reason", e), 80)
        if time.time() >= deadline:
            return seen
        sleep(delay)


def _want_second_machine(opts: Options, ask) -> bool:
    """Asked once, default no. A run with --yes never asks."""
    if opts.yes:
        return False
    answer = (ask("Make a connection string for a second machine now? It holds a device token and the Access pair, so keep it in a password manager. [y/N] ") or "")
    return answer.strip().lower() in ("y", "yes")


def run_setup(opts: Options) -> int:
    say = opts.say
    recorded = deploy.load_state()
    keep_recorded(opts, recorded)
    problem = option_problem(opts)
    if problem:
        say(problem + " Nothing was created.")
        return 1
    ask = opts.ask or _ask_default
    cli = opts.run_cli or default_cli
    steps = Steps(say)
    n = resources.names(opts.name)
    for line in plan_text(opts):
        say(line)
    if opts.no_access and recorded_access(recorded):
        say("WARNING: --no-access turns Access off on this store. The Worker stops checking the Access token and the bearer token becomes the only lock. "
            "The Access application and service token stay in Cloudflare until uninstall. A plain rerun keeps Access off, and --access --email turns it back on.")
    if opts.harnesses:
        for line in preflight.needs_lines(opts.harnesses()):
            say(line)
    if not opts.dry_run:
        for line in preflight.scope_lines():
            say(line)
        if opts.confirm and not opts.confirm():
            say("Stopped. Nothing was created.")
            return 1
    if opts.dry_run:
        token, account = "dry-run", opts.account_id or "<account-id>"
        say("Dry run. Every API call setup would make is listed below and nothing is sent. Reads show what setup looks for first.")
    else:
        token = opts.token or preflight.get_token()
        if not token:
            say("No API token given. Nothing was created.")
            return 1
        account = opts.account_id
    client = cf.Client(token, account, dry_run=opts.dry_run, say=say, sleep=opts.sleep)
    state = {} if opts.dry_run else recorded
    step = "preflight"
    try:
        if not opts.dry_run:
            steps.head("checking the token and the account")
            account = preflight.pick_account(client, account)
            client.account_id = account
            preflight.check_scopes(client)
            if state.get("account_id") and state["account_id"] != account:
                raise preflight.Problem("An earlier run used a different Cloudflare account than this one. Set CLOUDFLARE_ACCOUNT_ID to the first one, or run `%s` there first." % scripts.cmd("uninstall"))
            if state.get("name") and state["name"] != opts.name:
                raise preflight.Problem("A store named %r is already recorded in %s. Use --name %s, or run `%s` first." % (state["name"], deploy.state_file(), state["name"], scripts.cmd("uninstall")))
        state.update(name=opts.name, account_id=account, domain=opts.domain, access_enabled=bool(opts.access))
        if opts.access:
            state["access_email"] = opts.email
        save = (lambda s: None) if opts.dry_run else deploy.save_state
        save(state)
        had_worker = isinstance(state.get("worker"), dict)

        step = "D1 database"
        steps.head("D1 database and schema")
        d1_id = resources.ensure_d1(client, state, n["d1"], save, say)
        step = "database schema"
        resources.apply_migrations(client, d1_id, opts.root, say)

        step = "Vectorize index"
        steps.head("Vectorize index and its metadata indexes")
        resources.ensure_vectorize(client, state, n["vectorize"], save, say)
        step = "Vectorize metadata index"
        resources.ensure_metadata_indexes(client, state, n["vectorize"], save, say)

        step = "R2 bucket"
        steps.head("R2 backup bucket")
        resources.ensure_r2(client, state, n["r2"], save, say)

        step = "address"
        steps.head("address")
        config_data = worker.read_config(opts.root)
        subdomain = ""
        if not opts.domain:
            subdomain = worker.account_subdomain(client, opts.subdomain)
        hostname = worker.hostname_for(n["worker"], subdomain, opts.domain)
        url = "https://" + hostname

        access = None
        if opts.access:
            step = "Access"
            steps.head("Cloudflare Access")
            have_secret = bool(config.read_file().get("access_client_secret"))
            save_secret = (lambda values: None) if opts.dry_run else config.write_file
            access = access_mod.provision(client, state, opts.name, hostname, opts.email, save, say, have_secret, save_secret, opts.rotate_access)

        step = "Worker"
        steps.head("Worker")
        # a Worker upload whose reply was lost is marked pending, and the rerun must not refuse the Worker it made
        if not had_worker and "worker" not in state.get("pending", []) and not opts.dry_run and worker.script_exists(client, n["worker"]):
            raise resources.NameTaken("Worker", n["worker"])
        resources.mark_pending(state, "worker", save)
        existing_token = config.read_file().get("token", "") if had_worker else ""
        auth_token = "" if existing_token else secrets.token_urlsafe(32)
        if had_worker and not existing_token:
            say("  The Worker exists but its token is not on this machine, so a new AUTH_TOKEN is set. Device tokens keep working.")
        modules, assets = worker.collect_modules(opts.root), worker.collect_assets(opts.root)
        asset_token = worker.upload_assets(client, n["worker"], assets, say)
        meta = worker.metadata(config_data, n, d1_id, asset_token, worker.vars_for(config_data, access), auth_token)
        worker.upload_script(client, n["worker"], modules, meta, say)
        resources.record(state, "worker", n["worker"], save)
        step = "cron trigger"
        worker.set_cron(client, n["worker"], say)

        step = "address"
        if opts.domain:
            worker.attach_domain(client, n["worker"], opts.domain, say)
            worker.set_workers_dev(client, n["worker"], False)
            say("  workers.dev turned off for this Worker")
        else:
            worker.set_workers_dev(client, n["worker"], True)
            say("  workers.dev address on: %s" % url)
        state.update(url=url)
        save(state)
    except (cf.CfError, resources.NameTaken, preflight.Problem, access_mod.AccessUnavailable) as e:
        say(failure_line(e, step, state, opts))
        return 1

    if opts.dry_run:
        say("Dry run finished, nothing was sent. After the calls above setup writes the local config, runs `%s`, and makes a connection string with `%s`." % (scripts.cmd("doctor", "--probe"), scripts.cmd("devices", "add LABEL --share")))
        say("")
        for line in limits.table_lines():
            say(line)
        return 0

    values = {"url": url}
    if auth_token:
        values["token"] = auth_token
    path = config.write_file(values)
    steps.head("local config written to %s (mode 0600, the token is never printed)" % path)
    state["complete"] = True
    deploy.save_state(state)

    steps.head("waiting for the Worker to answer")
    settings = config.load(use_command=False)
    problem = (opts.healthy or wait_healthy)(url, settings.token, opts.wait, opts.sleep, settings.access_client_id, settings.access_client_secret)
    healthy = not problem
    if problem:
        say("The Worker did not answer /health within %d seconds (last try %s). A new workers.dev name can take a few minutes. Run `%s` in a minute." % (int(opts.wait), problem, scripts.cmd("doctor", "--probe")))
    steps.head("doctor --probe")
    doctor_rc = cli(["doctor", "--probe"]) if healthy else 1
    # one connection string per store, made on request and recorded, so a rerun never adds a second device by accident
    if not state.get("second_machine") and (opts.second_machine or _want_second_machine(opts, ask)):
        steps.head("connection string for your other machines")
        if cli(["devices", "add", "second-machine", "--share"]) == 0:
            state["second_machine"] = True
            deploy.save_state(state)
    say("")
    say("Created in your Cloudflare account:")
    for kind in ORDER:
        if isinstance(state.get(kind), dict) and state[kind].get("name"):
            say("  %-20s %s" % (LABELS[kind], state[kind]["name"]))
    say("Worker address:  %s" % url)
    if not opts.access:
        say("No Access in front: the bearer token is the only lock. Add it with `%s --access --email you@example.com`." % opts.rerun())
    say("")
    for line in limits.table_lines():
        say(line)
    plan = limits.ask_plan(opts.plan, ask, say) if not opts.yes or opts.plan else ""
    if plan:
        state["plan"] = plan
        deploy.save_state(state)
        say(limits.plan_note(plan))
    if opts.rotate_access:
        say("The Access service token was replaced. Every connection string made before this run no longer passes Access. Make new ones with `%s`." % scripts.cmd("devices", "add LABEL --share"))
    say("")
    say("To remove everything later run `%s`." % scripts.cmd("uninstall"))
    return 0 if doctor_rc == 0 else 1
