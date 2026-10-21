// The nightly brief step: who is rebuilt, what is saved, what a failed check or a dead model leaves behind, the budget, the
// private rule, retirement and backup. Every sample name is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SMALL_MODEL } from "../ai.js";
import { briefsStep, MAX_BUILDS } from "../cron/briefs.js";
import { createBudget, countedEnv } from "../cron/budget.js";
import { runMaintenance, STEPS } from "../cron/maintenance.js";
import { createApp } from "./helpers/app.js";
import { DAY, indexAll, row, rows, seed, storeOf } from "./helpers/maintenance.js";
import { note } from "./helpers/search.js";
import { about, addSubject, device } from "./helpers/subjects.js";
import { createProposed } from "../subjects/propose.js";
import { KINDS } from "../subjects/store.js";
import { memberHash } from "../subjects/brief.js";

const ON = { SUBJECTS: "on", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "on" };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** A subject with its members, written straight to the store. @returns {Promise<{card: string, ids: string[]}>} */
async function subject(app, slug, texts, over = {}) {
  const card = await addSubject(app, { slug, kind: over.kind ?? "pet", name: over.name ?? cap(slug), scope: over.scope, status: over.status, fields: over.fields });
  const ids = [];
  for (const [i, text] of texts.entries()) {
    ids.push(await seed(app, { name: `${slug}-note-${i}`, text, origin: "capture" }));
    await about(app, ids[i], card);
    app.clock.t += 10;
  }
  return { card, ids };
}

/** The memories of a prompt, as {id, date, text}. */
const blocks = (prompt) => [...prompt.matchAll(/<memory id="([^"]+)" date="([^"]+)">\n([\s\S]*?)\n<\/memory>/g)].map((m) => ({ id: m[1], date: m[2], text: m[3] }));
const subjectOf = (prompt) => /^Subject: (.+?) \(/m.exec(prompt)?.[1];

/**
 * The model, scripted. It writes one line for each memory it is shown, citing it and copying its last line. edit may change the
 * lines or do something to the store while the model is working. Every prompt is kept in app.prompts.
 */
function model(app, edit = async (lines) => lines) {
  app.prompts = [];
  app.env.AI.reply(SMALL_MODEL, async (input) => {
    const prompt = input.messages[1].content;
    app.prompts.push(prompt);
    const lines = blocks(prompt).map((b) => ({ section: "now", text: b.text.split("\n").at(-1), ids: [b.id] }));
    return { response: { lines: await edit(lines, prompt) } };
  });
}

async function run(app, { subrequests = 500 } = {}) {
  const now = () => app.clock.t;
  const budget = createBudget({ now, subrequests });
  const out = await briefsStep(countedEnv(app.env, budget), { now, budget });
  return { out, spent: budget.spent };
}

const world = async (env = ON) => createApp({ env });
const auditRows = (app) => rows(app, "SELECT * FROM audit ORDER BY id");
const subjectRow = (app, id) => row(app, id).then(() => app.env.DB.prepare("SELECT * FROM subjects WHERE id = ?").bind(id).first());

// ------------------------------------------------------------------ the flags

test("with any of the three flags off the step builds nothing, and only looks for text that must go", async () => {
  const cases = [{}, { SUBJECTS: "on" }, { SUBJECTS_AUTO: "on" }, { SUBJECTS: "off", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "on" }, { SUBJECTS: "on", SUBJECTS_AUTO: "off", SUBJECTS_BRIEFS: "on" }, { SUBJECTS: "on", SUBJECTS_AUTO: "on" }, { SUBJECTS: "on", SUBJECTS_AUTO: "on", SUBJECTS_BRIEFS: "off" }, { SUBJECTS: "on", SUBJECTS_BRIEFS: "on" }, { SUBJECTS_BRIEFS: "on" }];
  for (const env of cases) {
    const app = await world(env);
    const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
    model(app);
    const before = await subjectRow(app, card);
    const { out, spent } = await run(app);
    assert.deepEqual(out, { skipped: "off" }, JSON.stringify(env));
    assert.equal(spent, 1, "one read, the look for text that must go");
    assert.equal(app.env.AI.calls.length, 0);
    assert.deepEqual(await subjectRow(app, card), before);
    assert.equal((await auditRows(app)).length, 0);
  }
});

// ------------------------------------------------------------------ a good brief

test("a good brief is saved as a new version of the card, with derived_from links, the hash and the build time", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "The vet visit is on 3 November 2026."]);
  model(app);
  const before = (await row(app, card)).content;
  app.clock.t += 1000;
  const { out } = await run(app);
  assert.deepEqual(out, { candidates: 1, built: 1, stale: 0, failed: 0, conflicts: 0, retired: 0, cleared: 0, pinned: 0, remaining: 0 });
  const after = await row(app, card);
  assert.match(after.content, /^---\nname: pip\ndescription: pet card for Pip\n---\n\nNow\n- /);
  assert.match(after.body, /^Now\n- /);
  assert.ok(after.body.includes("Pip weighs 12 kilos.") && after.body.includes("The vet visit is on 3 November 2026."));
  // one version holds the old text, and the reason says why it changed
  const versions = await rows(app, "SELECT seq, reason, snapshot FROM memory_versions WHERE memory_id = ?", card);
  assert.deepEqual(versions.map((v) => v.reason), ["brief"]);
  assert.equal(JSON.parse(versions[0].snapshot).content, before);
  const links = await rows(app, "SELECT target_id, made_by, confidence FROM links WHERE source_id = ? AND link_type = 'derived_from' ORDER BY target_id", card);
  assert.deepEqual(links.map((l) => ({ ...l })), ids.map((id) => ({ target_id: id, made_by: "system", confidence: null })).sort((a, b) => (a.target_id < b.target_id ? -1 : 1)));
  const s = await subjectRow(app, card);
  assert.equal(s.status, "active");
  assert.equal(s.stale_reason, "");
  assert.equal(s.built_at, app.clock.t);
  const members = await rows(app, "SELECT id, updated_at FROM memories WHERE id IN (?, ?)", ...ids);
  assert.equal(s.member_hash, await memberHash(members));
  const audit = await auditRows(app);
  assert.equal(audit.length, 1);
  assert.deepEqual({ kind: audit[0].actor_kind, id: audit[0].actor_id, method: audit[0].method, route: audit[0].route, status: audit[0].status, script: audit[0].script }, { kind: "system", id: "brief", method: "SYSTEM", route: "brief.build", status: 200, script: "how:model.lines:2" });
  const touched = JSON.parse(audit[0].memory_ids);
  assert.equal(touched[0], card);
  assert.deepEqual(touched.slice(1).sort(), [...ids].sort());
  // undo goes back to the old brief
  await storeOf(app).undo(card);
  assert.equal((await row(app, card)).content, before);
});

