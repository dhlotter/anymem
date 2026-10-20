import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../memory/store.js";
import { appWith, note } from "./helpers/search.js";
import { DAY, runNightly, seed } from "./helpers/maintenance.js";
import { RETENTION_MS } from "../audit.js";

const recall = (app, query, extra = "", opts = {}) => app.call(`/recall?query=${encodeURIComponent(query)}${extra}`, opts);
const log = async (app) => (await app.env.DB.prepare("SELECT ts, harness, memory_id FROM recall_log ORDER BY ts, memory_id").all()).results.map((r) => ({ ...r }));

test("a counted recall writes one row per relevant memory, with the time and the harness, and nothing else", async () => {
  const { app, ids } = await appWith(["civet alpha note", "civet beta note", "unrelated chinchilla text here"]);
  app.clock.t += 1000;
  const res = await recall(app, "civet note please", "&count=1&topK=2", { headers: { "x-anymem-harness": "codex" } });
  assert.equal(res.json.results.length, 2);
  assert.deepEqual(await log(app), [...ids.slice(0, 2)].sort().map((id) => ({ ts: app.clock.t, harness: "codex", memory_id: id })));
  const columns = (await app.env.DB.prepare("PRAGMA table_info(recall_log)").all()).results.map((c) => c.name);
  assert.deepEqual(columns, ["ts", "harness", "memory_id"], "no query text, no prompt, nothing but the three facts");
  app.clock.t += 1000;
  await recall(app, "civet note please", "&count=1&topK=2");
  assert.deepEqual((await log(app)).filter((r) => r.ts === app.clock.t).map((r) => r.harness), ["", ""], "a call that named no harness is blank");
});

test("a known alias is logged under its id, and an unknown name as written", async () => {
  const { app } = await appWith(["wombat alpha note"]);
  for (const name of ["claude-code", "Antigravity", "some-new-tool"]) {
    app.clock.t += 1000;
    await recall(app, "wombat note please", "&count=1", { headers: { "x-anymem-harness": name } });
  }
  assert.deepEqual((await log(app)).map((r) => r.harness), ["claude", "agy", "some-new-tool"]);
});

test("a plain recall, count=0, a browser login and a recall with no relevant hit write no row", async () => {
  const { app } = await appWith([note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim")]);
  app.env.RERANK = "0";
  await recall(app, "tapir facts tapirs eat leaves and swim");
  await recall(app, "tapir facts tapirs eat leaves and swim", "&count=0");
  await recall(app, "tapir facts tapirs eat leaves and swim", "&count=1", { jwt: app.browserJwt("me@example.com"), token: null });
  app.env.RECALL_MIN_SIM = "0.99";
  const weak = await recall(app, "tapir facts tapirs eat leaves and swim zzqxj", "&count=1");
  assert.equal(weak.json.results[0].relevant, false);
  assert.deepEqual(await log(app), []);
});

test("a failed log write never undoes the recall count", async () => {
  const { app, ids } = await appWith(["quokka alpha note"]);
  await app.env.DB.exec("DROP TABLE recall_log");
  const res = await recall(app, "quokka note please", "&count=1");
  assert.equal(res.status, 200);
  assert.equal((await app.env.DB.prepare("SELECT recall_count FROM memories WHERE id = ?").bind(ids[0]).first()).recall_count, 1);
});

test("deleting a memory removes its rows, and the trash purge does too", async () => {
  const app = (await appWith(["lemming alpha note", "lemming beta note"])).app;
  const store = createStore(app.env.DB, () => app.clock.t);
  const [a, b] = (await app.env.DB.prepare("SELECT id FROM memories ORDER BY id").all()).results.map((r) => r.id);
  for (const id of [a, b]) await app.env.DB.prepare("INSERT INTO recall_log (ts, harness, memory_id) VALUES (?, 'claude', ?)").bind(app.clock.t, id).run();
  await store.softDelete(a);
  app.clock.t += 15 * DAY;
  await runNightly(app, { steps: ["purge_trash"] });
  assert.deepEqual((await log(app)).map((r) => r.memory_id), [b]);
  await app.env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(b).run();
  assert.deepEqual(await log(app), [], "the foreign key cascades too");
});

test("the nightly job deletes rows older than 90 days and keeps the rest", async () => {
  const { createApp } = await import("./helpers/app.js");
  const app = await createApp();
  const id = await seed(app, { name: "kept" });
  const put = (age) => app.env.DB.prepare("INSERT INTO recall_log (ts, harness, memory_id) VALUES (?, 'claude', ?)").bind(app.clock.t - age, id).run();
  await put(RETENTION_MS + 1000);
  await put(RETENTION_MS - 1000);
  await put(0);
  const out = await runNightly(app, { steps: ["purge_old"] });
  assert.equal(out.summary.purge_old.recall_log, 1);
  assert.equal((await log(app)).length, 2);
});
