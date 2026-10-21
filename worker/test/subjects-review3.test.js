// The third review of phase 3c. A person's own brief survives a forget, a clear that cannot finish stops the request instead of
// leaving text readable, a plain link between memories never takes a memory's shared links away, an old backup cannot bring back what
// was taken away, a person's own link is never deleted by the system, and the nightly backup clear runs first. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SMALL_MODEL } from "../ai.js";
import { briefsStep } from "../cron/briefs.js";
import { createBudget, countedEnv } from "../cron/budget.js";
import { createStore } from "../memory/store.js";
import { createProposed } from "../subjects/propose.js";
import { createApp } from "./helpers/app.js";
import { DAY, dump, row, rows, restore, runNightly, seed } from "./helpers/maintenance.js";
import { about, addSubject, device } from "./helpers/subjects.js";
import { NEW_FACT, NEW_WINS, OLD_FACT, put, QUIET, scriptModel } from "./helpers/write.js";

const ALL = { SUBJECTS: "on", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "on" };
const SECRET = "Dana stays at the cottage when she is sick.";
const blocks = (prompt) => [...prompt.matchAll(/<memory id="([^"]+)" date="([^"]+)">\n([\s\S]*?)\n<\/memory>/g)].map((m) => ({ id: m[1], text: m[3] }));
const post = (app, path, body, opts = {}) => app.call(path, { method: "POST", body, ...opts });
const status = async (app, closed, id) => (await app.call(`/entry?id=${id}`, { token: closed.token })).status;
const derived = (app, card) => rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", card);
const aboutLinks = (app, id) => rows(app, "SELECT target_id, made_by, confidence FROM links WHERE source_id = ? AND link_type = 'about' ORDER BY target_id", id);

/** The model copies the last line of each memory it is shown, citing it. */
function model(app) {
  app.env.AI.reply(SMALL_MODEL, async (input) => ({ response: { lines: blocks(input.messages[1].content).map((b) => ({ section: "now", text: b.text.split("\n").at(-1), ids: [b.id] })) } }));
}
async function night(app) {
  const now = () => app.clock.t;
  const budget = createBudget({ now, subrequests: 500 });
  return briefsStep(countedEnv(app.env, budget), { now, budget });
}
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
/** The database with a call that fails: prepare throws for a statement matching `select`, a batch fails when one of its statements matches `batch`. */
function breakDb(app, { select, batch }) {
  const real = app.env.DB;
  const state = { armed: true };
  app.env.DB = {
    prepare: (sql) => {
      if (state.armed && select?.test(sql)) throw new Error("D1 down");
      return real.prepare(sql);
    },
    batch: async (list) => {
      if (state.armed && batch && list.some((s) => batch.test(s.sql))) throw new Error("D1 batch failed");
      return real.batch(list);
    },
    exec: (sql) => real.exec(sql),
  };
  return () => {
    state.armed = false;
    app.env.DB = real;
  };
}
const CITING = /derived_from' AND l\.target_id IN/;
const BLANKING = /DELETE FROM memory_versions/;

// ------------------------------------------------------------------ 1: a person's own brief

test("a person's own brief, saved after a system build, is not wiped when a member the build cited is forgotten", async () => {
  const { app, cottage, m } = await world();
  assert.equal((await derived(app, cottage)).length, 1, "the build cites the member");
  const mine = "Our cottage. Mum's room is the blue one.";
  assert.equal((await post(app, "/subject/update", { slug: "cottage", brief: mine })).status, 200);
  assert.equal((await derived(app, cottage)).length, 0, "the person's text cites nothing");
  assert.equal((await post(app, "/forget", { id: m })).status, 200);
  assert.equal((await row(app, cottage)).body, mine);
  const versions = await rows(app, "SELECT snapshot FROM memory_versions WHERE memory_id = ?", cottage);
  assert.ok(versions.length >= 2, "the history of the card is still there");
  assert.ok(versions.some((v) => /Dana stays/.test(JSON.parse(v.snapshot).body)), "including the system's earlier text");
  // the member that was forgotten is the person's to restore, and the brief is still theirs
  assert.equal((await post(app, "/restore", { id: m })).status, 200);
  assert.equal((await row(app, cottage)).body, mine);
});

