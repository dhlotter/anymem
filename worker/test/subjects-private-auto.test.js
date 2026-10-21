// The private rule against the automatic steps: a device kept from private subjects must never learn that one exists, and
// must never see a memory that belongs to one, however the system links, proposes or retires. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { addSubject, about, device } from "./helpers/subjects.js";
import { put, scriptModel, QUIET } from "./helpers/write.js";
import { parseMemory } from "../memory/parse.js";
import { createStore } from "../memory/store.js";
import { createCounters } from "../counters.js";
import { afterSubjects } from "../subjects/after.js";
import { assignMemory } from "../subjects/assign.js";
import { createProposed } from "../subjects/propose.js";
import { recallSubject } from "../search/recall.js";

const ON = { SUBJECTS: "on", SUBJECTS_AUTO: "on" };
const now = () => 1_790_000_000_000;
const status = async (app, id, d) => (await app.call(`/entry?id=${id}`, { token: d.token })).status;
const links = async (app, id, d) => (await app.call(`/links?id=${id}`, d ? { token: d.token } : {})).json.links;
/** A memory straight into the store, so the write path has not linked it to anything. @returns {Promise<string>} the id */
const plain = async (app, text) => (await createStore(app.env.DB, () => app.clock.t).create({ ...(await parseMemory(text)), origin: "capture" })).id;
const subjectRows = async (app) => (await app.env.DB.prepare("SELECT slug, status FROM subjects ORDER BY slug").all()).results.map((r) => ({ ...r }));

// ---------------------------------------------------------------- S1: no way to probe for a private subject

test("a closed device's hint makes no proposal and no link, so a private name and a free name look the same", async () => {
  const app = await createApp({ env: ON });
  await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const probe = async (name) => {
    const r = await put(app, `${name} is on my mind today, a note about ${name}.`, { subject: { name, kind: "pet" } }, { token: closed.token });
    assert.equal(r.status, 200);
    return { links: await links(app, r.json.id, closed), listed: (await app.call("/subjects?status=proposed", { token: closed.token })).json.subjects };
  };
  const hit = await probe("Pip");
  const miss = await probe("Rex");
  assert.deepEqual(hit, miss);
  assert.deepEqual(miss, { links: [], listed: [] });
  assert.deepEqual(await subjectRows(app), [{ slug: "pip", status: "active" }], "the device made no proposal at all");
});

test("a device that may see private subjects still proposes from a hint", async () => {
  const app = await createApp({ env: ON });
  const open = await device(app, { allowPrivate: true });
  const r = await put(app, "Rex is a dog we met at the park.", { subject: { name: "Rex", kind: "pet" } }, { token: open.token });
  assert.equal(r.status, 200);
  assert.deepEqual(await subjectRows(app), [{ slug: "rex", status: "proposed" }]);
});

test("a device whose row cannot be found is treated as closed by the hint step", async () => {
  const app = await createApp({ env: ON });
  const id = (await put(app, "Rex is a dog we met at the park.")).json.id;
  const counters = createCounters(app.env.DB, now);
  await afterSubjects(app.env, { id, content: "Rex is a dog we met at the park.", hint: { name: "Rex", kind: "pet" }, actor: { kind: "device", id: "no-such-device" }, now, counters });
  assert.deepEqual(await subjectRows(app), []);
});

test("a proposal is invisible to a closed device in every read, and visible to the admin and to an open device", async () => {
  const app = await createApp({ env: ON });
  const memory = (await put(app, "Rex is a dog we met at the park.", { subject: { name: "Rex", kind: "pet" } })).json.id;
  const card = (await app.env.DB.prepare("SELECT id FROM subjects WHERE slug = 'rex'").first()).id;
  const closed = await device(app, { allowPrivate: false });
  const open = await device(app, { allowPrivate: true, label: "desk" });
  const as = (d, path) => app.call(path, d ? { token: d.token } : {});

  assert.equal((await as(closed, "/subjects?status=proposed")).json.subjects.length, 0);
  assert.equal((await as(closed, "/subjects")).json.subjects.length, 0);
  assert.equal((await as(closed, "/subject?slug=rex")).status, 404);
  assert.equal((await as(closed, `/subject?id=${card}`)).status, 404);
  assert.equal((await as(closed, `/entry?id=${card}`)).status, 404);
  assert.equal((await as(closed, `/links?id=${card}`)).status, 404);
  assert.equal((await as(closed, `/history?id=${card}`)).status, 404);
  assert.deepEqual(await links(app, memory, closed), [], "the memory does not name the card it is evidence for");
  assert.equal((await as(closed, `/entry?id=${memory}`)).status, 200, "the memory itself is an ordinary one");
  const listed = (await as(closed, "/list?status=pending&n=50")).json.entries;
  assert.ok(!listed.some((e) => e.id === card), "the pending card is not in a device's list");

  for (const d of [null, open]) {
    assert.equal((await as(d, "/subject?slug=rex")).status, 200);
    assert.equal((await as(d, "/subjects?status=proposed")).json.subjects.length, 1);
    assert.equal((await as(d, `/entry?id=${card}`)).status, 200);
    assert.equal((await links(app, memory, d)).length, 1);
  }
});

