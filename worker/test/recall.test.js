import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemory } from "../memory/parse.js";
import { fuse, PROBATION_FACTOR, RRF_K } from "../search/recall.js";
import { reindex } from "../search/indexer.js";
import { storeOf } from "./helpers/maintenance.js";
import { appWith, names, note } from "./helpers/search.js";

const DAY = 24 * 60 * 60 * 1000;
const recall = (app, query, extra = "") => app.call(`/recall?query=${encodeURIComponent(query)}${extra}`);

test("the best memory comes first with the full shape, and the content is never cut", async () => {
  const long = note("long-one", "A long memory about sea otters", `${"Sea otters hold hands while they sleep so they do not drift apart. ".repeat(80)}THE END`);
  const { app, ids } = await appWith([long, note("other", "About tax", "Nothing about animals here"), note("third", "About cars", "Engines and wheels")]);
  const res = await recall(app, "which animal holds hands while sleeping, the sea otter");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const top = res.json.results[0];
  assert.equal(top.id, ids[0]);
  assert.deepEqual(Object.keys(top).sort(), ["content", "created_at", "description", "harness", "harness_label", "id", "name", "origin", "project", "relevant", "rerank", "score", "similarity", "status", "tags", "type", "updated_at"]);
  assert.equal(top.content, long, "the whole text, including the end");
  assert.equal(top.name, "long-one");
  assert.equal(typeof top.score, "number");
  assert.equal(typeof top.similarity, "number");
  assert.equal(top.why, undefined);
});

test("explain adds why with the dense score, the dense rank, the keyword rank, the coverage and the keyword terms", async () => {
  const { app, ids } = await appWith([note("zorbax-notes", "Notes on zorbax", "Everything about zorbax devices")]);
  const res = await recall(app, "tell me about the zorbax devices please", "&explain=1");
  const hit = res.json.results[0];
  assert.equal(hit.id, ids[0]);
  assert.deepEqual(Object.keys(hit.why).sort(), ["coverage", "dense_rank", "dense_score", "keyword_rank", "keyword_terms", "query_words"]);
  assert.equal(hit.why.keyword_rank, 1);
  assert.equal(hit.why.query_words, 4, "tell, zorbax, device and please");
  assert.ok(hit.why.coverage > 0 && hit.why.coverage <= 1);
  assert.equal(hit.why.dense_score, hit.similarity);
  assert.equal(hit.why.dense_rank, 1);
  const term = hit.why.keyword_terms.find((t) => t.term === "zorbax");
  assert.deepEqual(Object.keys(term).sort(), ["idf", "level", "term"]);
  assert.equal(term.level, 2);
  assert.equal(typeof res.json.took_ms, "number");
  assert.equal((await recall(app, "tell me about the zorbax devices please")).json.took_ms, undefined);
});

test("reciprocal rank fusion adds one over k plus rank from each list", () => {
  const dense = [{ id: "a", similarity: 0.9 }, { id: "b", similarity: 0.7 }];
  const keyword = [{ id: "b", terms: [{ term: "x", level: 1, idf: 2 }] }, { id: "c", terms: [] }];
  const merged = fuse(dense, keyword);
  assert.equal(merged.get("a").rrf, 1 / (RRF_K + 1));
  assert.equal(merged.get("b").rrf, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  assert.equal(merged.get("c").rrf, 1 / (RRF_K + 2));
  assert.equal(merged.get("c").similarity, null);
  assert.equal(merged.get("b").denseRank, 2);
  assert.deepEqual([...merged.keys()], ["a", "b", "c"]);
});

test("a memory found by both lists beats one found by the better of them alone", async () => {
  const { app, ids } = await appWith([
    note("both", "Quokka habitat", "quokka island habitat rottnest"),
    note("meaning-only", "Marsupials", "quokka island habitat rottnest marsupial smiling animal"),
    note("noise", "Weather", "rain and wind and snow and sun"),
  ]);
  const res = await recall(app, "quokka island habitat rottnest");
  assert.equal(res.json.results[0].id, ids[0]);
});

test("a memory with no vectors yet is still found by keyword, with no similarity", async () => {
  const { app } = await appWith([]);
  await storeOf(app).create({ ...(await parseMemory(note("fresh-note", "Fresh", "a note about narwhals and tusks"))), origin: "explicit" });
  const res = await recall(app, "what do we know about narwhals and tusks");
  assert.deepEqual(names(res), ["fresh-note"]);
  assert.equal(res.json.results[0].similarity, null);
});

test("a memory with several chunks appears once, at its best chunk", async () => {
  const filler = "Unrelated words about accounting and ledgers fill this stretch of text. ".repeat(30);
  const { app, ids } = await appWith([note("multi", "Multi chunk", `${filler}\n\nThe zeppelin hangar opens at dawn.\n\n${filler}`)]);
  const res = await recall(app, "the zeppelin hangar opens at dawn", "&explain=1");
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].id, ids[0]);
  const chunkKeys = (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_keys WHERE memory_id = ? AND key_type = 'chunk'").bind(ids[0]).first()).n;
  assert.ok(chunkKeys >= 2);
});

