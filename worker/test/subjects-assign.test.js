// Assignment: which subjects a memory belongs to, and what the write path does with the answer. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { addSubject, about, device } from "./helpers/subjects.js";
import { QUIET, THIRTY_WORDS, cosine, put, scriptModel } from "./helpers/write.js";
import { parseMemory } from "../memory/parse.js";
import { createStore } from "../memory/store.js";
import { createCounters } from "../counters.js";
import { afterSubjects } from "../subjects/after.js";
import { assignMemory, MAX_LINKS } from "../subjects/assign.js";
import { autoOn } from "../subjects/auto.js";

const ON = { SUBJECTS: "on", SUBJECTS_AUTO: "on" };
const now = () => 1_790_000_000_000;

const storeOf = (app) => createStore(app.env.DB, () => app.clock.t);

/** A memory straight into the store, so a test needs no write path. @returns {Promise<string>} the id */
async function mem(app, text, origin = "capture") {
  const parsed = await parseMemory(text);
  return (await storeOf(app).create({ ...parsed, origin })).id;
}

/** A subject with aliases. addSubject writes none. @returns {Promise<string>} the card id */
async function subject(app, { aliases = [], ...rest }) {
  const id = await addSubject(app, rest);
  await app.env.DB.prepare("UPDATE subjects SET aliases = ? WHERE id = ?").bind(JSON.stringify(aliases), id).run();
  return id;
}

const assign = (app, id, content, extra = {}) => assignMemory(app.env, { id, content, now, ...extra });
const slugs = (r) => r.links.map((l) => l.slug);
const linksOf = async (app, id) => (await app.env.DB.prepare("SELECT target_id, link_type, made_by, confidence FROM links WHERE source_id = ? ORDER BY target_id").bind(id).all()).results.map((r) => ({ ...r }));
const auditRows = async (app) => (await app.env.DB.prepare("SELECT * FROM audit WHERE actor_kind = 'system' ORDER BY id").all()).results;

/** Count every D1 call, a batch as one, the way a Worker is charged for subrequests. */
function counted(db) {
  const seen = { calls: 0 };
  const wrap = (st) => ({ inner: st, bind: (...a) => wrap(st.bind(...a)), first: (c) => (seen.calls++, st.first(c)), all: () => (seen.calls++, st.all()), run: () => (seen.calls++, st.run()), raw: () => (seen.calls++, st.raw()) });
  return { seen, db: { prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => (seen.calls++, db.batch(list.map((s) => s.inner ?? s))) } };
}

/** The neighbours of the vote tests: members of one subject and strangers, with the similarity given. */
const near = (ids, sims) => ids.map((id, i) => ({ id, similarity: sims[i] }));

// ---------------------------------------------------------------- the switch

test("autoOn needs both SUBJECTS and SUBJECTS_AUTO to be on", () => {
  assert.equal(autoOn({}), false);
  assert.equal(autoOn({ SUBJECTS: "on" }), false);
  assert.equal(autoOn({ SUBJECTS_AUTO: "on" }), false);
  assert.equal(autoOn({ SUBJECTS: "off", SUBJECTS_AUTO: "on" }), false);
  assert.equal(autoOn({ SUBJECTS: "on", SUBJECTS_AUTO: "on" }), true);
});

// ---------------------------------------------------------------- alias match

test("the slug, the name and an alias each match, at confidence 1.0, and the match ignores case", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  await subject(app, { slug: "corolla", kind: "asset", name: "the Corolla", aliases: ["the old car"] });
  await subject(app, { slug: "dana-reed", kind: "person", name: "Dana Reed" });
  const id = await mem(app, "x");
  const r = await assign(app, id, "PIP buried a bone. We took the old car to the garage, and Dana Reed waved. Dana-Reed again.");
  assert.deepEqual(slugs(r).sort(), ["corolla", "dana-reed", "pip"]);
  assert.ok(r.links.every((l) => l.confidence === 1 && l.how === "alias"));
  assert.equal((await assign(app, id, "The corolla needs tyres")).links[0].slug, "corolla");
  assert.equal((await assign(app, id, "dana reed called")).links[0].slug, "dana-reed", "a dash in the slug also matches a space");
});

