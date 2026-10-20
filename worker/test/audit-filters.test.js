import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { RESULTS, recordAudit } from "../audit.js";

async function auditApp() {
  const app = await createApp();
  const add = (over) =>
    recordAudit(app.env.DB, { ts: app.clock.t++, actor: { kind: "device", id: "d1" }, harness: "claude", script: "hook:recall", method: "GET", route: "/recall", status: 200, durationMs: 4, memoryIds: [], ...over });
  await add({});
  await add({ harness: "codex" });
  await add({ harness: "kilo", route: "/capture", method: "POST", status: 422 });
  await add({ harness: "kilo", route: "/capture", method: "POST", status: 429 });
  await add({ harness: "codex", route: "/capture", method: "POST", status: 403 });
  await add({ harness: "claude", route: "/entry", status: 404 });
  await add({ harness: "dsh", route: "/recall", status: 502 });
  await add({ harness: "", actor: { kind: "browser", id: "me@example.com" }, route: "/list", status: 200 });
  return app;
}
const list = async (app, q) => (await app.call(`/audit?${q}`)).json;
const statuses = (res) => res.entries.map((e) => e.status).sort();

test("GET /audit filters by harness", async () => {
  const app = await auditApp();
  assert.equal((await list(app, "harness=kilo")).entries.length, 2);
  assert.equal((await list(app, "harness=codex")).entries.length, 2);
  assert.equal((await list(app, "harness=zcode")).entries.length, 0);
  assert.equal((await list(app, "harness=claude&route=/recall")).entries.length, 1);
});

test("GET /audit filters by result, and each result is a class of status", async () => {
  const app = await auditApp();
  assert.deepEqual(statuses(await list(app, "result=ok")), [200, 200, 200]);
  assert.deepEqual(statuses(await list(app, "result=refused")), [422]);
  assert.deepEqual(statuses(await list(app, "result=limited")), [429]);
  assert.deepEqual(statuses(await list(app, "result=denied")), [403]);
  assert.deepEqual(statuses(await list(app, "result=failed")), [404, 502]);
  assert.deepEqual(Object.keys(RESULTS), ["ok", "refused", "limited", "denied", "failed"]);
});

test("filters combine, and paging keeps them", async () => {
  const app = await auditApp();
  const first = await list(app, "result=ok&limit=2");
  assert.equal(first.entries.length, 2);
  const second = await list(app, `result=ok&limit=2&cursor=${first.next_cursor}`);
  assert.equal(second.entries.length, 1);
  assert.equal(second.next_cursor, null);
  assert.equal((await list(app, "harness=kilo&result=refused")).entries.length, 1);
});

test("a bad harness or result is a 400, and the rows still hold no content", async () => {
  const app = await auditApp();
  assert.equal((await app.call("/audit?result=bogus")).status, 400);
  assert.equal((await app.call("/audit?result=constructor")).status, 400);
  assert.equal((await app.call("/audit?harness=a%20b")).status, 400);
  assert.equal((await app.call(`/audit?harness=${"x".repeat(65)}`)).status, 400);
  assert.equal((await app.call("/audit?harness=claude", { token: null, jwt: null })).status, 401);
  const [row] = (await list(app, "limit=1")).entries;
  assert.deepEqual(Object.keys(row).sort(), ["actor_id", "actor_kind", "duration_ms", "harness", "harness_label", "id", "memory_ids", "method", "route", "script", "status", "ts"]);
});