test("a subject whose members have not changed is left alone, a changed member makes it a candidate again", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app);
  assert.equal((await run(app)).out.built, 1);
  const calls = app.env.AI.calls.length;
  app.clock.t += DAY;
  assert.deepEqual((await run(app)).out, { candidates: 0, built: 0, stale: 0, failed: 0, conflicts: 0, retired: 0, cleared: 0, pinned: 0, remaining: 0 });
  assert.equal(app.env.AI.calls.length, calls, "no model call when nothing changed");
  await storeOf(app).update({ id: ids[0], content: note("pip-note-0", "A sample.", "Pip weighs 13 kilos.") });
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 1);
  assert.equal(app.env.AI.calls.length, calls + 1);
  assert.match((await row(app, card)).body, /13 kilos/);
  // a new member also counts
  const extra = await seed(app, { name: "pip-extra", text: "Pip is a beagle.", origin: "capture" });
  await about(app, extra, card);
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 1);
  assert.deepEqual((await rows(app, "SELECT target_id FROM links WHERE source_id = ? AND link_type = 'derived_from'", card)).map((r) => r.target_id).sort(), [ids[0], extra].sort());
});

test("a rebuild replaces the derived_from links, so a member that is no longer cited loses its link", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "Pip is a beagle."]);
  model(app);
  await run(app);
  const links = async () => (await rows(app, "SELECT target_id FROM links WHERE source_id = ? AND link_type = 'derived_from'", card)).map((r) => r.target_id).sort();
  assert.deepEqual(await links(), [...ids].sort());
  await storeOf(app).unlink(ids[1], card, "about");
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 1);
  assert.deepEqual(await links(), [ids[0]]);
});

test("a brief with a hashtag in a member's text does not give the card a tag", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip likes #walks in the park."]);
  const tags = async () => (await rows(app, "SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag", card)).map((r) => r.tag);
  const before = await tags();
  model(app);
  await run(app);
  assert.match((await row(app, card)).body, /Pip likes walks in the park\./);
  assert.deepEqual(await tags(), before);
});

test("a subject with no live member, a trashed member or a closed member has nothing to build from", async () => {
  const app = await world();
  const lone = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  const empty = await subject(app, "corolla", [], { kind: "asset" });
  const gone = await subject(app, "dana", ["Dana lives in Cape Town."], { kind: "person" });
  await storeOf(app).softDelete(gone.ids[0]);
  const closed = await subject(app, "cottage", ["The Cottage roof is old."], { kind: "asset" });
  await storeOf(app).supersede(closed.ids[0], lone.ids[0], app.clock.t);
  model(app);
  const { out } = await run(app);
  assert.equal(out.built, 1, "only Pip");
  assert.equal(app.prompts.length, 1);
  assert.equal(subjectOf(app.prompts[0]), "Pip");
  assert.equal(empty.ids.length, 0);
});

test("the prompt holds the newest 20 members, each with its id and date", async () => {
  const app = await world();
  const { ids } = await subject(app, "pip", Array.from({ length: 25 }, (_, i) => `Pip fact number ${i}.`));
  model(app, async () => [{ section: "now", text: "Pip has facts.", ids: [ids.at(-1)] }]);
  await run(app);
  const shown = blocks(app.prompts[0]);
  assert.equal(shown.length, 20);
  assert.deepEqual(shown.map((b) => b.id), ids.slice(5).reverse(), "newest first");
  assert.match(shown[0].date, /^2026-/);
});

// ------------------------------------------------------------------ a brief that fails a check

const FORGERIES = [
  ["uncited_number", "check.uncited.number", async (lines) => lines.map((l, i) => (i === 0 ? { ...l, text: `${l.text} It was 7731 in all.` } : l))],
  ["foreign_id", "check.foreign.id", async (lines) => lines.map((l, i) => (i === 0 ? { ...l, ids: [...l.ids, "not-a-member"] } : l))],
  ["no_citation", "check.no.citation", async (lines) => [...lines, { section: "now", text: "Pip is a good dog.", ids: [] }]],
];

for (const [check, script, forge] of FORGERIES) {
  test(`a brief that fails ${check} leaves the old brief, marks the subject stale and says why, and a good build later clears it`, async () => {
    const app = await world();
    const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
    const old = await row(app, card);
    model(app, forge);
    const { out } = await run(app);
    assert.equal(out.stale, 1);
    assert.equal(out.built, 0);
    assert.equal(out.refused, undefined, "a failed check is not a failed run");
    const kept = await row(app, card);
    assert.equal(kept.content, old.content, "the old brief stays");
    assert.equal(kept.updated_at, old.updated_at);
    assert.equal((await rows(app, "SELECT * FROM memory_versions WHERE memory_id = ?", card)).length, 0);
    assert.equal((await rows(app, "SELECT * FROM links WHERE link_type = 'derived_from'")).length, 0);
    const s = await subjectRow(app, card);
    assert.deepEqual({ status: s.status, reason: s.stale_reason, built: s.built_at, hash: s.member_hash }, { status: "stale", reason: check, built: null, hash: "" });
    const audit = await auditRows(app);
    assert.deepEqual(audit.map((a) => [a.route, a.status, a.script, a.actor_kind]), [["brief.build", 500, `how:${script}`, "system"]]);
    // the next night the model does better, the subject is rebuilt although nothing changed since, and is active again
    model(app);
    app.clock.t += DAY;
    assert.equal((await run(app)).out.built, 1);
    const fixed = await subjectRow(app, card);
    assert.deepEqual({ status: fixed.status, reason: fixed.stale_reason }, { status: "active", reason: "" });
    assert.ok((await row(app, card)).body.includes("Pip weighs 12 kilos."));
    assert.equal(ids.length, 1);
  });
}

test("a member trashed while the model works cannot be cited, and the old brief stays", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "Pip is a beagle."]);
  const old = (await row(app, card)).content;
  model(app, async (lines) => {
    await storeOf(app).softDelete(ids[0]);
    return lines;
  });
  const { out } = await run(app);
  assert.equal(out.stale, 1);
  assert.equal((await subjectRow(app, card)).stale_reason, "trashed_member");
  assert.equal((await row(app, card)).content, old);
});