test("the match is on whole words: Pip does not match Pipeline, but Pip's and a comma do", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  for (const text of ["The Pipeline is slow", "pipelines and pipette", "a_pip_b", "Pips and Pipa", "pip2 is another", "tulip"]) {
    assert.deepEqual((await assign(app, id, text)).links, [], text);
  }
  for (const text of ["Pip's bowl", "Pip, Dana and I", "walked (Pip) home", "pip.", "good dog: Pip"]) {
    assert.deepEqual(slugs(await assign(app, id, text)), ["pip"], text);
  }
});

test("a name or alias shorter than 3 characters never matches", async () => {
  const app = await createApp();
  await subject(app, { slug: "jo", kind: "person", name: "Jo", aliases: ["j", "ab", "xy"] });
  const id = await mem(app, "x");
  assert.deepEqual((await assign(app, id, "Jo and j and ab and xy came by")).links, []);
  await app.env.DB.prepare("UPDATE subjects SET aliases = ? WHERE slug = 'jo'").bind(JSON.stringify(["joe"])).run();
  assert.deepEqual(slugs(await assign(app, id, "Joe came by")), ["jo"], "three characters is enough");
});

test("only active and stale subjects match, proposed and retired ones do not", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip", status: "stale" });
  await subject(app, { slug: "wren", kind: "pet", name: "Wren", status: "proposed" });
  await subject(app, { slug: "otto", kind: "pet", name: "Otto", status: "retired" });
  const id = await mem(app, "x");
  assert.deepEqual(slugs(await assign(app, id, "Pip, Wren and Otto went out")), ["pip"]);
});

test("a subject whose card is in the trash is not a candidate", async () => {
  const app = await createApp();
  const card = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  await storeOf(app).softDelete(card);
  assert.deepEqual((await assign(app, id, "Pip is here")).links, []);
});

test("a memory may link to several subjects, best first, at most MAX_LINKS", async () => {
  const app = await createApp();
  for (const slug of ["alpha", "bravo", "charlie", "delta"]) await subject(app, { slug, kind: "topic", name: slug });
  const id = await mem(app, "x");
  const r = await assign(app, id, "alpha bravo charlie delta all in one line");
  assert.equal(r.links.length, MAX_LINKS);
  assert.deepEqual(slugs(r), ["alpha", "bravo", "charlie"], "equal confidence keeps the order of the slugs");
});

// ---------------------------------------------------------------- ambiguity

test("two subjects that share an alias are ambiguous, and neither is linked", async () => {
  const app = await createApp();
  const dog = await subject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog", aliases: ["rowan"] });
  const colleague = await subject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee", aliases: ["rowan"] });
  const id = await mem(app, "x");
  const r = await assign(app, id, "Rowan said hello");
  assert.deepEqual(r.links, []);
  assert.deepEqual(r.ambiguous, ["rowan-dog", "rowan-lee"]);
  assert.deepEqual(r.ambiguous_ids, [dog, colleague]);
});

test("a name only one of two subjects has settles the tie for that one", async () => {
  const app = await createApp();
  await subject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog", aliases: ["rowan"] });
  await subject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee", aliases: ["rowan"] });
  const id = await mem(app, "x");
  const r = await assign(app, id, "Rowan the dog dug a hole");
  assert.deepEqual(slugs(r), ["rowan-dog"]);
  assert.deepEqual(r.ambiguous, ["rowan-lee"]);
});

test("a subject that tied on a name is not linked by a vote either", async () => {
  const app = await createApp();
  const dog = await subject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog", aliases: ["rowan"] });
  await subject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee", aliases: ["rowan"] });
  const members = [];
  for (let i = 0; i < 4; i++) {
    members.push(await mem(app, `dog walk ${i}`));
    await about(app, members[i], dog);
  }
  const id = await mem(app, "x");
  const r = await assign(app, id, "Rowan said hello", { neighbours: near(members, [0.9, 0.9, 0.9, 0.9]) });
  assert.deepEqual(r.links, []);
});

