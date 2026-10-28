// Recall with subjects: the private rule on results, the cards above them, and GET /recall?subject=. All sample text is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexMemories } from "../search/indexer.js";
import { appWith, note } from "./helpers/search.js";
import { addSubject, about, device, wire } from "./helpers/subjects.js";

const SAMPLE = [
  note("vet-visit", "The vet visit", "Pip saw the vet about a limp in the left paw"),
  note("garden-plan", "The garden plan", "Pip digs up the Cottage garden every morning"),
  note("roof-repair", "The roof repair", "The Cottage roof needs new tiles before winter"),
  note("tax-note", "A tax note", "Nothing about any subject"),
];

/** The small world, with the two cards indexed so a search can find them. */
async function world(env = {}) {
  const { app, ids } = await appWith(SAMPLE, { env });
  const w = await wire(app, ids);
  await indexMemories(app.env, [w.pip, w.cottage], () => app.clock.t);
  return { app, w, closed: await device(app, { allowPrivate: false }), open: await device(app, { allowPrivate: true }) };
}
const recall = (app, d, query, extra = "") => app.call(`/recall?query=${encodeURIComponent(query)}${extra}`, { token: d?.token });
const idsOf = (res) => res.json.results.map((r) => r.id);

test("recall gives a device without allow_private no hidden memory and no private card, and still fills top_k", async () => {
  const { app, w, closed, open } = await world();
  const query = "Pip vet limp paw";
  assert.ok(idsOf(await recall(app, open, query)).includes(w.hidden));
  assert.ok(idsOf(await recall(app, undefined, query)).includes(w.hidden), "the admin token sees it too");
  const shut = idsOf(await recall(app, closed, query));
  assert.ok(!shut.includes(w.hidden) && !shut.includes(w.pip));
  assert.ok(shut.includes(w.mixed), "a memory about a shared subject as well stays");
  const all = idsOf(await recall(app, open, query, "&topK=50")).filter((id) => id !== w.hidden && id !== w.pip);
  const two = idsOf(await recall(app, closed, query, "&topK=2"));
  assert.deepEqual(two, all.slice(0, 2), "hiding happens before the cut, so the page is full and the order is the same");
  assert.deepEqual(idsOf(await recall(app, closed, "Cottage roof tiles")), idsOf(await recall(app, open, "Cottage roof tiles")).filter((id) => id !== w.hidden && id !== w.pip));
});

test("a hidden memory takes no rank: a closed device sees the same order and scores as if it did not exist", async () => {
  const query = "Pip vet limp paw";
  const { app, closed } = await world();
  // The same store without the vet note and the private Pip card. The visible Cottage card stays.
  const bare = await appWith(SAMPLE.filter((s) => !s.includes("vet-visit")));
  await indexMemories(bare.app.env, [await addSubject(bare.app, { slug: "cottage", kind: "asset", name: "the Cottage" })], () => bare.app.clock.t);
  const shown = async (a, d) => (await recall(a, d, query, "&topK=50")).json.results.map((r) => [r.name, r.score, r.similarity]);
  const without = await shown(bare.app);
  assert.ok(without.length > 1, "there are several visible results to compare");
  assert.deepEqual(await shown(app, closed), without);
});

test("without SUBJECTS on, the reply has no subjects key", async () => {
  for (const env of [{}, { SUBJECTS: "off" }]) {
    const { app } = await world(env);
    const res = await recall(app, undefined, "Cottage roof tiles");
    assert.equal("subjects" in res.json, false, JSON.stringify(env));
    assert.equal(res.json.results[0].name, "roof-repair");
  }
});

test("with SUBJECTS on, the cards the relevant results are about come after the results with their via ids", async () => {
  const { app, w } = await world({ SUBJECTS: "on" });
  const res = await recall(app, undefined, "Pip digs up the Cottage garden");
  const relevant = res.json.results.filter((r) => r.relevant).map((r) => r.id);
  assert.ok(relevant.includes(w.mixed));
  assert.deepEqual(res.json.subjects.map((s) => s.slug).sort(), ["cottage", "pip"]);
  const pip = res.json.subjects.find((s) => s.slug === "pip");
  assert.deepEqual(Object.keys(pip).sort(), ["brief", "fields", "id", "kind", "name", "slug", "via"]);
  assert.equal(pip.id, w.pip);
  assert.equal(pip.name, "Pip");
  assert.equal(pip.kind, "pet");
  assert.equal(pip.brief, "Brief of Pip.");
  assert.deepEqual(pip.fields, {});
  assert.ok(pip.via.length > 0 && pip.via.every((id) => relevant.includes(id)), "reached only through relevant results");
  assert.ok(pip.via.includes(w.mixed));
  assert.equal(res.json.subjects.find((s) => s.slug === "cottage").name, "the Cottage");
  // The results are the same as without the cards.
  const plain = await app.call(`/recall?query=${encodeURIComponent("Pip digs up the Cottage garden")}`);
  assert.deepEqual(idsOf(res), idsOf(plain));
  assert.deepEqual(res.json.results.map((r) => r.score), plain.json.results.map((r) => r.score));
});

