import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, START, createApp } from "./helpers/app.js";
import { RETENTION_MS, cleanLabel, purgeAudit, recordAudit } from "../audit.js";

const rows = async (app) => (await app.call("/audit?limit=500")).json.entries;

test("every authenticated request writes one audit row, including failures", async () => {
  const app = await createApp();
  await app.call("/count");
  await app.call("/entry");
  await app.call("/count", { method: "POST", body: {}, token: "bad" });
  const entries = (await rows(app)).filter((e) => e.route !== "/audit");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.status).reverse(), [200, 400]);
});

test("a request refused after the caller is known is audited under that caller", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  assert.equal((await app.call("/devices", { token })).status, 403, "a device token on an admin route");
  const jwt = app.browserJwt("me@example.com");
  assert.equal((await app.call("/capture", { method: "POST", body: { content: "a browser note" }, token: null, jwt })).status, 403, "a browser write without the dashboard headers");
  const denied = (await rows(app)).filter((e) => e.status === 403);
  assert.equal(denied.length, 2);
  const device = denied.find((e) => e.route === "/devices");
  assert.equal(device.actor_kind, "device");
  assert.equal(device.actor_id, (await app.env.DB.prepare("SELECT id FROM devices").first()).id);
  const browser = denied.find((e) => e.route === "/capture");
  assert.equal(browser.actor_kind, "browser");
  assert.equal(browser.actor_id, "me@example.com");
});

test("anonymous traffic writes no audit row, whether it is refused, unknown or the wrong method", async () => {
  const app = await createApp();
  await app.call("/count", { token: "bad" });
  await app.call("/count", { token: null, jwt: null });
  await app.call("/count", { jwt: "junk" });
  await app.call("/nope");
  await app.call("/count", { method: "POST", body: {} });
  await app.call("/devices", { method: "POST", body: { label: "x" }, jwt: app.browserJwt("intruder@example.com"), token: null });
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first()).n, 0);
});

test("an audit row has time, actor, harness, script, method, route, status, duration and ids but no content", async () => {
  const app = await createApp();
  await app.call("/count", { headers: { "x-anymem-harness": "claude-code", "x-anymem-script": "recall" } });
  const [row] = (await rows(app)).filter((e) => e.route === "/count");
  assert.deepEqual(Object.keys(row).sort(), ["actor_id", "actor_kind", "duration_ms", "harness", "harness_label", "id", "memory_ids", "method", "route", "script", "status", "ts"]);
  assert.equal(row.ts, START);
  assert.equal(row.actor_kind, "admin");
  assert.equal(row.harness, "claude-code");
  assert.equal(row.script, "recall");
  assert.equal(row.method, "GET");
  assert.deepEqual(row.memory_ids, []);
  assert.equal(row.duration_ms, 0);
});

test("a device is recorded by its id and a call with no valid login leaves no row", async () => {
  const app = await createApp();
  const { device, token } = (await app.call("/devices", { method: "POST", body: { label: "m" } })).json;
  await app.call("/count", { token });
  await app.call("/count", { token: null });
  const entries = await rows(app);
  assert.ok(entries.some((e) => e.actor_kind === "device" && e.actor_id === device.id));
  assert.ok(!entries.some((e) => e.actor_kind === "none"));
});

test("no token, secret or body text reaches the audit table", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "my-private-label" } })).json;
  await app.call("/count?query=very-private-text", { token });
  const dump = JSON.stringify((await app.env.DB.prepare("SELECT * FROM audit").all()).results);
  for (const secret of [token, ADMIN_TOKEN, "my-private-label", "very-private-text"]) assert.ok(!dump.includes(secret), secret);
});

test("odd header values are dropped and long ones cut", async () => {
  const app = await createApp();
  await app.call("/count", { headers: { "x-anymem-harness": "bad value with spaces", "x-anymem-script": "x".repeat(100) } });
  const [row] = (await rows(app)).filter((e) => e.route === "/count");
  assert.equal(row.harness, "");
  assert.equal(row.script, "x".repeat(64));
  assert.equal(cleanLabel(null), "");
  assert.equal(cleanLabel("codex"), "codex");
});

test("the audit write goes through waitUntil and a failing write does not break the reply", async () => {
  const app = await createApp();
  const realPrepare = app.env.DB.prepare.bind(app.env.DB);
  app.env.DB.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO audit")) throw new Error("audit table is broken");
    return realPrepare(sql);
  };
  const res = await app.call("/count");
  assert.equal(res.status, 200);
});

test("a long path is truncated in the route column", async () => {
  const app = await createApp();
  await app.call("/backup/" + "a".repeat(500));
  const entries = await rows(app);
  assert.equal(entries.find((e) => e.route.startsWith("/backup/")).route.length, 120);
});

test("GET /audit filters by time, actor and route and pages with a cursor", async () => {
  const app = await createApp();
  const { device, token } = (await app.call("/devices", { method: "POST", body: { label: "m" } })).json;
  app.clock.t += 1000;
  await app.call("/count", { token });
  app.clock.t += 1000;
  await app.call("/health", { token });
  app.clock.t += 1000;
  await app.call("/count");

  const byActor = (await app.call(`/audit?actor=${device.id}`)).json.entries;
  assert.deepEqual(byActor.map((e) => e.route).reverse(), ["/count", "/health"]);
  const byRoute = (await app.call("/audit?route=/health")).json.entries;
  assert.equal(byRoute.length, 1);
  const since = (await app.call(`/audit?since=${START + 2000}&route=/count`)).json.entries;
  assert.equal(since.length, 1);
  assert.equal(since[0].actor_kind, "admin");
  const until = (await app.call(`/audit?until=${START + 1000}`)).json.entries;
  assert.deepEqual(until.map((e) => e.route), ["/devices"]);

  const page1 = (await app.call("/audit?limit=2")).json;
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.next_cursor);
  const page2 = (await app.call(`/audit?limit=2&cursor=${page1.next_cursor}`)).json;
  assert.ok(page2.entries.every((e) => e.id < page1.next_cursor + 0));
  assert.ok(page2.entries.length >= 1);
  const ids = [...page1.entries, ...page2.entries].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const all = (await app.call("/audit?limit=500")).json;
  assert.equal(all.next_cursor, null);
});

test("GET /audit rejects bad parameters", async () => {
  const app = await createApp();
  for (const q of ["since=abc", "limit=0", "limit=501", "cursor=-1", "until=1.5", `actor=${"x".repeat(129)}`, `route=${"x".repeat(121)}`]) {
    const res = await app.call(`/audit?${q}`);
    assert.equal(res.status, 400, q);
  }
});

test("purgeAudit removes only rows past the 90 day retention", async () => {
  const app = await createApp();
  const db = app.env.DB;
  const row = (ts) => recordAudit(db, { ts, actor: { kind: "admin", id: "admin" }, harness: "", script: "", method: "GET", route: "/x", status: 200, durationMs: 1, memoryIds: [] });
  await row(START - RETENTION_MS - 1);
  await row(START - RETENTION_MS + 1000);
  await row(START);
  assert.equal(await purgeAudit(db, START), 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit").first()).n, 2);
});

test("at most 100 memory ids are kept per row", async () => {
  const app = await createApp();
  const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
  await recordAudit(app.env.DB, { ts: 1, actor: { kind: "admin", id: "a" }, harness: "", script: "", method: "GET", route: "/x", status: 200, durationMs: 1, memoryIds: ids });
  const row = await app.env.DB.prepare("SELECT memory_ids FROM audit").first();
  assert.equal(JSON.parse(row.memory_ids).length, 100);
});