test("a member replaced while the model works cannot be cited either", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "Pip is a beagle."]);
  model(app, async (lines) => {
    await storeOf(app).supersede(ids[1], ids[0], app.clock.t);
    return lines;
  });
  await run(app);
  assert.equal((await subjectRow(app, card)).stale_reason, "trashed_member");
});

test("a member the person took out of the subject while the model works cannot be cited", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app, async (lines) => {
    await storeOf(app).unlink(ids[0], card, "about");
    return lines;
  });
  await run(app);
  assert.equal((await subjectRow(app, card)).stale_reason, "foreign_id");
});

test("a card the person edited while the model worked is not overwritten", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  const mine = "---\nname: pip\ndescription: pet card for Pip\nmetadata:\n  type: project\n---\n\nPip is the best dog.";
  model(app, async (lines) => {
    app.clock.t += 5;
    await storeOf(app).update({ id: card, content: mine });
    return lines;
  });
  const { out } = await run(app);
  assert.equal(out.conflicts, 1);
  assert.equal(out.built, 0);
  assert.equal((await row(app, card)).content, mine);
  assert.equal((await subjectRow(app, card)).status, "active", "a lost race is not a failed check");
  assert.equal((await rows(app, "SELECT * FROM links WHERE link_type = 'derived_from'")).length, 0);
});

test("a card that lost its frontmatter is marked stale with bad_card", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  await app.env.DB.prepare("UPDATE memories SET content = 'just text' WHERE id = ?").bind(card).run();
  model(app);
  await run(app);
  assert.equal((await subjectRow(app, card)).stale_reason, "bad_card");
});

// ------------------------------------------------------------------ a model that does not answer

test("a dead model leaves subjects, cards and links as they are, counts the failure and stops", async () => {
  const app = await world();
  const made = [];
  for (const slug of ["pip", "corolla", "dana", "cottage", "garden", "tilly"]) made.push(await subject(app, slug, [`${cap(slug)} is here.`]));
  app.env.AI.reply(SMALL_MODEL, () => {
    throw new Error("the model is down");
  });
  const before = await rows(app, "SELECT * FROM subjects ORDER BY id");
  const cards = await rows(app, "SELECT id, content, updated_at FROM memories ORDER BY id");
  const { out } = await run(app);
  assert.equal(out.built + out.stale, 0);
  assert.equal(out.failed, 4);
  assert.equal(app.env.AI.calls.length, 4, "the first four run at once, and when all of them fail the step gives up");
  assert.equal(out.refused, "the model did not answer");
  // The only change to a subject is the count of failures, in stale_reason. Its status, hash and times stay.
  const after = await rows(app, "SELECT * FROM subjects ORDER BY id");
  assert.deepEqual(after.map((r) => ({ ...r, stale_reason: "" })), before.map((r) => ({ ...r })));
  assert.equal(after.filter((r) => r.stale_reason === "model.fail.1").length, 4);
  assert.deepEqual(await rows(app, "SELECT id, content, updated_at FROM memories ORDER BY id"), cards);
  assert.equal((await rows(app, "SELECT * FROM links WHERE link_type = 'derived_from'")).length, 0);
  assert.deepEqual((await auditRows(app)).map((a) => [a.route, a.status, a.script]), Array(4).fill(["brief.build", 500, "how:model.fail"]));
  assert.equal(made.length, 6);
});

test("a model that fails for a subject 3 nights in a row makes it stale with model.fail.3, and a failed subject waits behind the healthy ones", async () => {
  const app = await world();
  const bad = [];
  for (let i = 0; i < 8; i++) bad.push((await subject(app, `bad${i}`, [`Bad subject ${i} note.`], { kind: "topic" })).card);
  app.clock.t += 100;
  const good = (await subject(app, "healthy", ["Healthy subject note."], { kind: "topic" })).card;
  // The eight have failed once already. Before this fix they sorted first every night and the healthy one behind them was never built.
  await app.env.DB.prepare("UPDATE subjects SET stale_reason = 'model.fail.1' WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(bad)).run();
  app.env.AI.reply(SMALL_MODEL, async (input) => {
    const prompt = input.messages[1].content;
    if (/^Subject: Bad/m.test(prompt)) return { response: "not json at all" };
    return { response: { lines: blocks(prompt).map((b) => ({ section: "now", text: b.text.split("\n").at(-1), ids: [b.id] })) } };
  });
  const state = async () => await rows(app, "SELECT status, stale_reason FROM subjects WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(bad));
  const one = await run(app);
  assert.equal(one.out.built, 1, "the healthy subject is first in line");
  assert.equal((await subjectRow(app, good)).status, "active");
  assert.ok((await row(app, good)).body.includes("Healthy subject note."));
  assert.ok((await state()).some((r) => r.stale_reason === "model.fail.2"), "the failures are counted");
  for (let n = 0; n < 3; n++) {
    app.clock.t += DAY;
    await run(app);
  }
  const final = await state();
  assert.ok(final.some((r) => r.status === "stale" && r.stale_reason === "model.fail.3"), JSON.stringify(final));
  assert.ok(final.every((r) => /^model\.fail\.\d+$/.test(r.stale_reason) && r.status === (Number(r.stale_reason.split(".")[2]) >= 3 ? "stale" : "active")), JSON.stringify(final));
});

test("a model that answers again after failing clears the count", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  app.env.AI.reply(SMALL_MODEL, () => {
    throw new Error("down");
  });
  await run(app);
  assert.equal((await subjectRow(app, card)).stale_reason, "model.fail.1");
  model(app);
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 1);
  assert.equal((await subjectRow(app, card)).stale_reason, "");
});

test("the nightly run reports the step as failed when the model never answered, and ok when it did", async () => {
  const app = await world();
  await subject(app, "pip", ["Pip weighs 12 kilos."]);
  const registered = STEPS.briefs;
  STEPS.briefs = briefsStep;
  try {
    app.env.AI.reply(SMALL_MODEL, () => {
      throw new Error("down");
    });
    const down = await runMaintenance(app.env, () => app.clock.t, { steps: ["briefs"] });
    assert.equal(down.ok, false);
    assert.equal(down.summary.briefs.refused, "the model did not answer");
    assert.equal(typeof down.summary.briefs.subrequests, "number");
    model(app);
    const fine = await runMaintenance(app.env, () => app.clock.t, { steps: ["briefs"] });
    assert.equal(fine.ok, true);
    assert.equal(fine.summary.briefs.built, 1);
  } finally {
    STEPS.briefs = registered;
  }
});

// ------------------------------------------------------------------ budget and order

