import { test } from "node:test";
import assert from "node:assert/strict";
import { idf, keywordSearch, queryTerms, stem } from "../search/fts.js";
import { newStore } from "./helpers/memories.js";

const hitsOf = async (...args) => (await keywordSearch(...args)).hits;
const note = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

test("stemming keeps at least four letters", () => {
  assert.equal(stem("deployed"), "deploy");
  assert.equal(stem("deploying"), "deploy");
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("costs"), "cost");
  assert.equal(stem("charges"), "charg");
  assert.equal(stem("string"), "string");
  assert.equal(stem("class"), "class");
  assert.equal(stem("bed"), "bed");
});

test("query terms drop stop words, short words and repeats", () => {
  assert.deepEqual(queryTerms("How do we deploy the Worker to Cloudflare, and deploy it again?"), ["deploy", "worker", "cloudflare"]);
  assert.deepEqual(queryTerms("S3 is on AWS"), ["aws"]);
  assert.deepEqual(queryTerms("the and of"), []);
  assert.equal(queryTerms(Array.from({ length: 40 }, (_, i) => `word${i}x`).join(" ")).length, 16);
  assert.deepEqual(queryTerms("ABC-12027 and OAuth2"), ["abc", "12027", "oauth2"]);
});

test("idf is high for a rare word and low for a common one", () => {
  assert.ok(idf(1000, 1) > 6);
  assert.ok(idf(1000, 500) < 1);
  assert.ok(idf(1000, 1) > idf(1000, 10));
  assert.ok(idf(10, 10) > 0, "never negative");
});

test("a rare word scores higher than a common one, and the level says where it matched", async () => {
  const { add, db } = await newStore();
  const a = await add(note("zebra-crossing", "Where the zebra crossing is", "The road has a marking."));
  const b = await add(note("road-notes", "Notes about roads", "A zebra was seen near the road."));
  for (let i = 0; i < 12; i++) await add(note(`filler-${i}`, "Filler", "The road is long and the road is wide."));
  const hits = await hitsOf(db, "zebra road");
  assert.equal(hits[0].id, a.id, "name hit on the rare word wins");
  const byId = Object.fromEntries(hits.map((h) => [h.id, h]));
  const zebraA = byId[a.id].terms.find((t) => t.term === "zebra");
  const zebraB = byId[b.id].terms.find((t) => t.term === "zebra");
  assert.equal(zebraA.level, 2, "name or description hit is level 2");
  assert.equal(zebraB.level, 1, "body hit is level 1");
  const road = byId[b.id].terms.find((t) => t.term === "road");
  assert.ok(zebraA.idf > road.idf, "the rare word has the higher idf");
  assert.equal(zebraA.idf, zebraB.idf, "idf is per word, not per hit");
});

test("a word in the description is level 2, a word only in the extra keys is level 1", async () => {
  const { add, db } = await newStore();
  const m = await add(note("plain", "mentions quokka here", "nothing else"));
  const k = await add(note("other", "x", "y"));
  await db.prepare("INSERT INTO memory_keys (memory_id, key_type, text, created_at) VALUES (?, 'question', 'what is a wombat', 1)").bind(k.id).run();
  await db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(k.id).run();
  await db.prepare("INSERT INTO memory_fts (memory_id, name, description, body, keys) VALUES (?, 'other', 'x', 'y', 'what is a wombat')").bind(k.id).run();
  assert.equal((await hitsOf(db, "quokka"))[0].terms[0].level, 2);
  const w = await hitsOf(db, "wombat");
  assert.equal(w[0].id, k.id);
  assert.equal(w[0].terms[0].level, 1);
  assert.ok(m.id);
});

test("a word matches inside longer words, and a stemmed query finds the plain word", async () => {
  const { add, db } = await newStore();
  const m = await add(note("pipelines", "Deployment pipelines", "We deploy every day."));
  assert.equal((await hitsOf(db, "deployed"))[0].id, m.id);
  assert.equal((await hitsOf(db, "pipeline"))[0].id, m.id);
});

