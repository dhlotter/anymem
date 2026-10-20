import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemory } from "../memory/parse.js";
import { countPending, indexMemories, reindex } from "../search/indexer.js";
import { EMBEDDING_MODEL } from "../search/embed.js";
import { appWith, note } from "./helpers/search.js";
import { seed, storeOf } from "./helpers/maintenance.js";

const keysOf = async (app, id) => (await app.env.DB.prepare("SELECT key_type, position, text, vector_id FROM memory_keys WHERE memory_id = ? ORDER BY key_type, position").bind(id).all()).results;
const vectorsOf = (app, id) => [...app.env.VECTORIZE.vectors.keys()].filter((v) => v.startsWith(`${id}:`)).sort();
const embedCalls = (app) => app.env.AI.calls.filter((c) => c.model === EMBEDDING_MODEL).length;
const post = (app, path, body) => app.call(path, { method: "POST", body });

test("a new memory gets a chunk key and a description key with deterministic vector ids", async () => {
  const { app, ids } = await appWith([{ content: note("deploy-notes", "How the worker deploys", "Use wrangler with the temp config."), origin: "capture", project: "demo" }]);
  const keys = await keysOf(app, ids[0]);
  assert.deepEqual(keys.map((k) => [k.key_type, k.position, k.vector_id]), [["chunk", 0, `${ids[0]}:chunk:0`], ["description", 0, `${ids[0]}:description:0`]]);
  assert.match(keys[0].text, /deploy-notes/);
  assert.equal(keys[1].text, "How the worker deploys");
  assert.deepEqual(vectorsOf(app, ids[0]), [`${ids[0]}:chunk:0`, `${ids[0]}:description:0`]);
  assert.deepEqual(app.env.VECTORIZE.vectors.get(`${ids[0]}:chunk:0`).metadata, { memory_id: ids[0], project: "demo", origin: "capture" });
  assert.equal((await app.call("/stats")).json.unvectorized, 0);
});

test("a memory that is only frontmatter is keyed on its content, so nothing waits for a reindex forever", async () => {
  const { app, ids } = await appWith(["---\ntype: user\n---"]);
  assert.deepEqual((await keysOf(app, ids[0])).map((k) => [k.key_type, k.text]), [["chunk", "---\ntype: user\n---"]]);
  assert.equal(await countPending(app.env.DB), 0);
  assert.equal((await app.call("/stats")).json.unvectorized, 0);
});

test("a memory with no description has no description key, a long one has several chunks", async () => {
  const { app, ids } = await appWith(["plain text without frontmatter", `${"A sentence about hedgehogs and their habits. ".repeat(120)}`]);
  assert.deepEqual((await keysOf(app, ids[0])).map((k) => k.key_type), ["chunk"]);
  const long = await keysOf(app, ids[1]);
  assert.ok(long.length >= 3);
  assert.deepEqual(long.map((k) => k.position), long.map((_, i) => i));
  assert.equal(vectorsOf(app, ids[1]).length, long.length);
});

test("update replaces the keys and the vectors, and drops chunks that are gone", async () => {
  const { app, ids } = await appWith([`${"The first long text about otters. ".repeat(120)}`]);
  const before = (await keysOf(app, ids[0])).length;
  assert.ok(before >= 3);
  const res = await post(app, "/update", { id: ids[0], content: note("short", "Now short", "tiny") });
  assert.equal(res.status, 200);
  const keys = await keysOf(app, ids[0]);
  assert.deepEqual(keys.map((k) => k.key_type), ["chunk", "description"]);
  assert.deepEqual(vectorsOf(app, ids[0]), [`${ids[0]}:chunk:0`, `${ids[0]}:description:0`], "vectors of the removed chunks are deleted");
  assert.equal((await countPending(app.env.DB)), 0);
});

test("append, undo and a project change rebuild the keys", async () => {
  const { app, ids } = await appWith([note("n", "d", "original")]);
  const id = ids[0];
  await post(app, "/append", { id, addition: "an appended fact about lemurs" });
  assert.match((await keysOf(app, id))[0].text, /lemurs/);
  assert.deepEqual(app.env.VECTORIZE.vectors.get(`${id}:chunk:0`).values.length, 384);
  await post(app, "/undo", { id });
  assert.doesNotMatch((await keysOf(app, id))[0].text, /lemurs/);
  await post(app, "/update", { id, tags: ["project:apollo"] });
  assert.equal(app.env.VECTORIZE.vectors.get(`${id}:chunk:0`).metadata.project, "apollo");
  assert.equal(await countPending(app.env.DB), 0);
});