test("topK defaults to 5, allows up to 50, and refuses other values", async () => {
  const { app } = await appWith(Array.from({ length: 8 }, (_, i) => note(`n${i}`, "d", `shared lynx word number${i}`)));
  assert.equal((await recall(app, "lynx shared word please")).json.results.length, 5);
  assert.equal((await recall(app, "lynx shared word please", "&topK=3")).json.results.length, 3);
  assert.equal((await recall(app, "lynx shared word please", "&topK=50")).json.results.length, 8);
  for (const bad of ["0", "51", "x", "-1"]) assert.equal((await recall(app, "lynx shared word please", `&topK=${bad}`)).status, 400, bad);
});

test("short or empty queries give an empty list, and the cleaned query is returned", async () => {
  const { app } = await appWith([note("n", "d", "ok body")]);
  for (const q of ["ok", "", "<private>hidden things about otters</private>"]) {
    const res = await recall(app, q);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results, []);
  }
  const res = await recall(app, "what is in the ok body? Answer in one sentence.");
  assert.equal(res.json.query, "what is in the ok body?");
  assert.equal((await app.call("/recall")).status, 400);
});

test("only live memories are found: trash, closed, pending", async () => {
  const { app, ids } = await appWith(["gorilla alpha note live", "gorilla beta note trashed", "gorilla gamma note closed", { content: "gorilla delta note pending", tags: ["status:pending"] }, "gorilla epsilon note live2"]);
  await app.call("/forget", { method: "POST", body: { id: ids[1] } });
  await storeOf(app).supersede(ids[2], ids[0], app.clock.t);
  const found = (await recall(app, "gorilla note", "&topK=50")).json.results.map((r) => r.id).sort();
  assert.deepEqual(found, [ids[0], ids[4]].sort());
});

test("as_of shows a closed memory that was valid then, and hides one created later", async () => {
  const { app, ids } = await appWith(["ibis alpha note first"]);
  app.clock.t += DAY;
  const created2 = app.clock.t;
  const second = (await app.call("/capture", { method: "POST", body: { content: "ibis beta note second" } })).json.id;
  app.clock.t += DAY;
  await storeOf(app).supersede(ids[0], second, app.clock.t);
  const asOf = (t) => recall(app, "ibis note please", `&topK=50&as_of=${t}`).then((r) => r.json.results.map((x) => x.id));
  const now = (await recall(app, "ibis note please", "&topK=50")).json.results.map((r) => r.id);
  assert.deepEqual(now, [second]);
  assert.deepEqual((await asOf(created2 + 1)).sort(), [ids[0], second].sort());
  assert.deepEqual(await asOf(created2 - 1), [ids[0]]);
  assert.deepEqual(await asOf(app.clock.t + 1), [second]);
});

test("capsule memories are hidden unless capsule=1", async () => {
  const { app, ids } = await appWith([
    { content: "ferret core rule", tags: ["capsule:core"] },
    { content: "ferret slot rule", tags: ["capsule-slot:identity"] },
    "ferret normal rule",
  ]);
  assert.deepEqual((await recall(app, "ferret rule please", "&topK=50")).json.results.map((r) => r.id), [ids[2]]);
  assert.equal((await recall(app, "ferret rule please", "&topK=50&capsule=1")).json.results.length, 3);
});

