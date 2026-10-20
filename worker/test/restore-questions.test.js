// A restore must bring the likely question keys back, with vectors, so a memory can still be found by its question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { fakeEmbedding } from "./helpers/fakes.js";
import { restore, rows } from "./helpers/maintenance.js";
import { QUESTION_MODEL } from "../search/questions.js";
import { appWith, note } from "./helpers/search.js";

const post = (app, path, body) => app.call(path, { method: "POST", body });
const questionKeys = (app, id) => rows(app, "SELECT position, text, vector_id FROM memory_keys WHERE memory_id = ? AND key_type = 'question' ORDER BY position", id);

async function reindexAll(app) {
  for (let i = 0; i < 20; i++) if ((await post(app, "/admin/reindex", { limit: 50 })).json.remaining === 0) return;
  throw new Error("reindex did not finish");
}

test("import with questions, then reindex, keeps the question keys, embeds them and finds the memory by its question", async () => {
  const source = await appWith([note("sleep-habits", "Habits", "They link paws on the water.")]).then(async ({ app, ids }) => {
    app.env.AI.reply(QUESTION_MODEL, { response: { questions: ["Why do otters never drift apart?", "Do otters sleep in groups?"] } });
    await post(app, "/admin/questions", {});
    await reindexAll(app);
    return { app, id: ids[0] };
  });
  const doc = (await source.app.call("/export")).json;
  assert.equal(doc.questions.length, 2);

  const fresh = await createApp();
  const [reply] = await restore(fresh, doc);
  assert.equal(reply.questions, 2);
  assert.deepEqual((await questionKeys(fresh, source.id)).map((k) => k.vector_id), [null, null], "an import leaves the questions waiting for vectors");

  await reindexAll(fresh);
  const keys = await questionKeys(fresh, source.id);
  assert.deepEqual(keys.map((k) => [k.position, k.text, k.vector_id]), [
    [0, "Why do otters never drift apart?", `${source.id}:question:0`],
    [1, "Do otters sleep in groups?", `${source.id}:question:1`],
  ]);
  for (const k of keys) assert.ok(fresh.env.VECTORIZE.vectors.has(k.vector_id), `${k.vector_id} is in the index`);
  const hit = await fresh.env.VECTORIZE.query(fakeEmbedding("Why do otters never drift apart?"), { topK: 1 });
  assert.equal(hit.matches[0].id, `${source.id}:question:0`);
  assert.equal(hit.matches[0].metadata.memory_id, source.id);
  const found = await fresh.call(`/recall?query=${encodeURIComponent("why do otters never drift apart")}`);
  assert.equal(found.json.results[0].id, source.id);
});

async function withQuestions(items, questions) {
  const { app, ids } = await appWith(items);
  app.env.AI.reply(QUESTION_MODEL, { response: { questions } });
  await post(app, "/admin/questions", {});
  await reindexAll(app);
  return { app, ids };
}

test("a reindex keeps the time a question was written", async () => {
  const { app, ids } = await withQuestions([note("n", "d", "body about otters")], ["Where do otters sleep at night?"]);
  const before = await rows(app, "SELECT created_at FROM memory_keys WHERE memory_id = ? AND key_type = 'question'", ids[0]);
  app.clock.t += 60_000;
  await post(app, "/append", { id: ids[0], addition: "more about otters" });
  await reindexAll(app);
  assert.deepEqual(await rows(app, "SELECT created_at FROM memory_keys WHERE memory_id = ? AND key_type = 'question'", ids[0]), before);
});

test("a memory in the trash keeps its question rows, without vectors, and gets them back with vectors on restore", async () => {
  const { app, ids } = await withQuestions([note("n", "d", "body about otters")], ["Where do otters sleep at night?"]);
  const id = ids[0];
  await post(app, "/forget", { id });
  assert.deepEqual((await questionKeys(app, id)).map((k) => [k.text, k.vector_id]), [["Where do otters sleep at night?", null]]);
  assert.deepEqual([...app.env.VECTORIZE.vectors.keys()].filter((v) => v.startsWith(`${id}:`)), [], "the trash has no vectors");
  assert.equal((await post(app, "/admin/reindex", { limit: 50 })).json.remaining, 0, "a trashed memory with only question rows is not waiting");
  await post(app, "/restore", { id });
  assert.deepEqual((await questionKeys(app, id)).map((k) => k.vector_id), [`${id}:question:0`]);
  assert.ok(app.env.VECTORIZE.vectors.has(`${id}:question:0`));
});

test("a trashed memory with questions survives export, import and reindex", async () => {
  const { app, ids } = await withQuestions([note("n", "d", "body about otters")], ["Where do otters sleep at night?"]);
  await post(app, "/forget", { id: ids[0] });
  const doc = (await app.call("/export")).json;
  assert.equal(doc.questions.length, 1, "the export carries the questions of a trashed memory");
  const fresh = await createApp();
  await restore(fresh, doc);
  await reindexAll(fresh);
  assert.deepEqual((await questionKeys(fresh, ids[0])).map((k) => k.text), ["Where do otters sleep at night?"]);
  await post(fresh, "/restore", { id: ids[0] });
  assert.deepEqual((await questionKeys(fresh, ids[0])).map((k) => k.vector_id), [`${ids[0]}:question:0`]);
});