test("a change of name keeps the links of a system build, because the brief itself did not change, and a brief saved with the same text does too", async () => {
  const { app, cottage, m } = await world();
  assert.equal((await post(app, "/subject/update", { slug: "cottage", name: "The Cottage" })).status, 200);
  assert.equal((await derived(app, cottage)).length, 1);
  const same = (await row(app, cottage)).body;
  assert.equal((await post(app, "/subject/update", { slug: "cottage", brief: same })).status, 200);
  assert.equal((await derived(app, cottage)).length, 1, "the same text is not a new brief");
  // so forgetting the cited member still blanks the system's text
  assert.equal((await post(app, "/forget", { id: m })).status, 200);
  assert.equal((await row(app, cottage)).body, "");
});

test("a subject made with a brief has no derived_from links, and forgetting a member of it leaves the brief alone", async () => {
  const app = await createApp({ env: ALL });
  const made = (await post(app, "/subject", { slug: "garden", kind: "area", name: "Garden", brief: "The garden is the long one by the lane." })).json.subject;
  const m = await seed(app, { name: "g", text: "The garden gate sticks.", origin: "capture" });
  await about(app, m, made.id);
  assert.equal((await derived(app, made.id)).length, 0);
  await post(app, "/forget", { id: m });
  assert.equal((await row(app, made.id)).body, "The garden is the long one by the lane.");
});

// ------------------------------------------------------------------ 2: the clear comes first and fails closed

test("a link to a private subject whose clear cannot be read is refused and stores nothing", async () => {
  const { app, cottage, dana, m, closed } = await world();
  const restoreDb = breakDb(app, { select: CITING });
  const res = await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  restoreDb();
  assert.equal(res.status, 500);
  assert.equal((await aboutLinks(app, m)).filter((l) => l.target_id === dana).length, 0, "the link was not stored");
  assert.equal(await status(app, closed, m), 200, "the memory is still where it was");
  assert.match((await row(app, cottage)).body, /Dana stays/, "nothing was half done");
  // and the same request goes through once the database answers
  assert.equal((await post(app, "/link", { source_id: m, target_id: dana, type: "about" })).status, 200);
  assert.equal((await row(app, cottage)).body, "");
});

test("a link to a private subject whose blanking fails is refused too, not answered with a 200 and readable text", async () => {
  const { app, dana, m } = await world();
  const restoreDb = breakDb(app, { batch: BLANKING });
  const res = await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  restoreDb();
  assert.equal(res.status, 500);
  assert.equal((await aboutLinks(app, m)).filter((l) => l.target_id === dana).length, 0);
});

test("a forget whose clear cannot finish fails, and the memory stays", async () => {
  for (const [name, fault] of [["read", { select: CITING }], ["blank", { batch: BLANKING }]]) {
    const { app, cottage, m } = await world();
    const restoreDb = breakDb(app, fault);
    const res = await post(app, "/forget", { id: m });
    restoreDb();
    assert.equal(res.status, 500, name);
    assert.equal((await row(app, m)).deleted_at, null, `${name}: the memory was not forgotten`);
    assert.match((await row(app, cottage)).body, /Dana stays/, `${name}: and its text still belongs to a live memory`);
    assert.equal((await post(app, "/forget", { id: m })).status, 200, `${name}: the retry works`);
    assert.equal((await row(app, cottage)).body, "");
  }
});

