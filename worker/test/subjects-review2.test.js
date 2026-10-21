// The second review of phase 3c. Text that must be gone is gone for a device with private access off, at the moment it must be gone,
// and in every place it can be read: the live card, the versions and the history of the card, recall by subject, the search text and
// vectors, and links. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SMALL_MODEL } from "../ai.js";
import { briefsStep } from "../cron/briefs.js";
import { createBudget, countedEnv } from "../cron/budget.js";
import { createStore } from "../memory/store.js";
import { clearCiting, clearIneligible } from "../subjects/clear.js";
import { createProposed } from "../subjects/propose.js";
import { createApp } from "./helpers/app.js";
import { DAY, indexAll, row, rows, seed, storeOf } from "./helpers/maintenance.js";
import { about, addSubject, device } from "./helpers/subjects.js";
import { put, QUIET, scriptModel } from "./helpers/write.js";

const ALL = { SUBJECTS: "on", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "on" };
const SECRET = "Dana stays at the cottage when she is sick.";
const blocks = (prompt) => [...prompt.matchAll(/<memory id="([^"]+)" date="([^"]+)">\n([\s\S]*?)\n<\/memory>/g)].map((m) => ({ id: m[1], text: m[3] }));

/** The model copies the last line of each memory it is shown, citing it. */
function model(app, edit = (lines) => lines) {
  app.env.AI.reply(SMALL_MODEL, async (input) => ({ response: { lines: await edit(blocks(input.messages[1].content).map((b) => ({ section: "now", text: b.text.split("\n").at(-1), ids: [b.id] }))) } }));
}
async function night(app, { subrequests = 500, env = app.env } = {}) {
  const now = () => app.clock.t;
  const budget = createBudget({ now, subrequests });
  return briefsStep(countedEnv(env, budget), { now, budget });
}
const post = (app, path, body, opts = {}) => app.call(path, { method: "POST", body, ...opts });

/** A shared Cottage whose brief was built from one memory that says the secret, a private Dana, and a device that may not see her. */
async function world(env = ALL) {
  const app = await createApp({ env });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "cottage-note", text: SECRET, origin: "capture" });
  await about(app, m, cottage);
  model(app);
  app.clock.t += 1000;
  assert.equal((await night(app)).built, 1);
  assert.match((await row(app, cottage)).body, /Dana stays/);
  const closed = await device(app, { allowPrivate: false });
  return { app, cottage, dana, m, closed };
}
/** The person moves a memory from a shared subject to a private one: out of the first, then into the second, as two requests. */
async function move(app, m, from, to) {
  assert.equal((await post(app, "/unlink", { source_id: m, target_id: from, type: "about" })).status, 200);
  assert.equal((await post(app, "/link", { source_id: m, target_id: to, type: "about" })).status, 200);
}

/** Every place a closed device can read the card, as one text. */
async function everything(app, closed, card, slug = "cottage") {
  const get = async (path) => JSON.stringify((await app.call(path, { token: closed.token })).json);
  const versions = (await app.call(`/history?id=${card}`, { token: closed.token })).json.versions ?? [];
  const parts = [await get(`/entry?id=${card}`), await get(`/history?id=${card}`), await get(`/subject?slug=${slug}`), await get(`/recall?subject=${slug}`), await get(`/links?id=${card}`)];
  for (let v = 1; v <= Math.max(8, ...versions.map((x) => x.seq)); v++) parts.push(await get(`/entry?id=${card}&version=${v}`));
  return parts.join("\n");
}
const derived = (app, card) => rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", card);
const subjectRow = (app, id) => app.env.DB.prepare("SELECT * FROM subjects WHERE id = ?").bind(id).first();
const audit = (app, route) => rows(app, "SELECT * FROM audit WHERE route = ? ORDER BY id", route);

// ------------------------------------------------------------------ 1 and 4: the text is gone at once, in every place

