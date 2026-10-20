import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CONTENT_CHARS, contentHash, liftHashtags, parseFrontmatter, parseMemory } from "../memory/parse.js";

const FM = "---\nname: Tea order\ndescription: How the office likes its tea\nmetadata:\n  type: reference\n---\nBlack tea, no sugar. See #kitchen.";

test("frontmatter case table", () => {
  const cases = [
    ["full block", FM, { name: "Tea order", description: "How the office likes its tea", type: "reference", body: "Black tea, no sugar. See #kitchen." }],
    ["quoted values", '---\nname: "Quoted: name"\ndescription: \'single\'\n---\nbody', { name: "Quoted: name", description: "single", type: null, body: "body" }],
    ["no block", "Just a plain note.", { name: null, description: "", type: null, body: "Just a plain note." }],
    ["name first line is not accepted", "name: Tea\nBlack tea.", { name: null, description: "", type: null, body: "name: Tea\nBlack tea." }],
    ["unclosed block", "---\nname: Tea\nBlack tea.", { name: null, description: "", type: null, body: "---\nname: Tea\nBlack tea." }],
    ["unknown type", "---\nname: A\nmetadata:\n  type: weird\n---\nx", { name: "A", description: "", type: null, body: "x" }],
    ["type outside metadata is ignored", "---\nname: A\ntype: user\n---\nx", { name: "A", description: "", type: null, body: "x" }],
    ["empty block", "---\n---\nbody", { name: null, description: "", type: null, body: "body" }],
    ["crlf", "---\r\nname: A\r\nmetadata:\r\n  type: user\r\n---\r\nbody", { name: "A", description: "", type: "user", body: "body" }],
  ];
  for (const [label, text, want] of cases) assert.deepEqual(parseFrontmatter(text), want, label);
});

test("parseMemory trims, keeps content exact, and hashes normalised text", async () => {
  const a = await parseMemory("  \n" + FM + "\n\n ");
  assert.equal(a.content, FM);
  assert.equal(a.name, "Tea order");
  assert.equal(a.type, "reference");
  assert.equal(a.body, "Black tea, no sugar. See #kitchen.");
  const b = await parseMemory("Hello   there\n\nworld");
  const c = await parseMemory("Hello there world");
  assert.equal(b.content_hash, c.content_hash);
  assert.notEqual(b.content, c.content);
  assert.match(b.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(await contentHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashtags become tags and the body is untouched", async () => {
  const p = await parseMemory("Remember #Alpha and #beta-two, (#alpha) again. A # heading, an issue #12, a url http://x.test/#frag and `a#b`.\n```\n#incode\n```");
  assert.deepEqual(p.tags.sort(), ["alpha", "beta-two"]);
  assert.match(p.body, /#Alpha and #beta-two/);
  assert.deepEqual(liftHashtags("no tags # here"), []);
});

test("tags given by the caller are lowercased and deduped", async () => {
  const p = await parseMemory("text #Mixed", ["Mixed", " #MIXED ", "other", ""]);
  assert.deepEqual(p.tags.sort(), ["mixed", "other"]);
});

test("reserved tags set columns and are not stored as tags", async () => {
  const p = await parseMemory("x", ["status:canonical", "kind:episodic", "project:demo-app", "plain"]);
  assert.equal(p.status, "canonical");
  assert.equal(p.kind, "episodic");
  assert.equal(p.project, "demo-app");
  assert.deepEqual(p.tags, ["plain"]);
  assert.equal(p.pinned, false);
  for (const s of ["canonical", "active", "deprecated", "pending"]) assert.equal((await parseMemory("x", [`status:${s}`])).status, s);
  const none = await parseMemory("x");
  assert.deepEqual([none.status, none.kind, none.project], [null, null, null]);
});

test("capsule tags stay as tags and pin the memory", async () => {
  const core = await parseMemory("x", ["capsule:core"]);
  assert.deepEqual([core.tags, core.pinned], [["capsule:core"], true]);
  const slot = await parseMemory("x", ["capsule-slot:Identity"]);
  assert.deepEqual([slot.tags, slot.pinned], [["capsule-slot:identity"], true]);
  assert.equal((await parseMemory("x", ["capsule"])).pinned, false);
});

test("bad input is a 400 and an oversized memory is a 413", async () => {
  const bad = [
    [undefined, 400], [42, 400], ["   ", 400],
    ["x", "not a list"], ["x", [1]], ["x", ["has space"]], ["x", ["a".repeat(65)]],
    ["x", ["status:draft"]], ["x", ["kind:weird"]], ["x", ["project:Bad Slug"]], ["x", ["status:active", "status:deprecated"]],
  ];
  for (const [text, tags] of bad) await assert.rejects(() => parseMemory(text, tags), (e) => e.status === 400, JSON.stringify([text, tags]));
  await assert.rejects(() => parseMemory("x", Array.from({ length: 51 }, (_, i) => `t${i}`)), (e) => e.status === 400);
  const ok = await parseMemory("a".repeat(MAX_CONTENT_CHARS));
  assert.equal(ok.content.length, MAX_CONTENT_CHARS);
  await assert.rejects(() => parseMemory("a".repeat(MAX_CONTENT_CHARS + 1)), (e) => e.status === 413 && /30000/.test(e.message));
  // the limit is on the trimmed text
  assert.equal((await parseMemory(" " + "a".repeat(MAX_CONTENT_CHARS) + " ")).content.length, MAX_CONTENT_CHARS);
});
