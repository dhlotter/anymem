import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createApp, START } from "./helpers/app.js";
import { FakeVectorize } from "./helpers/fakes.js";
import { VERSION } from "../version.js";
import { listMigrations } from "../migrate.js";
import { EMPTY_COUNTERS } from "./helpers/write.js";

const addMemory = (db, id, over = {}) =>
  db
    .prepare("INSERT INTO memories (id, content, content_hash, origin, status, kind, valid_from, valid_until, deleted_at, created_at, updated_at) VALUES (?, 'c', ?, ?, ?, ?, 1, ?, ?, 1, 1)")
    .bind(id, id, over.origin ?? "explicit", over.status ?? "active", over.kind ?? null, over.validUntil ?? null, over.deletedAt ?? null)
    .run();

test("GET /health reports version, schema and vectorize", async () => {
  const app = await createApp();
  const res = await app.call("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, version: VERSION, schema_version: listMigrations().at(-1).version, vectorize: { ok: true, dimensions: 384 } });
});

test("GET /health tolerates an empty index and reports a broken or wrong sized one", async () => {
  const app = await createApp();
  assert.equal((await app.call("/health")).json.vectorize.ok, true);
  app.env.VECTORIZE = new FakeVectorize({ failing: true });
  const down = await app.call("/health");
  assert.equal(down.status, 200);
  assert.deepEqual(down.json.vectorize, { ok: false, dimensions: null });
  app.env.VECTORIZE = new FakeVectorize({ dimensions: 1024 });
  assert.equal((await app.call("/health")).json.vectorize.ok, false);
  app.env.VECTORIZE = { describe: async () => ({ config: { dimensions: 384 }, vectorsCount: 0 }) };
  assert.equal((await app.call("/health")).json.vectorize.ok, true);
});

test("GET /health is a 503 when the schema was never applied", async () => {
  const app = await createApp();
  await app.env.DB.exec("DELETE FROM meta");
  const res = await app.call("/health");
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.schema_version, null);
});

test("GET /count counts live memories only", async () => {
  const app = await createApp();
  assert.deepEqual((await app.call("/count")).json, { count: 0 });
  await addMemory(app.env.DB, "a");
  await addMemory(app.env.DB, "b", { deletedAt: 5 });
  await addMemory(app.env.DB, "c", { validUntil: 5 });
  await addMemory(app.env.DB, "d", { status: "pending" });
  await addMemory(app.env.DB, "e", { status: "canonical" });
  assert.deepEqual((await app.call("/count")).json, { count: 2 });
});

test("GET /stats on an empty store", async () => {
  const app = await createApp();
  const res = await app.call("/stats");
  assert.deepEqual(res.json, { count: 0, by_status: {}, by_origin: {}, unvectorized: 0, unclassified: 0, last_run: null, ...EMPTY_COUNTERS });
});

test("GET /stats counts by status and origin, unvectorized and unclassified", async () => {
  const app = await createApp();
  await addMemory(app.env.DB, "a", { origin: "capture", status: "active" });
  await addMemory(app.env.DB, "b", { origin: "explicit", status: "canonical", kind: "semantic" });
  await addMemory(app.env.DB, "c", { origin: "capture", status: "active", kind: "episodic" });
  await app.env.DB.exec("INSERT INTO memory_keys (memory_id, key_type, text, vector_id, created_at) VALUES ('b', 'chunk', 't', 'v1', 1), ('c', 'chunk', 't', NULL, 1)");
  const res = await app.call("/stats");
  assert.equal(res.json.count, 3);
  assert.deepEqual(res.json.by_status, { active: 2, canonical: 1 });
  assert.deepEqual(res.json.by_origin, { capture: 2, explicit: 1 });
  assert.equal(res.json.unvectorized, 2);
  assert.equal(res.json.unclassified, 1);
});

test("GET /stats shows the last cron run", async () => {
  const app = await createApp();
  await app.worker.scheduled({}, app.env, app.ctx);
  await app.settle();
  const { last_run } = (await app.call("/stats")).json;
  assert.equal(last_run.job, "nightly");
  assert.equal(last_run.ok, true);
  assert.deepEqual(Object.keys(last_run.summary), ["backup", "purge_trash", "reindex", "classify", "merge", "probation", "purge_old", "token"]);
  assert.equal(last_run.summary.purge_old.audit, 0);
});

test("devices, create then list then revoke", async () => {
  const app = await createApp();
  assert.deepEqual((await app.call("/devices")).json, { devices: [] });
  const made = await app.call("/devices", { method: "POST", body: { label: "  laptop  " } });
  assert.equal(made.status, 201);
  assert.equal(made.json.device.label, "laptop");
  assert.equal(made.json.device.created_at, START);
  assert.match(made.json.token, /^amd_[A-Za-z0-9_-]{43}$/);
  const listed = (await app.call("/devices")).json.devices;
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["allow_private", "created_at", "id", "label", "last_used_at"]);
  assert.ok(!JSON.stringify(listed).includes(made.json.token));
  const gone = await app.call("/devices/revoke", { method: "POST", body: { id: made.json.device.id } });
  assert.deepEqual(gone.json, { ok: true, id: made.json.device.id });
  assert.deepEqual((await app.call("/devices")).json, { devices: [] });
});