test("a device without allow_private is shown no private card, and one with allow_private 1 is", async () => {
  const { app, w, closed, open } = await world({ SUBJECTS: "on" });
  const query = "Pip digs up the Cottage garden";
  assert.deepEqual((await recall(app, closed, query)).json.subjects.map((s) => s.slug), ["cottage"]);
  assert.deepEqual((await recall(app, open, query)).json.subjects.map((s) => s.slug).sort(), ["cottage", "pip"]);
  // A memory about the private subject alone is hidden, so it cannot lead to the card either.
  const vet = await recall(app, closed, "Pip vet limp paw");
  assert.ok(!vet.json.subjects.some((s) => s.id === w.pip));
});

test("only active and stale subjects are shown, at most two, and showing a card counts no recall", async () => {
  const { app, w } = await world({ SUBJECTS: "on" });
  const db = app.env.DB;
  const alpha = await addSubject(app, { slug: "alpha", kind: "project", name: "Alpha" });
  const beta = await addSubject(app, { slug: "beta", kind: "project", name: "Beta", status: "stale" });
  const gone = await addSubject(app, { slug: "retired-one", kind: "project", name: "Old", status: "retired" });
  for (const card of [alpha, beta, gone]) await about(app, w.shared, card);
  const query = "The Cottage roof needs new tiles before winter";
  const shown = (await recall(app, undefined, query)).json.subjects;
  assert.equal(shown.length, 2, "never more than two");
  assert.ok(!shown.some((s) => s.slug === "retired-one"));
  await db.prepare("UPDATE subjects SET status = 'retired' WHERE id IN (?, ?)").bind(alpha, beta).run();
  assert.deepEqual((await recall(app, undefined, query)).json.subjects.map((s) => s.slug), ["cottage"]);
  const before = (await db.prepare("SELECT recall_count FROM memories WHERE id IN (?, ?) ORDER BY id").bind(w.cottage, w.pip).all()).results;
  await recall(app, undefined, query, "&count=1");
  assert.deepEqual((await db.prepare("SELECT recall_count FROM memories WHERE id IN (?, ?) ORDER BY id").bind(w.cottage, w.pip).all()).results, before);
});

test("the cards add one query to a recall, and the private rule one query for a device", async () => {
  const { app } = await world();
  const real = app.env.DB;
  let queries = 0;
  app.env.DB = { prepare: (sql) => (queries++, real.prepare(sql)), batch: (s) => real.batch(s), exec: (sql) => real.exec(sql) };
  const cost = async (token, query = "Pip digs up the Cottage garden") => {
    queries = 0;
    await app.call(`/recall?query=${encodeURIComponent(query)}`, { token });
    return queries;
  };
  const off = await cost();
  app.env.SUBJECTS = "on";
  assert.equal((await cost()) - off, 1);
  app.env.SUBJECTS = undefined;
  const closed = await device(app, { allowPrivate: false });
  // An empty query returns before the rule runs, so it shows what a device costs over the admin token anyway: its token lookup and model slot.
  const overhead = (await cost(closed.token, "")) - (await cost(undefined, ""));
  assert.equal((await cost(closed.token)) - off, overhead + 1);
});

test("GET /recall?subject= gives the members newest first without scores, whatever SUBJECTS says", async () => {
  const { app, w } = await world();
  app.clock.t += 1000;
  await app.call("/append", { method: "POST", body: { id: w.shared, addition: "A later line." } });
  const res = await app.call("/recall?subject=cottage");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.query, null);
  assert.equal(res.json.subject.slug, "cottage");
  assert.equal(res.json.subject.id, w.cottage);
  assert.equal(res.json.subject.brief, "Brief of the Cottage.");
  assert.deepEqual(idsOf(res), [w.shared, w.mixed], "newest first");
  assert.deepEqual(Object.keys(res.json.results[0]).sort(), ["content", "created_at", "description", "harness", "harness_label", "id", "name", "origin", "project", "status", "tags", "type", "updated_at"]);
  assert.match(res.json.results[0].content, /A later line/);
  assert.deepEqual(idsOf(await app.call("/recall?subject=cottage&topK=1")), [w.shared], "capped by topK");
  app.env.SUBJECTS = "on";
  assert.equal((await app.call("/recall?subject=cottage")).status, 200);
});

test("GET /recall?subject= is a 404 for no subject, a bad slug, and a private subject a device may not see", async () => {
  const { app, w, closed, open } = await world();
  assert.equal((await app.call("/recall?subject=nobody")).status, 404);
  assert.equal((await app.call("/recall?subject=Not%20A%20Slug")).status, 404);
  const shut = await app.call("/recall?subject=pip", { token: closed.token });
  assert.equal(shut.status, 404);
  assert.deepEqual(shut.json, (await app.call("/recall?subject=nobody", { token: closed.token })).json, "the same reply as a missing subject");
  assert.deepEqual(idsOf(await app.call("/recall?subject=pip", { token: open.token })).sort(), [w.hidden, w.mixed].sort());
  assert.deepEqual(idsOf(await app.call("/recall?subject=pip")).sort(), [w.hidden, w.mixed].sort());
  assert.deepEqual(idsOf(await app.call("/recall?subject=cottage", { token: closed.token })).sort(), [w.mixed, w.shared].sort());
});

test("GET /recall?subject= leaves out a trashed member and a trashed card is not found", async () => {
  const { app, w } = await world();
  await app.call("/forget", { method: "POST", body: { id: w.shared } });
  assert.deepEqual(idsOf(await app.call("/recall?subject=cottage")), [w.mixed]);
  await app.call("/forget", { method: "POST", body: { id: w.cottage } });
  assert.equal((await app.call("/recall?subject=cottage")).status, 404);
});