test("a person links the member to a private subject: the shared brief is gone at once, from the card, every version and the history", async () => {
  const { app, cottage, dana, m, closed } = await world();
  assert.match(await everything(app, closed, cottage), /Dana stays/, "before: the closed device reads it, so the check below can fail");
  // the person files it under Dana: the route that makes the link blanks every brief that cites the memory, no night in between
  await move(app, m, cottage, dana);
  const seen = await everything(app, closed, cottage);
  assert.doesNotMatch(seen, /Dana stays|sick/);
  const s = await subjectRow(app, cottage);
  assert.deepEqual({ built: s.built_at, hash: s.member_hash, status: s.status, reason: s.stale_reason }, { built: null, hash: "", status: "stale", reason: "members_changed" });
  assert.equal((await derived(app, cottage)).length, 0);
  assert.equal((await row(app, cottage)).body, "");
  const versions = await rows(app, "SELECT snapshot FROM memory_versions WHERE memory_id = ?", cottage);
  assert.ok(versions.every((v) => JSON.parse(v.snapshot).body === ""), "no version holds brief text");
  assert.ok(!versions.some((v) => /Dana stays/.test(v.snapshot)));
  const rowsAudit = await audit(app, "brief.clear");
  assert.equal(rowsAudit.length, 1, "one system audit row");
  assert.deepEqual([rowsAudit[0].actor_kind, rowsAudit[0].actor_id, rowsAudit[0].harness, rowsAudit[0].method, rowsAudit[0].status], ["system", "brief", "system", "SYSTEM", 200]);
});

test("the older versions that hold the brief are deleted in the clear itself, and a version of a private card is not readable by a closed device", async () => {
  const { app, cottage, dana, m, closed } = await world();
  const before = await rows(app, "SELECT seq, reason FROM memory_versions WHERE memory_id = ? ORDER BY seq", cottage);
  assert.ok(before.length >= 1);
  assert.equal((await app.call(`/entry?id=${cottage}&version=${before[0].seq}`, { token: closed.token })).status, 200, "before the clear the closed device can read a version of a shared card");
  await move(app, m, cottage, dana);
  for (const v of before) {
    const r = await app.call(`/entry?id=${cottage}&version=${v.seq}`, { token: closed.token });
    assert.ok(r.status === 404 || r.json.entry.body === "", `version ${v.seq}: ${r.status}`);
  }
  // the version of a private card is a card read: 404 for a closed device, 200 for the admin
  await app.env.DB.prepare("UPDATE subjects SET scope = 'private' WHERE id = ?").bind(cottage).run();
  const sample = (await rows(app, "SELECT seq FROM memory_versions WHERE memory_id = ?", cottage))[0]?.seq ?? 1;
  assert.equal((await app.call(`/entry?id=${cottage}&version=${sample}`, { token: closed.token })).status, 404);
  assert.equal((await app.call(`/history?id=${cottage}`, { token: closed.token })).status, 404);
});

test("a version edited by a person that holds the brief is deleted too", async () => {
  const { app, cottage, dana, m, closed } = await world();
  await post(app, "/update", { id: cottage, content: (await row(app, cottage)).content.replace("Now", "Now (edited)") });
  await move(app, m, cottage, dana);
  assert.doesNotMatch(await everything(app, closed, cottage), /Dana stays/);
});

test("forgetting the member blanks every brief that cites it at once, for a pinned subject and a retired one as well", async () => {
  for (const mode of ["plain", "pinned", "retired"]) {
    const { app, cottage, m, closed } = await world();
    if (mode === "pinned") await app.env.DB.prepare("UPDATE subjects SET fields = ? WHERE id = ?").bind(JSON.stringify({ brief_pinned: { value: "yes", confirmed_at: 1, source: "user" } }), cottage).run();
    if (mode === "retired") await app.env.DB.prepare("UPDATE subjects SET status = 'retired' WHERE id = ?").bind(cottage).run();
    assert.equal((await post(app, "/forget", { id: m })).status, 200);
    assert.doesNotMatch(await everything(app, closed, cottage), /Dana stays|sick/, mode);
    assert.equal((await derived(app, cottage)).length, 0, mode);
    const s = await subjectRow(app, cottage);
    assert.equal(s.status, mode === "retired" ? "retired" : "stale", mode);
    assert.equal(s.built_at, null, mode);
  }
});