test("a device's last_used_at is updated after it is used", async () => {
  const app = await createApp();
  const { device, token } = (await app.call("/devices", { method: "POST", body: { label: "m" } })).json;
  app.clock.t += 5000;
  await app.call("/count", { token });
  const row = (await app.call("/devices")).json.devices.find((d) => d.id === device.id);
  assert.equal(row.last_used_at, START + 5000);
});

test("POST /devices rejects bad labels", async () => {
  const app = await createApp();
  for (const body of [{}, { label: "" }, { label: "   " }, { label: 5 }, { label: "x".repeat(65) }, { label: "bad\u0007label" }]) {
    const res = await app.call("/devices", { method: "POST", body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.code, "bad_request");
  }
});

test("POST /devices/revoke rejects bad input and unknown ids", async () => {
  const app = await createApp();
  assert.equal((await app.call("/devices/revoke", { method: "POST", body: {} })).status, 400);
  assert.equal((await app.call("/devices/revoke", { method: "POST", body: { id: "x".repeat(65) } })).status, 400);
  const missing = await app.call("/devices/revoke", { method: "POST", body: { id: "nope" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "not_found");
  const { device } = (await app.call("/devices", { method: "POST", body: { label: "m" } })).json;
  await app.call("/devices/revoke", { method: "POST", body: { id: device.id } });
  assert.equal((await app.call("/devices/revoke", { method: "POST", body: { id: device.id } })).status, 404);
});

test("body problems give 400 and 413", async () => {
  const app = await createApp();
  const bad = await app.call("/devices", { method: "POST", rawBody: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "bad_json");
  assert.equal((await app.call("/devices", { method: "POST", rawBody: "[1]" })).json.code, "bad_json");
  assert.equal((await app.call("/devices", { method: "POST", rawBody: "null" })).status, 400);
  const noBody = await app.call("/devices", { method: "POST" });
  assert.equal(noBody.status, 400);
  const big = await app.call("/devices", { method: "POST", body: { label: "x", pad: "y".repeat(1_100_000) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, "payload_too_large");
});

test("an oversized body without a content-length is still stopped", async () => {
  const app = await createApp();
  const chunk = new TextEncoder().encode("a".repeat(100_000));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"label":"'));
      for (let i = 0; i < 12; i++) c.enqueue(chunk);
      c.close();
    },
  });
  const { jwt } = { jwt: app.serviceJwt() };
  const req = new Request("https://anymem-worker.test/devices", { method: "POST", body: stream, duplex: "half", headers: { authorization: "Bearer " + app.env.AUTH_TOKEN, "cf-access-jwt-assertion": jwt } });
  const res = await app.worker.fetch(req, app.env, app.ctx);
  assert.equal(res.status, 413);
});

test("unknown routes are 404 and wrong methods are 405 with an Allow header", async () => {
  const app = await createApp();
  const nope = await app.call("/nope");
  assert.equal(nope.status, 404);
  assert.deepEqual(nope.json, { error: "No such route.", code: "not_found" });
  const wrong = await app.call("/count", { method: "POST", body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.json.code, "method_not_allowed");
  assert.equal(wrong.headers.get("allow"), "GET");
  const both = await app.call("/devices", { method: "DELETE" });
  assert.equal(both.headers.get("allow"), "GET, POST");
  assert.equal((await app.call("/health", { method: "OPTIONS" })).status, 405);
});

test("every error is JSON with error and code", async () => {
  const app = await createApp();
  const replies = [await app.call("/nope"), await app.call("/count", { token: "x" }), await app.call("/devices", { method: "POST", rawBody: "{" }), await app.call("/count", { method: "PUT" })];
  for (const r of replies) {
    assert.deepEqual(Object.keys(r.json).sort(), ["code", "error"]);
    assert.equal(typeof r.json.error, "string");
    assert.match(r.headers.get("content-type"), /application\/json/);
  }
});

test("an unexpected failure is a 500 that does not leak details", async () => {
  const app = await createApp();
  const realPrepare = app.env.DB.prepare.bind(app.env.DB);
  app.env.DB.prepare = (sql) => {
    if (sql.includes("FROM memories")) throw new Error("secret internal detail");
    return realPrepare(sql);
  };
  const res = await app.call("/count");
  assert.equal(res.status, 500);
  assert.equal(res.json.code, "internal");
  assert.ok(!res.json.error.includes("secret"));
});

test("routes need auth", async () => {
  const app = await createApp();
  for (const [path, method] of [["/health", "GET"], ["/count", "GET"], ["/stats", "GET"], ["/devices", "GET"], ["/devices", "POST"], ["/devices/revoke", "POST"], ["/audit", "GET"]]) {
    const res = await app.call(path, { method, token: null, jwt: null, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("the Worker version is 2.0.5 and matches package.json and the plugin manifest", () => {
  const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
  assert.equal(VERSION, "2.0.5");
  assert.equal(read("../package.json").version, VERSION);
  assert.equal(read("../../.claude-plugin/plugin.json").version, VERSION);
});