test("a read between the clear and the change finds the brief already blank, for a link and for a forget", async () => {
  for (const act of ["link", "forget"]) {
    const { app, cottage, dana, m, closed } = await world();
    const real = app.env.DB;
    const seen = [];
    // the closed device reads the card right after the batch that stores the change, which is the moment the old order left the text readable
    const mark = act === "link" ? /INSERT OR IGNORE INTO links \(source_id, target_id, link_type, created_at, made_by, confidence\) VALUES/ : /UPDATE memories SET deleted_at/;
    app.env.DB = {
      prepare: (sql) => real.prepare(sql),
      exec: (sql) => real.exec(sql),
      batch: async (list) => {
        const out = await real.batch(list);
        if (list.some((s) => mark.test(s.sql))) seen.push((await real.prepare("SELECT body FROM memories WHERE id = ?").bind(cottage).first()).body);
        return out;
      },
    };
    const res = act === "link" ? await post(app, "/link", { source_id: m, target_id: dana, type: "about" }) : await post(app, "/forget", { id: m });
    app.env.DB = real;
    assert.equal(res.status, 200, act);
    assert.deepEqual(seen, [""], `${act}: the card was blank by the time the change was stored`);
    assert.equal(await status(app, closed, cottage), 200);
  }
});

test("a brief built between the first clear and the link is blanked by the second clear", async () => {
  const { app, cottage, dana, m } = await world();
  const real = app.env.DB;
  const text = (await row(app, cottage)).content;
  let rebuilt = false;
  // the build lands right after the first clear has blanked the card: the brief is back, with its citation
  app.env.DB = {
    prepare: (sql) => real.prepare(sql),
    exec: (sql) => real.exec(sql),
    batch: async (list) => {
      const out = await real.batch(list);
      if (!rebuilt && list.some((s) => BLANKING.test(s.sql))) {
        rebuilt = true;
        await real.batch([
          real.prepare("UPDATE memories SET body = ?, content = ? WHERE id = ?").bind(`Now\n- ${SECRET}`, text, cottage),
          real.prepare("INSERT INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, 'derived_from', ?, 'system', NULL)").bind(cottage, m, app.clock.t),
        ]);
      }
      return out;
    },
  };
  const res = await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  app.env.DB = real;
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(rebuilt);
  assert.equal((await row(app, cottage)).body, "");
  assert.equal((await derived(app, cottage)).length, 0);
});

test("a capture that replaces a memory a brief cites does not replace it when the brief cannot be blanked", async () => {
  const app = await createApp({ env: ALL });
  const answers = { ...QUIET, "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS };
  scriptModel(app.env.AI, answers);
  const staging = await addSubject(app, { slug: "staging", kind: "project", name: "Staging" });
  const old = (await put(app, OLD_FACT)).json.id;
  await about(app, old, staging);
  model(app);
  app.clock.t += 1000;
  assert.equal((await night(app)).built, 1);
  scriptModel(app.env.AI, answers);
  app.clock.t += 1000;
  const restoreDb = breakDb(app, { batch: BLANKING });
  const res = await put(app, NEW_FACT);
  restoreDb();
  assert.equal(res.status, 200, "the capture itself is stored");
  assert.equal(res.json.replaced, undefined);
  assert.deepEqual(res.json.kept_both, { id: old, reason: "unsure" });
  assert.equal((await row(app, old)).valid_until, null, "the old memory is still live, so the brief that cites it is still true to its source");
});

test("with every switch off a forget costs no more database calls than before, and a link between memories or to a shared subject none more", async () => {
  const app = await createApp({ env: {} });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const a = await seed(app, { name: "a", text: "alpha note about nothing special", origin: "capture" });
  const b = await seed(app, { name: "b", text: "beta note about something else", origin: "capture" });
  const c = await seed(app, { name: "c", text: "gamma note about stuff", origin: "capture" });
  const calls = async (path, body) => {
    const real = app.env.DB;
    const budget = createBudget({ now: () => app.clock.t, subrequests: 10000 });
    app.env.DB = countedEnv({ ...app.env, DB: real }, budget).DB;
    assert.equal((await post(app, path, body)).status, 200);
    await app.settle();
    app.env.DB = real;
    return budget.spent;
  };
  // measured on the branch before this round: forget 9, about link to a shared subject 7, link between memories 6
  assert.ok((await calls("/forget", { id: c })) <= 9, "forget");
  assert.ok((await calls("/link", { source_id: a, target_id: cottage, type: "about" })) <= 7, "about link to a shared subject");
  assert.ok((await calls("/link", { source_id: a, target_id: b, type: "related" })) <= 6, "link between memories");
});

test("a link to a private subject costs no more database calls than before this round", async () => {
  const app = await createApp({ env: {} });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const a = await seed(app, { name: "a", text: "alpha note about nothing special", origin: "capture" });
  const real = app.env.DB;
  const budget = createBudget({ now: () => app.clock.t, subrequests: 10000 });
  app.env.DB = countedEnv({ ...app.env, DB: real }, budget).DB;
  assert.equal((await post(app, "/link", { source_id: a, target_id: dana, type: "about" })).status, 200);
  await app.settle();
  app.env.DB = real;
  assert.ok(budget.spent <= 8, `${budget.spent} calls`); // 8 before this round
});

// ------------------------------------------------------------------ 3: the shed only fires for a link to a private subject

async function mixed() {
  const app = await createApp({ env: ALL });
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "g", text: "Garden and dana note.", origin: "capture" });
  const x = await seed(app, { name: "x", text: "an unrelated note about x.", origin: "capture" });
  const closed = await device(app, { allowPrivate: false });
  // the state an old store or a restore leaves: a system link to a shared subject next to a link to a private one
  const link = (target, by) => app.env.DB.prepare("INSERT INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, 'about', ?, ?, ?)").bind(m, target, app.clock.t, by, by === "system" ? 1 : null).run();
  await link(garden, "system");
  await link(dana, "system");
  return { app, garden, dana, m, x, closed };
}

