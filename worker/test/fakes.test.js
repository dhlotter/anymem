import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeAI, FakeR2, FakeVectorize, fakeEmbedding } from "./helpers/fakes.js";

test("fake embeddings are stable and similar texts are close", async () => {
  assert.deepEqual(fakeEmbedding("hello world"), fakeEmbedding("hello world"));
  const v = new FakeVectorize();
  await v.upsert([
    { id: "a", values: fakeEmbedding("deploy the worker to cloudflare"), metadata: { project: "x" } },
    { id: "b", values: fakeEmbedding("my dog likes long walks"), metadata: { project: "y" } },
  ]);
  const top = await v.query(fakeEmbedding("deploy worker cloudflare"), { topK: 1 });
  assert.equal(top.matches[0].id, "a");
  const filtered = await v.query(fakeEmbedding("deploy worker cloudflare"), { topK: 5, filter: { project: "y" } });
  assert.deepEqual(filtered.matches.map((m) => m.id), ["b"]);
  assert.equal((await v.describe()).vectorCount, 2);
  await v.deleteByIds(["a"]);
  assert.equal((await v.describe()).vectorCount, 1);
});

test("the fake refuses a vector id over 64 bytes on upsert and on delete, and the whole call changes nothing", async () => {
  const v = new FakeVectorize();
  const ok = "a".repeat(64);
  const long = "b".repeat(65);
  await v.upsert([{ id: ok, values: fakeEmbedding("first") }]);
  await assert.rejects(v.upsert([{ id: "c", values: fakeEmbedding("second") }, { id: long, values: fakeEmbedding("third") }]), /64 bytes/);
  assert.equal((await v.describe()).vectorCount, 1, "the good id in the refused call was not stored");
  await assert.rejects(v.deleteByIds([ok, long]), /64 bytes/);
  assert.equal((await v.describe()).vectorCount, 1, "nothing was deleted");
  await assert.rejects(v.upsert([{ id: "é".repeat(33), values: fakeEmbedding("fourth") }]), /64 bytes/, "66 bytes in UTF-8, though 33 characters");
  await v.upsert([{ id: "é".repeat(32), values: fakeEmbedding("fifth") }]);
  assert.equal((await v.describe()).vectorCount, 2, "64 bytes is allowed");
});

test("fake AI answers embeddings and canned replies", async () => {
  const ai = new FakeAI();
  const out = await ai.run("@cf/baai/bge-small-en-v1.5", { text: ["one", "two"] });
  assert.equal(out.data.length, 2);
  ai.reply("model-x", (input) => ({ response: input.prompt.toUpperCase() }));
  assert.deepEqual(await ai.run("model-x", { prompt: "hi" }), { response: "HI" });
  await assert.rejects(ai.run("unknown", {}));
  assert.equal(ai.calls.length, 3);
});

test("fake R2 stores, lists with prefix and cursor, keeps metadata and deletes", async () => {
  const r2 = new FakeR2();
  await r2.put("backups/a.json", "{}", { customMetadata: { entries: "3" } });
  await r2.put("backups/b.json", new Uint8Array([1, 2, 3]));
  await r2.put("backups/c.json", "c");
  await r2.put("other/b", "x");
  const first = await r2.list({ prefix: "backups/", limit: 2 });
  assert.deepEqual(first.objects.map((o) => o.key), ["backups/a.json", "backups/b.json"]);
  assert.equal(first.truncated, true);
  assert.equal(first.objects[0].customMetadata, undefined, "metadata only comes back when asked for");
  const second = await r2.list({ prefix: "backups/", limit: 2, cursor: first.cursor });
  assert.deepEqual(second.objects.map((o) => o.key), ["backups/c.json"]);
  assert.equal(second.truncated, false);
  const withMeta = await r2.list({ prefix: "backups/", include: ["customMetadata"] });
  assert.deepEqual(withMeta.objects[0].customMetadata, { entries: "3" });
  assert.equal(await (await r2.get("backups/a.json")).text(), "{}");
  assert.equal((await r2.head("backups/b.json")).size, 3);
  assert.equal(await r2.get("nope"), null);
  await r2.delete("backups/a.json");
  await r2.delete(["backups/b.json", "backups/c.json"]);
  assert.equal((await r2.list()).objects.length, 1);
});