test("no terms, no matches, and a trashed memory give nothing", async () => {
  const { add, db, store } = await newStore();
  const m = await add(note("gone", "d", "a unique platypus note"));
  assert.deepEqual(await hitsOf(db, "the and of"), []);
  assert.deepEqual(await hitsOf(db, "nothing matches xylophone"), []);
  assert.equal((await hitsOf(db, "platypus")).length, 1);
  await store.softDelete(m.id);
  assert.deepEqual(await hitsOf(db, "platypus"), []);
});

test("at most the top 50 are returned, best first, with a stable order for ties", async () => {
  const { add, db } = await newStore();
  for (let i = 0; i < 60; i++) await add(note(`n${i}`, "d", `shared marmot text number ${i}`));
  const hits = await hitsOf(db, "marmot", { limit: 50 });
  assert.equal(hits.length, 50);
  assert.deepEqual(hits.map((h) => h.id), [...hits.map((h) => h.id)].sort());
  assert.equal((await hitsOf(db, "marmot", { limit: 5 })).length, 5);
});

test("quotes and operators in the query cannot break the match expression", async () => {
  const { add, db } = await newStore();
  const m = await add(note("q", "d", "a normal note about gadgets"));
  const hits = await hitsOf(db, 'what "about" NEAR( AND OR * gadgets"');
  assert.deepEqual(hits.map((h) => h.id), [m.id]);
});

test("a match inside a longer identifier ranks below the identifier as its own word", async () => {
  const { add, db } = await newStore();
  const inside = await add(note("order-lookup", "Order lookup notes", "The order B07ACR84189 shipped late."));
  const own = await add(note("rent-plan", "Rent plan", "Pay R84 to the landlord on time."));
  const hits = await hitsOf(db, "R84");
  assert.deepEqual(hits.map((h) => h.id), [own.id, inside.id]);
  assert.ok(hits[0].score > hits[1].score);
});

test("a match in the case the person typed ranks above the same letters in another case", async () => {
  const { add, db } = await newStore();
  const lower = await add(note("connection-notes", "How to connect", "A connector links two systems."));
  const typed = await add(note("airbyte-icons", "Icons", "Open the Connector builder and save."));
  const hits = await hitsOf(db, "Connector");
  assert.equal(hits[0].id, typed.id);
  assert.ok(hits.some((h) => h.id === lower.id));
});

test("a plain lowercase word is not rescored by case", async () => {
  const { add, db } = await newStore();
  const a = await add(note("one", "d", "A zebra stands here."));
  const b = await add(note("two", "d", "The Zebra is capitalised here."));
  const hits = await hitsOf(db, "zebra");
  assert.equal(hits.find((h) => h.id === a.id).score, hits.find((h) => h.id === b.id).score);
});

test("coverage is the share of the idf of all query words that a hit matched, unknown words count in full", async () => {
  const { add, db } = await newStore();
  const a = await add(note("zebra crossing", "d", "a unique quagga note"));
  for (let i = 0; i < 20; i++) await add(note(`filler ${i}`, "d", `plain text number ${i}`));
  const one = await keywordSearch(db, "zebra");
  assert.equal(one.words, 1);
  assert.equal(one.hits[0].id, a.id);
  assert.ok(Math.abs(one.hits[0].coverage - 1) < 1e-9, "the only word is matched");
  const two = await keywordSearch(db, "zebra xylophone");
  assert.equal(two.words, 2);
  const unknown = idf(21, 0);
  const matched = idf(21, 1);
  assert.ok(Math.abs(two.hits[0].coverage - matched / (matched + unknown)) < 1e-9, "a word found nowhere still counts");
  assert.ok(two.hits[0].coverage < 0.5);
  assert.deepEqual(await keywordSearch(db, "the and of"), { hits: [], words: 0 });
});

test("the idf of a word in more memories than the match cap is counted exactly, not capped at the cap", async () => {
  const { add, db } = await newStore();
  await add(note("rare-one", "The rare word lives here", "xylophone"));
  for (let i = 0; i < 1010; i++) await add(note(`common-${i}`, "Common", `the road number ${i}`));
  const { hits } = await keywordSearch(db, "road");
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL").first()).n;
  const road = hits[0].terms.find((t) => t.term === "road");
  assert.equal(road.idf, idf(n, 1010), "1010 memories hold the word, not the 1000 the id list is capped at");
});