test("a dismissed proposal stays hidden from a closed device too", async () => {
  const app = await createApp({ env: ON });
  await put(app, "Rex is a dog we met at the park.", { subject: { name: "Rex", kind: "pet" } });
  await app.call("/subject/dismiss", { method: "POST", body: { slug: "rex" } });
  const closed = await device(app, { allowPrivate: false });
  assert.equal((await app.call("/subjects?status=retired", { token: closed.token })).json.subjects.length, 0);
  assert.equal((await app.call("/subject?slug=rex", { token: closed.token })).status, 404);
  assert.equal((await app.call("/subject?slug=rex")).status, 200);
});

// ---------------------------------------------------------------- S2: a hint cannot un-hide a memory

test("an update in place with a hint does not link a private memory to a shared proposal", async () => {
  const app = await createApp({ env: ON });
  scriptModel(app.env.AI, { ...QUIET, "contradiction-detect": { match: 0 } });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const text = (more) => `---\nname: pip-notes\ndescription: Notes\nmetadata:\n  type: project\n---\n\nPip has an ear infection${more}.`;
  const id = (await put(app, text(""), { source: "session-capture" })).json.id;
  await about(app, id, pip);
  assert.equal(await status(app, id, closed), 404, "hidden before");
  const second = await put(app, text(", and Rowan the vet gave drops"), { source: "session-capture", subject: { name: "Rowan", kind: "person" } });
  assert.equal(second.json.updated, true, JSON.stringify(second.json));
  assert.equal(second.json.id, id);
  assert.deepEqual(await subjectRows(app), [{ slug: "pip", status: "active" }], "no proposal was made");
  assert.equal(await status(app, id, closed), 404, "and the memory is still hidden");
});

test("a link to a proposal does not count as a shared link, so it cannot un-hide a private memory", async () => {
  const app = await createApp({ env: ON });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const rex = await addSubject(app, { slug: "rex", kind: "pet", name: "Rex", status: "proposed" });
  await app.env.DB.prepare("UPDATE memories SET status = 'pending' WHERE id = ?").bind(rex).run();
  const id = (await put(app, "Pip and Rex met at the park.")).json.id;
  await about(app, id, pip);
  await about(app, id, rex);
  const closed = await device(app, { allowPrivate: false });
  assert.equal(await status(app, id, closed), 404);
  assert.ok(!(await app.call("/list?n=50", { token: closed.token })).json.entries.some((e) => e.id === id));
  // The same memory with a link to an accepted subject is visible, which is the rule as it was.
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  await about(app, id, garden);
  assert.equal(await status(app, id, closed), 200);
});

// ---------------------------------------------------------------- S3: assignment cannot un-hide a memory

async function privateWorld() {
  const app = await createApp({ env: ON });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const closed = await device(app, { allowPrivate: false });
  return { app, pip, garden, closed };
}

test("a memory that names a private subject and a shared one is linked to the private one only, and stays hidden", async () => {
  const { app, pip, closed } = await privateWorld();
  const r = await put(app, "Pip is on a strict diet and nobody must feed Pip in the garden.");
  assert.deepEqual((await links(app, r.json.id)).map((l) => [l.other_id, l.made_by]), [[pip, "system"]]);
  assert.equal(await status(app, r.json.id, closed), 404);
});

test("assignment decides the same for a memory that already belongs to a private subject", async () => {
  const { app, pip, garden } = await privateWorld();
  const id = await plain(app, "Notes from the weekend.");
  await about(app, id, pip);
  const found = await assignMemory(app.env, { id, content: "We sat in the garden all day." });
  assert.deepEqual(found.links, [], "the person's private link is kept private");
  const other = await plain(app, "We sat in the garden all day.");
  const free = await assignMemory(app.env, { id: other, content: "We sat in the garden all day." });
  assert.deepEqual(free.links.map((l) => l.subject_id), [garden], "and a memory with no private link is linked as before");
});

test("a vote through mixed neighbours does not add a shared link to a private memory either", async () => {
  const { app, pip, garden } = await privateWorld();
  const members = [];
  for (let i = 0; i < 3; i++) {
    members.push(await plain(app, `Weekend note ${i} about nothing in particular.`));
    await about(app, members[i], garden);
  }
  const id = await plain(app, "Pip needs a new lead.");
  const neighbours = members.map((m) => ({ id: m, similarity: 0.9 }));
  const found = await assignMemory(app.env, { id, content: "Pip needs a new lead.", neighbours });
  assert.deepEqual(found.links.map((l) => l.slug), ["pip"]);
  const voteOnly = await assignMemory(app.env, { id, content: "A note with no names.", neighbours });
  assert.deepEqual(voteOnly.links.map((l) => [l.slug, l.how]), [["garden", "vote"]], "with no private subject in play the vote still links");
  void pip;
});