test("at most 8 builds a night, and the rest wait for the next night", async () => {
  const app = await world();
  for (let i = 0; i < 10; i++) await subject(app, `thing${i}`, [`Thing ${i} is here.`], { kind: "topic" });
  model(app);
  const first = await run(app);
  assert.equal(MAX_BUILDS, 8);
  assert.deepEqual([first.out.candidates, first.out.built, first.out.remaining], [10, 8, 2]);
  assert.equal(first.spent, 1 + 2 + 8 * 4);
  assert.ok(first.spent <= 40, `a night with 8 builds used ${first.spent} subrequests`);
  app.clock.t += DAY;
  const second = await run(app);
  assert.deepEqual([second.out.candidates, second.out.built, second.out.remaining], [2, 2, 0]);
});

test("the step stops when the subrequest budget says no, and never goes over it", async () => {
  const app = await world();
  for (let i = 0; i < 10; i++) await subject(app, `thing${i}`, [`Thing ${i} is here.`], { kind: "topic" });
  model(app);
  // The step leaves merge the 15 it needs to run at all, so a budget of 40 gives it 25: one read for text that must go, two reads, then builds.
  const small = await run(app, { subrequests: 40 });
  assert.ok(small.spent <= 25, `spent ${small.spent}`);
  assert.equal(small.out.built, 5);
  assert.equal(small.out.remaining, 5);
  const tight = await world();
  await subject(tight, "pip", ["Pip weighs 12 kilos."]);
  model(tight);
  const none = await run(tight, { subrequests: 21 });
  assert.deepEqual(none, { out: { candidates: 0, built: 0, stale: 0, failed: 0, conflicts: 0, retired: 0, cleared: 0, pinned: 0, remaining: 0, skipped: "budget" }, spent: 1 });
  assert.equal(tight.env.AI.calls.length, 0);
  const exact = await run(tight, { subrequests: 22 });
  assert.equal(exact.out.built, 1);
  assert.equal(exact.spent, 7);
});

test("a build costs 4 subrequests, a failed one 3, and a night with nothing to do costs 1", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app);
  const one = await run(app);
  assert.equal(one.out.built, 1);
  assert.equal(one.spent, 1 + 2 + 4, "the look for text that must go, two reads, then the model, a fresh read of the members, the card read and one batch");
  app.clock.t += DAY;
  const idle = await run(app);
  assert.equal(idle.spent, 1 + 1, "the look for text that must go, and one batch of reads");
  // A subject that was never built, the model forges a line: a failed check saves the stale mark and its audit row in one batch.
  const fresh = await subject(app, "corolla", ["The Corolla is blue."], { kind: "asset" });
  model(app, async (lines) => lines.map((l) => ({ ...l, ids: [] })));
  const failed = await run(app);
  assert.equal(failed.out.stale, 1);
  assert.equal(failed.spent, 1 + 2 + 3);
  assert.equal((await subjectRow(app, fresh.card)).stale_reason, "no_citation");
  // A built subject whose member was edited is not cleared, the brief stays until the new one is saved over it.
  app.clock.t += DAY;
  await storeOf(app).update({ id: (await rows(app, "SELECT source_id FROM links WHERE target_id = ?", card))[0].source_id, content: note("pip-note-0", "A sample.", "Pip weighs 13 kilos.") });
  model(app);
  const changed = await run(app);
  assert.equal(changed.out.cleared, 0);
  assert.equal(changed.out.built, 2, "Pip and the stale Corolla");
  assert.equal(changed.spent, 1 + 2 + 2 * 4);
});

test("the oldest brief goes first, a subject never built before all, and a stale subject after the healthy ones", async () => {
  const app = await world();
  const set = async (slug, built, status = "active") => {
    const s = await subject(app, slug, [`${cap(slug)} is here.`], { kind: "topic" });
    await app.env.DB.prepare("UPDATE subjects SET built_at = ?, status = ? WHERE id = ?").bind(built, status, s.card).run();
  };
  await set("dd", 300);
  await set("ee", null, "stale");
  await set("bb", 100);
  await set("aa", null);
  await set("cc", 200);
  model(app);
  // Room for exactly three builds: the step keeps 15 for merge, and spends 1 on the look for text that must go and 2 on reads.
  const { out } = await run(app, { subrequests: 30 });
  assert.equal(out.built, 3);
  assert.deepEqual(app.prompts.map(subjectOf), ["Aa", "Bb", "Cc"]);
});

// ------------------------------------------------------------------ pinned

test("a subject with a hand written brief is never rebuilt, and a pin set to false does not count", async () => {
  const app = await world();
  const field = (value) => ({ brief_pinned: { value, confirmed_at: 1, source: "user" } });
  const pinned = await subject(app, "pip", ["Pip weighs 12 kilos."], { fields: field("yes") });
  const loose = await subject(app, "corolla", ["The Corolla is blue."], { kind: "asset", fields: field("false") });
  const plain = await subject(app, "dana", ["Dana lives in Cape Town."], { kind: "person" });
  const mine = (await row(app, pinned.card)).content;
  model(app);
  const { out } = await run(app);
  assert.equal(out.pinned, 1);
  assert.equal(out.built, 2);
  assert.deepEqual(app.prompts.map(subjectOf).sort(), ["Corolla", "Dana"]);
  assert.equal((await row(app, pinned.card)).content, mine);
  assert.equal((await subjectRow(app, pinned.card)).built_at, null);
  assert.equal(loose.ids.length + plain.ids.length, 2);
});

// ------------------------------------------------------------------ the private rule

test("a shared subject's prompt never holds text of a member that belongs to a private subject, and a private subject's holds only its own", async () => {
  const app = await world();
  const cottage = await subject(app, "cottage", ["The Cottage has a green door.", "The Cottage roof was fixed in 2025."], { kind: "asset" });
  const pip = await subject(app, "pip", ["Pip hates the vet at 9 sharp."], { scope: "private" });
  const mixed = await seed(app, { name: "cottage-pip", text: "Pip loves the Cottage garden.", origin: "capture" });
  await about(app, mixed, cottage.card);
  await about(app, mixed, pip.card);
  model(app);
  const { out } = await run(app);
  assert.equal(out.built, 2);
  const forCottage = app.prompts.find((p) => subjectOf(p) === "Cottage");
  const forPip = app.prompts.find((p) => subjectOf(p) === "Pip");
  assert.match(forCottage, /green door/);
  assert.match(forCottage, /roof was fixed/);
  assert.doesNotMatch(forCottage, /Pip hates/, "a private subject's own member");
  assert.doesNotMatch(forCottage, /loves the Cottage garden/, "a member that is also about a private subject");
  assert.match(forPip, /Pip hates the vet/);
  assert.match(forPip, /loves the Cottage garden/, "its own members, shared ones included");
  assert.doesNotMatch(forPip, /green door/);
  const derived = await rows(app, "SELECT target_id FROM links WHERE source_id = ? AND link_type = 'derived_from'", cottage.card);
  assert.ok(!derived.some((r) => r.target_id === mixed || r.target_id === pip.ids[0]));
  // the same members make the same hash, so the next night does not build again
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 0);
});

