import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { api, fakeAssets, raw, UI_DIR } from "./helpers/ui.js";
import { appWith } from "./helpers/search.js";
import { assetPath, CSP, matchesEtag } from "../dashboard.js";
import { seed } from "./helpers/maintenance.js";

const ME = "me@example.com";
const withUi = (extra = {}) => ({ env: { ASSETS: fakeAssets, ...extra } });
const files = (dir = UI_DIR) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [relative(UI_DIR, join(dir, f))]));
const TYPE = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

test("every dashboard file is served with the right content type and the strict CSP", async () => {
  const app = await createApp(withUi());
  const list = files();
  assert.ok(list.length >= 20, `found ${list.length} files`);
  for (const file of list) {
    const res = await raw(app, `/ui/${file}`, { jwt: app.browserJwt(ME) });
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("content-type"), TYPE[file.split(".").pop()], file);
    assert.equal(res.headers.get("content-security-policy"), CSP, file);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok((await res.text()).length > 0);
  }
});

test("a dashboard file carries its etag, and a browser that has the same one gets a 304 with no body", async () => {
  const app = await createApp(withUi());
  const jwt = app.browserJwt(ME);
  const first = await raw(app, "/ui/app.js", { jwt });
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]+"$/);
  await first.text();
  const again = await raw(app, "/ui/app.js", { jwt, headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("content-security-policy"), CSP, "a 304 keeps the headers");
  assert.equal((await raw(app, "/ui/app.js", { jwt, headers: { "if-none-match": '"not-this-one"' } })).status, 200, "a different etag gets the file");
});

test("If-None-Match matches a list of etags, weak or strong, and a star", () => {
  assert.equal(matchesEtag('"a"', '"a"'), true);
  assert.equal(matchesEtag('"x", W/"a"', '"a"'), true, "a weak tag in a list still matches");
  assert.equal(matchesEtag('W/"a"', '"a"'), true);
  assert.equal(matchesEtag("*", '"a"'), true);
  assert.equal(matchesEtag('"b"', '"a"'), false);
  assert.equal(matchesEtag(null, '"a"'), false, "no header, no 304");
});

test("the People count is the Home badge, and the list says when it shows only the first page of them", async () => {
  const app = await createApp();
  for (let i = 0; i < 503; i++) await seed(app, { name: `profile-proposal-${i}`, text: `Proposed Phone: ${i}`, origin: "profile", tags: ["profile-proposal"], status: "pending" });
  await seed(app, { name: "a pending note", origin: "explicit", status: "pending" });
  const people = (await api(app, "/ui/api/people")).json;
  const home = (await api(app, "/ui/api/home")).json;
  assert.equal(people.pending_total, 503);
  assert.equal(home.nav.pending, 503, "the badge counts the same changes");
  assert.equal(people.pending.length, 500, "the page shows the first 500");
});

test("the root serves the page", async () => {
  const app = await createApp(withUi());
  for (const path of ["/", "/ui/", "/ui/index.html"]) {
    const res = await raw(app, path, { jwt: app.browserJwt(ME) });
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>anymem<\/title>/);
  }
});

