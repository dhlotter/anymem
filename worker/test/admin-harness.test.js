import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN } from "./helpers/app.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";
import { appWith } from "./helpers/search.js";
import { createStore } from "../memory/store.js";

const set = (app, body, opts = {}) => app.call("/admin/harness", { method: "POST", body, ...opts });
const col = (app, id) => app.env.DB.prepare("SELECT harness, updated_at FROM memories WHERE id = ?").bind(id).first();

test("it fills in a blank harness, leaves updated_at and the history alone, and says it changed", async () => {
  const { app, ids } = await appWith(["a note with no harness"]);
  const before = await col(app, ids[0]);
  assert.equal(before.harness, "");
  app.clock.t += 5000;
  const res = await set(app, { id: ids[0], harness: "codex" });
  assert.deepEqual([res.status, res.json], [200, { ok: true, id: ids[0], harness: "codex", changed: true }]);
  assert.deepEqual({ ...(await col(app, ids[0])) }, { harness: "codex", updated_at: before.updated_at });
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_versions").first()).n, 0);
  const entry = (await app.call(`/entry?id=${ids[0]}`)).json.entry;
  assert.equal(entry.harness_label, "Codex");
});

test("it never replaces a harness that is already there, and a second call changes nothing", async () => {
  const { app, ids } = await appWith([{ content: "saved by kilo", harness: "kilo" }, "blank one"]);
  const kept = await set(app, { id: ids[0], harness: "codex" });
  assert.deepEqual(kept.json, { ok: true, id: ids[0], harness: "kilo", changed: false });
  assert.equal((await col(app, ids[0])).harness, "kilo");
  await set(app, { id: ids[1], harness: "dsh" });
  const again = await set(app, { id: ids[1], harness: "codex" });
  assert.deepEqual([again.json.harness, again.json.changed], ["dsh", false]);
});

test("an alias is stored as its id, and a name nobody knows is refused", async () => {
  const { app, ids } = await appWith(["one", "two"]);
  assert.equal((await set(app, { id: ids[0], harness: "Claude-Code" })).json.harness, "claude");
  assert.equal((await col(app, ids[0])).harness, "claude");
  for (const harness of ["hermes", "", "a b", 5, null, undefined]) {
    const res = await set(app, { id: ids[1], harness });
    assert.deepEqual([res.status, res.json.code], [400, "unknown_harness"], String(harness));
  }
  assert.equal((await col(app, ids[1])).harness, "");
});

test("bad input and a memory that does not exist", async () => {
  const { app, ids } = await appWith(["one"]);
  for (const body of [{}, { harness: "codex" }, { id: "", harness: "codex" }, { id: 7, harness: "codex" }, { id: "x".repeat(65), harness: "codex" }]) {
    assert.equal((await set(app, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await app.call("/admin/harness", { method: "POST", rawBody: "{not json" })).status, 400);
  const missing = await set(app, { id: "no-such-memory", harness: "codex" });
  assert.deepEqual([missing.status, missing.json.code], [404, "not_found"]);
  assert.equal((await app.call("/admin/harness")).status, 405);
  assert.equal((await col(app, ids[0])).harness, "");
});

test("a trashed memory can still be filled in, the backfill is about provenance", async () => {
  const { app, ids } = await appWith(["to be trashed"]);
  await createStore(app.env.DB, () => app.clock.t).softDelete(ids[0]);
  assert.equal((await set(app, { id: ids[0], harness: "agy" })).json.changed, true);
});

test("it is admin only, never a device token and never a browser login", async () => {
  const { app, ids } = await appWith(["one"]);
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  const asDevice = await set(app, { id: ids[0], harness: "codex" }, { token: device.token });
  assert.equal(asDevice.status, 403);
  const browser = await raw(app, "/admin/harness", { method: "POST", jwt: app.browserJwt("me@example.com"), headers: UI_HEADERS, body: { id: ids[0], harness: "codex" } });
  assert.deepEqual([browser.status, (await browser.json()).code], [403, "browser_not_allowed"]);
  assert.equal((await set(app, { id: ids[0], harness: "codex" }, { token: null })).status, 401);
  assert.equal((await set(app, { id: ids[0], harness: "codex" }, { token: "wrong" })).status, 401);
  assert.equal((await col(app, ids[0])).harness, "");
  assert.equal((await set(app, { id: ids[0], harness: "codex" }, { token: ADMIN_TOKEN })).status, 200);
});

test("the audit row lists the memory id and never a name or text", async () => {
  const { app, ids } = await appWith(["zebra harness note"]);
  await set(app, { id: ids[0], harness: "codex" }, { headers: { "x-anymem-harness": "claude" } });
  const row = await app.env.DB.prepare("SELECT * FROM audit WHERE route = '/admin/harness'").first();
  assert.deepEqual(JSON.parse(row.memory_ids), [ids[0]]);
  assert.doesNotMatch(JSON.stringify(row), /zebra/, "the memory text is not in the audit row");
});

test("a call that loses a race says what is stored now, not the blank it read", async () => {
  const { app, ids } = await appWith(["racing note"]);
  const real = app.env.DB;
  app.env.DB = {
    prepare(sql) {
      if (sql.startsWith("UPDATE memories SET harness")) real.sqlite.exec("UPDATE memories SET harness = 'kilo'"); // another caller got in first
      return real.prepare(sql);
    },
    batch: (...a) => real.batch(...a),
  };
  const res = await set(app, { id: ids[0], harness: "codex" });
  assert.deepEqual(res.json, { ok: true, id: ids[0], harness: "kilo", changed: false });
});