test("scope project:<slug> is that project plus global, scope=all and no scope are everything", async () => {
  const { app, ids } = await appWith([
    { content: "walrus global note" },
    { content: "walrus apollo note", tags: ["project:apollo"] },
    { content: "walrus gemini note", tags: ["project:gemini"] },
  ]);
  const got = async (extra) => (await recall(app, "walrus note please", `&topK=50${extra}`)).json.results.map((r) => r.id).sort();
  assert.deepEqual(await got("&scope=project:apollo"), [ids[0], ids[1]].sort());
  assert.deepEqual(await got("&scope=project:Gemini"), [ids[0], ids[2]].sort());
  assert.deepEqual(await got("&scope=project:nothing-here"), [ids[0]]);
  assert.deepEqual(await got("&scope=all"), [...ids].sort());
  assert.deepEqual(await got(""), [...ids].sort());
  for (const bad of ["everything", "project:", "project:has space", "global"]) assert.equal((await recall(app, "walrus note please", `&scope=${encodeURIComponent(bad)}`)).status, 400, bad);
});

test("exclude_ids drops the listed memories", async () => {
  const { app, ids } = await appWith(["badger one note", "badger two note", "badger three note"]);
  const got = (await recall(app, "badger note please", `&topK=50&exclude_ids=${ids[0]},${ids[2]}`)).json.results.map((r) => r.id);
  assert.deepEqual(got, [ids[1]]);
  assert.equal((await recall(app, "badger note please", `&exclude_ids=${Array.from({ length: 201 }, (_, i) => `x${i}`).join(",")}`)).status, 400);
});

test("tag, kind, type, origin, time and recall count filters", async () => {
  const { app, ids } = await appWith([
    { content: note("a", "d", "stoat filter note"), tags: ["red", "blue", "kind:semantic"], origin: "explicit" },
    { content: "stoat filter note two", tags: ["red", "kind:episodic"], origin: "capture" },
    { content: "---\nname: c\ndescription: d\nmetadata:\n  type: feedback\n---\nstoat filter note three", origin: "import" },
  ]);
  const created = (await app.env.DB.prepare("SELECT id, created_at FROM memories").all()).results;
  const at = Object.fromEntries(created.map((r) => [r.id, r.created_at]));
  const got = async (extra) => (await recall(app, "stoat filter note", `&topK=50${extra}`)).json.results.map((r) => ids.indexOf(r.id)).sort();
  assert.deepEqual(await got("&tag=red"), [0, 1]);
  assert.deepEqual(await got("&tag=red&tag=blue"), [0]);
  assert.deepEqual(await got("&tag=missing"), []);
  assert.deepEqual(await got("&kind=episodic"), [1]);
  assert.deepEqual(await got("&type=feedback"), [2]);
  assert.deepEqual(await got("&origin=capture"), [1]);
  assert.deepEqual(await got(`&after=${at[ids[1]]}`), [1, 2]);
  assert.deepEqual(await got(`&before=${at[ids[1]]}`), [0]);
  await app.env.DB.prepare("UPDATE memories SET recall_count = 4 WHERE id = ?").bind(ids[2]).run();
  assert.deepEqual(await got("&min_recalls=3"), [2]);
  assert.deepEqual(await got("&min_recalls=0"), [0, 1, 2]);
  for (const bad of ["&kind=odd", "&type=odd", "&origin=odd", "&after=x", "&min_recalls=-1", "&as_of=x"]) assert.equal((await recall(app, "stoat filter note", bad)).status, 400, bad);
});