test("a link between two memories, or to a shared subject, never takes a memory's shared links away, so a device cannot make a member vanish", async () => {
  const { app, garden, m, x, closed } = await mixed();
  assert.equal(await status(app, closed, m), 200, "the memory is visible through its shared link");
  for (const type of ["related", "about"]) {
    assert.equal((await post(app, "/link", { source_id: m, target_id: x, type }, { token: closed.token })).status, 200, type);
    assert.equal(await status(app, closed, m), 200, `${type}: still visible`);
  }
  const other = await addSubject(app, { slug: "lane", kind: "area", name: "Lane" });
  assert.equal((await post(app, "/link", { source_id: m, target_id: other, type: "about" })).status, 200);
  assert.equal(await status(app, closed, m), 200);
  assert.ok((await aboutLinks(app, m)).some((l) => l.target_id === garden && l.made_by === "system"), "the system's link to the garden is still there");
});

test("a link to a private subject still takes the system's shared links away", async () => {
  const { app, garden, m, closed } = await mixed();
  const lane = await addSubject(app, { slug: "lane", kind: "area", name: "Lane" });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  assert.equal((await post(app, "/link", { source_id: m, target_id: pip, type: "about" })).status, 200);
  assert.ok(!(await aboutLinks(app, m)).some((l) => l.target_id === garden), "gone");
  assert.equal(await status(app, closed, m), 404);
  void lane;
});

test("a private subject that turns shared drops the system's links to it from members that belong to another private subject", async () => {
  const app = await createApp({ env: ALL });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const both = await seed(app, { name: "both", text: "Pip bites Dana.", origin: "capture" });
  const only = await seed(app, { name: "only", text: "Pip likes the beach.", origin: "capture" });
  const mine = await seed(app, { name: "mine", text: "Pip, Dana and me at the vet.", origin: "capture" });
  const store = createStore(app.env.DB, () => app.clock.t);
  for (const id of [both, only]) await store.link(id, pip, "about", { madeBy: "system", confidence: 1 });
  await store.link(both, dana, "about", { madeBy: "system", confidence: 1 });
  await store.link(mine, pip, "about"); // the person's own link
  await store.link(mine, dana, "about");
  const closed = await device(app, { allowPrivate: false });
  assert.deepEqual([await status(app, closed, both), await status(app, closed, only), await status(app, closed, mine)], [404, 404, 404]);
  assert.equal((await post(app, "/subject/update", { slug: "pip", scope: "shared" })).status, 200);
  assert.deepEqual([await status(app, closed, both), await status(app, closed, only), await status(app, closed, mine)], [404, 200, 200], "only the member that is nowhere else visible is now visible, and the person's own link stays");
  assert.deepEqual((await aboutLinks(app, both)).map((l) => l.target_id), [dana]);
  assert.deepEqual((await aboutLinks(app, only)).map((l) => l.target_id), [pip]);
  assert.equal((await rows(app, "SELECT * FROM link_rejections")).length, 0, "it is not a rejection");
});

