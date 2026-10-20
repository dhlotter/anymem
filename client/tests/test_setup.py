#!/usr/bin/env python3
"""Runnable check for the setup and uninstall scripts against a fake Cloudflare API. No network, no real account, no Node.
`python3 client/tests/test_setup.py`, exits non-zero on failure."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

for key in list(os.environ):
    if key.startswith("ANYMEM_") or key.startswith("CLOUDFLARE_"):
        del os.environ[key]

from fake_cloudflare import ACCOUNT, SECRET_TEXT, FakeCloudflare  # noqa: E402
from hm import config, deploy  # noqa: E402
from hm.commands import setup as setup_cmd, uninstall as uninstall_cmd  # noqa: E402
from setup import cf, limits, preflight, resources, run as runner, teardown, worker  # noqa: E402

API_TOKEN = "cf-api-token-test-0123456789abcdef"
failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


class World:
    """One isolated machine: its own config dir, a fake Cloudflare, and recorders for the child commands."""

    def __init__(self, **fake_args):
        self.tmp = Path(tempfile.mkdtemp())
        os.environ.update(ANYMEM_CONFIG_DIR=str(self.tmp / "cfg"), ANYMEM_CACHE_DIR=str(self.tmp / "cache"))
        self.cf = FakeCloudflare(**fake_args).__enter__()
        os.environ["ANYMEM_CF_API"] = self.cf.url
        self.out = []
        self.cli_calls = []
        self.cli_rc = {}

    def close(self):
        self.cf.__exit__()

    def cli(self, args, stdin=None):
        self.cli_calls.append(list(args))
        return self.cli_rc.get(args[0], 0)

    def options(self, **over):
        base = dict(name="anymem-trial", token=API_TOKEN, say=self.out.append, ask=lambda prompt: "paid", run_cli=self.cli, wait=0,
                    healthy=lambda *a: "", sleep=lambda s: None)
        base.update(over)
        return runner.Options(**base)

    def run(self, **over):
        return runner.run_setup(self.options(**over))

    @property
    def text(self):
        return "\n".join(self.out)

    def state(self):
        return deploy.load_state()


def world(**kw):
    return World(**kw)


# ------------------------------------------------------------------ pure helpers
check("scope list names every scope of plan 6.1", all(k in " ".join(preflight.scope_lines()) for k in ("Workers Scripts Edit", "D1 Edit", "Vectorize Edit", "Workers R2 Storage Edit", "Access Apps and Policies Edit", "Access Service Tokens Edit", "Access Organizations, Identity Providers, and Groups Read")))
check("the token guidance asks for no Workers AI permission and names one account and one zone", "Workers AI" not in " ".join(preflight.scope_lines()) and "one account" in " ".join(preflight.scope_lines()) and "Specific zone" in " ".join(preflight.scope_lines()))
check("python version gate", preflight.python_ok((3, 9)) and not preflight.python_ok((3, 8)))
check("limits table carries every row of plan section 7", len(limits.ROWS) == 11 and "Vectorize stored" in "\n".join(limits.table_lines()) and "4,000 memories" in "\n".join(limits.table_lines()))
check("no text claims a warning at 80 percent", "80 percent" not in "\n".join(limits.table_lines()) and "80 percent" not in limits.plan_note("free") and "nothing warns" in limits.plan_note("free"))
_docs = Path(__file__).resolve().parents[2] / "docs"
check("install and troubleshooting name --no-access as the only way to drop Access", all("`--no-access`" in (_docs / n).read_text() for n in ("install.md", "troubleshooting.md")))
check("option checks", runner.option_problem(runner.Options(name="Bad Name")) != "" and runner.option_problem(runner.Options(domain="nodots")) != ""
      and runner.option_problem(runner.Options(access=True)) != "" and runner.option_problem(runner.Options(rotate_access=True)) != ""
      and runner.option_problem(runner.Options(access=True, email="me@example.com", rotate_access=True)) == ""
      and runner.option_problem(runner.Options(plan="gold")) != "" and runner.option_problem(runner.Options(name="anymem-trial")) == ""
      and runner.option_problem(runner.Options(access=True, email="me@example.com", no_access=True)) != "")
check("asset hash is 32 hex", len(worker.asset_hash(b"x", "/a.js")) == 32)
check("modules skip tests, dev, scripts, ui and migrate.js", all(not k.startswith(("test/", "dev/", "scripts/", "ui/")) and k != "migrate.js" for k in worker.collect_modules(ROOT)) and "index.js" in worker.collect_modules(ROOT))
check("lifecycle rule planner keeps other rules and is quiet when right", resources.plan_rules([resources.wanted_rule()])[1] is False
      and resources.plan_rules([{"id": "mine"}])[0][0] == {"id": "mine"} and resources.plan_rules([])[1] is True)

# ------------------------------------------------------------------ dry run
w = world()
rc = w.run(dry_run=True, token="", access=True, email="me@example.com", domain="memory.example.com")
check("dry run exits 0", rc == 0)
check("dry run sends nothing", w.cf.calls == [])
for needle in ("POST /accounts/<account-id>/d1/database", "metadata_index/create", "r2/buckets/anymem-trial-backups/lifecycle", "assets-upload-session", "PUT /accounts/<account-id>/workers/scripts/anymem-trial",
               "schedules", "workers/domains", "access/service_tokens", "access/apps", "policies", "Plan limits"):
    check("dry run lists " + needle, needle in w.text)
check("dry run order, D1 then Vectorize indexes then Worker", w.text.index("d1/database") < w.text.index("metadata_index/create") < w.text.index("scripts/anymem-trial   ("))
check("dry run writes no state and no config", not deploy.state_file().exists() and not config.config_file().exists())
check("dry run shows no secret", "AUTH_TOKEN hidden" in w.text and SECRET_TEXT not in w.text)
w.close()

# ------------------------------------------------------------------ a full run
w = world()
rc = w.run()
st = w.state()
S = w.cf.state
check("full run exits 0", rc == 0)
check("D1 database exists with schema at the latest migration", "anymem-trial-db" in S["d1"] and S["d1"]["anymem-trial-db"]["db"].execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(len(resources.migrations(ROOT))))
check("schema has the memories table", S["d1"]["anymem-trial-db"]["db"].execute("SELECT count(*) FROM sqlite_master WHERE name='memories'").fetchone()[0] == 1)
check("setup applies migration 0003, the recall log and its indexes exist", S["d1"]["anymem-trial-db"]["db"].execute("SELECT count(*) FROM sqlite_master WHERE name IN ('recall_log', 'idx_recall_log_memory', 'idx_recall_log_ts')").fetchone()[0] == 3 and len(resources.migrations(ROOT)) >= 3)
vec = S["vectorize"].get("anymem-trial-vectors", {})
check("Vectorize is 384 dimensions cosine", vec.get("config") == {"dimensions": 384, "metric": "cosine"})
check("both metadata indexes exist", sorted(n for n, _ in vec.get("meta", [])) == ["origin", "project"])
check("metadata indexes were created before the Worker upload", [i for i, c in enumerate(w.cf.calls) if "metadata_index/create" in c[1]][-1] < [i for i, c in enumerate(w.cf.calls) if c[0] == "PUT" and c[1].endswith("/workers/scripts/anymem-trial")][0])
check("R2 bucket has the 30 day rule", S["r2"]["anymem-trial-backups"]["rules"] == [resources.wanted_rule()])
script = S["scripts"].get("anymem-trial", {})
kinds = {b["name"]: b["type"] for b in script.get("meta", {}).get("bindings", [])}
check("Worker bindings D1 Vectorize AI R2 assets secret", kinds.get("DB") == "d1" and kinds.get("VECTORIZE") == "vectorize" and kinds.get("AI") == "ai" and kinds.get("BACKUP_BUCKET") == "r2_bucket" and kinds.get("ASSETS") == "assets" and kinds.get("AUTH_TOKEN") == "secret_text")
check("Worker binding names point at our resources", {b["name"]: b for b in script["meta"]["bindings"]}["BACKUP_BUCKET"]["bucket_name"] == "anymem-trial-backups" and {b["name"]: b for b in script["meta"]["bindings"]}["VECTORIZE"]["index_name"] == "anymem-trial-vectors")
check("Worker modules uploaded, index.js is main", script.get("meta", {}).get("main_module") == "index.js" and "memory/store.js" in script.get("modules", []))
check("one cron trigger at 01:00 UTC", script.get("crons") == [{"cron": "0 1 * * *"}])
check("assets run the Worker first", script["meta"]["assets"]["config"]["run_worker_first"] is True and len(S["assets"]) >= 15)
check("no Access means REQUIRE_ACCESS false", {b["name"]: b for b in script["meta"]["bindings"]}["REQUIRE_ACCESS"]["text"] == "false")
check("none of the owner's Access values are uploaded", not any(b["name"].startswith("ACCESS_") for b in script["meta"]["bindings"]))
check("workers.dev address on", script.get("workers_dev") is True and st.get("url") == "https://anymem-trial.trialbox.workers.dev")
cfg_path = config.config_file()
cfg = json.loads(cfg_path.read_text())
check("config has url and token, mode 0600", cfg["url"] == st["url"] and len(cfg["token"]) >= 32 and stat.S_IMODE(cfg_path.stat().st_mode) == 0o600)
check("the Worker token is the one uploaded", script["secret"] == cfg["token"])
check("the Worker token is never printed", cfg["token"] not in w.text)
check("deploy.json records names and ids and no secret", st["d1"]["name"] == "anymem-trial-db" and st["worker"]["name"] == "anymem-trial" and cfg["token"] not in json.dumps(st) and API_TOKEN not in json.dumps(st))
disk = "".join(p.read_text(errors="ignore") for p in w.tmp.rglob("*") if p.is_file())
check("the Cloudflare API token is never written to disk", API_TOKEN not in disk)
check("the API token is never printed", API_TOKEN not in w.text)
check("doctor --probe ran", ["doctor", "--probe"] in w.cli_calls)
check("no connection string is made unless it is asked for", not any(c[0] == "devices" for c in w.cli_calls) and "second_machine" not in st)
check("limits table printed and plan recorded", "Plan limits" in w.text and st.get("plan") == "paid" and "Paid" in w.text)
check("progress lines carry seconds", "s] D1 database and schema" in w.text)
calls_first = list(w.cf.calls)

# ------------------------------------------------------------------ idempotent rerun
w.out.clear()
w.cli_calls.clear()
before_cfg = cfg_path.read_text()
rc = w.run()
check("rerun exits 0", rc == 0)
creates = [(m, p) for m, p in w.cf.calls[len(calls_first):] if m == "POST" and any(k in p for k in ("/d1/database", "/vectorize/v2/indexes", "/r2/buckets")) and "/query" not in p and "metadata_index" not in p]
check("rerun creates no resource twice", creates == [] and len(S["d1"]) == 1 and len(S["vectorize"]) == 1 and len(S["r2"]) == 1)
check("rerun makes no metadata index and no lifecycle write", not any("metadata_index/create" in p or (m == "PUT" and "lifecycle" in p) for m, p in w.cf.calls[len(calls_first):]))
check("rerun keeps the token, config unchanged", cfg_path.read_text() == before_cfg and S["scripts"]["anymem-trial"]["secret"] == cfg["token"])
check("rerun uploads the Worker again with keep_bindings", S["scripts"]["anymem-trial"]["meta"].get("keep_bindings") == ["secret_text"])
check("rerun applies no migration", "applying migration" not in w.text and "schema already at version" in w.text)
check("rerun does not make a second connection string", not any(c[0] == "devices" for c in w.cli_calls))
w.close()

# second machine: asked for with the flag, or yes at the prompt, once per store, and never with --yes
w = world()
rc = w.run(second_machine=True)
check("--second-machine makes one connection string with --share", rc == 0 and w.cli_calls.count(["devices", "add", "second-machine", "--share"]) == 1 and w.state().get("second_machine") is True)
w.cli_calls.clear()
rc = w.run(second_machine=True)
check("a rerun does not make a second one, the store remembers it", rc == 0 and not any(c[0] == "devices" for c in w.cli_calls))
w.close()

w = world()
rc = w.run(ask=lambda prompt: "y" if "second machine" in prompt else "paid")
check("the prompt makes one connection string when answered yes", rc == 0 and ["devices", "add", "second-machine", "--share"] in w.cli_calls)
w.close()

w = world()
rc = w.run(yes=True, ask=lambda prompt: "y")
check("--yes never makes a connection string on its own", rc == 0 and not any(c[0] == "devices" for c in w.cli_calls))
w.close()

# a Worker upload whose reply was lost is pending, and the rerun does not refuse the Worker it made
w = world()
rc = w.run()
st = w.state()
w.cf.state["scripts"]["anymem-trial"] = {"meta": {}, "modules": [], "secret": "earlier", "crons": [], "workers_dev": False}
st.pop("worker", None)
st["pending"] = ["worker"]
deploy.save_state(st)
w.out.clear()
rc = w.run()
check("a pending Worker is not refused as someone else's on the rerun", rc == 0 and "left alone" not in w.text)
w.close()

w = world()
rc = w.run(healthy=lambda *a: "HTTP 401")
check("a Worker that does not answer is reported with what was seen, and doctor is not run", rc == 1 and "last try HTTP 401" in w.text and ["doctor", "--probe"] not in w.cli_calls)
w.close()

# ------------------------------------------------------------------ eventual consistency of the metadata index
w = world(metadata_lag=3)
sleeps = []
rc = w.run(sleep=sleeps.append)
check("metadata index lag is waited out", rc == 0 and len(sleeps) >= 2 and len(w.cf.state["vectorize"]["anymem-trial-vectors"]["meta"]) == 2)
check("the second index waits for the first", w.cf.count("POST", "metadata_index/create") == 2)
w.close()

w = world()
w.cf.fail("GET", r"metadata_index/list", 400, [3003], "index deleted", times=3)
w.cf.fail("POST", r"metadata_index/create", 400, [3003], "index deleted", times=2)
rc = w.run()
check("a just created index that still answers index deleted is waited for", rc == 0 and len(w.cf.state["vectorize"]["anymem-trial-vectors"]["meta"]) == 2)
w.close()

# ------------------------------------------------------------------ resume after a failure
w = world()
w.cf.fail("PUT", r"/workers/scripts/anymem-trial$", 400, [10021], "script rejected")
rc = w.run()
check("a failed Worker upload exits 1 with a plain line", rc == 1 and ("Worker failed" in w.text or "step Worker failed" in w.text))
check("the failure line says what was kept and how to resume", "Already created and kept" in w.text and "setup.py --name anymem-trial" in w.text)
check("state kept the earlier resources", w.state().get("d1", {}).get("name") == "anymem-trial-db" and "worker" not in w.state())
w.out.clear()
rc = w.run()
check("the rerun finishes without recreating", rc == 0 and w.cf.count("POST", r"/d1/database$") == 1 and w.cf.count("POST", r"/r2/buckets$") == 1)
w.close()

# ------------------------------------------------------------------ failure messages
w = world()
w.cf.deny(r"/vectorize/")
rc = w.run()
check("a missing scope is named and nothing is created", rc == 1 and "Vectorize Edit" in w.text and w.cf.writes() == [])
w.close()

w = world()
w.cf.deny(r"/d1/")
w.cf.deny(r"/r2/")
rc = w.run()
check("several missing scopes are all named", rc == 1 and "D1 Edit" in w.text and "Workers R2 Storage Edit" in w.text and "missing: D1 Edit, Workers R2 Storage Edit." in w.text)
w.close()

w = world()
rc = w.run(token="x")
check("an invalid token is said plainly", rc == 1 and "not valid" in w.text and w.cf.writes() == [])
w.close()

w = world()
preflight.get_token = lambda *a, **k: ""
rc = w.run(token="")
check("no token means the scope list and no calls", rc == 1 and "Workers Scripts Edit" in w.text and w.cf.calls == [])
del preflight.get_token
import importlib; importlib.reload(preflight)
w.close()

w = world()
w.cf.state["d1"]["anymem-trial-db"] = {"uuid": "deadbeef", "db": __import__("sqlite3").connect(":memory:")}
rc = w.run()
check("a D1 name that is not ours is refused and left alone", rc == 1 and "already exists" in w.text and "left alone" in w.text and w.cf.writes() == [])
check("name_taken suggests a way out", "--name" in w.text and "connect.py" in w.text)
w.close()

w = world()
w.cf.fail("POST", r"/vectorize/v2/indexes$", 400, [7403], "quota exceeded for this account")
rc = w.run()
check("a plan limit is said as a plan limit", rc == 1 and "plan limit" in w.text and "Already created and kept: D1 database" in w.text)
w.close()

w = world()
w.cf.fail("POST", r"/d1/database$", 403, [10000], "Authentication error")
rc = w.run()
check("a scope refused mid run names the step", rc == 1 and "refused the API token" in w.text and "D1 database" in w.text)
w.close()

w = world()
w.cf.fail("GET", r"/d1/database", 503, [], "unavailable", times=2)
rc = w.run()
check("a short outage is retried", rc == 0)
w.close()

w = world()
os.environ["ANYMEM_CF_API"] = "http://127.0.0.1:9/client/v4"
rc = w.run(account_id=ACCOUNT)
check("an unreachable Cloudflare is a plain line", rc == 1 and "could not reach Cloudflare" in w.text)
w.close()

w = world(subdomain="")
rc = w.run()
check("an account without a workers.dev name says how to choose one", rc == 1 and "--subdomain" in w.text)
w.out.clear()
rc = w.run(subdomain="trialbox")
check("--subdomain creates it", rc == 0 and w.cf.state["subdomain"] == "trialbox")
w.close()

w = world()
w.cf.state["scripts"]["anymem-trial"] = {"meta": {}, "modules": [], "secret": "other-owner", "crons": [], "workers_dev": False}
rc = w.run()
check("a Worker name that is not ours is refused", rc == 1 and "Worker" in w.text and "left alone" in w.text and w.cf.state["scripts"]["anymem-trial"]["secret"] == "other-owner")
w.close()

# ------------------------------------------------------------------ custom domain
w = world(zones=("example.com",))
rc = w.run(domain="memory.example.com")
dom = w.cf.state["domains"].get("memory.example.com", {})
check("custom domain attached to the Worker in its zone", rc == 0 and dom.get("service") == "anymem-trial" and dom.get("zone_id") == "zone-example.com" and "override_existing_origin" not in dom)
check("workers.dev turned off with a custom domain", w.cf.state["scripts"]["anymem-trial"]["workers_dev"] is False and w.state()["url"] == "https://memory.example.com")
w.close()

w = world(zones=("other.org",))
rc = w.run(domain="memory.example.com")
check("a domain outside the account is refused", rc == 1 and "not in a zone" in w.text)
w.close()

w = world()
w.cf.state["domains"]["memory.example.com"] = {"hostname": "memory.example.com", "service": "someone-else"}
rc = w.run(domain="memory.example.com")
check("a hostname used by another Worker is refused by default", rc == 1 and "someone-else" in w.text and w.cf.state["domains"]["memory.example.com"]["service"] == "someone-else")
check("the refusal says to remove the domain from that Worker first", "Remove the custom domain from that Worker first" in w.text)
w.close()

# ------------------------------------------------------------------ a plain rerun keeps Access and the domain
w = world(zones=("example.com",))
rc = w.run(access=True, email="me@example.com", domain="memory.example.com")
check("store with Access and a custom domain set up", rc == 0 and w.cf.state["scripts"]["anymem-trial"]["workers_dev"] is False)
w.out.clear()
rc = w.run()
script = w.cf.state["scripts"]["anymem-trial"]
binds = {b["name"]: b.get("text") for b in script["meta"]["bindings"]}
check("a plain rerun keeps REQUIRE_ACCESS true, the Access vars and the recorded email", rc == 0 and binds["REQUIRE_ACCESS"] == "true" and binds["ACCESS_ALLOWED_EMAILS"] == "me@example.com"
      and binds["ACCESS_AUD"].startswith("aud") and binds["ACCESS_TEAM_DOMAIN"] == "team.cloudflareaccess.com")
check("a plain rerun leaves workers.dev off and keeps the custom domain", script["workers_dev"] is False and "workers.dev address on" not in w.text and w.state()["domain"] == "memory.example.com")
w.out.clear()
rc = w.run(no_access=True)
script = w.cf.state["scripts"]["anymem-trial"]
binds = {b["name"]: b.get("text") for b in script["meta"]["bindings"]}
check("--no-access drops Access, with a warning, and keeps the domain", rc == 0 and binds["REQUIRE_ACCESS"] == "false" and not any(k.startswith("ACCESS_") for k in binds)
      and "WARNING: --no-access" in w.text and script["workers_dev"] is False and w.state()["domain"] == "memory.example.com")
w.out.clear()
rc = w.run()
binds = {b["name"]: b.get("text") for b in w.cf.state["scripts"]["anymem-trial"]["meta"]["bindings"]}
check("a plain rerun after --no-access keeps Access off", rc == 0 and binds["REQUIRE_ACCESS"] == "false" and "WARNING" not in w.text)
w.out.clear()
rc = w.run(access=True, email="me@example.com")
binds = {b["name"]: b.get("text") for b in w.cf.state["scripts"]["anymem-trial"]["meta"]["bindings"]}
check("--access --email turns Access back on after --no-access", rc == 0 and binds["REQUIRE_ACCESS"] == "true" and binds["ACCESS_ALLOWED_EMAILS"] == "me@example.com")
w.close()

w = world(zones=("example.com",))
rc = w.run(access=True, email="me@example.com", domain="memory.example.com")
st = w.state()
st.pop("access_enabled")
deploy.save_state(st)
rc = w.run()
binds = {b["name"]: b.get("text") for b in w.cf.state["scripts"]["anymem-trial"]["meta"]["bindings"]}
check("a store recorded before access_enabled is read from its Access record", rc == 0 and binds["REQUIRE_ACCESS"] == "true")
w.close()

# ------------------------------------------------------------------ Access
w = world()
rc = w.run(access=True, email="me@example.com")
S = w.cf.state
script = S["scripts"]["anymem-trial"]
binds = {b["name"]: b.get("text") for b in script["meta"]["bindings"]}
check("Access run exits 0", rc == 0)
check("Access app on the address", len(S["access_apps"]) == 1 and list(S["access_apps"].values())[0]["domain"] == "anymem-trial.trialbox.workers.dev")
check("service token created", len(S["service_tokens"]) == 1)
pol = list(S["policies"].values())[0]
check("two policies, service token and the email", [p["decision"] for p in pol] == ["non_identity", "allow"] and pol[1]["include"] == [{"email": {"email": "me@example.com"}}])
check("Worker vars carry the Access values", binds["REQUIRE_ACCESS"] == "true" and binds["ACCESS_AUD"].startswith("aud") and binds["ACCESS_ALLOWED_EMAILS"] == "me@example.com"
      and binds["ACCESS_TEAM_DOMAIN"] == "team.cloudflareaccess.com" and binds["ACCESS_TOKEN_EXPIRES"] == "2027-10-17")
client_id = list(S["service_tokens"].values())[0]["client_id"]
check("the common name is the service token client id as Cloudflare shows it, 32 hex and .access, not suffixed twice", binds["ACCESS_SERVICE_COMMON_NAMES"] == client_id
      and re.fullmatch(r"[0-9a-f]{32}\.access", client_id) is not None)
cfg = json.loads(config.config_file().read_text())
check("the Access pair is saved locally and never printed", cfg.get("access_client_secret") == SECRET_TEXT and SECRET_TEXT not in w.text and stat.S_IMODE(config.config_file().stat().st_mode) == 0o600)
check("deploy.json holds no Access secret", SECRET_TEXT not in deploy.state_file().read_text())
w.out.clear()
rc = w.run(access=True, email="me@example.com")
check("Access rerun makes nothing twice", rc == 0 and len(S["access_apps"]) == 1 and len(S["service_tokens"]) == 1 and len(list(S["policies"].values())[0]) == 2)
check("Access rerun keeps the saved pair", json.loads(config.config_file().read_text()).get("access_client_secret") == SECRET_TEXT)
w.out.clear()
rc = w.run(access=True, email="new@example.com")
pols = list(S["policies"].values())[0]
check("a changed --email is applied to the owner policy, in place", rc == 0 and len(pols) == 2 and pols[1]["include"] == [{"email": {"email": "new@example.com"}}] and "updated" in w.text)
old_token = list(S["service_tokens"])[0]
del S["service_tokens"][old_token]
w.out.clear()
rc = w.run(access=True, email="new@example.com")
new_token = list(S["service_tokens"])[0]
pols = list(S["policies"].values())[0]
check("a recreated service token is the one the machines policy names", rc == 0 and new_token != old_token and pols[0]["include"] == [{"service_token": {"token_id": new_token}}] and len(pols) == 2)
w.close()

w = world()
w.cf.fail("PUT", r"/workers/scripts/anymem-trial$", 400, [10021], "script rejected")
rc = w.run(access=True, email="me@example.com")
cfg = json.loads(config.config_file().read_text())
check("a failure after the Access token is made keeps its pair on this machine", rc == 1 and cfg.get("access_client_secret") == SECRET_TEXT
      and cfg.get("access_client_id") == list(w.cf.state["service_tokens"].values())[0]["client_id"])
w.out.clear()
rc = w.run(access=True, email="me@example.com")
check("the rerun resumes with the saved pair and makes no second token", rc == 0 and "already there" in w.text and len(w.cf.state["service_tokens"]) == 1
      and json.loads(config.config_file().read_text()).get("access_client_secret") == SECRET_TEXT)
w.close()

w = world(zero_trust=False)
rc = w.run(access=True, email="me@example.com")
check("no Zero Trust is explained, and setup says how to go on without Access", rc == 1 and "Zero Trust" in w.text and "leave out --access" in w.text)
w.close()

w = world()
w.cf.deny(r"/access/")
rc = w.run(access=True, email="me@example.com")
check("missing Access scope is named, the organization read one included", rc == 1 and "Access: Organizations, Identity Providers, and Groups Read" in w.text)
w.close()

# ------------------------------------------------------------------ Access: rotation, adoption, pages
w = world()
rc = w.run(access=True, email="me@example.com")
S = w.cf.state
old_client = list(S["service_tokens"].values())[0]["client_id"]
old_token = list(S["service_tokens"])[0]
w.out.clear()
rc = w.run(access=True, email="me@example.com", rotate_access=True)
binds = {b["name"]: b.get("text") for b in S["scripts"]["anymem-trial"]["meta"]["bindings"]}
new_token = list(S["service_tokens"])[0]
new_client = S["service_tokens"][new_token]["client_id"]
pols = list(S["policies"].values())[0]
cfg = json.loads(config.config_file().read_text())
check("rotation replaces the service token: the old one is deleted and the new one is the only one", rc == 0 and new_token != old_token and list(S["service_tokens"]) == [new_token])
check("rotation moves the Worker and the local config to the new pair, and the policy names the new token", binds["ACCESS_SERVICE_COMMON_NAMES"] == new_client and cfg.get("access_client_id") == new_client
      and pols[0]["include"] == [{"service_token": {"token_id": new_token}}] and old_client != new_client)
check("rotation says the old connection strings stop working", "no longer passes Access" in w.text)
w.close()

w = world()
w.cf.state["access_apps"]["foreign"] = {"name": "anymem-trial", "domain": "someone.example.net", "aud": "their-aud"}
rc = w.run(access=True, email="me@example.com")
check("an Access application with our name that we did not make is refused and left alone", rc == 1 and "left alone" in w.text
      and w.cf.state["access_apps"]["foreign"]["domain"] == "someone.example.net" and not any(m == "DELETE" for m, _ in w.cf.calls))
w.close()

# an Access application whose create reply was lost is adopted while access is pending, and refused otherwise
from setup import access as _access  # noqa: E402


class _App:
    dry_run = False

    def __init__(self, apps):
        self.apps = apps
        self.calls = []

    def acct(self, path):
        return path

    def pages(self, path):
        return self.apps

    def call(self, method, path, body=None, default=None):
        self.calls.append((method, path))
        return default


_apps = [{"id": "app-1", "name": "anymem-test", "domain": "memory.example.com"}]
_saved = []
_st = {"pending": ["access"]}
_got = _access.ensure_app(_App(_apps), _st, "anymem-test", "memory.example.com", lambda s: _saved.append(dict(s)), lambda *_: None)
check("a pending Access create that lost its reply adopts the application it left behind", _got["id"] == "app-1" and _st["access"]["app_id"] == "app-1" and _saved)
try:
    _access.ensure_app(_App(_apps), {}, "anymem-test", "memory.example.com", lambda s: None, lambda *_: None)
    _refused = False
except _access.NameTaken:
    _refused = True
check("with nothing pending the same application is refused", _refused)

w = world(zones=("example.com",))
rc = w.run(access=True, email="me@example.com")
app_id = list(w.cf.state["access_apps"])[0]
w.out.clear()
rc = w.run(access=True, email="me@example.com", domain="memory.example.com")
check("a changed hostname moves the recorded Access application, it is not left on the old one", rc == 0 and w.cf.state["access_apps"][app_id]["domain"] == "memory.example.com"
      and len(w.cf.state["access_apps"]) == 1 and "moved to memory.example.com" in w.text)
w.close()

# the application is recorded the moment it is made, so a failure after it keeps it for the rerun
w = world()
w.cf.fail("POST", r"/access/service_tokens$", 400, [10021], "cannot make token")
rc = w.run(access=True, email="me@example.com")
check("a failure before the Access application exists keeps nothing half made", rc == 1 and not w.cf.state["access_apps"])
w.cf.failures.clear()
rc = w.run(access=True, email="me@example.com")
check("the rerun after that failure makes one application", rc == 0 and len(w.cf.state["access_apps"]) == 1)
w.close()

# Cloudflare pages its lists: a store whose application is on a later page is found, not made again
w = world()
w.cf.max_per_page = 1
for n in range(3):
    w.cf.state["access_apps"]["other%d" % n] = {"name": "other-%d" % n, "domain": "other%d.example.net" % n, "aud": "a%d" % n}
rc = w.run(access=True, email="me@example.com")
check("the first run makes its application behind the others", rc == 0)
rc = w.run(access=True, email="me@example.com")
apps = w.cf.state["access_apps"]
check("a rerun finds the application on a later page and makes no second one", rc == 0 and len(apps) == 4 and "already there" in w.text)
w.close()

# the health check sends the Access pair, refuses redirects and needs the Worker's own reply
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class _Health(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/health", "/html/health"):
            self.send_response(404); self.end_headers(); return
        if self.headers.get("CF-Access-Client-Id") != "pair.access" or self.headers.get("CF-Access-Client-Secret") != "pair-secret":
            self.send_response(302); self.send_header("Location", "https://team.example.cloudflareaccess.com/login"); self.end_headers(); return
        if self.headers.get("Authorization") != "Bearer tok-for-health-check":
            self.send_response(401); self.end_headers(); return
        if self.path == "/html/health":
            body, ctype = b"<html>login</html>", "text/html"
        else:
            body, ctype = b'{"ok": true, "version": "2.0.2", "schema_version": 3}', "application/json"
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), _Health)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
check("the health check passes with the Access pair and our reply", runner.wait_healthy(base, "tok-for-health-check", 0, lambda s: None, "pair.access", "pair-secret") == "")
problem = runner.wait_healthy(base, "tok-for-health-check", 0, lambda s: None, "wrong.access", "wrong")
check("a redirect to a login page is not healthy, and the wait ends at once", "redirected to" in problem and "login" in problem)
problem = runner.wait_healthy(base + "/html", "tok-for-health-check", 0, lambda s: None, "pair.access", "pair-secret")
check("a 200 that is not our /health reply is not healthy", "not the Worker's /health reply" in problem)
srv.shutdown()

# ------------------------------------------------------------------ uninstall
w = world()
w.cf.state["d1"]["other-db"] = {"uuid": "feed", "db": __import__("sqlite3").connect(":memory:")}
w.cf.state["scripts"]["other-worker"] = {"meta": {}, "modules": [], "secret": "s", "crons": [], "workers_dev": False}
w.cf.state["r2"]["other-backups"] = {"rules": [], "objects": 0}
w.run(access=True, email="me@example.com")
st = w.state()
check("teardown plan has only recorded resources with our prefix, R2 kept", [k for k, _ in teardown.plan(st)] == ["worker", "access", "vectorize", "d1"] and all(n.startswith("anymem-trial") for _, n in teardown.plan(st)))
check("teardown plan with backups adds the bucket last", [k for k, _ in teardown.plan(st, True)][-1] == "r2")
foreign = json.loads(json.dumps(st))
foreign["d1"]["name"] = "other-db"
check("a foreign name in deploy.json is not planned", ("d1", "other-db") not in teardown.plan(foreign))
w.out.clear()
client = cf.Client(API_TOKEN, ACCOUNT, say=w.out.append)
n_before = len(w.cf.calls)
rc = teardown.delete_resources(client, False, w.out.append)
S = w.cf.state
check("uninstall exits 0", rc == 0)
check("Worker, Access app and token, Vectorize and D1 are gone", "anymem-trial" not in S["scripts"] and not S["access_apps"] and not S["service_tokens"] and "anymem-trial-vectors" not in S["vectorize"] and "anymem-trial-db" not in S["d1"])
check("the backup bucket is kept and said", "anymem-trial-backups" in S["r2"] and "Kept R2 bucket" in w.text)
check("other people's resources are untouched", "other-db" in S["d1"] and "other-worker" in S["scripts"] and "other-backups" in S["r2"])
check("only DELETE calls were made, in reverse creation order", [m for m, p in w.cf.calls[n_before:]] == ["DELETE"] * 5 and "workers/scripts" in w.cf.calls[n_before][1] and "/d1/database/" in w.cf.calls[-1][1])
check("deploy.json keeps the bucket record", "r2" in w.state() and "d1" not in w.state())
rc = teardown.delete_resources(client, False, w.out.append)
check("uninstall twice is harmless", rc == 0)
rc = teardown.delete_resources(client, True, w.out.append)
check("include_backups deletes the empty bucket", rc == 0 and "anymem-trial-backups" not in S["r2"] and "other-backups" in S["r2"])
check("deploy.json is removed when nothing is left", not deploy.state_file().exists())
w.close()

w = world()
w.run()
w.cf.state["r2"]["anymem-trial-backups"]["objects"] = 3
client = cf.Client(API_TOKEN, ACCOUNT, say=w.out.append)
rc = teardown.delete_resources(client, True, w.out.append)
check("a bucket with backups in it is never emptied, the failure is plain", rc == 1 and "not empty" in w.text and "anymem-trial-backups" in w.cf.state["r2"])
w.close()

w = world()
w.run()
w.cf.fail("DELETE", r"/vectorize/", 500, [], "boom", times=9)
client = cf.Client(API_TOKEN, ACCOUNT, say=w.out.append, sleep=lambda s: None)
rc = teardown.delete_resources(client, False, w.out.append)
check("a failed delete stops, says what is left, and rerun continues", rc == 1 and "Could not delete Vectorize index" in w.text and "anymem-trial" not in w.cf.state["scripts"] and "worker" not in w.state() and "vectorize" in w.state())
w.cf.failures.clear()
rc = teardown.delete_resources(client, False, w.out.append)
check("the rerun finishes the rest", rc == 0 and not w.cf.state["vectorize"] and not w.cf.state["d1"])
w.close()

# the command layer
# The default harness probe runs each harness's real binary and writes its state into the home folder, so these tests get a fixed list.
probed = []
setup_cmd.harnesses = lambda: (probed.append(1), [("claude", True)])[1]
w = world()
w.run()
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = uninstall_cmd.run(SimpleNamespace(delete_resources=False, include_backups=False, yes=False))
check("uninstall without --delete-resources lists and deletes nothing", rc == 0 and "Nothing was deleted" in buf.getvalue() and "anymem-trial-db" in buf.getvalue() and w.cf.count("DELETE", ".*") == 0)
uninstall_cmd.input = lambda prompt="": "no"
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = uninstall_cmd.run(SimpleNamespace(delete_resources=True, include_backups=False, yes=False))
check("anything but delete stops", rc == 1 and w.cf.count("DELETE", ".*") == 0)
os.environ["CLOUDFLARE_API_TOKEN"] = API_TOKEN
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = uninstall_cmd.run(SimpleNamespace(delete_resources=True, include_backups=False, yes=True))
check("--yes deletes with the token from the environment", rc == 0 and "anymem-trial-db" not in w.cf.state["d1"] and API_TOKEN not in buf.getvalue())
del os.environ["CLOUDFLARE_API_TOKEN"]
w.close()

# setup command: scopes, dry run through the command
buf = io.StringIO()
ns = SimpleNamespace(name="anymem", domain="", subdomain="", access=False, no_access=False, email="", plan="", account_id="", rotate_access=False, second_machine=False, scopes=True, dry_run=False, yes=False)
with contextlib.redirect_stdout(buf):
    rc = setup_cmd.run(ns)
check("setup --scopes prints the list and stops", rc == 0 and "Workers Scripts Edit" in buf.getvalue())
ns.scopes, ns.dry_run = False, True
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = setup_cmd.run(ns)
check("setup --dry-run through the command", rc == 0 and "Dry run" in buf.getvalue() and "Node.js: not needed" in buf.getvalue() and bool(probed))
ns.dry_run, ns.name = False, "Bad Name"
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = setup_cmd.run(ns)
check("a bad --name stops before anything", rc == 1 and "not a usable --name" in buf.getvalue())

# ALLOWED_HOSTS from the committed wrangler.jsonc is carried to the Worker settings, the ACCESS_ values never are
carried = worker.vars_for({"vars": {"ALLOWED_HOSTS": "memory.example.com", "ACCESS_AUD": "committed", "RECALL_MIN_SIM": "0.75"}}, {"team_domain": "t.cloudflareaccess.com", "aud": "real", "common_name": "x.access", "email": "me@example.com", "expires": "2027-10-17"})
check("ALLOWED_HOSTS is carried and the committed ACCESS_ value is replaced", carried["ALLOWED_HOSTS"] == "memory.example.com" and carried["ACCESS_AUD"] == "real" and carried["RECALL_MIN_SIM"] == "0.75")
check("no ALLOWED_HOSTS in the committed file means none is uploaded", "ALLOWED_HOSTS" not in worker.vars_for({"vars": {}}, None))

print("\n%d failed" % len(failures) if failures else "\nall passed")
sys.exit(1 if failures else 0)