// ------------------------------------------------------------------ retirement

test("a person, a pet and an asset are never retired for having few members, a project and an area can be", async () => {
  const app = await world();
  const kept = [];
  for (const kind of ["person", "pet", "asset"]) kept.push(await subject(app, `old-${kind}`, ["One memory."], { kind }));
  const faded = [await subject(app, "old-project", ["One memory."], { kind: "project" }), await subject(app, "old-area", ["One memory."], { kind: "area" })];
  app.clock.t += 61 * DAY;
  model(app);
  await run(app);
  for (const s of kept) assert.notEqual((await subjectRow(app, s.card)).status, "retired");
  for (const s of faded) assert.equal((await subjectRow(app, s.card)).status, "retired");
});

test("a subject with fewer than 3 live members that is over 60 days old is retired, and nothing else is", async () => {
  const app = await world();
  const two = await subject(app, "oldtwo", ["Old two a.", "Old two b."], { kind: "topic" });
  const three = await subject(app, "oldthree", ["Old three a.", "Old three b.", "Old three c."], { kind: "topic" });
  const trashed = await subject(app, "oldtrash", ["Trash a.", "Trash b.", "Trash c."], { kind: "topic" });
  const stale = await subject(app, "oldstale", ["Stale a."], { kind: "topic", status: "stale" });
  const pinned = await subject(app, "oldpin", ["Pin a."], { kind: "topic", fields: { brief_pinned: { value: "yes", confirmed_at: 1, source: "user" } } });
  const proposed = await subject(app, "oldprop", [], { kind: "topic", status: "proposed" });
  const retired = await subject(app, "oldgone", [], { kind: "topic", status: "retired" });
  await storeOf(app).softDelete(trashed.ids[0]);
  app.clock.t += 61 * DAY;
  const young = await subject(app, "young", [], { kind: "topic" });
  model(app);
  const { out } = await run(app);
  const status = async (s) => (await subjectRow(app, s.card)).status;
  assert.equal(await status(two), "retired");
  assert.equal(await status(trashed), "retired", "a trashed member does not count");
  assert.equal(await status(stale), "retired");
  assert.equal(await status(three), "active");
  assert.equal(await status(pinned), "active", "a pinned subject is left alone");
  assert.equal(await status(proposed), "proposed");
  assert.equal(await status(retired), "retired");
  assert.equal(await status(young), "active", "younger than 60 days");
  assert.equal(out.retired, 3);
  assert.deepEqual(app.prompts.map(subjectOf), ["Oldthree"], "a retired subject is not built");
  // links stay, and a retired card is still there
  assert.equal((await rows(app, "SELECT * FROM links WHERE target_id = ? AND link_type = 'about'", two.card)).length, 2);
  const audit = (await auditRows(app)).filter((a) => a.route === "brief.retire");
  assert.deepEqual(audit.map((a) => [a.status, a.actor_kind, a.method]).sort(), [[200, "system", "SYSTEM"], [200, "system", "SYSTEM"], [200, "system", "SYSTEM"]]);
  assert.deepEqual(audit.map((a) => a.script).sort(), ["how:members:1", "how:members:2", "how:members:2"]);
});

test("exactly 60 days old is not old enough", async () => {
  const app = await world();
  const edge = await subject(app, "edge", ["Edge a."], { kind: "topic" });
  const made = (await subjectRow(app, edge.card)).created_at;
  app.clock.t = made + 60 * DAY;
  model(app);
  await run(app);
  assert.equal((await subjectRow(app, edge.card)).status, "active");
  app.clock.t += 1;
  await run(app);
  assert.equal((await subjectRow(app, edge.card)).status, "retired");
});

// ------------------------------------------------------------------ backup and the migration

const exportOf = async (app) => (await app.call("/export")).json;
const restoreInto = async (doc) => {
  const fresh = await world();
  const res = await fresh.call("/import", { method: "POST", body: { ...doc, offset: 0, limit: 200 } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { fresh, res: res.json };
};

test("an export carries the three brief columns and an import brings them back", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app);
  await run(app);
  await app.env.DB.prepare("UPDATE subjects SET stale_reason = 'uncited_number' WHERE id = ?").bind(card).run();
  const doc = await exportOf(app);
  const sent = doc.subjects.find((s) => s.id === card);
  assert.deepEqual([typeof sent.member_hash, sent.built_at, sent.stale_reason], ["string", app.clock.t, "uncited_number"]);
  assert.match(sent.member_hash, /^[0-9a-f]{64}$/);
  const { fresh, res } = await restoreInto(doc);
  assert.equal(res.subjects, 1);
  assert.deepEqual(await subjectRow(fresh, card), await subjectRow(app, card));
});

test("an export from 2.0.8 has no brief columns and still imports, as a brief that was never built", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  const doc = await exportOf(app);
  doc.subjects = doc.subjects.map(({ member_hash, built_at, stale_reason, ...old }) => old);
  assert.equal("member_hash" in doc.subjects[0], false);
  const { fresh, res } = await restoreInto(doc);
  assert.equal(res.subjects, 1);
  assert.deepEqual(res.errors, []);
  const s = await subjectRow(fresh, card);
  assert.deepEqual({ hash: s.member_hash, built: s.built_at, reason: s.stale_reason }, { hash: "", built: null, reason: "" });
  // and the restored store builds the brief the next night
  model(fresh);
  assert.equal((await run(fresh)).out.built, 1);
});

test("an import refuses a subject whose brief columns are the wrong type", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  const doc = await exportOf(app);
  for (const bad of [{ member_hash: 7 }, { built_at: "yesterday" }, { stale_reason: ["x"] }, { member_hash: "a".repeat(200) }, { built_at: -1 }]) {
    const { fresh, res } = await restoreInto({ ...doc, subjects: doc.subjects.map((s) => ({ ...s, ...bad })) });
    assert.equal(res.subjects, 0, JSON.stringify(bad));
    assert.equal(res.errors.length, 1);
    assert.equal(await fresh.env.DB.prepare("SELECT COUNT(*) AS n FROM subjects WHERE id = ?").bind(card).first().then((r) => r.n), 0);
  }
});

