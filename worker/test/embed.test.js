import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMENSIONS, EMBEDDING_MODEL, embedTexts } from "../search/embed.js";
import { FakeAI, fakeEmbedding } from "./helpers/fakes.js";

test("texts are embedded in batches of 50 and the order is kept", async () => {
  const ai = new FakeAI();
  const texts = Array.from({ length: 120 }, (_, i) => `text number ${i}`);
  const out = await embedTexts(ai, texts);
  assert.equal(out.length, 120);
  assert.deepEqual(ai.calls.map((c) => c.input.text.length), [50, 50, 20]);
  assert.ok(ai.calls.every((c) => c.model === EMBEDDING_MODEL));
  assert.deepEqual(out[77], fakeEmbedding("text number 77"));
  assert.equal(out[0].length, DIMENSIONS);
});

test("no texts means no call", async () => {
  const ai = new FakeAI();
  assert.deepEqual(await embedTexts(ai, []), []);
  assert.equal(ai.calls.length, 0);
});

test("a reply with the wrong shape is an error", async () => {
  const ai = new FakeAI();
  ai.reply(EMBEDDING_MODEL, { data: [[1, 2, 3]] });
  await assert.rejects(embedTexts(ai, ["a"]), /unexpected shape/);
  ai.reply(EMBEDDING_MODEL, { data: [] });
  await assert.rejects(embedTexts(ai, ["a"]), /unexpected shape/);
  ai.reply(EMBEDDING_MODEL, {});
  await assert.rejects(embedTexts(ai, ["a"]), /unexpected shape/);
});
