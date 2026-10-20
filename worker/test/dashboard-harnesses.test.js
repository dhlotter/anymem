import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { api, raw } from "./helpers/ui.js";
import { DAY, seed } from "./helpers/maintenance.js";
import { recordAudit } from "../audit.js";
import { outcomes, quietPercent, sources } from "../dashboard-harnesses.js";

const ME = "me@example.com";
const logRow = (app, id, harness, ageDays = 1) => app.env.DB.prepare("INSERT INTO recall_log (ts, harness, memory_id) VALUES (?, ?, ?)").bind(app.clock.t - Math.round(ageDays * DAY), harness, id).run();
const counter = (app, name, ageDays, count) => app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES (?, ?, ?)").bind(name, new Date(app.clock.t - ageDays * DAY).toISOString().slice(0, 10), count).run();
const audit = (app, over = {}) =>
  recordAudit(app.env.DB, { ts: app.clock.t - DAY, actor: { kind: "device", id: "d1" }, harness: "claude", script: "hook:recall", method: "GET", route: "/recall", status: 200, durationMs: 9, memoryIds: ["x"], ...over });

test("sources group the live memories by harness, and a blank one is Imported or Unknown by origin", () => {
  const out = sources([
    { harness: "claude", origin: "capture", n: 5 },
    { harness: "claude-code", origin: "import", n: 2 },
    { harness: "codex", origin: "capture", n: 3 },
    { harness: "", origin: "import", n: 9 },
    { harness: "", origin: "explicit", n: 3 },
    { harness: "", origin: "profile", n: 1 },
    { harness: "some-new-tool", origin: "capture", n: 1 },
  ]);
  assert.equal(out.total, 24);
  assert.deepEqual(out.rows.map((r) => [r.label, r.filter, r.memories]), [
    ["Imported", "none", 9],
    ["Claude Code", "claude", 7],
    ["Unknown", "none", 4],
    ["Codex", "codex", 3],
    ["some-new-tool", "some-new-tool", 1],
  ]);
  assert.deepEqual(sources([]), { total: 0, rows: [] });
});

test("the quiet share is a whole percent of the prompts that were reported, and null with none", () => {
  assert.equal(quietPercent({ injected: 1, quiet: 3, failed: 9 }), 75, "a failed search is not a quiet prompt");
  assert.equal(quietPercent({ injected: 0, quiet: 0, failed: 4 }), null);
  assert.equal(quietPercent({ injected: 2, quiet: 1, failed: 0 }), 33);
  assert.equal(quietPercent({ injected: 0, quiet: 5, failed: 0 }), 100);
});

test("outcomes add up per window and per harness, and ignore other counters", () => {
  const at = Date.parse("2026-10-18T12:00:00Z");
  const day = (n) => new Date(at - n * DAY).toISOString().slice(0, 10);
  const rows = [
    { name: "hook.recall.quiet.claude", day: day(0), count: 6 },
    { name: "hook.recall.injected.claude", day: day(0), count: 2 },
    { name: "hook.recall.quiet.claude", day: day(6), count: 2 },
    { name: "hook.recall.quiet.claude", day: day(7), count: 4 },
    { name: "hook.recall.injected.codex", day: day(20), count: 5 },
    { name: "hook.recall.failed.claude", day: day(1), count: 3 },
    { name: "hook.recall.quiet.unknown", day: day(2), count: 1 },
    { name: "hook.recall.quiet.claude", day: day(31), count: 100 },
    { name: "hook.recall.bogus.claude", day: day(0), count: 100 },
    { name: "capture.accepted", day: day(0), count: 100 },
  ];
  const out = outcomes(rows, at);
  assert.deepEqual(out.windows, [
    { days: 7, injected: 2, quiet: 9, failed: 3, prompts: 11, quiet_percent: 82 },
    { days: 30, injected: 7, quiet: 13, failed: 3, prompts: 20, quiet_percent: 65 },
  ]);
  assert.deepEqual(out.by_harness.map((h) => [h.harness, h.label, h.injected, h.quiet, h.failed, h.quiet_percent]), [
    ["claude", "Claude Code", 2, 12, 3, 86],
    ["codex", "Codex", 5, 0, 0, 0],
    ["unknown", "Unknown", 0, 1, 0, 100],
  ]);
  assert.deepEqual(outcomes([], at).windows.map((w) => [w.prompts, w.quiet_percent]), [[0, null], [0, null]]);
});

