import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeys, chunkText, memoryIdOf, memoryText, vectorId } from "../search/chunk.js";

test("empty and short text", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n "), []);
  assert.deepEqual(chunkText("  one short note  "), ["one short note"]);
  const exact = "x".repeat(1600);
  assert.deepEqual(chunkText(exact), [exact]);
});

test("a long text is cut at a blank line when one is in reach", () => {
  const para = (c) => `${c}`.repeat(700);
  const text = `${para("a")}\n\n${para("b")}\n\n${para("c")}`;
  const chunks = chunkText(text);
  assert.equal(chunks[0], `${para("a")}\n\n${para("b")}`, "the cut is at the blank line after the second paragraph, the last one that fits");
  assert.equal(chunks[1], para("c"), "a paragraph with no word boundary in the overlap starts the next chunk clean");
  assert.ok(chunks.every((c) => c.length <= 1600));
  assert.ok(chunks.length >= 2);
});

test("with no blank line the cut falls after a sentence", () => {
  const sentence = "This is one sentence of about fifty characters. ";
  const text = sentence.repeat(60);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks.slice(0, -1)) assert.match(c, /\.$/);
  assert.ok(chunks.every((c) => c.length <= 1600));
});

test("with no sentence end the cut falls at whitespace, and with no whitespace it is hard", () => {
  const words = "word ".repeat(700);
  const chunks = chunkText(words);
  assert.ok(chunks.every((c) => c.length <= 1600));
  for (const c of chunks) assert.ok(/^word/.test(c) && /word$/.test(c), "chunks start and end on whole words");
  const solid = "x".repeat(4000);
  const hard = chunkText(solid);
  assert.deepEqual(hard.map((c) => c.length <= 1600), hard.map(() => true));
  assert.ok(hard.length >= 3);
  assert.ok(hard.join("").length >= 4000, "every character is in some chunk");
});

test("neighbouring chunks overlap by about 200 characters and nothing is lost", () => {
  const text = Array.from({ length: 400 }, (_, i) => `token${i}`).join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (let i = 1; i < chunks.length; i++) {
    const shared = chunks[i].split(" ").filter((w) => chunks[i - 1].split(" ").includes(w));
    assert.ok(shared.length > 0, `chunk ${i} shares words with chunk ${i - 1}`);
    const tail = chunks[i - 1].slice(-260);
    assert.ok(tail.includes(chunks[i].split(" ")[0]), "the next chunk starts inside the last 260 characters of the previous one");
  }
  const seen = new Set(chunks.flatMap((c) => c.split(" ")));
  for (let i = 0; i < 400; i++) assert.ok(seen.has(`token${i}`), `token${i} is kept`);
});

test("custom sizes are honoured and progress is always made", () => {
  const chunks = chunkText("abcdefghij ".repeat(30), 50, 10);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 50));
  assert.ok(chunkText("a".repeat(100), 10, 10).length > 1, "overlap as large as the size still ends");
});

test("memoryText joins name, description and body, and buildKeys adds the description key", () => {
  assert.equal(memoryText({ name: "n", description: "d", body: "b" }), "n\n\nd\n\nb");
  assert.equal(memoryText({ name: "", description: "", body: "only body" }), "only body");
  const keys = buildKeys({ name: "n", description: "A description.", body: "b" });
  assert.deepEqual(keys.map((k) => [k.key_type, k.position]), [["chunk", 0], ["description", 0]]);
  assert.equal(keys[1].text, "A description.");
  assert.deepEqual(buildKeys({ name: "", description: "", body: "x" }).map((k) => k.key_type), ["chunk"]);
  const long = buildKeys({ name: "", description: "", body: "word ".repeat(800) });
  assert.deepEqual(long.map((k) => k.position), long.map((_, i) => i));
});

test("vector ids are deterministic and map back to the memory", () => {
  const id = "6f0f6d28-3c6e-4d52-9d62-0a1b2c3d4e5f";
  assert.equal(vectorId(id, "chunk", 2), `${id}:chunk:2`);
  assert.ok(vectorId(id, "description", 0).length <= 64);
  for (const type of ["chunk", "description", "question"]) assert.equal(memoryIdOf(vectorId(id, type, 3)), id);
  assert.equal(memoryIdOf(vectorId("old:style", "chunk", 0)), "old:style");
});