test("migration 0007 adds the three columns with defaults to subjects that already exist, and the data stays", async () => {
  const { FakeD1 } = await import("./helpers/d1.js");
  const { listMigrations } = await import("../migrate.js");
  const db = new FakeD1();
  const upto = (n) => listMigrations().filter((m) => m.version <= n).map((m) => m.sql).join("\n");
  await db.exec(upto(6));
  await db.exec("INSERT INTO memories (id, content, content_hash, origin, valid_from, created_at, updated_at) VALUES ('c', 'c', 'h', 'system', 1, 1, 1)");
  await db.exec("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES ('c', 'pip', 'pet', 'active', 'shared', '{\"a\":1}', '[\"pippin\"]', 5, 6)");
  await db.exec(listMigrations().find((m) => m.version === 7).sql);
  assert.deepEqual({ ...(await db.prepare("SELECT slug, fields, aliases, created_at, updated_at, member_hash, built_at, stale_reason FROM subjects").first()) }, { slug: "pip", fields: '{"a":1}', aliases: '["pippin"]', created_at: 5, updated_at: 6, member_hash: "", built_at: null, stale_reason: "" });
});

// ------------------------------------------------------------------ the pin, through the API

const post = (app, path, body) => app.call(path, { method: "POST", body });
/** The calls to the small model, not the embedder that indexes a changed card. */
const modelCalls = (app) => app.env.AI.calls.filter((c) => c.model === SMALL_MODEL).length;
const pinOf = async (app, slug) => (await app.call(`/subject?slug=${slug}`)).json.subject.fields.brief_pinned?.value;

test("brief_pinned can be set and removed through the API for every kind of subject", async () => {
  const app = await world();
  for (const kind of KINDS) {
    const made = await post(app, "/subject", { slug: `s-${kind}`, kind, name: `S ${kind}` });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const set = await post(app, "/subject/update", { slug: `s-${kind}`, fields: { brief_pinned: "yes" } });
    assert.equal(set.status, 200, `${kind}: ${JSON.stringify(set.json)}`);
    assert.equal(set.json.subject.fields.brief_pinned.value, "yes");
    assert.equal(set.json.subject.fields.brief_pinned.source, "user");
    const off = await post(app, "/subject/update", { slug: `s-${kind}`, fields: { brief_pinned: null } });
    assert.equal(off.json.subject.fields.brief_pinned, undefined, "null removes the pin");
  }
  assert.equal((await post(app, "/subject/update", { slug: "s-pet", fields: { brief_pinned: "" } })).json.code, "bad_field", "an empty value is not a pin");
  assert.equal((await post(app, "/subject/update", { slug: "s-pet", fields: { nope: "x" } })).json.code, "bad_field", "other keys are still refused");
});

test("a brief a person writes through the API pins itself, and the nightly step leaves it alone", async () => {
  const app = await world();
  const made = await post(app, "/subject", { slug: "pip", kind: "pet", name: "Pip" });
  const card = made.json.subject.id;
  const m = await seed(app, { name: "n", text: "Pip is a beagle.", origin: "capture" });
  await about(app, m, card);
  assert.equal(await pinOf(app, "pip"), undefined, "nothing was written by hand yet");
  await post(app, "/subject/update", { slug: "pip", brief: "My own careful brief about Pip." });
  assert.equal(await pinOf(app, "pip"), "yes", "a brief written by a person is a pin");
  model(app);
  const { out } = await run(app);
  assert.deepEqual([out.pinned, out.built, out.candidates], [1, 0, 0]);
  assert.equal(modelCalls(app), 0);
  assert.equal((await row(app, card)).body, "My own careful brief about Pip.");
  // taking the pin off hands the brief back to the nightly step
  await post(app, "/subject/update", { slug: "pip", fields: { brief_pinned: null } });
  app.clock.t += DAY;
  assert.equal((await run(app)).out.built, 1);
  assert.match((await row(app, card)).body, /^Now\n- /);
});

test("a brief that is unchanged, empty or sent with its own pin value does not decide the pin by itself", async () => {
  const app = await world();
  await post(app, "/subject", { slug: "pip", kind: "pet", name: "Pip" });
  await post(app, "/subject/update", { slug: "pip", name: "Pip the dog" });
  assert.equal(await pinOf(app, "pip"), undefined, "a name change is not a brief");
  await post(app, "/subject/update", { slug: "pip", brief: "" });
  assert.equal(await pinOf(app, "pip"), undefined, "an empty brief pins nothing, it hands the card to the step");
  await post(app, "/subject/update", { slug: "pip", brief: "Written.", fields: { brief_pinned: null } });
  assert.equal(await pinOf(app, "pip"), undefined, "a request that says what the pin should be is obeyed");
  await post(app, "/subject/update", { slug: "pip", brief: "Written again.", fields: { species: "dog" } });
  assert.equal(await pinOf(app, "pip"), "yes", "other fields in the same request do not stop it");
  await post(app, "/subject/update", { slug: "pip", fields: { brief_pinned: null } });
  await post(app, "/subject/update", { slug: "pip", brief: "Written again.", name: "Pip" });
  assert.equal(await pinOf(app, "pip"), undefined, "the same brief sent again is not a new one");
  const created = await post(app, "/subject", { slug: "rex", kind: "pet", name: "Rex", brief: "Rex is the neighbour's dog." });
  assert.equal(created.json.subject.fields.brief_pinned.value, "yes", "a subject made with a brief has a hand written brief");
  assert.equal((await post(app, "/subject", { slug: "tilly", kind: "pet", name: "Tilly" })).json.subject.fields.brief_pinned, undefined);
});

// ------------------------------------------------------------------ a built brief is cleared when its members change

const closedDevice = async (app) => (await device(app, { allowPrivate: false })).token;
const recalled = async (app, token, slug) => (await app.call(`/recall?subject=${slug}`, { token })).json.subject;