// ---------------------------------------------------------------- neighbour vote

async function votingWorld(memberCount = 5) {
  const app = await createApp();
  const card = await subject(app, { slug: "cottage", kind: "asset", name: "the Cottage" });
  const members = [];
  for (let i = 0; i < memberCount; i++) {
    members.push(await mem(app, `Cottage note number ${i} about tiles`));
    await about(app, members[i], card);
  }
  const strangers = [];
  for (let i = 0; i < 5; i++) strangers.push(await mem(app, `Unrelated stranger ${i}`));
  const id = await mem(app, "x");
  return { app, card, members, strangers, id };
}

test("a vote of 3 of the 5 nearest members links with confidence (votes / 5) times the best similarity", async () => {
  const { app, members, strangers, id } = await votingWorld();
  const r = await assign(app, id, "Nothing named here", { neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.9, 0.85, 0.8, 0.7, 0.6]) });
  assert.deepEqual(r.links, [{ subject_id: r.links[0].subject_id, slug: "cottage", confidence: 0.54, how: "vote" }]);
  const five = await assign(app, id, "Nothing named here", { neighbours: near(members, [0.9, 0.8, 0.8, 0.8, 0.7]) });
  assert.equal(five.links[0].confidence, 0.9, "5 of 5 at 0.9");
});

test("two votes, or votes outside the 5 nearest, do not link", async () => {
  const { app, members, strangers, id } = await votingWorld();
  const two = await assign(app, id, "Nothing named here", { neighbours: near([members[0], members[1], strangers[0], strangers[1], strangers[2]], [0.95, 0.95, 0.9, 0.9, 0.9]) });
  assert.deepEqual(two.links, []);
  // the third member is sixth in line, so it is not asked
  const late = await assign(app, id, "Nothing named here", { neighbours: near([members[0], members[1], strangers[0], strangers[1], strangers[2], members[2]], [0.95, 0.95, 0.9, 0.9, 0.9, 0.9]) });
  assert.deepEqual(late.links, []);
});

test("a best similarity under 0.6 does not link, however many vote", async () => {
  const { app, members, id } = await votingWorld();
  const r = await assign(app, id, "Nothing named here", { neighbours: near(members, [0.59, 0.5, 0.5, 0.5, 0.5]) });
  assert.deepEqual(r.links, []);
});

test("a confidence under the 0.5 floor is never linked", async () => {
  const { app, members, strangers, id } = await votingWorld();
  // 3 of 5 at 0.8 is 0.48
  const r = await assign(app, id, "Nothing named here", { neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.8, 0.7, 0.7, 0.6, 0.6]) });
  assert.deepEqual(r.links, []);
  // 3 of 5 at 0.84 is 0.504, which is over
  const over = await assign(app, id, "Nothing named here", { neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.84, 0.7, 0.7, 0.6, 0.6]) });
  assert.equal(over.links[0].confidence, 0.5);
});

test("an alias match beats a vote for the same subject", async () => {
  const { app, members, id } = await votingWorld();
  const r = await assign(app, id, "The Cottage roof leaks", { neighbours: near(members, [0.9, 0.9, 0.9, 0.9, 0.9]) });
  assert.deepEqual(r.links.map((l) => [l.slug, l.confidence, l.how]), [["cottage", 1, "alias"]]);
});

test("a memory is never one of its own five neighbours", async () => {
  const { app, members, strangers } = await votingWorld();
  // The memory is first in line. Counted, it would push the third member out of the five and the vote would fall to two.
  const r = await assign(app, strangers[4], "Nothing named here", { neighbours: near([strangers[4], members[0], members[1], strangers[0], strangers[1], members[2]], [1, 0.9, 0.9, 0.9, 0.9, 0.9]) });
  assert.deepEqual(slugs(r), ["cottage"]);
});

// ---------------------------------------------------------------- never relink, never link these