test("a memory that replaces the cited one blanks the brief at once (the write path)", async () => {
  const app = await createApp({ env: ALL });
  scriptModel(app.env.AI, { ...QUIET, "contradiction-detect": { match: 0 } });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const m = await seed(app, { name: "cottage-note", text: SECRET, origin: "capture" });
  await about(app, m, cottage);
  const cited = await seed(app, { name: "cottage-note-2", text: "The cottage roof leaks over the kitchen.", origin: "capture" });
  await about(app, cited, cottage);
  model(app);
  app.clock.t += 1000;
  await night(app);
  assert.match((await row(app, cottage)).body, /roof leaks/);
  // replacing goes through the store the same way the write path does it, and the helper is what the write path calls
  await storeOf(app).supersede(cited, m, app.clock.t);
  const done = await clearCiting(app.env, { ids: [cited], now: () => app.clock.t, why: "member.gone" });
  assert.deepEqual(done, [cottage]);
  assert.equal((await row(app, cottage)).body, "");
});

test("the clear works with SUBJECTS_AUTO and SUBJECTS_BRIEFS off, because the text may have been built earlier", async () => {
  const { app, cottage, dana, m, closed } = await world();
  app.env.SUBJECTS_AUTO = "off";
  app.env.SUBJECTS_BRIEFS = "off";
  await move(app, m, cottage, dana);
  assert.doesNotMatch(await everything(app, closed, cottage), /Dana stays/);
  // and the nightly backup does it with every flag off
  const w = await world();
  w.app.env.SUBJECTS = "off";
  w.app.env.SUBJECTS_AUTO = "off";
  w.app.env.SUBJECTS_BRIEFS = "off";
  await createStore(w.app.env.DB, () => w.app.clock.t).softDelete(w.m);
  const out = await night(w.app);
  assert.deepEqual(out, { skipped: "off", cleared: 1 });
  assert.equal((await row(w.app, w.cottage)).body, "");
});

test("a private subject's brief is not cleared when its member joins another private subject, a shared one is", async () => {
  const app = await createApp({ env: ALL });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const wren = await addSubject(app, { slug: "wren", kind: "person", name: "Wren", scope: "private" });
  const shared = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const m = await seed(app, { name: "n", text: "Pip digs holes in the garden every day.", origin: "capture" });
  await about(app, m, shared);
  model(app);
  app.clock.t += 1000;
  await night(app);
  assert.match((await row(app, shared)).body, /digs holes/);
  await post(app, "/link", { source_id: m, target_id: pip, type: "about" });
  assert.equal((await row(app, shared)).body, "", "the shared card is blanked when the memory joins a private subject");
  await post(app, "/unlink", { source_id: m, target_id: shared, type: "about" });
  app.clock.t += DAY;
  await night(app);
  assert.match((await row(app, pip)).body, /digs holes/, "Pip's own brief is built from it");
  await post(app, "/link", { source_id: m, target_id: wren, type: "about" });
  assert.match((await row(app, pip)).body, /digs holes/, "the private card stays");
});

test("the card is indexed again at once, so a closed recall of the old text does not find it, and its questions are gone", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "cottage-note", text: SECRET, origin: "capture" });
  await about(app, m, cottage);
  model(app);
  app.clock.t += 1000;
  await night(app);
  // the questions the backfill wrote about the card, from the text it had then
  for (const [i, q] of ["Where does Dana stay when she is sick?", "Who stays at the cottage when ill?"].entries()) {
    await app.env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) VALUES (?, 'question', ?, ?, NULL, ?)").bind(cottage, i, q, app.clock.t).run();
  }
  await indexAll(app);
  const closed = await device(app, { allowPrivate: false });
  const probe = async () => (await app.call(`/recall?query=${encodeURIComponent("Dana stays at the cottage when she is sick")}`, { token: closed.token })).json;
  assert.ok((await rows(app, "SELECT * FROM memory_keys WHERE memory_id = ? AND key_type = 'question'", cottage)).length > 0, "the card has questions about the old text");
  const questionVectors = (await rows(app, "SELECT vector_id FROM memory_keys WHERE memory_id = ? AND key_type = 'question'", cottage)).map((r) => r.vector_id);
  assert.equal(questionVectors.length, 2);
  assert.ok(questionVectors.every((id) => app.env.VECTORIZE.vectors.has(id)));
  await move(app, m, cottage, dana);
  assert.doesNotMatch(JSON.stringify((await probe()).results), /Dana stays|sick/);
  const keys = await rows(app, "SELECT key_type, text FROM memory_keys WHERE memory_id = ?", cottage);
  assert.ok(keys.every((k) => k.key_type !== "question"), "no question about the old text is left");
  assert.ok(!keys.some((k) => /Dana|sick/.test(k.text)), JSON.stringify(keys));
  const fts = await rows(app, "SELECT keys, body FROM memory_fts WHERE memory_id = ?", cottage);
  assert.ok(!/Dana|sick/.test(JSON.stringify(fts)), "the search text is made again without them");
  const found = (await probe()).results?.find((r) => r.id === cottage);
  assert.ok(!found || !/Dana stays/.test(found.content), "the card does not come back with the old text");
  assert.deepEqual(questionVectors.filter((id) => app.env.VECTORIZE.vectors.has(id)), [], "the vectors of the questions are deleted too");
});