test("the write step itself refuses a shared link when a person made the memory private a moment after it was decided", async () => {
  const { app, pip, garden } = await privateWorld();
  const id = await plain(app, "We sat in the garden all day.");
  const real = app.env.DB;
  // The decision (garden, shared) is made on a memory with no private link. The person links it to Pip before the batch runs.
  const racing = { prepare: (sql) => real.prepare(sql), batch: async (list) => (await about(app, id, pip), real.batch(list)) };
  const counters = createCounters(real, now);
  await afterSubjects({ ...app.env, DB: racing }, { id, content: "We sat in the garden all day.", neighbours: [], now, counters });
  const rows = (await real.prepare("SELECT target_id FROM links WHERE source_id = ? ORDER BY target_id").bind(id).all()).results.map((r) => r.target_id);
  assert.deepEqual(rows, [pip]);
  assert.ok(!rows.includes(garden));
  assert.equal((await real.prepare("SELECT COUNT(*) AS n FROM audit WHERE route = 'assign.link'").first()).n, 0, "and no row says it was made");
});

// ---------------------------------------------------------------- S8: the links and their audit rows are one batch

test("every system link and its audit row are written in one batch, and a failing audit write leaves no link", async () => {
  const app = await createApp({ env: ON });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = (await put(app, "Notes from the weekend.")).json.id;
  const real = app.env.DB;
  const down = { prepare: (sql) => real.prepare(sql), batch: (list) => (list.some((s) => /INTO audit/.test(s.sql)) ? Promise.reject(new Error("d1 down")) : real.batch(list)) };
  const counters = createCounters(real, now);
  await afterSubjects({ ...app.env, DB: down }, { id, content: "Pip went out.", neighbours: [], now, counters });
  assert.deepEqual((await real.prepare("SELECT target_id FROM links WHERE source_id = ?").bind(id).all()).results, [], "no link without its row");
  await counters.flush();
  assert.equal((await real.prepare("SELECT count FROM counters WHERE name = 'subjects.failed'").first()).count, 1);
  await afterSubjects(app.env, { id, content: "Pip went out.", neighbours: [], now, counters: createCounters(real, now) });
  assert.deepEqual((await real.prepare("SELECT target_id FROM links WHERE source_id = ?").bind(id).all()).results.map((r) => r.target_id), [pip]);
  assert.equal((await real.prepare("SELECT COUNT(*) AS n FROM audit WHERE route = 'assign.link'").first()).n, 1);
});

test("a link the batch did not make leaves no audit row that says it did", async () => {
  const app = await createApp({ env: ON });
  await addSubject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana" });
  const id = (await put(app, "Notes from the weekend.")).json.id;
  const real = app.env.DB;
  // Dana's card is trashed after the candidates were read, and a person rejected Pip a moment later.
  const racing = {
    prepare: (sql) => {
      const st = real.prepare(sql);
      if (!/FROM subjects s JOIN memories/.test(sql)) return st;
      return { bind: (...a) => ({ all: async () => { const r = await st.bind(...a).all(); await real.prepare("UPDATE memories SET deleted_at = 1 WHERE id = ?").bind(dana).run(); return r; } }) };
    },
    batch: (l) => real.batch(l),
  };
  const counters = createCounters(real, now);
  await afterSubjects({ ...app.env, DB: racing }, { id, content: "Pip and Dana", neighbours: [], now, counters });
  assert.equal((await real.prepare("SELECT COUNT(*) AS n FROM links WHERE source_id = ?").bind(id).first()).n, 1);
  assert.equal((await real.prepare("SELECT COUNT(*) AS n FROM audit WHERE route = 'assign.link'").first()).n, 1, "one row for the one link");
});

// ---------------------------------------------------------------- F8: a dismissed proposal is not served by subject

test("GET /recall?subject= does not serve a dismissed proposal, and serves it once it is brought back", async () => {
  const app = await createApp({ env: ON });
  await put(app, "Rex is a dog we met at the park.", { subject: { name: "Rex", kind: "pet" } });
  await app.call("/subject/dismiss", { method: "POST", body: { slug: "rex" } });
  assert.equal((await app.call("/recall?subject=rex")).status, 404);
  assert.equal(await recallSubject(app.env, { slug: "rex", topK: 5 }), null);
  await app.call("/subject/update", { method: "POST", body: { slug: "rex", status: "active" } });
  assert.equal((await app.call("/recall?subject=rex")).status, 200);
});

// createProposed is also the cluster step's door, and its evidence rule is the same there.
test("a proposal made by the cluster step cannot take a private memory as evidence", async () => {
  const app = await createApp({ env: ON });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const id = (await put(app, "Pip has an ear infection.")).json.id;
  await about(app, id, pip);
  const res = await createProposed(app.env, { name: "Ear care", kind: "topic", evidence: [{ id, confidence: 0.7 }], now, step: "cluster" });
  assert.deepEqual(res, { ok: false, reason: "no_evidence" });
});