test("a pair a person rejected is never linked again, and a pair already linked is left alone", async () => {
  const app = await createApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const wren = await subject(app, { slug: "wren", kind: "pet", name: "Wren" });
  const id = await mem(app, "x");
  await app.env.DB.prepare("INSERT INTO link_rejections (source_id, target_id, link_type, created_at) VALUES (?, ?, 'about', 1)").bind(id, pip).run();
  await about(app, id, wren);
  const r = await assign(app, id, "Pip and Wren");
  assert.deepEqual(r.links, []);
  const other = await mem(app, "y");
  assert.deepEqual(slugs(await assign(app, other, "Pip and Wren")).sort(), ["pip", "wren"], "another memory is not held back by it");
});

test("a rejection of another link type does not hold an about link back", async () => {
  const app = await createApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  await app.env.DB.prepare("INSERT INTO link_rejections (source_id, target_id, link_type, created_at) VALUES (?, ?, 'related', 1)").bind(id, pip).run();
  assert.deepEqual(slugs(await assign(app, id, "Pip")), ["pip"]);
});

test("profile, person and system memories, and cards, are never assigned", async () => {
  const app = await createApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  for (const origin of ["profile", "person", "system"]) {
    const r = await assign(app, id, "Pip", { origin });
    assert.deepEqual([r.links, r.skipped], [[], "origin"], origin);
  }
  for (const origin of ["capture", "explicit", "import"]) assert.deepEqual(slugs(await assign(app, id, "Pip", { origin })), ["pip"], origin);
  assert.deepEqual([(await assign(app, pip, "Pip")).links, (await assign(app, pip, "Pip")).skipped], [[], "card"]);
});

test("with no subjects, or no text and no neighbours, there is nothing to do and one read at most", async () => {
  const app = await createApp();
  const id = await mem(app, "x");
  const c = counted(app.env.DB);
  assert.equal((await assignMemory({ DB: c.db }, { id, content: "", neighbours: [] })).skipped, "no_text");
  assert.equal(c.seen.calls, 0);
  assert.equal((await assignMemory({ DB: c.db }, { id, content: "Pip is here", neighbours: [] })).skipped, "no_subjects");
  assert.equal(c.seen.calls, 1);
});

// ---------------------------------------------------------------- private subjects

test("a private subject is linked for the admin, for an open device, and not for a closed device", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  await subject(app, { slug: "dana", kind: "person", name: "Dana" });
  const id = await mem(app, "x");
  const closed = await device(app, { allowPrivate: false });
  const open = await device(app, { allowPrivate: true });
  const text = "Pip and Dana went out";
  // Dana is shared, and a memory that belongs to a private subject gets no shared link, or every device could read it. So Pip only.
  assert.deepEqual(slugs(await assign(app, id, text, { actor: { kind: "admin", id: "admin" } })), ["pip"]);
  assert.deepEqual(slugs(await assign(app, id, text, { actor: { kind: "browser", id: "me@example.com" } })), ["pip"]);
  assert.deepEqual(slugs(await assign(app, id, text, { actor: { kind: "device", id: open.id } })), ["pip"]);
  assert.deepEqual(slugs(await assign(app, id, text, { actor: { kind: "device", id: closed.id } })), ["dana"], "a closed device cannot find out that Pip exists by losing sight of its memory");
  assert.deepEqual(slugs(await assign(app, id, text, { actor: { kind: "device", id: "no-such-device" } })), ["dana"], "a device that cannot be found sees nothing private");
});

// ---------------------------------------------------------------- dry run and budget

test("a dry run gives the same answer and writes nothing", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  const before = [(await linksOf(app, id)).length, (await auditRows(app)).length];
  const dry = await assign(app, id, "Pip is here", { dry: true });
  assert.deepEqual(dry, await assign(app, id, "Pip is here"));
  assert.deepEqual(slugs(dry), ["pip"]);
  assert.deepEqual([(await linksOf(app, id)).length, (await auditRows(app)).length], before);
});