test("a captured memory still on probation ranks a small step lower, and not after probation ends", async () => {
  const { app, ids } = await appWith([
    { content: "okapi forest giraffe relative stripes", origin: "capture" },
    { content: "okapi forest giraffe relative", origin: "explicit" },
    "completely unrelated text about spreadsheets and budgets",
  ]);
  const order = async () => (await recall(app, "okapi forest giraffe relative stripes", "&topK=3")).json.results.map((r) => r.id);
  await app.env.DB.prepare("UPDATE memories SET probation_until = NULL").run(); // the write pipeline starts every capture on probation
  assert.equal((await order())[0], ids[0]);
  await app.env.DB.prepare("UPDATE memories SET probation_until = ? WHERE id = ?").bind(app.clock.t + 30 * DAY, ids[0]).run();
  const during = await order();
  assert.equal(during[0], ids[1], "the explicit memory now ranks first");
  assert.equal(during[1], ids[0], "the captured one is only a small step lower");
  const scores = (await recall(app, "okapi forest giraffe relative stripes", "&topK=3")).json.results;
  assert.ok(PROBATION_FACTOR < 1 && PROBATION_FACTOR > 0.9);
  assert.ok(scores[0].score > scores[1].score);
  app.clock.t += 31 * DAY;
  assert.equal((await order())[0], ids[0], "probation over, back on top");
  await app.env.DB.prepare("UPDATE memories SET origin = 'explicit', probation_until = ? WHERE id = ?").bind(app.clock.t + DAY, ids[0]).run();
  assert.equal((await order())[0], ids[0], "only captured memories are held back");
});

// Words found in no memory. They pull the coverage of a hit down so that only the rule under test can make it relevant.
const UNKNOWN = "quillon vexta zymor";

test("relevant by cosine, with RECALL_MIN_SIM moving the cutoff", async () => {
  const text = note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim");
  const { app } = await appWith([text, note("noise", "Other", "completely different topic words here")]);
  app.env.RERANK = "0";
  const query = `tapir facts tapirs eat leaves and swim ${UNKNOWN}`;
  const hit = (await recall(app, query)).json.results[0];
  assert.equal(hit.name, "tapir-facts");
  assert.ok(hit.similarity > 0.6);
  assert.equal(hit.relevant, true);
  app.env.RECALL_MIN_SIM = "0.99";
  assert.equal((await recall(app, query)).json.results[0].relevant, false);
  app.env.RECALL_MIN_SIM = "0.2";
  assert.equal((await recall(app, query)).json.results[0].relevant, true);
});