test("a member that later joins a private subject leaves the shared brief at once, and a closed device cannot read it", async () => {
  const app = await world();
  const shared = await addSubject(app, { slug: "cottage", kind: "asset", name: "Cottage" });
  const priv = await addSubject(app, { slug: "dana", kind: "person", name: "Dana", scope: "private" });
  const m = await seed(app, { name: "n", text: "Dana stays at the cottage when she is sick.", origin: "capture" });
  await about(app, m, shared);
  model(app);
  assert.equal((await run(app)).out.built, 1);
  const token = await closedDevice(app);
  assert.match((await recalled(app, token, "cottage")).brief, /Dana stays at the cottage/, "before: the device reads the brief of a shared subject");
  await about(app, m, priv); // the person says this memory is about Dana, who is private
  app.clock.t += DAY;
  const { out } = await run(app);
  assert.equal(out.cleared, 1);
  const s = await subjectRow(app, shared);
  assert.deepEqual({ built: s.built_at, hash: s.member_hash, status: s.status, reason: s.stale_reason }, { built: null, hash: "", status: "stale", reason: "members_changed" });
  assert.equal((await row(app, shared)).body, "");
  assert.doesNotMatch(JSON.stringify(await recalled(app, token, "cottage")), /Dana stays|sick/);
  assert.equal((await rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", shared)).length, 0, "and the link to the memory it came from");
  assert.equal(app.prompts.map(subjectOf).filter((n) => n === "Cottage").length, 1, "no member is left to build the cottage from, so the model is not asked again");
  assert.equal(app.prompts.map(subjectOf).filter((n) => n === "Dana").length, 1, "Dana's own brief is built from her own member");
  const audit = (await auditRows(app)).filter((a) => a.route === "brief.clear");
  assert.deepEqual(audit.map((a) => [a.actor_kind, a.harness, a.script, a.status, JSON.parse(a.memory_ids)]), [["system", "system", "how:member.gone", 200, [shared]]]);
});

test("when the last member is forgotten the brief goes with it", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip hates the vet and bites."]);
  model(app);
  await run(app);
  assert.match((await row(app, card)).body, /bites/);
  await storeOf(app).softDelete(ids[0]);
  app.clock.t += DAY;
  const { out } = await run(app);
  assert.equal(out.cleared, 1);
  assert.equal((await row(app, card)).body, "");
  assert.equal((await rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", card)).length, 0);
  assert.equal(modelCalls(app), 1);
});

test("a rebuild that fails a check, a model that is down and a night with no budget all leave no old text behind a forgotten member", async () => {
  for (const how of ["check", "model", "budget"]) {
    const app = await world();
    const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "Pip is secretly fed at night."]);
    model(app);
    await run(app);
    assert.match((await row(app, card)).body, /secretly fed/);
    // the member that says the secret is forgotten, so the brief came from a member that may no longer feed it
    app.clock.t += DAY;
    await storeOf(app).softDelete(ids[1]);
    if (how === "check") model(app, async (lines) => lines.map((l, i) => (i === 0 ? { ...l, ids: [] } : l)));
    if (how === "model") app.env.AI.reply(SMALL_MODEL, () => { throw new Error("down"); });
    const { out } = await run(app, { subrequests: how === "budget" ? 16 : 500 });
    assert.equal(out.cleared, 1, how);
    const body = (await row(app, card)).body;
    assert.equal(body, "", `${how}: the old text is gone`);
    assert.doesNotMatch(body, /secretly/);
    const s = await subjectRow(app, card);
    assert.equal(s.status, "stale", how);
    assert.equal(s.built_at, null);
    assert.equal((await rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", card)).length, 0, how);
    assert.equal(s.stale_reason, { check: "no_citation", model: "model.fail.1", budget: "members_changed" }[how]);
  }
});

test("a member that is added or edited never blanks a good brief, and a rebuild that fails leaves it with the reason it is stale", async () => {
  for (const how of ["check", "model", "budget"]) {
    const app = await world();
    const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos.", "Pip is fed at night."]);
    model(app);
    await run(app);
    const built = (await row(app, card)).body;
    assert.match(built, /fed at night/);
    app.clock.t += DAY;
    await storeOf(app).update({ id: ids[1], content: note("pip-note-1", "A sample.", "Pip is fed twice at night.") });
    const added = await seed(app, { name: "pip-note-2", text: "Pip loves the beach.", origin: "capture" });
    await about(app, added, card);
    if (how === "check") model(app, async (lines) => lines.map((l, i) => (i === 0 ? { ...l, ids: [] } : l)));
    if (how === "model") app.env.AI.reply(SMALL_MODEL, () => { throw new Error("down"); });
    const { out } = await run(app, { subrequests: how === "budget" ? 16 : 500 });
    assert.equal(out.cleared, 0, how);
    assert.equal((await row(app, card)).body, built, `${how}: the good brief is still there`);
    assert.equal((await rows(app, "SELECT * FROM links WHERE source_id = ? AND link_type = 'derived_from'", card)).length, 2, how);
    const s = await subjectRow(app, card);
    assert.equal(s.stale_reason, { check: "no_citation", model: "model.fail.1", budget: "" }[how], how);
    assert.equal(s.status, how === "check" ? "stale" : "active", how);
  }
});

test("a clear leaves no version of the card that holds the old brief", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app);
  await run(app);
  assert.match((await row(app, card)).body, /12 kilos/);
  await storeOf(app).softDelete(ids[0]);
  app.clock.t += DAY;
  await run(app);
  assert.equal((await row(app, card)).body, "");
  const versions = await rows(app, "SELECT seq, snapshot FROM memory_versions WHERE memory_id = ?", card);
  assert.ok(versions.every((v) => !/12 kilos/.test(v.snapshot)), "no version holds the text");
  assert.ok(versions.every((v) => JSON.parse(v.snapshot).body === ""));
});

test("a subject that is not built, or whose members did not change, is never cleared, and a pinned subject keeps its text", async () => {
  const app = await world();
  const field = (value) => ({ brief_pinned: { value, confirmed_at: 1, source: "user" } });
  const mine = await subject(app, "pip", ["Pip weighs 12 kilos."], { fields: field("yes") });
  await app.env.DB.prepare("UPDATE subjects SET built_at = 5, member_hash = 'old' WHERE id = ?").bind(mine.card).run();
  const body = (await row(app, mine.card)).body;
  const fresh = await subject(app, "corolla", ["The Corolla is blue."], { kind: "asset" });
  model(app);
  const { out } = await run(app);
  assert.equal(out.cleared, 0);
  assert.equal(out.built, 1);
  assert.equal((await row(app, mine.card)).body, body);
  app.clock.t += DAY;
  assert.equal((await run(app)).out.cleared, 0, "the same members, nothing to clear");
  assert.match((await row(app, fresh.card)).body, /^Now\n- /);
});

test("a private subject is cleared when its own member is forgotten, and not when the member also joins another private subject", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "dana", ["Dana is allergic to nuts."], { kind: "person", scope: "private" });
  const other = await addSubject(app, { slug: "wren", kind: "person", name: "Wren", scope: "private" });
  model(app);
  await run(app);
  assert.match((await row(app, card)).body, /allergic/);
  await about(app, ids[0], other);
  app.clock.t += DAY;
  assert.equal((await run(app)).out.cleared, 0, "a private card may hold text of any private subject's member");
  await storeOf(app).softDelete(ids[0]);
  app.clock.t += DAY;
  assert.equal((await run(app)).out.cleared, 2, "both private subjects had built a brief from it");
  assert.equal((await row(app, card)).body, "");
});