test("deciding costs at most 3 reads, and the whole step at most 12 subrequests with the most links it may make", async () => {
  const { app, members, strangers, id } = await votingWorld();
  for (const slug of ["alpha", "bravo", "charlie"]) await subject(app, { slug, kind: "topic", name: slug });
  const c = counted(app.env.DB);
  const decided = await assignMemory({ DB: c.db }, { id, content: "alpha bravo charlie", neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.9, 0.9, 0.9, 0.9, 0.9]) });
  assert.equal(decided.links.length, 3);
  assert.ok(c.seen.calls <= 3, `reads ${c.seen.calls}`);

  const again = counted(app.env.DB);
  const counters = createCounters(app.env.DB, now);
  await afterSubjects({ ...ON, DB: again.db }, { id, content: "alpha bravo charlie and one more word cottage", neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.9, 0.9, 0.9, 0.9, 0.9]), now, counters });
  assert.equal((await linksOf(app, id)).length, 3);
  assert.ok(again.seen.calls <= 12, `subrequests ${again.seen.calls}`);
});

test("the step with a vote read, an ambiguous name and three links still fits in 12", async () => {
  const app = await createApp();
  for (const slug of ["alpha", "bravo", "charlie"]) await subject(app, { slug, kind: "topic", name: slug });
  await subject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog", aliases: ["rowan"] });
  await subject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee", aliases: ["rowan"] });
  const id = await mem(app, "x");
  const strangers = await Promise.all([1, 2, 3].map((i) => mem(app, `stranger ${i}`)));
  const c = counted(app.env.DB);
  await afterSubjects({ ...ON, DB: c.db }, { id, content: "alpha bravo charlie rowan", neighbours: near(strangers, [0.9, 0.8, 0.7]), now, counters: createCounters(app.env.DB, now) });
  assert.equal((await linksOf(app, id)).length, 3);
  assert.equal((await auditRows(app)).length, 4);
  assert.ok(c.seen.calls <= 12, `subrequests ${c.seen.calls}`);
});

// ---------------------------------------------------------------- the step after a write

test("with either flag off the step writes nothing and reads nothing", async () => {
  for (const flags of [{}, { SUBJECTS: "on" }, { SUBJECTS_AUTO: "on" }]) {
    const app = await createApp();
    await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
    const id = await mem(app, "x");
    const c = counted(app.env.DB);
    const counters = createCounters(app.env.DB, now);
    await afterSubjects({ ...flags, DB: c.db }, { id, content: "Pip is here", neighbours: [], hint: { name: "Wren", kind: "pet" }, now, counters, propose: () => assert.fail("proposed") });
    assert.equal(c.seen.calls, 0, JSON.stringify(flags));
    assert.deepEqual(await linksOf(app, id), []);
    assert.deepEqual(await auditRows(app), []);
  }
});

test("with both flags on the step writes system links and one audit row for each", async () => {
  const app = await createApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  const counters = createCounters(app.env.DB, now);
  await afterSubjects({ ...app.env, ...ON }, { id, content: "Pip is here", neighbours: [], now, counters });
  assert.deepEqual(await linksOf(app, id), [{ target_id: pip, link_type: "about", made_by: "system", confidence: 1 }]);
  const [row, ...rest] = await auditRows(app);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { kind: row.actor_kind, actor: row.actor_id, method: row.method, route: row.route, status: row.status, script: row.script, ids: JSON.parse(row.memory_ids) },
    { kind: "system", actor: "assign", method: "SYSTEM", route: "assign.link", status: 200, script: "how:alias.conf:1.0", ids: [id, pip] },
  );
  await counters.flush();
  const count = async (name) => (await app.env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM counters WHERE name = ?").bind(name).first()).n;
  assert.equal(await count("subjects.assigned"), 1);
});

test("a vote writes its confidence into the audit row", async () => {
  const { app, members, strangers, id } = await votingWorld();
  await afterSubjects({ ...app.env, ...ON }, { id, content: "Nothing named here", neighbours: near([members[0], members[1], members[2], strangers[0], strangers[1]], [0.9, 0.85, 0.8, 0.7, 0.6]), now, counters: createCounters(app.env.DB, now) });
  const [row] = await auditRows(app);
  assert.equal(row.script, "how:vote.conf:0.54");
  assert.equal((await linksOf(app, id))[0].confidence, 0.54);
});