test("the search text of the keyword index follows the memory too", async () => {
  const { app, ids } = await appWith([note("n", "d", "original")]);
  await post(app, "/update", { id: ids[0], content: note("n", "d", "something about wombats") });
  const rows = (await app.env.DB.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH '\"wombats\"'").all()).results;
  assert.deepEqual(rows.map((r) => r.memory_id), [ids[0]]);
});

test("a status change does not embed again", async () => {
  const { app, ids } = await appWith([note("n", "d", "body")]);
  const calls = embedCalls(app);
  const res = await post(app, "/status", { id: ids[0], status: "canonical" });
  assert.equal(res.status, 200);
  assert.equal(embedCalls(app), calls);
  assert.equal(await countPending(app.env.DB), 0);
});

test("forget removes the keys and the vectors, restore creates them again", async () => {
  const { app, ids } = await appWith([note("n", "d", "body about capybaras")]);
  const id = ids[0];
  await post(app, "/forget", { id });
  assert.deepEqual(await keysOf(app, id), []);
  assert.deepEqual(vectorsOf(app, id), []);
  assert.equal(await countPending(app.env.DB), 0, "a trashed memory with no keys is not waiting");
  await post(app, "/restore", { id });
  assert.equal((await keysOf(app, id)).length, 2);
  assert.deepEqual(vectorsOf(app, id).length, 2);
});

test("supersede keeps the keys and the vectors, so the closed memory can be searched as of a time", async () => {
  const { app, ids } = await appWith([note("old", "d", "old fact"), note("new", "d", "new fact")]);
  await storeOf(app).supersede(ids[0], ids[1], app.clock.t);
  await indexMemories(app.env, [ids[0]], () => app.clock.t);
  assert.equal((await keysOf(app, ids[0])).length, 2);
  assert.equal(vectorsOf(app, ids[0]).length, 2);
  assert.equal(await countPending(app.env.DB), 0);
});

test("a change made without the routes leaves a marker that stats shows and reindex clears", async () => {
  const { app, ids } = await appWith([note("n", "d", "first text")]);
  await storeOf(app).update({ id: ids[0], content: note("n", "d", "second text about marmots") });
  assert.equal((await keysOf(app, ids[0])).every((k) => k.vector_id === null), true, "the vector ids are cleared in the change's own batch");
  assert.equal((await app.call("/stats")).json.unvectorized, 1);
  const res = await post(app, "/admin/reindex", {});
  assert.deepEqual(res.json, { ok: true, processed: 1, remaining: 0 });
  assert.match((await keysOf(app, ids[0]))[0].text, /marmots/);
  assert.equal((await app.call("/stats")).json.unvectorized, 0);
});

test("a write still succeeds when embedding fails, and the memory waits for the next reindex", async () => {
  const { app } = await appWith([]);
  app.env.AI.reply(EMBEDDING_MODEL, () => {
    throw new Error("ai is down");
  });
  const res = await post(app, "/capture", { content: note("n", "d", "body") });
  assert.equal(res.status, 200);
  assert.equal((await app.call("/stats")).json.unvectorized, 1);
  assert.equal((await post(app, "/admin/reindex", {})).status, 502);
  app.env.AI.replies.delete(EMBEDDING_MODEL);
  assert.deepEqual((await post(app, "/admin/reindex", {})).json, { ok: true, processed: 1, remaining: 0 });
});

test("reindex drains in pages and reports what is left", async () => {
  const { app } = await appWith([]);
  const store = storeOf(app);
  for (let i = 0; i < 7; i++) await store.create({ ...(await parseMemory(note(`m${i}`, `d${i}`, `body ${i}`))), origin: "import" });
  assert.equal(await countPending(app.env.DB), 7);
  assert.deepEqual((await post(app, "/admin/reindex", { limit: 3 })).json, { ok: true, processed: 3, remaining: 4 });
  assert.deepEqual((await post(app, "/admin/reindex", { limit: 3 })).json, { ok: true, processed: 3, remaining: 1 });
  assert.deepEqual((await post(app, "/admin/reindex", { limit: 3 })).json, { ok: true, processed: 1, remaining: 0 });
  assert.deepEqual((await post(app, "/admin/reindex", {})).json, { ok: true, processed: 0, remaining: 0 });
  assert.equal(app.env.VECTORIZE.vectors.size, 14);
  assert.equal((await app.call("/stats")).json.unvectorized, 0);
});

test("reindex cleans up a memory that was trashed while its keys were stale", async () => {
  const { app, ids } = await appWith([note("n", "d", "body")]);
  await storeOf(app).softDelete(ids[0]);
  assert.equal(await countPending(app.env.DB), 1);
  await reindex(app.env, 10, () => app.clock.t);
  assert.deepEqual(vectorsOf(app, ids[0]), []);
  assert.deepEqual(await keysOf(app, ids[0]), []);
  assert.equal(await countPending(app.env.DB), 0);
});

test("a change that lands while a memory is being indexed is not overwritten", async () => {
  const { app, ids } = await appWith([note("n", "d", "first text")]);
  const store = storeOf(app);
  await store.update({ id: ids[0], content: note("n", "d", "second text") });
  let hit = false;
  const real = app.env.AI.run.bind(app.env.AI);
  app.env.AI.run = async (model, input) => {
    if (!hit) {
      hit = true;
      app.clock.t += 10;
      await store.update({ id: ids[0], content: note("n", "d", "third text about quails") });
    }
    return real(model, input);
  };
  await indexMemories(app.env, [ids[0]], () => app.clock.t);
  assert.match((await keysOf(app, ids[0]))[0].text, /quails/);
  assert.equal(await countPending(app.env.DB), 0);
  const stored = app.env.VECTORIZE.vectors.get(`${ids[0]}:chunk:0`).values;
  const { fakeEmbedding } = await import("./helpers/fakes.js");
  assert.deepEqual(stored, fakeEmbedding((await keysOf(app, ids[0]))[0].text));
});

test("indexing twice is harmless, and an unknown id does nothing", async () => {
  const { app, ids } = await appWith([note("n", "d", "body")]);
  const calls = embedCalls(app);
  await indexMemories(app.env, [ids[0], ids[0], "no-such-id"], () => app.clock.t);
  assert.equal(embedCalls(app), calls);
  assert.equal(app.env.VECTORIZE.vectors.size, 2);
});

test("a memory whose vector ids Vectorize refuses does not hold back the rest of its batch, and is reported as failed", async () => {
  const { app } = await appWith([]);
  const a = await seed(app, { name: "first", text: "alpha body text", ageDays: 3 });
  const long = await seed(app, { name: "long-id", id: "L".repeat(60), text: "long body text", ageDays: 2 });
  const c = await seed(app, { name: "third", text: "gamma body text", ageDays: 1 });
  assert.deepEqual(await post(app, "/admin/reindex", {}).then((r) => r.json), { ok: true, processed: 2, remaining: 1, failed: 1 });
  assert.ok(app.env.VECTORIZE.vectors.has(`${a}:chunk:0`), "the memory before it is indexed");
  assert.ok(app.env.VECTORIZE.vectors.has(`${c}:chunk:0`), "the memory after it is indexed");
  assert.deepEqual(await keysOf(app, long), [], "the refused memory keeps no new keys");
  assert.deepEqual(vectorsOf(app, long), []);
  assert.equal(await countPending(app.env.DB), 1, "the refused memory waits");
});

test("when Vectorize is down the call still fails, after one refused upsert and no retry for every memory", async () => {
  const { app } = await appWith([]);
  for (let i = 0; i < 4; i++) await seed(app, { name: `down-${i}`, text: `zq${i} words here` });
  let upserts = 0;
  app.env.VECTORIZE.upsert = async () => {
    upserts++;
    throw new Error("vectorize is down");
  };
  app.env.VECTORIZE.describe = async () => {
    throw new Error("vectorize is down");
  };
  await assert.rejects(reindex(app.env, 10, () => app.clock.t), /vectorize is down/);
  assert.equal(upserts, 2, "the batch, then the first memory alone, then describe says the index is down");
  assert.equal(await countPending(app.env.DB), 4, "nothing was indexed, so every memory waits");
});

test("reindex takes a limit of 1 to 200 and refuses others", async () => {
  const { app } = await appWith([]);
  for (const limit of [0, 201, -1, 1.5, "5"]) assert.equal((await post(app, "/admin/reindex", { limit })).status, 400, String(limit));
  assert.equal((await post(app, "/admin/reindex", { limit: 200 })).status, 200);
});

test("a memory that changed mid-pass leaves no vector behind for a key the new text does not have", async () => {
  const { app, ids } = await appWith([note("n", "d", "word ".repeat(500))]);
  assert.equal((await keysOf(app, ids[0])).filter((k) => k.key_type === "chunk").length, 2, "the long text has two chunks");
  const store = storeOf(app);
  let hit = false;
  const real = app.env.AI.run.bind(app.env.AI);
  app.env.AI.run = async (model, input) => {
    if (!hit) {
      hit = true;
      app.clock.t += 10;
      await store.update({ id: ids[0], content: note("n", "d", "short text now") });
    }
    return real(model, input);
  };
  await indexMemories(app.env, [ids[0]], () => app.clock.t);
  const current = (await keysOf(app, ids[0])).map((k) => k.vector_id).sort();
  assert.deepEqual(vectorsOf(app, ids[0]), current, "every vector belongs to a key row, so purge can find it");
  assert.equal(await countPending(app.env.DB), 0);
});