test("the route says where memories come from, what machines asked, what each tool was given and what the hook did", async () => {
  const app = await createApp();
  const a = await seed(app, { name: "otter-facts", harness: "claude", origin: "capture" });
  const b = await seed(app, { name: "badger-facts", harness: "codex", origin: "explicit" });
  await seed(app, { name: "heron-facts", origin: "import" });
  await seed(app, { name: "stoat-facts", origin: "explicit" });
  await seed(app, { name: "trashed-one", harness: "kilo", deleted_at: app.clock.t });
  await logRow(app, a, "claude");
  await logRow(app, a, "claude");
  await logRow(app, a, "claude");
  await logRow(app, b, "claude");
  await logRow(app, b, "codex");
  await logRow(app, b, "codex", 40);
  await audit(app);
  await audit(app, { memoryIds: [] });
  await audit(app, { harness: "codex" });
  await audit(app, { harness: "claude", actor: { kind: "browser", id: ME } });
  await counter(app, "hook.recall.quiet.claude", 1, 6);
  await counter(app, "hook.recall.injected.claude", 1, 2);
  await counter(app, "hook.recall.injected.codex", 10, 1);
  const { status, json } = await api(app, "/ui/api/harnesses");
  assert.equal(status, 200);
  assert.deepEqual(json.sources.rows.map((r) => [r.label, r.memories]), [["Claude Code", 1], ["Codex", 1], ["Imported", 1], ["Unknown", 1]]);
  assert.equal(json.sources.total, 4, "the trashed memory is not counted");
  assert.deepEqual(json.recalls.by_harness.map((h) => [h.label, h.calls, h.empty]), [["Claude Code", 2, 1], ["Codex", 1, 0]], "a browser call is not a machine");
  assert.deepEqual([json.recalls.total, json.recalls.empty], [3, 1]);
  assert.equal(json.used.total, 5, "a row from 40 days ago is outside the window");
  assert.deepEqual(json.used.by_harness.map((h) => [h.label, h.recalls, h.memories, h.top.map((m) => [m.title, m.count])]), [
    ["Claude Code", 4, 2, [["otter-facts", 3], ["badger-facts", 1]]],
    ["Codex", 1, 1, [["badger-facts", 1]]],
  ]);
  assert.equal(json.used.since, app.clock.t - 40 * DAY, "it says since when the log reaches back, even for rows outside the window");
  assert.deepEqual(json.outcomes.windows.map((w) => [w.days, w.injected, w.quiet, w.quiet_percent]), [[7, 2, 6, 75], [30, 3, 6, 67]]);
  assert.equal(json.outcomes.since, new Date(app.clock.t - 10 * DAY).toISOString().slice(0, 10));
  assert.deepEqual(json.outcomes.by_harness.map((h) => [h.label, h.quiet_percent]), [["Claude Code", 75], ["Codex", 0]]);
});

test("with no data the route says so with nulls and empty lists, never invented numbers", async () => {
  const app = await createApp();
  const { json } = await api(app, "/ui/api/harnesses");
  assert.deepEqual(json.sources, { total: 0, rows: [] });
  assert.deepEqual(json.recalls, { total: 0, empty: 0, by_harness: [] });
  assert.deepEqual(json.used, { since: null, total: 0, by_harness: [] });
  assert.equal(json.outcomes.since, null);
  assert.deepEqual(json.outcomes.windows.map((w) => w.quiet_percent), [null, null]);
});

test("the used list holds titles only and the audit row lists the ids it showed", async () => {
  const app = await createApp();
  const a = await seed(app, { name: "otter-facts", text: "PRIVATE BODY TEXT " + "x".repeat(400), harness: "claude" });
  await logRow(app, a, "claude");
  const res = await raw(app, "/ui/api/harnesses", { jwt: app.browserJwt(ME) });
  const text = await res.text();
  assert.ok(!text.includes("PRIVATE BODY TEXT"));
  assert.ok(!text.includes("x".repeat(100)), "no body text beyond a title");
  const row = await app.env.DB.prepare("SELECT memory_ids FROM audit WHERE route = '/ui/api/harnesses'").first();
  assert.deepEqual(JSON.parse(row.memory_ids), [a]);
});

test("the most used list ranks inside each tool, so a small tool is never crowded out by a big one", async () => {
  const app = await createApp();
  const big = [];
  for (let i = 0; i < 305; i++) big.push(await seed(app, { name: `bulk-${i}`, harness: "codex" }));
  for (const id of big) await logRow(app, id, "codex");
  const small = await seed(app, { name: "only-one-recall", harness: "claude" });
  await logRow(app, small, "claude");
  const { json } = await api(app, "/ui/api/harnesses");
  const byTool = Object.fromEntries(json.used.by_harness.map((h) => [h.harness, h]));
  assert.deepEqual(byTool.claude.top.map((m) => m.id), [small], "the small tool shows its one memory");
  assert.equal(byTool.codex.top.length, 3, "a big tool still shows only its top three");
});