test("a deprecated memory is still found but never relevant, so a hook does not inject it", async () => {
  const { app, ids } = await appWith([note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim")]);
  app.env.RERANK = "0";
  const query = `tapir facts tapirs eat leaves and swim ${UNKNOWN}`;
  assert.equal((await app.call("/status", { method: "POST", body: { id: ids[0], status: "deprecated" } })).status, 200);
  const hit = (await recall(app, query)).json.results[0];
  assert.equal(hit.id, ids[0]);
  assert.equal(hit.status, "deprecated");
  assert.equal(hit.relevant, false);
});

async function bigStore(extra) {
  // idf only reaches 5 in a store of a few hundred memories, so add fillers directly and index them in two passes.
  const { app, ids } = await appWith(extra);
  const store = storeOf(app);
  for (let i = 0; i < 300; i++) await store.create({ ...(await parseMemory(note(`filler-${i}`, `filler description ${i}`, `filler body ${i} lorem ipsum`))), origin: "import" });
  await reindex(app.env, 200, () => app.clock.t);
  await reindex(app.env, 200, () => app.clock.t);
  return { app, ids };
}

test("relevant by two rare words matched by name, and not by one rare word", async () => {
  const { app, ids } = await bigStore([note("zorbax-quuxlet", "Zorbax and quuxlet", "body text")]);
  app.env.RERANK = "0";
  const pad = "and a great many other unrelated words that dilute the meaning of this whole sentence so that cosine stays low";
  const two = (await recall(app, `zorbax quuxlet ${pad}`, "&explain=1")).json.results[0];
  assert.equal(two.id, ids[0]);
  assert.ok(two.similarity < 0.6, `similarity ${two.similarity} is below the cutoff`);
  assert.equal(two.why.keyword_terms.filter((t) => t.level === 2 && t.idf >= 5).length, 2);
  assert.equal(two.relevant, true, "two rare words");
  const name = (await recall(app, `What about Zorbax ${pad}`, "&explain=1")).json.results[0];
  assert.equal(name.id, ids[0]);
  assert.equal(name.relevant, false, "one rare word is not rare enough here for the name rule (idf under 6 in a store of 300)");
  const plain = (await recall(app, `what about zorbax ${pad}`, "&explain=1")).json.results[0];
  assert.equal(plain.id, ids[0]);
  assert.ok(plain.similarity < 0.6);
  assert.equal(plain.relevant, false, "one plain rare word is not enough");
  const none = (await recall(app, `nothing in common with it ${pad}`)).json.results.every((r) => r.relevant === false);
  assert.equal(none, true, "no cosine, no rare words");
});

test("count defaults to off, and count=1 bumps only the returned memories", async () => {
  const { app, ids } = await appWith(["civet alpha note", "civet beta note", "unrelated chinchilla text here"]);
  const row = (id) => app.env.DB.prepare("SELECT recall_count, last_recalled_at, updated_at FROM memories WHERE id = ?").bind(id).first();
  const before = { 0: await row(ids[0]), 1: await row(ids[1]) };
  await recall(app, "civet note please");
  await recall(app, "civet note please", "&count=0");
  assert.deepEqual(await row(ids[0]), before[0]);
  app.clock.t += 1000;
  const res = await recall(app, "civet note please", "&count=1&topK=2");
  const returned = res.json.results.map((r) => r.id);
  assert.equal(returned.length, 2);
  for (const i of [0, 1]) {
    const r = await row(ids[i]);
    assert.equal(r.recall_count, 1);
    assert.equal(r.last_recalled_at, app.clock.t);
    assert.equal(r.updated_at, before[i].updated_at, "counting leaves updated_at alone");
  }
  assert.equal((await row(ids[2])).recall_count, 0);
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_versions").first()).n, 0, "counting writes no version");
  assert.equal((await recall(app, "civet note please", "&count=2")).status, 400);
});

test("count=1 is ignored for a browser login and still counts for a bearer caller", async () => {
  const { app, ids } = await appWith(["quokka alpha note", "quokka beta note"]);
  const row = (id) => app.env.DB.prepare("SELECT recall_count, last_recalled_at FROM memories WHERE id = ?").bind(id).first();
  const path = `/recall?query=${encodeURIComponent("quokka note please")}&count=1&topK=2`;
  const jwt = app.browserJwt("me@example.com");
  app.clock.t += 1000;
  const asBrowser = await app.call(path, { jwt, token: null });
  assert.equal(asBrowser.status, 200);
  assert.equal(asBrowser.json.results.length, 2, "the search itself still runs");
  for (const id of ids) assert.deepEqual({ ...(await row(id)) }, { recall_count: 0, last_recalled_at: null });
  assert.equal((await app.call(path.replace("count=1", "count=2"), { jwt, token: null })).status, 400, "a bad count value is still refused");
  await app.call(path);
  for (const id of ids) assert.equal((await row(id)).recall_count, 1);
});

test("count=1 bumps only hits marked relevant, not the weak ones the client drops", async () => {
  const { app, ids } = await appWith([note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim"), note("noise", "Other", "completely different topic words here")]);
  app.env.RERANK = "0";
  const row = (id) => app.env.DB.prepare("SELECT recall_count, last_recalled_at FROM memories WHERE id = ?").bind(id).first();
  const query = "tapir facts tapirs eat leaves and swim";
  const both = (await recall(app, query, "&topK=2")).json.results;
  assert.equal(both.length, 2);
  const [strong, weak] = [both.find((r) => r.id === ids[0]), both.find((r) => r.id === ids[1])];
  assert.ok(strong.similarity > weak.similarity);
  app.env.RECALL_MIN_SIM = String((strong.similarity + weak.similarity) / 2);
  app.clock.t += 1000;
  const res = await recall(app, query, "&topK=2&count=1");
  assert.deepEqual(res.json.results.map((r) => [r.id, r.relevant]).sort(), [[ids[0], true], [ids[1], false]].sort());
  assert.equal((await row(ids[0])).recall_count, 1);
  assert.equal((await row(ids[0])).last_recalled_at, app.clock.t);
  assert.deepEqual({ ...(await row(ids[1])) }, { recall_count: 0, last_recalled_at: null }, "a weak hit is left alone");
});

test("count=1 with no relevant hit writes nothing", async () => {
  const { app, ids } = await appWith([note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim")]);
  app.env.RERANK = "0";
  app.env.RECALL_MIN_SIM = "0.99";
  const res = await recall(app, `tapir facts tapirs eat leaves and swim ${UNKNOWN}`, "&count=1");
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].relevant, false);
  const r = await app.env.DB.prepare("SELECT recall_count, last_recalled_at FROM memories WHERE id = ?").bind(ids[0]).first();
  assert.deepEqual({ ...r }, { recall_count: 0, last_recalled_at: null });
});

test("a plain recall writes nothing except its audit row", async () => {
  const { app, ids } = await appWith(["lemming alpha note", note("lemming-b", "d", "lemming beta note")]);
  await app.call("/link", { method: "POST", body: { source_id: ids[0], target_id: ids[1], type: "related" } });
  const tables = ["memories", "memory_tags", "memory_versions", "memory_keys", "memory_fts", "links", "devices", "capsule_cache", "runs", "write_counter", "meta", "recall_log"];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, JSON.stringify((await app.env.DB.prepare(`SELECT * FROM ${t}`).all()).results)])));
  const before = await snapshot();
  const modelCallsBefore = app.env.AI.calls.filter((c) => !c.model.includes("bge")).length;
  const vectors = JSON.stringify([...app.env.VECTORIZE.vectors.keys()]);
  for (const extra of ["", "&explain=1", "&count=0", "&topK=50&capsule=1"]) await recall(app, "lemming note please", extra);
  assert.deepEqual(await snapshot(), before);
  assert.equal(JSON.stringify([...app.env.VECTORIZE.vectors.keys()]), vectors);
  assert.equal(app.env.AI.calls.filter((c) => !c.model.includes("bge")).length, modelCallsBefore);
});