test("a member that joins a private subject while the model works never gets into the saved brief", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "cottage-note", text: SECRET, origin: "capture" });
  await about(app, m, cottage);
  model(app, async (lines) => {
    await about(app, m, dana);
    return lines;
  });
  app.clock.t += 1000;
  const out = await night(app);
  assert.equal(out.built, 0);
  assert.equal(out.stale, 1);
  assert.doesNotMatch((await row(app, cottage)).body, /Dana stays/);
  assert.equal((await derived(app, cottage)).length, 0);
});

test("the backup finds a cited member that is trashed, gone or in a private subject, and only those", async () => {
  const { app, cottage, dana, m } = await world();
  // an added or an edited member is not a reason
  const added = await seed(app, { name: "n2", text: "The cottage has a blue door.", origin: "capture" });
  await about(app, added, cottage);
  await storeOf(app).update({ id: m, content: `---\nname: cottage-note\ndescription: A sample.\nmetadata:\n  type: project\n---\n\n${SECRET} Plus a word.` });
  assert.deepEqual(await clearIneligible(app.env, { now: () => app.clock.t }), []);
  await about(app, m, dana);
  assert.deepEqual(await clearIneligible(app.env, { now: () => app.clock.t }), [cottage]);
  assert.deepEqual(await clearIneligible(app.env, { now: () => app.clock.t }), [], "nothing is left to clear");
});

// ------------------------------------------------------------------ 3: a good brief is not destroyed

test("a harmless added member and a rebuild that fails leave the good brief and mark the subject stale with the reason", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const m = await seed(app, { name: "cottage-note", text: "The cottage has a red roof.", origin: "capture" });
  await about(app, m, cottage);
  model(app);
  app.clock.t += 1000;
  await night(app);
  const built = (await row(app, cottage)).body;
  assert.match(built, /red roof/);
  const added = await seed(app, { name: "cottage-note-2", text: "The cottage has a blue door.", origin: "capture" });
  await about(app, added, cottage);
  model(app, (lines) => lines.map((l) => ({ ...l, ids: [] }))); // the rebuild fails the citation check
  app.clock.t += DAY;
  const out = await night(app);
  assert.equal(out.cleared, 0);
  assert.equal(out.stale, 1);
  assert.equal((await row(app, cottage)).body, built, "the good brief stays");
  assert.equal((await subjectRow(app, cottage)).stale_reason, "no_citation");
  assert.equal((await derived(app, cottage)).length, 1);
  assert.equal((await audit(app, "brief.clear")).length, 0);
});

// ------------------------------------------------------------------ 2: a memory with a shared system link gains a private link

test("a link the system made to a shared subject goes in the same batch as a private link made by a person, and a person's own link stays", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const m = await seed(app, { name: "keys", text: "The cottage keys hang by the back door.", origin: "capture" });
  const store = createStore(app.env.DB, () => app.clock.t);
  await store.link(m, cottage, "about", { madeBy: "system", confidence: 1 });
  await store.link(m, garden, "about"); // the person's own link
  assert.equal((await app.call(`/entry?id=${m}`, { token: closed.token })).status, 200);
  await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  const left = (await rows(app, "SELECT target_id, made_by FROM links WHERE source_id = ? AND link_type = 'about' ORDER BY made_by", m)).map((r) => [r.target_id, r.made_by]);
  assert.deepEqual(left.sort(), [[dana, "user"], [garden, "user"]].sort(), "the system link is gone, both of the person's links stay");
  assert.equal((await rows(app, "SELECT * FROM link_rejections")).length, 0, "it is not a rejection");
  // without the person's shared link the memory is hidden again
  await post(app, "/unlink", { source_id: m, target_id: garden, type: "about" });
  assert.equal((await app.call(`/entry?id=${m}`, { token: closed.token })).status, 404);
});