test("an ambiguous name links nothing, writes one assign.ambiguous row and bumps the counter", async () => {
  const app = await createApp();
  const dog = await subject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog", aliases: ["rowan"] });
  const colleague = await subject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee", aliases: ["rowan"] });
  const id = await mem(app, "x");
  const counters = createCounters(app.env.DB, now);
  await afterSubjects({ ...app.env, ...ON }, { id, content: "Rowan said hello", neighbours: [], now, counters });
  assert.deepEqual(await linksOf(app, id), []);
  const rows = await auditRows(app);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].route, rows[0].script, rows[0].status, JSON.parse(rows[0].memory_ids)], ["assign.ambiguous", "how:ambiguous.n:2", 200, [id, dog, colleague]]);
  await counters.flush();
  assert.equal((await app.env.DB.prepare("SELECT count FROM counters WHERE name = 'subjects.ambiguous'").first()).count, 1);
});

test("the hint goes to the proposal step only when nothing was linked", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const calls = [];
  const propose = async (env, args) => calls.push(args);
  const hint = { name: "Wren", kind: "pet" };
  const linked = await mem(app, "a");
  await afterSubjects({ ...app.env, ...ON }, { id: linked, content: "Pip and Wren", neighbours: [], hint, now, counters: createCounters(app.env.DB, now), propose });
  assert.deepEqual(calls, [], "something was linked, so no proposal");
  const lonely = await mem(app, "b");
  await afterSubjects({ ...app.env, ...ON }, { id: lonely, content: "Wren is new", neighbours: [], hint, now, counters: createCounters(app.env.DB, now), propose });
  assert.deepEqual(calls.map((c) => [c.memoryId, c.hint]), [[lonely, hint]]);
  await afterSubjects({ ...app.env, ...ON }, { id: lonely, content: "Wren is new", neighbours: [], now, counters: createCounters(app.env.DB, now), propose });
  assert.equal(calls.length, 1, "no hint, no proposal");
});

test("the step never throws: a failing database or a failing proposal is counted and swallowed", async () => {
  const app = await createApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const id = await mem(app, "x");
  const counters = createCounters(app.env.DB, now);
  const broken = { prepare: () => { throw new Error("D1 is down"); }, batch: () => { throw new Error("D1 is down"); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    await afterSubjects({ ...ON, DB: broken }, { id, content: "Pip", neighbours: [], now, counters });
    await afterSubjects({ ...app.env, ...ON }, { id, content: "Wren", neighbours: [], hint: { name: "Wren", kind: "pet" }, now, counters, propose: async () => { throw new Error("no"); } });
  } finally {
    console.error = quiet;
  }
  await counters.flush();
  assert.equal((await app.env.DB.prepare("SELECT count FROM counters WHERE name = 'subjects.failed'").first()).count, 2);
});

test("a card or memory that vanishes between the read and the write counts as failed and the others still link", async () => {
  const app = await createApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const dana = await subject(app, { slug: "dana", kind: "person", name: "Dana" });
  const id = await mem(app, "x");
  // The card of Pip goes to the trash right after the candidates were read.
  const real = app.env.DB;
  let reads = 0;
  const racing = {
    prepare: (sql) => {
      const st = real.prepare(sql);
      if (!/FROM subjects s JOIN memories/.test(sql)) return st;
      return { bind: (...a) => { const b = st.bind(...a); return { all: async () => { const r = await b.all(); reads++; await storeOf(app).softDelete(pip); return r; } }; } };
    },
    batch: (list) => real.batch(list),
  };
  const counters = createCounters(real, now);
  await afterSubjects({ ...ON, DB: racing }, { id, content: "Pip and Dana", neighbours: [], now, counters });
  assert.equal(reads, 1);
  assert.deepEqual((await linksOf(app, id)).map((l) => l.target_id), [dana]);
  await counters.flush();
  assert.equal((await real.prepare("SELECT count FROM counters WHERE name = 'subjects.failed'").first()).count, 1);
});

// ---------------------------------------------------------------- through the write path

async function pipelineApp(env = ON, answers = {}) {
  const app = await createApp({ env });
  scriptModel(app.env.AI, { ...QUIET, "contradiction-detect": { match: 0 }, ...answers });
  return app;
}
const linkRows = async (app, id) => (await app.call(`/links?id=${id}`)).json.links;

test("a write that names a subject gets a system link, and the reply does not wait for it", async () => {
  const app = await pipelineApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const res = await put(app, "Pip chewed the sofa again");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["id", "ok", "status", "tags"], "the reply has no subject fields");
  const links = await linkRows(app, res.json.id);
  assert.deepEqual(links.map((l) => [l.type, l.direction, l.other_id, l.made_by, l.confidence]), [["about", "out", pip, "system", 1]]);
  const audit = (await app.call("/audit?actor=assign")).json.entries;
  assert.deepEqual(audit.map((e) => [e.actor_kind, e.route, e.script, e.status]), [["system", "assign.link", "how:alias.conf:1.0", 200]]);
});