// ------------------------------------------------------------------ 4: an old backup does not bring links back

test("restoring an older backup does not bring back a system link to a shared subject, or a brief citation, of a memory that is private now", async () => {
  const { app, cottage, dana, m, closed } = await world();
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const store = createStore(app.env.DB, () => app.clock.t);
  await store.link(m, garden, "about", { madeBy: "system", confidence: 1 });
  await post(app, "/unlink", { source_id: m, target_id: cottage, type: "about" }); // the person's own link to the cottage is gone, the brief's citation of the memory is not
  const old = (await app.call("/export")).json;
  assert.ok(old.links.some((l) => l.link_type === "derived_from"), "the old backup holds the citation");
  await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  assert.equal((await derived(app, cottage)).length, 0);
  assert.equal(await status(app, closed, m), 404);
  await restore(app, old);
  assert.equal(await status(app, closed, m), 404, "still hidden");
  assert.ok(!(await aboutLinks(app, m)).some((l) => l.target_id === garden), "the shared system link did not come back");
  assert.equal((await derived(app, cottage)).length, 0, "nor the citation");
  assert.equal((await row(app, cottage)).body, "");
});

test("an import of a backup that holds a link a person made keeps it", async () => {
  const app = await createApp({ env: ALL });
  const garden = await addSubject(app, { slug: "garden", kind: "area", name: "Garden" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "g", text: "Garden and dana note.", origin: "capture" });
  await about(app, m, garden);
  await about(app, m, dana);
  const before = (await dump(app)).links;
  await restore(app, (await app.call("/export")).json);
  assert.deepEqual((await dump(app)).links, before);
});

// ------------------------------------------------------------------ 5: accepting keeps a link a person made

test("accepting a proposal, or bringing one back, keeps the link a person made to it and drops only the system's", async () => {
  for (const way of ["accept", "revive"]) {
    const app = await createApp({ env: ALL });
    const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
    const system = await seed(app, { name: "rowan-a", text: "Rowan the vet gave new tablets for the dog.", origin: "capture" });
    const person = await seed(app, { name: "rowan-b", text: "Rowan the vet is on Main Road.", origin: "capture" });
    const open = await seed(app, { name: "rowan-c", text: "Rowan the vet is open on Saturdays.", origin: "capture" });
    const made = await createProposed(app.env, { name: "Rowan", kind: "person", evidence: [{ id: system, confidence: 1 }, { id: open, confidence: 1 }], now: () => app.clock.t });
    if (way === "revive") await post(app, "/subject/dismiss", { slug: "rowan" });
    await about(app, person, made.id); // the person files this one under Rowan themselves
    for (const id of [system, person]) await app.env.DB.prepare("INSERT INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, 'about', ?, 'user', NULL)").bind(id, dana, app.clock.t).run();
    const res = way === "accept" ? await post(app, "/subject/accept", { slug: "rowan" }) : await post(app, "/subject/update", { slug: "rowan", status: "active" });
    assert.equal(res.status, 200, way);
    const left = (await rows(app, "SELECT source_id, made_by FROM links WHERE target_id = ? AND link_type = 'about' ORDER BY source_id", made.id)).map((r) => [r.source_id, r.made_by]);
    assert.deepEqual(left.sort(), [[person, "user"], [open, "system"]].sort(), way);
  }
});