test("the audit row lists the returned ids and no query text", async () => {
  const { app, ids } = await appWith(["meerkat alpha note", "meerkat beta note"]);
  await recall(app, "meerkat note secret-phrase-xyz", "&topK=2");
  const row = await app.env.DB.prepare("SELECT * FROM audit WHERE route = '/recall'").first();
  assert.deepEqual(JSON.parse(row.memory_ids).sort(), [...ids].sort());
  assert.equal(row.method, "GET");
  assert.doesNotMatch(JSON.stringify(row), /secret-phrase/);
});

test("if the vector search fails the keyword results still come back, marked degraded", async () => {
  const { app, ids } = await appWith(["pangolin alpha note"]);
  app.env.VECTORIZE.query = async () => {
    throw new Error("vectorize is down");
  };
  const res = await recall(app, "pangolin alpha note please");
  assert.equal(res.status, 200);
  assert.equal(res.json.degraded, "vector");
  assert.deepEqual(res.json.results.map((r) => r.id), [ids[0]]);
  assert.equal(res.json.results[0].similarity, null);
});

test("a database failure is a 502 with no detail", async () => {
  const { app } = await appWith(["x note"]);
  const real = app.env.DB.batch.bind(app.env.DB);
  app.env.DB.batch = async () => {
    throw new Error("secret internals");
  };
  const res = await recall(app, "what about the x note");
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "recall_failed");
  assert.doesNotMatch(JSON.stringify(res.json), /secret internals/);
  app.env.DB.batch = real;
});

test("auth: a bearer is needed, a device token and a browser login can recall", async () => {
  const { app } = await appWith(["yak alpha note"]);
  const path = `/recall?query=${encodeURIComponent("yak alpha note please")}`;
  assert.equal((await app.call(path, { token: null })).status, 401);
  assert.equal((await app.call(path, { token: "wrong" })).status, 401);
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  assert.equal((await app.call(path, { token: device })).status, 200);
  assert.equal((await app.call(path, { token: null, jwt: app.browserJwt("me@example.com") })).status, 200);
  assert.equal((await app.call(path, { token: null, jwt: app.browserJwt("stranger@example.com") })).status, 403);
  assert.equal((await app.call("/recall?query=x", { method: "POST", body: {} })).status, 405);
});