// ------------------------------------------------------------------ the other fixes of the step

test("a proposal accepted more than 60 days after it was made is not retired the same night", async () => {
  const app = await world();
  const now = () => app.clock.t;
  const ev = await seed(app, { name: "garden-plan", text: "The garden project needs a new fence.", origin: "capture" });
  await createProposed(app.env, { name: "Garden", kind: "project", evidence: [{ id: ev, confidence: 1 }], now });
  app.clock.t += 61 * DAY;
  const accepted = await post(app, "/subject/accept", { slug: "garden" });
  assert.equal(accepted.json.subject.status, "active");
  model(app);
  const first = await run(app);
  assert.equal(first.out.retired, 0, "accepting is a change of status, the 60 days start again");
  assert.equal((await rows(app, "SELECT status FROM subjects WHERE slug = 'garden'"))[0].status, "active");
  assert.equal(first.out.built, 1);
  assert.equal((await rows(app, "SELECT status FROM subjects WHERE slug = 'garden'"))[0].status, "active", "building does not restart the 60 days either");
  app.clock.t += 59 * DAY;
  assert.equal((await run(app)).out.retired, 0);
  app.clock.t += 2 * DAY;
  assert.equal((await run(app)).out.retired, 1, "sixty days after the accept it is retired, with fewer than 3 members");
});

test("the step leaves merge the 15 it needs to run, so merge still has budget on the Free limit of 40", async () => {
  const app = await world();
  for (let i = 0; i < 8; i++) await subject(app, `s${i}x`, [`Subject ${i} note.`], { kind: "topic" });
  model(app);
  const now = () => app.clock.t;
  const budget = createBudget({ now, subrequests: 40 });
  budget.spent = 6; // what the steps before this one used
  const out = await briefsStep(countedEnv(app.env, budget), { now, budget });
  assert.ok(budget.spent - 6 <= 21, `the step used ${budget.spent - 6} of the 34 that were left`);
  assert.ok(budget.left() >= 15, `${budget.left()} are left for the steps after it`);
  assert.ok(out.built >= 1 && out.built < 8, "it did some work and left the rest for the next night");
  assert.equal(out.remaining, 8 - out.built);
});

test("in a whole night on the Free limit, merge still runs after eight subjects need a brief", async () => {
  const app = await world();
  for (let i = 0; i < 8; i++) await subject(app, `s${i}x`, [`Subject ${i} note.`], { kind: "topic" });
  for (let i = 0; i < 4; i++) await seed(app, { name: `dup-${i}`, text: "The very same long sentence about kiln glaze porcelain firing schedule one two three.", ageDays: i });
  await indexAll(app);
  model(app);
  app.clock.t += 1000;
  const night = await runMaintenance(app.env, () => app.clock.t, { subrequests: 40, steps: ["briefs", "merge"] });
  assert.ok(night.summary.briefs.built >= 1);
  assert.ok(night.summary.briefs.subrequests <= 25, `briefs used ${night.summary.briefs.subrequests}`);
  assert.ok(night.summary.merge.examined >= 1, `merge examined ${night.summary.merge.examined} with ${night.summary.merge.subrequests} subrequests`);
});

test("a line the model sends whose text is not text is dropped, never saved as garbage", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app, async () => [
    { section: "now", text: { a: 1 }, ids: [ids[0]] },
    { section: "now", text: ["Pip", "is", "evil"], ids: [ids[0]] },
    { section: "now", text: "Pip weighs 12 kilos.", ids: [ids[0]] },
  ]);
  assert.equal((await run(app)).out.built, 1);
  const body = (await row(app, card)).body;
  assert.equal(body, "Now\n- Pip weighs 12 kilos.");
});

test("a plain true brief is saved: digits and a date the way the members write them, a number word the member writes as a digit", async () => {
  const app = await world();
  const { card, ids } = await subject(app, "pip", ["Pip weighs 12 kilos and has 3 toys.", "The vet visit for Pip is on 3 November 2026 and costs 1,450 rand."]);
  model(app, async () => [
    { section: "now", text: "Pip weighs 12 kilos and has three toys.", ids: [ids[0]] },
    { section: "now", text: "The vet visit is on 3 November 2026 and costs 1450 rand.", ids: [ids[1]] },
    { section: "history", text: "The vet visit for Pip was booked for 2026-11-03.", ids: [ids[1]] },
  ]);
  const { out } = await run(app);
  assert.deepEqual([out.built, out.stale], [1, 0]);
  assert.match((await row(app, card)).body, /three toys[\s\S]*1450 rand[\s\S]*2026-11-03/);
});

test("the subject shape names when the brief was built and why it is stale", async () => {
  const app = await world();
  const { card } = await subject(app, "pip", ["Pip weighs 12 kilos."]);
  assert.deepEqual([(await app.call("/subject?slug=pip")).json.subject.built_at, (await app.call("/subject?slug=pip")).json.subject.stale_reason], [null, ""]);
  model(app, async (lines) => lines.map((l) => ({ ...l, ids: [] })));
  await run(app);
  const stale = (await app.call("/subject?slug=pip")).json.subject;
  assert.deepEqual([stale.status, stale.built_at, stale.stale_reason], ["stale", null, "no_citation"]);
  model(app);
  app.clock.t += DAY;
  await run(app);
  const built = (await app.call("/subjects")).json.subjects.find((s) => s.id === card);
  assert.deepEqual([built.status, built.built_at, built.stale_reason], ["active", app.clock.t, ""]);
});

test("the audit rows of the brief step are labelled Anymem, not Unknown", async () => {
  const app = await world();
  await subject(app, "pip", ["Pip weighs 12 kilos."]);
  model(app);
  await run(app);
  const audit = await auditRows(app);
  assert.ok(audit.length >= 1);
  assert.ok(audit.every((a) => a.harness === "system"), JSON.stringify(audit.map((a) => a.harness)));
});