test("the write path: a capture linked to a shared subject, then an update that adds private text, is hidden from a closed device", async () => {
  const app = await createApp({ env: ALL });
  scriptModel(app.env.AI, { ...QUIET, "contradiction-detect": { match: 0 } });
  await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const head = (t) => `---\nname: cottage-keys\ndescription: Keys\nmetadata:\n  type: project\n---\n\n${t}`;
  const a = await put(app, head("The cottage keys hang by the back door."), { source: "session-capture" });
  const first = (await app.call(`/links?id=${a.json.id}`)).json.links.map((l) => [l.other_name, l.made_by]);
  assert.deepEqual(first, [["cottage", "system"]]);
  assert.equal((await app.call(`/entry?id=${a.json.id}`, { token: closed.token })).status, 200);
  await put(app, head("The cottage keys hang by the back door. Dana hides her surprise party plans there."), { source: "session-capture" });
  const links = (await app.call(`/links?id=${a.json.id}`)).json.links.map((l) => [l.other_name, l.made_by]);
  assert.deepEqual(links, [["dana", "system"]], "the shared link is gone, the private one is made");
  assert.equal((await app.call(`/entry?id=${a.json.id}`, { token: closed.token })).status, 404);
});

test("a subject that turns private takes its members out of the shared subjects the system linked them to, and blanks their shared briefs", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana" });
  const m = await seed(app, { name: "n", text: SECRET, origin: "capture" });
  const store = createStore(app.env.DB, () => app.clock.t);
  await store.link(m, cottage, "about", { madeBy: "system", confidence: 1 });
  await store.link(m, dana, "about");
  model(app);
  app.clock.t += 1000;
  await night(app);
  assert.match((await row(app, cottage)).body, /Dana stays/);
  const closed = await device(app, { allowPrivate: false });
  assert.equal((await app.call(`/entry?id=${m}`, { token: closed.token })).status, 200);
  assert.equal((await post(app, "/subject/update", { slug: "dana", scope: "private" })).status, 200);
  assert.equal((await app.call(`/entry?id=${m}`, { token: closed.token })).status, 404);
  assert.equal((await row(app, cottage)).body, "");
  assert.doesNotMatch(await everything(app, closed, cottage), /Dana stays/);
});

test("a private subject that turns shared loses its brief when it holds text of a member that belongs to another private subject", async () => {
  const app = await createApp({ env: ALL });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const both = await seed(app, { name: "both", text: "Pip hates the vet and bites Dana.", origin: "capture" });
  const only = await seed(app, { name: "only", text: "Pip loves the beach.", origin: "capture" });
  await about(app, both, pip);
  await about(app, both, dana);
  await about(app, only, pip);
  model(app);
  app.clock.t += 1000;
  await night(app);
  assert.match((await row(app, pip)).body, /bites Dana/);
  assert.equal((await post(app, "/subject/update", { slug: "pip", scope: "shared" })).status, 200);
  assert.equal((await row(app, pip)).body, "", "a member that is also in Dana's subject may not feed a shared card");
  // a subject whose members belong to nothing else keeps its brief when it turns shared
  const wren = await addSubject(app, { slug: "wren", kind: "person", name: "Wren", scope: "private" });
  const mine = await seed(app, { name: "mine", text: "Wren likes tea.", origin: "capture" });
  await about(app, mine, wren);
  app.clock.t += DAY;
  await night(app);
  assert.match((await row(app, wren)).body, /likes tea/);
  await post(app, "/subject/update", { slug: "wren", scope: "shared" });
  assert.match((await row(app, wren)).body, /likes tea/);
});

// ------------------------------------------------------------------ 5: accept and revive do not un-hide