test("the reranker scores the top hits and decides relevance, without reordering", async () => {
  const { app, ids } = await appWith([note("otter-facts", "Sea otter facts", "otters hold hands when they sleep"), note("car-notes", "Cars", "engines wheels brakes")]);
  const query = `otter facts otters hold hands ${UNKNOWN}`;
  app.env.RECALL_MIN_SIM = "1";
  const res = (await recall(app, query, "&topK=2")).json.results;
  assert.equal(res[0].id, ids[0]);
  assert.ok(res[0].rerank > 0.2 && res[0].relevant === true, "scored and relevant by the reranker alone");
  assert.equal(res[1].relevant, false);
  assert.deepEqual(res.map((r) => r.id), (await recall(app, query, "&topK=2")).json.results.map((r) => r.id));
  app.env.RERANK = "0";
  const off = (await recall(app, query, "&topK=2")).json.results;
  assert.equal(off[0].rerank, undefined);
  assert.equal(off[0].relevant, false, "without the reranker and with a cutoff of 1 only the other rules apply");
  assert.deepEqual(off.map((r) => r.id), res.map((r) => r.id), "the order is the same with and without it");
});

test("a failing reranker leaves the other relevance rules in charge", async () => {
  const { app } = await appWith([note("tapir-facts", "Tapir facts", "tapirs eat leaves and swim")]);
  app.env.AI.reply("@cf/baai/bge-reranker-base", () => {
    throw new Error("down");
  });
  const hit = (await recall(app, "tapir facts tapirs eat leaves and swim")).json.results[0];
  assert.equal(hit.rerank, undefined);
  assert.equal(hit.relevant, true, "cosine still carries it");
});

test("a bare identifier is searched", async () => {
  const { app, ids } = await appWith([note("ticket-note", "A ticket", "the fix for ABC-12027 landed")]);
  const res = await recall(app, "ABC-12027");
  assert.equal(res.json.results[0].id, ids[0]);
});

test("a short lookup of an identifier found in a body is relevant, with no cosine and no reranker, a plain lower case word is not", async () => {
  const { app, ids } = await bigStore([note("ticket-note", "A ticket", "the fix for QX9142 landed last week")]);
  app.env.RERANK = "0";
  const hit = (await recall(app, "QX9142", "&explain=1")).json.results[0];
  assert.equal(hit.id, ids[0]);
  assert.ok(hit.similarity === null || hit.similarity < 0.6, "the meaning search does not carry it");
  assert.ok(hit.why.query_words <= 3 && hit.why.coverage >= 0.6, `covers ${hit.why.coverage}`);
  assert.equal(hit.relevant, true);
});

test("a lookup needs a name shaped word, a plain lower case rare word in the body is not enough", async () => {
  const { app, ids } = await bigStore([note("ticket-note", "A ticket", "the pangolin fix landed last week")]);
  app.env.RERANK = "0";
  const lower = (await recall(app, "pangolin", "&explain=1")).json.results[0];
  assert.equal(lower.id, ids[0]);
  assert.equal(lower.why.coverage, 1);
  assert.equal(lower.relevant, false, "a bare lower case word could be any chat word");
  const named = (await recall(app, "what about Pangolin", "&explain=1")).json.results[0];
  assert.equal(named.id, ids[0]);
  assert.equal(named.relevant, true, "capitalised after the first word reads as a name");
});

test("a rare word in a longer query that is mostly unknown words is not a lookup", async () => {
  const { app, ids } = await bigStore([note("ticket-note", "A ticket", "the fix for QX9142 landed last week")]);
  app.env.RERANK = "0";
  const hit = (await recall(app, "zymor vexta QX9142", "&explain=1")).json.results[0];
  assert.equal(hit.id, ids[0]);
  assert.ok(hit.why.coverage < 0.6, `covers ${hit.why.coverage}`);
  assert.equal(hit.relevant, false, "two of the three words are in no memory");
});