test("with SUBJECTS_AUTO off a write links nothing, and nothing new is audited", async () => {
  for (const env of [{ SUBJECTS: "on" }, { SUBJECTS_AUTO: "on" }, {}]) {
    const app = await pipelineApp(env);
    await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
    const res = await put(app, "Pip chewed the sofa again");
    assert.deepEqual(await linkRows(app, res.json.id), [], JSON.stringify(env));
    assert.deepEqual(await auditRows(app), []);
  }
});

test("a capture that updates a memory in place is matched by name too", async () => {
  const app = await pipelineApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const first = await put(app, "---\nname: dog-walk\ndescription: A walk\n---\nWe walked along the river", { source: "session-capture" });
  assert.deepEqual(await linkRows(app, first.json.id), []);
  app.clock.t += 1000;
  const again = await put(app, "---\nname: dog-walk\ndescription: A walk\n---\nWe walked along the river with Pip", { source: "session-capture" });
  assert.equal(again.json.updated, true);
  assert.deepEqual((await linkRows(app, again.json.id)).map((l) => l.other_id), [pip]);
});

test("removing a system link writes a rejection, and the next write of that memory does not remake it", async () => {
  const app = await pipelineApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const body = (extra) => `---\nname: dog-walk\ndescription: A walk\n---\nWe walked along the river ${extra} with Pip`;
  const first = await put(app, body("once"), { source: "session-capture" });
  assert.equal((await linkRows(app, first.json.id)).length, 1);
  const gone = await app.call("/unlink", { method: "POST", body: { source_id: first.json.id, target_id: pip, type: "about" } });
  assert.deepEqual(gone.json, { ok: true, removed: true });
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM link_rejections WHERE source_id = ? AND target_id = ?").bind(first.json.id, pip).first()).n, 1);
  assert.deepEqual(await linkRows(app, first.json.id), []);
  app.clock.t += 1000;
  const again = await put(app, body("twice"), { source: "session-capture" });
  assert.equal(again.json.id, first.json.id);
  assert.deepEqual(await linkRows(app, again.json.id), [], "a person said no, so the system does not ask again");
  assert.equal((await auditRows(app)).length, 1, "only the first link was audited");
});

test("a device token cannot remove a link the system made", async () => {
  const app = await pipelineApp();
  const pip = await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  const res = await put(app, "Pip chewed the sofa");
  const d = await device(app, { allowPrivate: true });
  const refused = await app.call("/unlink", { method: "POST", token: d.token, body: { source_id: res.json.id, target_id: pip, type: "about" } });
  assert.equal(refused.status, 403);
  assert.equal((await linkRows(app, res.json.id)).length, 1);
});