test("accepting a proposal drops the evidence links of a memory that got a private link after it was proposed", async () => {
  const app = await createApp({ env: ALL });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const hidden = await seed(app, { name: "rowan-a", text: "Rowan the vet gave new tablets for the dog.", origin: "capture" });
  const open = await seed(app, { name: "rowan-b", text: "Rowan the vet is open on Saturdays.", origin: "capture" });
  const made = await createProposed(app.env, { name: "Rowan", kind: "person", evidence: [{ id: hidden, confidence: 1 }, { id: open, confidence: 1 }], now: () => app.clock.t });
  assert.equal(made.ok, true);
  await about(app, hidden, dana); // the person files it under Dana, who is private
  assert.equal((await app.call(`/entry?id=${hidden}`, { token: closed.token })).status, 404, "while it is a proposal the memory is hidden");
  assert.equal((await post(app, "/subject/accept", { slug: "rowan" })).status, 200);
  assert.equal((await app.call(`/entry?id=${hidden}`, { token: closed.token })).status, 404, "and after accepting it");
  assert.equal((await app.call(`/entry?id=${open}`, { token: closed.token })).status, 200);
  const evidence = (await rows(app, "SELECT source_id FROM links WHERE target_id = ? AND link_type = 'about'", made.id)).map((r) => r.source_id);
  assert.deepEqual(evidence, [open]);
});

test("bringing a dismissed proposal back drops the same links, and a plain update of an active subject keeps all of its links", async () => {
  const app = await createApp({ env: ALL });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const hidden = await seed(app, { name: "rowan-a", text: "Rowan the vet gave new tablets for the dog.", origin: "capture" });
  const open = await seed(app, { name: "rowan-b", text: "Rowan the vet is open on Saturdays.", origin: "capture" });
  const made = await createProposed(app.env, { name: "Rowan", kind: "person", evidence: [{ id: hidden, confidence: 1 }, { id: open, confidence: 1 }], now: () => app.clock.t });
  await post(app, "/subject/dismiss", { slug: "rowan" });
  await about(app, hidden, dana);
  assert.equal((await post(app, "/subject/update", { slug: "rowan", status: "active" })).status, 200);
  assert.equal((await app.call(`/entry?id=${hidden}`, { token: closed.token })).status, 404);
  assert.deepEqual((await rows(app, "SELECT source_id FROM links WHERE target_id = ? AND link_type = 'about'", made.id)).map((r) => r.source_id), [open]);
  // a subject that was never a proposal is not touched by an update, even with a member that is private too
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const both = await seed(app, { name: "both", text: "The garden gate sticks.", origin: "capture" });
  await about(app, both, garden);
  await about(app, both, dana);
  await post(app, "/subject/update", { slug: "garden", name: "The Garden", status: "active" });
  assert.equal((await rows(app, "SELECT * FROM links WHERE target_id = ? AND link_type = 'about'", garden)).length, 1);
});

// ------------------------------------------------------------------ 7: the third switch, 9: a closed device and the brief state

test("the stats say whether briefs are on", async () => {
  for (const [env, want] of [[{ SUBJECTS: "on", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "on" }, true], [{ SUBJECTS: "on", SUBJECTS_AUTO: "on" }, false], [{ SUBJECTS_BRIEFS: "off" }, false]]) {
    const app = await createApp({ env });
    assert.equal((await app.call("/stats")).json.subjects_briefs, want, JSON.stringify(env));
  }
});

test("a closed device is not told when a brief was built or why it is stale, the admin and an open device are", async () => {
  const { app, cottage, dana, m, closed } = await world();
  const open = await device(app, { allowPrivate: true });
  await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  const shut = (await app.call("/subject?slug=cottage", { token: closed.token })).json.subject;
  assert.ok(!("built_at" in shut) && !("stale_reason" in shut), JSON.stringify(shut));
  const listed = (await app.call("/subjects", { token: closed.token })).json.subjects.find((s) => s.id === cottage);
  assert.ok(!("built_at" in listed) && !("stale_reason" in listed));
  for (const token of [undefined, open.token]) {
    const s = (await app.call("/subject?slug=cottage", { token })).json.subject;
    assert.equal(s.stale_reason, "members_changed");
    assert.equal(s.built_at, null);
  }
});