// ------------------------------------------------------------------ 6: a person's link on top of a system link

test("a person who links what the system linked takes the link over: it is theirs, with no confidence, and the shed leaves it", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const dana = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "k", text: "The cottage keys hang by the back door.", origin: "capture" });
  const store = createStore(app.env.DB, () => app.clock.t);
  await store.link(m, cottage, "about", { madeBy: "system", confidence: 0.9 });
  const res = await post(app, "/link", { source_id: m, target_id: cottage, type: "about" });
  assert.deepEqual(res.json, { ok: true, created: false });
  assert.deepEqual((await aboutLinks(app, m)).map((l) => [l.made_by, l.confidence]), [["user", null]]);
  await post(app, "/link", { source_id: m, target_id: dana, type: "about" });
  assert.deepEqual((await aboutLinks(app, m)).map((l) => l.made_by), ["user", "user"], "the person's link to the cottage stays");
  // the system can never take it back: its own link call changes nothing, and a person's link is not downgraded
  assert.deepEqual(await store.link(m, cottage, "about", { madeBy: "system", confidence: 0.5 }), { created: false });
  assert.deepEqual((await aboutLinks(app, m)).map((l) => [l.made_by, l.confidence]), [["user", null], ["user", null]]);
});

// ------------------------------------------------------------------ 7: the nightly clear runs first

test("the nightly clear is the first step, and a reindex backlog cannot starve it on the Free budget", async () => {
  const app = await createApp({ env: ALL });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const m = await seed(app, { name: "cottage-note", text: SECRET, origin: "capture", ageDays: 3 });
  await about(app, m, cottage);
  model(app);
  app.clock.t += 1000;
  assert.equal((await night(app)).built, 1);
  // a path that missed the clear: the member goes to the trash behind the routes' back
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(app.clock.t, m).run();
  scriptModel(app.env.AI, { ...QUIET });
  for (let i = 0; i < 80; i++) await seed(app, { name: `n${i}`, text: `note number ${i} about topic ${i * 17}`, origin: "capture", ageDays: 3 });
  app.clock.t += DAY;
  const out = await runNightly(app);
  assert.equal(Object.keys(out.summary)[0], "clear");
  assert.equal(out.summary.clear.cleared, 1);
  assert.equal((await row(app, cottage)).body, "", "gone on the first night, not after the backlog");
  assert.ok(out.summary.reindex.remaining > 0, "the backlog is still there");
});

test("the clear step blanks at most 8 cards a night, the rest the next night, and does nothing for a store without subjects", async () => {
  const app = await createApp({ env: {} });
  assert.deepEqual((await runNightly(app, { steps: ["clear"] })).summary.clear, { cleared: 0, subrequests: 1, ms: 0 }, "one read when there is nothing to do");
  const gone = await seed(app, { name: "gone", text: "A memory that went.", origin: "capture", deleted_at: app.clock.t });
  for (let i = 0; i < 10; i++) {
    const card = await addSubject(app, { slug: `card-${i}`, kind: "area", name: `Card ${i}`, brief: `Brief number ${i} of the card.` });
    await app.env.DB.prepare("INSERT INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, 'derived_from', ?, 'system', NULL)").bind(card, gone, app.clock.t).run();
  }
  assert.equal((await runNightly(app, { steps: ["clear"] })).summary.clear.cleared, 8);
  assert.equal((await runNightly(app, { steps: ["clear"] })).summary.clear.cleared, 2);
  assert.equal((await runNightly(app, { steps: ["clear"] })).summary.clear.cleared, 0);
  assert.equal((await rows(app, "SELECT * FROM links WHERE link_type = 'derived_from'")).length, 0);
});

test("the clear step leaves a run with too little budget alone, and says so", async () => {
  const app = await createApp({ env: {} });
  const out = await runNightly(app, { steps: ["clear"], subrequests: 3 });
  assert.deepEqual([out.summary.clear.cleared, out.summary.clear.skipped, out.summary.clear.subrequests], [0, "budget", 0]);
});
