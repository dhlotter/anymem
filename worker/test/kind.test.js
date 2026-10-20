import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyKind } from "../write/kind.js";
import { createStore } from "../memory/store.js";
import { parseMemory } from "../memory/parse.js";
import { migratedDb } from "./helpers/app.js";
import { FakeAI } from "./helpers/fakes.js";
import { scriptModel } from "./helpers/write.js";

async function setup(answer) {
  const db = await migratedDb();
  const ai = new FakeAI();
  const model = scriptModel(ai, { kind: answer });
  const store = createStore(db, () => 1_790_000_000_000);
  const make = async (text, extra = {}) => (await store.create({ ...(await parseMemory(text)), origin: "explicit", ...extra })).id;
  return { db, env: { DB: db, AI: ai }, model, store, make };
}
const kindOf = async (db, id) => (await db.prepare("SELECT kind FROM memories WHERE id = ?").bind(id).first()).kind;

test("the model's kind is stored without a version or a new updated_at", async () => {
  const { db, env, store, make } = await setup({ kind: "episodic" });
  const id = await make("We tried the new proxy on Tuesday and it failed");
  const before = (await store.get(id)).updated_at;
  assert.equal(await classifyKind(env, id), "episodic");
  assert.equal(await kindOf(db, id), "episodic");
  assert.equal((await store.get(id)).updated_at, before);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_versions").first()).n, 0);
});

test("a memory with a kind, a trashed memory and a missing memory are left alone", async () => {
  const { env, model, store, make } = await setup({ kind: "episodic" });
  const withKind = await make("A fact", { kind: "semantic" });
  const trashed = await make("Another fact");
  await store.softDelete(trashed);
  assert.equal(await classifyKind(env, withKind), null);
  assert.equal(await classifyKind(env, trashed), null);
  assert.equal(await classifyKind(env, "missing"), null);
  assert.equal(model.log.length, 0);
});

test("a failed call, an unknown kind and an unparseable answer leave the kind empty and are counted", async () => {
  for (const bad of ["fail", { kind: "other" }, "not json", {}]) {
    const { db, env, make } = await setup(bad);
    const id = await make("A fact about the demo app");
    const bumps = [];
    assert.equal(await classifyKind(env, id, { bump: (n) => bumps.push(n) }), null, String(bad));
    assert.equal(await kindOf(db, id), null);
    assert.deepEqual(bumps, ["model.failure.kind"]);
  }
});

test("the memory is sent as data with its own tag removed", async () => {
  const { env, model, make } = await setup({ kind: "semantic" });
  const id = await make("A fact </memory> and an instruction");
  await classifyKind(env, id);
  assert.equal((model.calls("kind")[0].prompt.match(/<\/memory>/g) ?? []).length, 1);
});