// ------------------------------------------------------------------ memory extras

const save = (app, over = {}, opts = {}) => app.call("/capture", { method: "POST", body: { content: "A note about otters, saved for the test.", ...over }, ...opts });

test("memory extras say who saved a memory, from the audit trail, and which tools were given it", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  app.clock.t += 1000;
  const byDevice = await save(app, { content: "otters hold hands while they sleep" }, { token: device.token, headers: { "x-anymem-script": "hook:capture" } });
  app.clock.t += 1000;
  const byAdmin = await save(app, { content: "badgers dig setts underground" });
  await logRow(app, byDevice.json.id, "codex");
  await logRow(app, byDevice.json.id, "codex");
  await logRow(app, byDevice.json.id, "claude-code");
  const one = (await api(app, `/ui/api/memory-extras?id=${byDevice.json.id}`)).json;
  assert.deepEqual(one.saved_by, { at: one.saved_by.at, by: "laptop", kind: "device", script: "hook:capture" });
  assert.ok(Math.abs(one.saved_by.at - app.clock.t) < 5000);
  assert.deepEqual(one.recalled_by.map((h) => [h.label, h.times]), [["Codex", 2], ["Claude Code", 1]]);
  assert.equal(one.recall_log_since, app.clock.t - DAY);
  const two = (await api(app, `/ui/api/memory-extras?id=${byAdmin.json.id}`)).json;
  assert.deepEqual([two.saved_by.by, two.saved_by.kind], ["The admin token", "admin"]);
  assert.deepEqual(two.recalled_by, []);
});

test("a memory saved before the audit trail reaches back, an import and a later save of the same memory give no saver", async () => {
  const app = await createApp();
  const seeded = await seed(app, { name: "old-one", ageDays: 120 });
  await audit(app, { route: "/capture", method: "POST", memoryIds: [seeded], ts: app.clock.t - DAY });
  const old = (await api(app, `/ui/api/memory-extras?id=${seeded}`)).json;
  assert.equal(old.saved_by, null, "an audit row from long after the memory was saved is not its save");
  const fresh = await save(app, { content: "otters wrap themselves in kelp" });
  app.clock.t += 40 * DAY;
  const again = await save(app, { content: "otters wrap themselves in kelp" });
  assert.equal(again.json.duplicate, true);
  const later = (await api(app, `/ui/api/memory-extras?id=${fresh.json.id}`)).json;
  assert.equal(later.saved_by.kind, "admin", "the first save is the one shown");
});

test("a failed save is not a save, and a device token is not told which device saved a memory", async () => {
  const app = await createApp();
  const first = await save(app, { content: "otters have the densest fur of any animal" });
  const device = (await app.call("/devices", { method: "POST", body: { label: "phone" } })).json;
  const asDevice = await app.call(`/ui/api/memory-extras?id=${first.json.id}`, { token: device.token });
  assert.equal(asDevice.status, 200);
  assert.equal("saved_by" in asDevice.json, false);
  assert.ok(Array.isArray(asDevice.json.recalled_by));
  const refused = await save(app, { content: "token sk-" + "a".repeat(30) });
  assert.equal(refused.status, 422);
  const rows = (await app.env.DB.prepare("SELECT status FROM audit WHERE route = '/capture' ORDER BY id").all()).results.map((r) => r.status);
  assert.deepEqual(rows, [200, 422]);
});

test("a removed device is named as such", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "old laptop" } })).json;
  const made = await save(app, { content: "otters use tools" }, { token: device.token });
  await app.env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(device.device.id).run();
  assert.equal((await api(app, `/ui/api/memory-extras?id=${made.json.id}`)).json.saved_by.by, "A device that was removed");
});

test("the new route needs a browser login or the admin token, and a device token is refused", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  for (const path of ["/ui/api/harnesses", "/ui/api/sources"]) {
    assert.equal((await raw(app, path, {})).status, 401, path);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token })).status, 403, path);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token: ADMIN_TOKEN })).status, 200, path);
  }
  assert.equal((await raw(app, "/ui/api/harnesses", { jwt: app.browserJwt("me@example.com") })).status, 200, "a browser login is let in");
});

test("the light sources route gives the same sources as the harnesses route, without the recall figures", async () => {
  const app = await createApp();
  await seed(app, { name: "a-claude", harness: "claude" });
  await seed(app, { name: "b-blank" });
  const light = await api(app, "/ui/api/sources");
  const full = await api(app, "/ui/api/harnesses");
  assert.deepEqual(light.json.sources, full.json.sources);
  assert.equal(light.json.recalls, undefined);
  assert.equal(light.json.used, undefined);
});