test("the CSP allows only this origin, no inline script or style, no eval, no frames", () => {
  const policy = Object.fromEntries(CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
  assert.deepEqual(policy["default-src"], ["'none'"]);
  assert.deepEqual(policy["script-src"], ["'self'"]);
  assert.deepEqual(policy["style-src"], ["'self'"]);
  assert.deepEqual(policy["connect-src"], ["'self'"]);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
  assert.doesNotMatch(CSP, /unsafe|\*|https?:/);
});

test("only an allowed browser login may load the dashboard", async () => {
  const app = await createApp(withUi());
  const none = await raw(app, "/", {});
  assert.equal(none.status, 401);
  const stranger = await raw(app, "/", { jwt: app.browserJwt("stranger@example.com") });
  assert.equal(stranger.status, 403);
  // a service token with the right bearer is not a browser login
  const machine = await raw(app, "/", { jwt: app.serviceJwt(), token: ADMIN_TOKEN });
  assert.equal(machine.status, 403);
  assert.equal((await machine.json()).code, "browser_only");
  const files = await raw(app, "/ui/app.js", { jwt: app.serviceJwt(), token: ADMIN_TOKEN });
  assert.equal(files.status, 403);
  assert.equal((await raw(app, "/", { jwt: app.browserJwt(ME) })).status, 200);
});

test("without Access there is no browser login, so the dashboard is refused", async () => {
  const app = await createApp({ ...withUi(), withAccess: false });
  assert.equal((await raw(app, "/", { token: ADMIN_TOKEN })).status, 403);
});

test("unknown files, odd paths and other methods are refused", async () => {
  const app = await createApp(withUi());
  const jwt = app.browserJwt(ME);
  for (const path of ["/ui/nope.js", "/ui/lib", "/ui/lib/", "/ui/app", "/ui/../auth.js", "/ui/%2e%2e/auth.js", "/ui/lib/..%2f..%2fauth.js", "/ui//app.js", "/ui/app.js.map", "/ui/api/nothing"]) {
    const res = await raw(app, path, { jwt });
    assert.ok([404, 400].includes(res.status), `${path} ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  const post = await raw(app, "/ui/app.js", { method: "POST", jwt, body: {} });
  assert.equal(post.status, 405);
  assert.equal(assetPath("/ui/lib/../x.js"), null);
  assert.equal(assetPath("/etc/passwd"), null);
  assert.equal(assetPath("/ui/screens/search.js"), "/screens/search.js");
});

test("a Worker with no assets binding says not found, not a crash", async () => {
  const app = await createApp();
  assert.equal((await raw(app, "/", { jwt: app.browserJwt(ME) })).status, 404);
});


test("overview reports counts, breakdowns, pending, trash, vectors and the last run", async () => {
  const { app, ids } = await appWith([
    { content: "alpha note", tags: ["status:canonical"], project: "demo" },
    { content: "beta note", source: "session-capture" },
    { content: "gamma note", tags: ["status:pending"] },
    "delta note",
  ]);
  await app.call("/forget", { method: "POST", body: { id: ids[3] } });
  await app.env.DB.prepare("INSERT INTO runs (job, started_at, finished_at, ok, summary) VALUES ('nightly', 1, 2, 1, '{\"merged\":2}')").run();
  const { status, json } = await api(app, "/ui/api/overview");
  assert.equal(status, 200);
  assert.equal(json.count, 2);
  assert.deepEqual(json.by_status, { canonical: 1, active: 1 });
  assert.deepEqual(json.by_origin, { explicit: 1, capture: 1 });
  assert.deepEqual(json.by_project, { "": 1, demo: 1 });
  assert.equal(json.pending, 1);
  assert.equal(json.trash, 1);
  assert.equal(typeof json.unvectorized, "number");
  assert.deepEqual(json.last_run.summary, { merged: 2 });
  assert.equal(json.capture.accepted, 4);
  assert.deepEqual(json.capture.reasons, {});
  assert.deepEqual(json.vectors.dimensions, 384);
  assert.equal(json.now, app.clock.t);
});

test("overview still works when Vectorize is down, and trash older than 14 days is not counted", async () => {
  const { app, ids } = await appWith(["one", "two"]);
  await app.call("/forget", { method: "POST", body: { id: ids[0] } });
  app.clock.t += 15 * 24 * 60 * 60 * 1000;
  app.env.VECTORIZE.failing = true;
  const { status, json } = await api(app, "/ui/api/overview");
  assert.equal(status, 200);
  assert.equal(json.vectors, null);
  assert.equal(json.trash, 0);
});

test("people returns the profile, person notes and pending changes", async () => {
  const { app } = await appWith([
    { content: "---\nname: profile\ndescription: me\n---\nEmail: a@b.c", source: "profile", tags: ["profile", "status:canonical"] },
    { content: "---\nname: person-alvin\ndescription: Alvin\n---\nRelationship: neighbour", source: "person", tags: ["person"] },
    { content: "---\nname: profile-proposal-phone\ndescription: p\n---\nProposed Phone: 123\nCurrent Phone: 456", source: "profile", tags: ["profile-proposal", "status:pending"] },
    { content: "an ordinary memory" },
  ]);
  const { status, json } = await api(app, "/ui/api/people");
  assert.equal(status, 200);
  assert.deepEqual(json.profile.map((e) => e.name), ["profile"]);
  assert.deepEqual(json.people.map((e) => e.name), ["person-alvin"]);
  assert.deepEqual(json.pending.map((e) => e.name), ["profile-proposal-phone"]);
});

test("token expiry gives the date, the days left and a warning inside 30 days", async () => {
  const app = await createApp({ env: { ACCESS_TOKEN_EXPIRES: "2027-10-07" } });
  const day = 24 * 60 * 60 * 1000;
  const expiry = Date.parse("2027-10-07T00:00:00Z");
  for (const [days, warn] of [[400, false], [31, false], [30, true], [3, true], [0, true], [-2, true]]) {
    app.clock.t = expiry - days * day;
    const { json } = await api(app, "/ui/api/token-expiry");
    assert.deepEqual([json.configured, json.expires, json.days_left, json.warn], [true, "2027-10-07", days, warn], String(days));
  }
  const unset = await createApp();
  assert.deepEqual((await api(unset, "/ui/api/token-expiry")).json, { ok: true, configured: false });
  const bad = await createApp({ env: { ACCESS_TOKEN_EXPIRES: "soon" } });
  assert.equal((await api(bad, "/ui/api/token-expiry")).json.configured, false);
});

test("memory extras give the probation end and links in both directions", async () => {
  const { app, ids } = await appWith(["first", "second"]);
  await app.call("/link", { method: "POST", body: { source_id: ids[0], target_id: ids[1], type: "related" } });
  await app.env.DB.prepare("UPDATE memories SET probation_until = 123 WHERE id = ?").bind(ids[0]).run();
  const a = (await api(app, `/ui/api/memory-extras?id=${ids[0]}`)).json;
  assert.equal(a.probation_until, 123);
  assert.deepEqual(a.links.map((l) => [l.direction, l.id, l.type]), [["out", ids[1], "related"]]);
  const b = (await api(app, `/ui/api/memory-extras?id=${ids[1]}`)).json;
  assert.deepEqual(b.links.map((l) => [l.direction, l.id]), [["in", ids[0]]]);
  assert.equal((await api(app, "/ui/api/memory-extras?id=missing")).status, 404);
  assert.equal((await api(app, "/ui/api/memory-extras")).status, 400);
});

test("the dashboard read routes need a login, and overview is admin only", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  for (const path of ["/ui/api/overview", "/ui/api/people", "/ui/api/token-expiry", "/ui/api/memory-extras?id=x"]) {
    assert.equal((await raw(app, path, {})).status, 401, path);
    assert.equal((await raw(app, path, { jwt: app.browserJwt("stranger@example.com") })).status, 403, path);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token: ADMIN_TOKEN })).status !== 401, true, path);
  }
  assert.equal((await raw(app, "/ui/api/overview", { jwt: app.serviceJwt(), token })).status, 403);
  assert.equal((await raw(app, "/ui/api/people", { jwt: app.serviceJwt(), token })).status, 200);
});

test("wrangler.jsonc serves the ui folder through the assets binding with the Worker in front, and dev files stay out of it", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.assets.directory, "./ui");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.not_found_handling, "none");
  assert.equal(config.assets.html_handling, "none");
  assert.ok(!files().some((f) => f.includes("dev-server")));
  assert.match(config.vars.ACCESS_TOKEN_EXPIRES, /^REPLACE_WITH_/);
});

test("wrangler.jsonc carries placeholders for the Access team domain and email, never personal values", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.match(config.vars.ACCESS_TEAM_DOMAIN, /^REPLACE_WITH_/);
  assert.match(config.vars.ACCESS_ALLOWED_EMAILS, /^REPLACE_WITH_/);
});

test("dashboard file loads write no audit row, a failed one and the dashboard API calls still do", async () => {
  const app = await createApp(withUi());
  const jwt = app.browserJwt(ME);
  for (const path of ["/", "/ui/", "/ui/index.html", "/ui/app.js", "/ui/lib/api.js"]) assert.equal((await raw(app, path, { jwt })).status, 200, path);
  const count = async () => (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first()).n;
  assert.equal(await count(), 0);
  assert.equal((await raw(app, "/ui/missing.js", { jwt })).status, 404);
  assert.equal((await raw(app, "/ui/api/people", { jwt })).status, 200);
  const rows = (await app.env.DB.prepare("SELECT route, status, actor_kind FROM audit ORDER BY id").all()).results.map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { route: "/ui/missing.js", status: 404, actor_kind: "browser" },
    { route: "/ui/api/people", status: 200, actor_kind: "browser" },
  ]);
});