test("a system audit row shows in GET /audit, in the filters and in the dashboard facets, as the caller Anymem", async () => {
  const app = await pipelineApp();
  await subject(app, { slug: "pip", kind: "pet", name: "Pip" });
  await put(app, "Pip chewed the sofa");
  const all = (await app.call("/audit")).json.entries;
  const mine = all.find((e) => e.actor_kind === "system");
  assert.equal(mine.harness, "system");
  assert.equal(mine.harness_label, "Anymem");
  assert.equal(mine.method, "SYSTEM");
  assert.equal((await app.call("/audit?harness=system")).json.entries.length, 1);
  assert.equal((await app.call("/audit?route=assign.link")).json.entries.length, 1);
  assert.equal((await app.call("/audit?result=ok")).json.entries.some((e) => e.actor_kind === "system"), true);
  const facets = await app.call("/ui/api/audit-facets");
  assert.equal(facets.status, 200);
  assert.ok(facets.json.harnesses.some((h) => h.harness === "system" && h.label === "Anymem"));
  assert.ok(facets.json.routes.some((r) => r.route === "assign.link"));
});

// The neighbours of a write that a device may not see do not count as votes. Three hidden memories sit closer than three
// shared ones, so counted they would fill three of the five places and the shared subject would get two votes, not three.
const variant = (swap, tag) => THIRTY_WORDS.map((w, i) => (i < swap ? `${tag}${i}x` : w)).join(" ");

async function neighbourWorld() {
  const app = await pipelineApp();
  const open = await subject(app, { slug: "cottage", kind: "asset", name: "the Cottage" });
  const secret = await subject(app, { slug: "vault-room", kind: "area", name: "the vault room", scope: "private" });
  for (let i = 0; i < 3; i++) await about(app, await mem(app, variant(2, `h${i}`)), secret);
  for (let i = 0; i < 3; i++) await about(app, await mem(app, variant(3, `s${i}`)), open);
  return { app, open, secret };
}

test("the sample texts have the similarities the neighbour test relies on", () => {
  const base = THIRTY_WORDS.join(" ");
  for (let i = 0; i < 3; i++) {
    assert.ok(cosine(base, variant(2, `h${i}`)) > 0.92 && cosine(base, variant(2, `h${i}`)) < 0.95);
    assert.ok(cosine(base, variant(3, `s${i}`)) > 0.88 && cosine(base, variant(3, `s${i}`)) < 0.92);
  }
});

test("a device that may not see private subjects is linked by the votes of the memories it may see", async () => {
  const { app, open } = await neighbourWorld();
  const closed = await device(app, { allowPrivate: false });
  const res = await put(app, THIRTY_WORDS.join(" "), {}, { token: closed.token });
  assert.equal(res.status, 200);
  const links = await linkRows(app, res.json.id);
  assert.deepEqual(links.map((l) => [l.other_id, l.made_by]), [[open, "system"]]);
  assert.ok(links[0].confidence >= 0.5 && links[0].confidence < 0.6, `confidence ${links[0].confidence}`);
});

test("the admin, who sees every neighbour, is linked by the closest ones", async () => {
  const { app, secret } = await neighbourWorld();
  const res = await put(app, THIRTY_WORDS.join(" "));
  const links = await linkRows(app, res.json.id);
  assert.deepEqual(links.map((l) => l.other_id), [secret], "three hidden votes at 0.93 beat two shared votes");
});

test("a write by a closed device whose text names a private subject is not linked to it", async () => {
  const app = await pipelineApp();
  const secret = await subject(app, { slug: "vault-room", kind: "area", name: "the vault room", scope: "private" });
  const closed = await device(app, { allowPrivate: false });
  const open = await device(app, { allowPrivate: true });
  const a = await put(app, "Checked the vault room today", {}, { token: closed.token });
  assert.deepEqual(await linkRows(app, a.json.id), [], "the memory stays visible to the device that wrote it");
  assert.equal((await app.call(`/entry?id=${a.json.id}`, { token: closed.token })).status, 200);
  const b = await put(app, "Checked the vault room again", {}, { token: open.token });
  assert.deepEqual((await linkRows(app, b.json.id)).map((l) => l.other_id), [secret]);
});
