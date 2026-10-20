// The neighbour check while Vectorize is still catching up. The real index shows a new vector about two minutes after the
// upsert, so these tests use a Vectorize fake with that delay. All sample text is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { FakeVectorize } from "./helpers/fakes.js";
import { findNeighbours, RECENT_MS } from "../write/neighbours.js";
import { parseMemory } from "../memory/parse.js";
import { NEW_FACT, NEW_WINS, OLD_FACT, QUIET, TEN, TEN_NINE, counter, distinct, liveCount, put, scriptModel } from "./helpers/write.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const LAG = 2 * MINUTE;

/** An app whose Vectorize shows new vectors only after LAG, with a scripted model. */
async function lagging(answers = {}) {
  const app = await createApp();
  app.env.VECTORIZE = new FakeVectorize({ delay: LAG, now: () => app.clock.t });
  const model = scriptModel(app.env.AI, { ...QUIET, ...answers });
  return { app, model };
}

const probe = async (app, text) => findNeighbours(app.env, await parseMemory(text, []), () => app.clock.t);

test("the fake index really hides a new vector until the lag has passed", async () => {
  const { app } = await lagging();
  await put(app, TEN);
  const vector = (await app.env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [TEN] })).data[0];
  assert.equal((await app.env.VECTORIZE.query(vector, { topK: 5 })).matches.length, 0);
  app.clock.t += LAG;
  assert.ok((await app.env.VECTORIZE.query(vector, { topK: 5 })).matches.length > 0);
});

test("a near duplicate written seconds after its match still gets warning similar", async () => {
  const { app } = await lagging();
  const first = (await put(app, TEN)).json;
  app.clock.t += 25 * SECOND;
  const res = (await put(app, TEN_NINE)).json;
  assert.equal(res.warning, "similar");
  assert.equal(res.matchId, first.id);
  assert.ok(res.score > 0.85 && res.score < 0.95);
  assert.equal(await counter(app, "conflicts.similar_warning"), 1);
});

test("a contradiction written seconds after the fact it corrects replaces it, and the old one stays readable", async () => {
  const { app } = await lagging({ "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS });
  const old = (await put(app, OLD_FACT)).json;
  app.clock.t += 25 * SECOND;
  const res = (await put(app, NEW_FACT)).json;
  assert.deepEqual(res.replaced, { id: old.id, reason: "contradiction" });
  const closed = (await app.call(`/entry?id=${old.id}`)).json.entry;
  assert.notEqual(closed.valid_until, null);
  assert.equal(closed.superseded_by, res.id);
  assert.equal(await liveCount(app), 1);
});

test("a pinned neighbour is kept, never replaced, even when it is too new for the index", async () => {
  const { app } = await lagging({ "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS });
  const old = (await put(app, OLD_FACT, { source: "profile" })).json;
  app.clock.t += 25 * SECOND;
  const res = (await put(app, NEW_FACT)).json;
  assert.deepEqual(res.kept_both, { id: old.id, reason: "pinned" });
  assert.equal(await liveCount(app), 2);
});

test("an unrelated memory gets no warning and no model call", async () => {
  const { app, model } = await lagging({ "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS });
  await put(app, distinct(1));
  app.clock.t += 25 * SECOND;
  const res = (await put(app, distinct(2))).json;
  assert.deepEqual(Object.keys(res).sort(), ["id", "ok", "status", "tags"]);
  assert.equal(model.calls("contradiction-detect").length, 0);
});

test("a batch of proposals written together compares its members with each other", async () => {
  const { app } = await lagging();
  const a = (await put(app, distinct(1))).json;
  app.clock.t += 2 * SECOND;
  const b = (await put(app, TEN)).json;
  app.clock.t += 2 * SECOND;
  const c = (await put(app, TEN_NINE)).json;
  assert.equal(a.warning, undefined);
  assert.equal(b.warning, undefined);
  assert.equal(c.warning, "similar");
  assert.equal(c.matchId, b.id);
});

test("an exact reorder written seconds later is refused as a near duplicate", async () => {
  const { app } = await lagging();
  const first = (await put(app, TEN)).json;
  app.clock.t += 5 * SECOND;
  const res = (await put(app, TEN.split(" ").reverse().join(" "))).json;
  assert.deepEqual(res, { ok: true, duplicate: true, matchId: first.id, score: 1 });
});

test("after the lag and past the recent window the index alone finds the neighbour", async () => {
  const { app } = await lagging();
  const first = (await put(app, TEN)).json;
  app.clock.t += RECENT_MS + MINUTE;
  const found = await probe(app, TEN_NINE);
  assert.equal(found[0].id, first.id);
  assert.ok(found[0].similarity > 0.85);
});

test("a memory in the trash is not a neighbour, recent or not", async () => {
  const { app } = await lagging();
  const first = (await put(app, TEN)).json;
  await app.call("/forget", { method: "POST", body: { id: first.id } });
  assert.deepEqual(await probe(app, TEN_NINE), []);
});

test("at most 20 recent memories are compared, newest first", async () => {
  const { app } = await lagging();
  for (let i = 0; i < 25; i++) {
    await put(app, distinct(100 + i));
    app.clock.t += SECOND;
  }
  const found = await probe(app, distinct(100));
  assert.equal(found.length, 10, "the result is cut to the limit");
  assert.ok(!found.some((n) => n.content === distinct(100)), "the oldest of 25 is outside the 20 compared");
});
