// The nightly job: the run record, the budget, and every step on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { START, createApp } from "./helpers/app.js";
import { DAY, indexAll, modelKind, row, rows, runNightly, seed } from "./helpers/maintenance.js";
import { BASE_30, SWAP_30, OLD_FACT, NEW_FACT, distinct } from "./helpers/write.js";
import { RETENTION_MS, recordAudit } from "../audit.js";
import { overlap } from "../cron/merge.js";
import { createBudget, countedEnv } from "../cron/budget.js";
import { runMaintenance, STEPS } from "../cron/maintenance.js";
import { dayOf } from "../counters.js";

const UNRELATED = "alpha beta gamma delta epsilon zeta theta iota kappa sigma";
const STEP_NAMES = ["backup", "purge_trash", "reindex", "classify", "merge", "probation", "purge_old", "token"];
const only = (app, step, body = {}) => runNightly(app, { steps: [step], ...body }).then((r) => r.summary[step]);

// ------------------------------------------------------------------ the run

test("the scheduled handler runs every step in order and records one runs row", async () => {
  const app = await createApp();
  await app.worker.scheduled({ cron: "0 1 * * *" }, app.env, app.ctx);
  await app.settle();
  const runs = await rows(app, "SELECT * FROM runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].job, "nightly");
  assert.equal(runs[0].started_at, START);
  assert.equal(runs[0].finished_at, START);
  assert.equal(runs[0].ok, 1);
  const summary = JSON.parse(runs[0].summary);
  assert.deepEqual(Object.keys(summary), STEP_NAMES);
  assert.deepEqual(Object.keys(STEPS), STEP_NAMES);
  for (const name of STEP_NAMES) assert.equal(typeof summary[name].subrequests, "number");
});

test("a failing step is recorded and the other steps still run", async () => {
  const app = await createApp();
  const real = app.env.DB.prepare.bind(app.env.DB);
  app.env.DB.prepare = (sql) => {
    if (sql.startsWith("DELETE FROM audit")) throw new Error("disk on fire");
    return real(sql);
  };
  const result = await runMaintenance(app.env, () => START);
  assert.equal(result.ok, false);
  assert.match(result.summary.purge_old.error, /disk on fire/);
  assert.equal(result.summary.token.configured, false, "the step after the failure ran");
  const run = await app.env.DB.prepare("SELECT ok, summary FROM runs").first();
  assert.equal(run.ok, 0);
  assert.match(JSON.parse(run.summary).purge_old.error, /disk on fire/);
});

test("POST /admin/run-maintenance runs a subset and records a manual run", async () => {
  const app = await createApp();
  const res = await runNightly(app, { steps: ["token", "backup"] });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.summary), ["backup", "token"], "the steps keep their own order");
  assert.equal((await rows(app, "SELECT job FROM runs"))[0].job, "manual");
});

test("POST /admin/run-maintenance is admin only and checks its input", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  const post = (opts) => app.call("/admin/run-maintenance", { method: "POST", ...opts });
  assert.equal((await post({ token: device, body: {} })).status, 403);
  assert.equal((await post({ token: null, body: {} })).status, 401);
  assert.equal((await post({ jwt: app.browserJwt("me@example.com"), token: null, body: {} })).status, 403);
  assert.equal((await post({ body: { steps: ["nope"] } })).status, 400);
  assert.equal((await post({ body: { steps: [] } })).status, 400);
  assert.equal((await post({ body: { steps: "token" } })).status, 400);
  assert.equal((await post({ body: { subrequests: 0 } })).status, 400);
  assert.equal((await post({ body: { wall_ms: "x" } })).status, 400);
  assert.equal((await app.call("/admin/run-maintenance", { method: "GET" })).status, 405);
  assert.equal((await post({ rawBody: "{}" })).status, 200);
  assert.equal((await rows(app, "SELECT * FROM runs")).length, 1, "only the good call ran");
});

test("the whole run stays under the Worker's 50 subrequests with a big backlog, and a backlog continues the next night", async () => {
  const app = await createApp();
  modelKind(app, "episodic");
  for (let i = 0; i < 60; i++) await seed(app, { name: `note-${i}`, text: `zq${i}a zq${i}b zq${i}c zq${i}d`, kind: null, ageDays: 1, probationInDays: 50 });
  for (let night = 1; night <= 20; night++) {
    await app.worker.scheduled({}, app.env, app.ctx);
    await app.settle();
    const run = (await rows(app, "SELECT summary FROM runs ORDER BY id DESC LIMIT 1"))[0];
    const summary = JSON.parse(run.summary);
    // the steps share one budget, and the run's own two writes (the runs row, inserted and then finished) come on top
    const total = STEP_NAMES.reduce((sum, name) => sum + summary[name].subrequests, 0) + 2;
    assert.ok(total <= 50, `the run used ${total} subrequests on night ${night}`);
    assert.ok(total > 36, `the run used only ${total} on night ${night}, so the steps were not sharing the budget`);
    if (summary.reindex.remaining === 0 && summary.classify.remaining === 0) {
      assert.ok(night > 1, "one night was not enough, so the work was split");
      return;
    }
  }
  assert.fail("the backlog did not clear in 20 nights");
});

test("a step that finds the run's budget spent does nothing, and the steps after it still run", async () => {
  const app = await createApp();
  for (let i = 0; i < 20; i++) await seed(app, { name: `unindexed-${i}`, text: `zq${i} one two three` });
  const res = await runMaintenance(app.env, () => START, { steps: ["reindex", "merge", "probation", "token"], subrequests: 12 });
  assert.ok(res.summary.reindex.subrequests <= 12, `reindex used ${res.summary.reindex.subrequests}`);
  assert.ok(res.summary.reindex.remaining > 0, "the backlog is left for the next night");
  assert.equal(res.summary.merge.subrequests, 0, "merge checks the budget first and makes no call");
  assert.equal(res.summary.probation.retired_never_recalled + res.summary.probation.retired_idle_project, 0, "probation retires nothing without budget");
  assert.equal(res.summary.token.configured, false, "token uses no subrequests, so it still ran");
  assert.equal(res.ok, true);
});

test("a call that never answers is given up on, and the later steps still run", async () => {
  const app = await createApp();
  await seed(app, { name: "needs-index", text: "zq one two" });
  app.env.AI.run = () => new Promise(() => {});
  const res = await runMaintenance(app.env, () => START, { steps: ["reindex", "token"], wallMs: 10, graceMs: 30 });
  assert.equal(res.ok, false);
  assert.match(res.summary.reindex.error, /given up on/);
  assert.ok(res.summary.token.configured === false, "the next step ran");
  assert.equal((await rows(app, "SELECT ok FROM runs"))[0].ok, 0);
});

// ------------------------------------------------------------------ the budget

test("a budget runs out by subrequests and by time", () => {
  let t = 0;
  const budget = createBudget({ now: () => t, wallMs: 100, subrequests: 3 });
  assert.equal(budget.has(3), true);
  assert.equal(budget.has(4), false);
  budget.spent = 2;
  assert.equal(budget.left(), 1);
  assert.equal(budget.has(), true);
  t = 100;
  assert.equal(budget.has(), false, "the time is up");
});

test("the counted bindings count every call, and a D1 batch once", async () => {
  const app = await createApp();
  const budget = createBudget({ now: () => START });
  const env = countedEnv(app.env, budget);
  await env.DB.prepare("SELECT 1 AS n").first();
  await env.DB.prepare("SELECT 1 AS n").bind().all();
  await env.DB.batch([env.DB.prepare("SELECT 1"), env.DB.prepare("SELECT 2"), env.DB.prepare("SELECT 3")]);
  assert.equal(budget.spent, 3);
  await env.VECTORIZE.describe();
  await env.BACKUP_BUCKET.list();
  await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: ["x"] });
  assert.equal(budget.spent, 6);
});

test("a step stops when the time budget is used and the next run continues", async () => {
  const app = await createApp();
  for (let i = 0; i < 250; i++) await seed(app, { name: `gone-${i}`, text: `zq${i}`, deleted_at: START - 20 * DAY });
  let ticks = 0;
  const slow = () => START + ticks++ * 3; // every call to now() is 3 ms later
  const first = await runMaintenance(app.env, slow, { steps: ["purge_trash"], wallMs: 10 });
  assert.equal(first.summary.purge_trash.remaining, true);
  assert.ok(first.summary.purge_trash.purged > 0 && first.summary.purge_trash.purged < 250);
  const second = await runMaintenance(app.env, () => START, { steps: ["purge_trash"] });
  assert.equal(first.summary.purge_trash.purged + second.summary.purge_trash.purged, 250);
  assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM memories"))[0].n, 0);
});

// ------------------------------------------------------------------ purge the trash

test("purge removes memories trashed more than 14 days ago with their tags, keys, versions, links, link rejections and vectors", async () => {
  const app = await createApp();
  const old = await seed(app, { name: "old-trash", text: "zqold alpha beta", tags: ["red"] });
  const edge = await seed(app, { name: "edge-trash", text: "zqedge alpha beta" });
  const keep = await seed(app, { name: "kept", text: "zqkeep alpha beta" });
  await indexAll(app);
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(START - 14 * DAY - 1, old).run();
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(START - 14 * DAY, edge).run();
  await app.env.DB.batch([
    app.env.DB.prepare("INSERT INTO memory_versions (memory_id, seq, snapshot, reason, created_at) VALUES (?, 1, '{}', 'update', ?)").bind(old, START),
    app.env.DB.prepare("INSERT INTO links (source_id, target_id, link_type, created_at) VALUES (?, ?, 'related', ?)").bind(keep, old, START),
    app.env.DB.prepare("INSERT INTO link_rejections (source_id, target_id, link_type, created_at) VALUES (?, ?, 'about', ?), (?, ?, 'about', ?), (?, ?, 'about', ?)").bind(keep, old, START, old, keep, START, keep, edge, START),
  ]);
  const before = app.env.VECTORIZE.vectors.size;
  // a vector whose key row lost its vector id, as after a trash change that was not yet reindexed
  await app.env.DB.prepare("UPDATE memory_keys SET vector_id = NULL WHERE memory_id = ?").bind(old).run();
  const out = await only(app, "purge_trash");
  assert.equal(out.purged, 1);
  assert.ok(out.vectors >= 1);
  assert.equal(await row(app, old), null);
  assert.ok(await row(app, edge), "exactly 14 days old is still restorable, so it stays");
  assert.ok(await row(app, keep));
  for (const table of ["memory_tags", "memory_versions", "memory_keys"]) assert.equal((await rows(app, `SELECT * FROM ${table} WHERE memory_id = ?`, old)).length, 0, table);
  assert.equal((await rows(app, "SELECT * FROM links")).length, 0);
  assert.deepEqual((await rows(app, "SELECT source_id, target_id FROM link_rejections")).map((r) => ({ ...r })), [{ source_id: keep, target_id: edge }], "the rejections of the purged memory go, in both directions");
  assert.equal((await rows(app, "SELECT * FROM memory_fts WHERE memory_id = ?", old)).length, 0);
  assert.ok([...app.env.VECTORIZE.vectors.keys()].every((id) => !id.startsWith(old)), "the vectors are gone");
  assert.ok(app.env.VECTORIZE.vectors.size < before);
});

test("purge sends Vectorize at most 500 ids a delete, so a batch with many vectors still goes through", async () => {
  const app = await createApp();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await seed(app, { name: `bulk-trash-${i}`, text: `zqbulk${i} alpha beta` }));
  for (const id of ids) {
    await app.env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99) SELECT ?, 'question', i, 'q', NULL, ? FROM n").bind(id, START).run();
    await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(START - 15 * DAY, id).run();
  }
  const sent = [];
  const deleteByIds = app.env.VECTORIZE.deleteByIds.bind(app.env.VECTORIZE);
  app.env.VECTORIZE.deleteByIds = async (list) => (sent.push(list.length), deleteByIds(list));
  const out = await only(app, "purge_trash");
  assert.equal(out.purged, 12);
  assert.equal(out.error, undefined);
  assert.equal(sent.reduce((n, c) => n + c, 0), 1200, "every vector id of the 12 memories is sent");
  assert.ok(Math.max(...sent) <= 500, `largest delete was ${Math.max(...sent)} ids`);
  assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM memory_keys"))[0].n, 0);
});

test("purge does not ask Vectorize to delete an id it refused, so one long id does not fail the batch", async () => {
  const app = await createApp();
  const long = await seed(app, { name: "long-trash", id: "L".repeat(60), text: "zqlong alpha beta" });
  await app.env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) VALUES (?, 'question', 0, 'What is the long one?', NULL, ?)").bind(long, START).run();
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(START - 15 * DAY, long).run();
  const out = await only(app, "purge_trash");
  assert.equal(out.purged, 1);
  assert.equal(out.error, undefined);
  assert.equal(await row(app, long), null);
});

// ------------------------------------------------------------------ reindex and classify

test("reindex builds keys and vectors for memories that lack them", async () => {
  const app = await createApp();
  for (let i = 0; i < 5; i++) await seed(app, { name: `fresh-${i}`, text: `zq${i} one two three` });
  assert.equal((await app.call("/stats")).json.unvectorized, 5);
  const out = await only(app, "reindex");
  assert.deepEqual([out.processed, out.remaining], [5, 0]);
  assert.equal((await app.call("/stats")).json.unvectorized, 0);
  assert.ok(app.env.VECTORIZE.vectors.size >= 5);
  const again = await only(app, "reindex");
  assert.deepEqual([again.processed, again.remaining], [0, 0]);
});

test("reindex works in batches sized by the budget and finishes over several runs", async () => {
  const app = await createApp();
  for (let i = 0; i < 40; i++) await seed(app, { name: `bulk-${i}`, text: `zq${i} one two three` });
  const first = await only(app, "reindex", { subrequests: 24 });
  assert.ok(first.processed > 0 && first.processed < 40, `processed ${first.processed}`);
  assert.equal(first.remaining, 40 - first.processed);
  assert.ok(first.subrequests <= 24, `used ${first.subrequests}`);
  let left = first.remaining;
  for (let i = 0; i < 10 && left > 0; i++) left = (await only(app, "reindex", { subrequests: 24 })).remaining;
  assert.equal(left, 0);
});

test("a failing embedding is recorded as the step's error and nothing else stops", async () => {
  const app = await createApp();
  await seed(app, { name: "needs-index", text: "zq one two" });
  app.env.AI.reply("@cf/baai/bge-small-en-v1.5", () => {
    throw new Error("ai is down");
  });
  const res = await runNightly(app, { steps: ["reindex", "token"] });
  assert.equal(res.ok, false);
  assert.match(res.summary.reindex.error, /ai is down/);
  assert.ok(res.summary.token);
});

test("classify sets the kind of live memories that have none, and leaves the rest", async () => {
  const app = await createApp();
  modelKind(app, "episodic");
  const a = await seed(app, { name: "unlabelled-a", kind: null });
  const b = await seed(app, { name: "unlabelled-b", kind: null });
  const trashed = await seed(app, { name: "trashed", kind: null, deleted_at: START - DAY });
  const labelled = await seed(app, { name: "labelled", kind: "semantic" });
  const out = await only(app, "classify");
  assert.deepEqual([out.classified, out.failed, out.remaining], [2, 0, 0]);
  assert.equal((await row(app, a)).kind, "episodic");
  assert.equal((await row(app, b)).kind, "episodic");
  assert.equal((await row(app, trashed)).kind, null);
  assert.equal((await row(app, labelled)).kind, "semantic");
  assert.equal((await row(app, a)).updated_at, START, "a label is not a content change");
});

test("classify stops early when the model is down, and finishes over runs when it is not", async () => {
  const app = await createApp();
  for (let i = 0; i < 12; i++) await seed(app, { name: `label-${i}`, text: `zq${i}`, kind: null });
  modelKind(app, null);
  const down = await only(app, "classify");
  assert.deepEqual([down.classified, down.failed, down.remaining], [0, 4, 12], "it gave up after one group of failures");
  modelKind(app, "semantic");
  const first = await only(app, "classify", { subrequests: 14 });
  assert.equal(first.classified, 3);
  assert.equal(first.remaining, 9);
  const rest = await only(app, "classify");
  assert.deepEqual([rest.classified, rest.remaining], [9, 0]);
});

// ------------------------------------------------------------------ merge

const mergeSetup = async (over = {}) => {
  const app = await createApp();
  const older = await seed(app, { name: "deploy-note-a", text: BASE_30, ageDays: 5, ...over.older });
  const newer = await seed(app, { name: "deploy-note-b", text: SWAP_30, ageDays: 2, ...over.newer });
  await indexAll(app);
  return { app, older, newer };
};

test("a near duplicate capture is closed into the older one with a merge version", async () => {
  const { app, older, newer } = await mergeSetup();
  const out = await only(app, "merge");
  assert.equal(out.merged, 1);
  assert.deepEqual(out.examples, [{ from: "deploy-note-b", into: "deploy-note-a" }]);
  const closed = await row(app, newer);
  assert.equal(closed.valid_until, START);
  assert.equal(closed.superseded_by, older);
  assert.equal(closed.deleted_at, null, "closed, not deleted");
  const survivor = await row(app, older);
  assert.equal(survivor.valid_until, null);
  assert.equal(survivor.superseded_by, null);
  const versions = await rows(app, "SELECT reason, snapshot FROM memory_versions WHERE memory_id = ?", newer);
  assert.deepEqual(versions.map((v) => v.reason), ["merge"]);
  assert.equal(JSON.parse(versions[0].snapshot).valid_until, null, "the version holds the state before the merge");
  assert.equal((await rows(app, "SELECT * FROM memory_versions WHERE memory_id = ?", older)).length, 0);
  assert.equal((await app.call(`/history?id=${newer}`)).json.versions[0].summary, "closed");
});

test("explicit, profile, person, system, import and pinned memories are never merged and never a match", async () => {
  for (const origin of ["explicit", "profile", "person", "system", "import"]) {
    const asNewer = await mergeSetup({ newer: { origin } });
    assert.equal((await only(asNewer.app, "merge")).merged, 0, `${origin} as the newer one`);
    assert.equal((await row(asNewer.app, asNewer.newer)).valid_until, null);
    const asOlder = await mergeSetup({ older: { origin } });
    assert.equal((await only(asOlder.app, "merge")).merged, 0, `${origin} as the older one`);
    assert.equal((await row(asOlder.app, asOlder.newer)).valid_until, null);
  }
  const pinnedNewer = await mergeSetup({ newer: { tags: ["capsule:core", "capsule-slot:identity"] } });
  assert.equal((await only(pinnedNewer.app, "merge")).merged, 0);
  const pinnedOlder = await mergeSetup({ older: { tags: ["capsule:core", "capsule-slot:identity"] } });
  assert.equal((await only(pinnedOlder.app, "merge")).merged, 0);
  const pinnedColumn = await mergeSetup({ newer: { pinned: 1 } });
  assert.equal((await only(pinnedColumn.app, "merge")).merged, 0);
});

test("captures of another project, or below 0.90, or already closed or trashed are left alone", async () => {
  const project = await mergeSetup({ newer: { project: "other" } });
  assert.equal((await only(project.app, "merge")).merged, 0);
  const far = await createApp();
  await seed(far, { name: "zqone", description: "", text: OLD_FACT, ageDays: 5 });
  await seed(far, { name: "zqtwo", description: "", text: NEW_FACT, ageDays: 2 });
  await indexAll(far);
  assert.equal((await only(far, "merge")).merged, 0);
  const trashed = await mergeSetup({ older: { deleted_at: START - DAY } });
  assert.equal((await only(trashed.app, "merge")).merged, 0);
  const closed = await mergeSetup({ older: { valid_until: START - DAY } });
  assert.equal((await only(closed.app, "merge")).merged, 0);
});

test("a canonical memory is never merged, as the newer one or as the older one", async () => {
  const asNewer = await mergeSetup({ newer: { status: "canonical" } });
  assert.equal((await only(asNewer.app, "merge")).merged, 0);
  assert.equal((await row(asNewer.app, asNewer.newer)).valid_until, null);
  const asOlder = await mergeSetup({ older: { status: "canonical" } });
  assert.equal((await only(asOlder.app, "merge")).merged, 0);
  assert.equal((await row(asOlder.app, asOlder.newer)).valid_until, null);
});

test("a pair needs 0.90 similarity and 0.45 word overlap, so a close vector with different words is left alone", async () => {
  const setup = async (similarity) => {
    const app = await createApp();
    const older = await seed(app, { name: "frame-one", text: BASE_30, ageDays: 5 });
    await seed(app, { name: "frame-two", text: UNRELATED, ageDays: 2 });
    app.env.VECTORIZE.query = async () => ({ matches: [{ id: `${older}:chunk:0`, score: similarity }] });
    return app;
  };
  assert.ok(overlap(BASE_30, UNRELATED) < 0.45, "the two texts differ");
  assert.equal((await only(await setup(0.99), "merge")).merged, 0, "high similarity, low overlap");
  const mixed = await mergeSetup();
  mixed.app.env.VECTORIZE.query = async () => ({ matches: [{ id: `${mixed.older}:chunk:0`, score: 0.89 }] });
  assert.equal((await only(mixed.app, "merge")).merged, 0, "high overlap, similarity just under 0.90");
  mixed.app.env.VECTORIZE.query = async () => ({ matches: [{ id: `${mixed.older}:chunk:0`, score: 0.9 }] });
  assert.equal((await only(mixed.app, "merge")).merged, 1, "0.90 is enough");
});

test("only captures from the last 14 days are candidates, but an older capture can be the survivor", async () => {
  const stale = await mergeSetup({ older: { ageDays: 30 }, newer: { ageDays: 14.5 } });
  assert.equal((await only(stale.app, "merge")).merged, 0, "the newer one is outside the window");
  const edge = await mergeSetup({ older: { ageDays: 30 }, newer: { ageDays: 13.9 } });
  const out = await only(edge.app, "merge");
  assert.equal(out.merged, 1, "inside the window, the older one is 30 days old and still survives");
  assert.equal((await row(edge.app, edge.newer)).superseded_by, edge.older);
});

test("the oldest of three near duplicates survives and the others close into it", async () => {
  const app = await createApp();
  const a = await seed(app, { name: "dup-a", text: BASE_30, ageDays: 6 });
  const b = await seed(app, { name: "dup-b", text: SWAP_30, ageDays: 4 });
  const c = await seed(app, { name: "dup-c", text: BASE_30, ageDays: 2 });
  await indexAll(app);
  assert.equal((await only(app, "merge")).merged, 2);
  assert.equal((await row(app, a)).valid_until, null);
  assert.equal((await row(app, b)).superseded_by, a);
  assert.equal((await row(app, c)).superseded_by, a);
});

test("the merge step prices a candidate at what the ones before it cost, so a night examines more than three", async () => {
  const app = await createApp();
  for (let i = 0; i < 12; i++) await seed(app, { name: `solo-${i}`, text: `zq${i}a zq${i}b zq${i}c zq${i}d unique words ${i} ${i * 7}`, ageDays: 1 + i / 20 });
  await indexAll(app);
  const out = await only(app, "merge");
  assert.equal(out.merged, 0);
  assert.ok(out.examined >= 6, `examined ${out.examined} with a budget of 40`);
  assert.ok(out.subrequests <= 40, `used ${out.subrequests}`);
  assert.equal(out.completed, false, "the rest waits for the next night");
  const cursor = await rows(app, "SELECT value FROM meta WHERE key = 'merge_cursor'");
  assert.equal(cursor.length, 1, "the cursor is kept so the next night continues");
});

test("two captures that share a name and text merge even when the older one is not searchable yet", async () => {
  const app = await createApp();
  const older = await seed(app, { name: "same-name", text: BASE_30, ageDays: 3 });
  const newer = await seed(app, { name: "same-name", text: SWAP_30, ageDays: 1 });
  await indexAll(app);
  // lose the older one's vectors, as when it was written seconds ago
  const ids = [...app.env.VECTORIZE.vectors.keys()].filter((id) => id.startsWith(older));
  await app.env.VECTORIZE.deleteByIds(ids);
  const out = await only(app, "merge");
  assert.equal(out.merged, 1);
  assert.equal((await row(app, newer)).superseded_by, older);
});

test("the name fallback does not merge a same name capture with different text", async () => {
  const app = await createApp();
  await seed(app, { name: "session-notes", text: OLD_FACT, ageDays: 3 });
  await seed(app, { name: "session-notes", text: NEW_FACT, ageDays: 1 });
  assert.equal((await only(app, "merge")).merged, 0, "nothing is indexed, so only the fallback could match, and the text differs");
});

test("a search failure leaves the pair for the name fallback and never fails the step", async () => {
  const { app, older, newer } = await mergeSetup({ older: { name: "twin" }, newer: { name: "twin" } });
  app.env.VECTORIZE.failing = true;
  app.env.VECTORIZE.query = async () => {
    throw new Error("vectorize is down");
  };
  const out = await only(app, "merge");
  assert.equal(out.error, undefined);
  assert.equal(out.merged, 1);
  assert.equal((await row(app, newer)).superseded_by, older);
});

test("a merge backlog continues from where the last run stopped, then starts over", async () => {
  const app = await createApp();
  for (let i = 0; i < 6; i++) await seed(app, { name: `solo-${i}`, text: `zq${i}a zq${i}b zq${i}c zq${i}d zq${i}e`, ageDays: 6 - i });
  await indexAll(app);
  const examined = [];
  let run;
  for (let night = 1; night <= 6; night++) {
    run = await only(app, "merge", { subrequests: 24 });
    examined.push(run.examined);
    if (run.completed) break;
    assert.ok(await app.env.DB.prepare("SELECT value FROM meta WHERE key = 'merge_cursor'").first(), "the cursor is kept for the next night");
  }
  assert.equal(run.completed, true);
  assert.ok(examined.length > 1, "the backlog did not fit in one night");
  assert.equal(examined.reduce((a, b) => a + b, 0), 6, "every capture was examined once across the nights");
  assert.equal(await app.env.DB.prepare("SELECT value FROM meta WHERE key = 'merge_cursor'").first(), null, "the sweep is done, the cursor is cleared");
  assert.ok((await only(app, "merge", { subrequests: 24 })).examined > 0, "the next sweep starts again");
});

test("a duplicate that arrives after the cursor passed is found by the same sweep", async () => {
  const app = await createApp();
  await seed(app, { name: "first", text: distinct(1), ageDays: 6 });
  await seed(app, { name: "second", text: BASE_30, ageDays: 5 });
  await indexAll(app);
  assert.equal((await only(app, "merge", { subrequests: 14 })).completed, false);
  const dup = await seed(app, { name: "late-dup", text: SWAP_30, ageDays: 1 });
  await indexAll(app);
  const rest = await only(app, "merge");
  assert.equal(rest.merged, 1);
  assert.ok((await row(app, dup)).superseded_by);
});

// ------------------------------------------------------------------ probation

const probation = async (specs) => {
  const app = await createApp();
  const ids = {};
  for (const [key, spec] of Object.entries(specs)) ids[key] = await seed(app, { name: key, text: `zq-${key}`, ...spec });
  const out = await only(app, "probation");
  return { app, ids, out };
};

test("a recalled capture whose probation time has passed ends probation", async () => {
  const { app, ids, out } = await probation({
    recalledPast: { recalls: 1, probationInDays: -1, ageDays: 61 },
    recalledNow: { recalls: 1, probationInDays: 0, ageDays: 10 },
    recalledFuture: { recalls: 5, probationInDays: 1, ageDays: 10 },
    unrecalledPast: { recalls: 0, probationInDays: -1, ageDays: 10 },
    explicit: { origin: "explicit", recalls: 1, probationInDays: -1 },
  });
  assert.equal(out.probation_ended, 1);
  assert.equal((await row(app, ids.recalledPast)).probation_until, null);
  assert.equal((await row(app, ids.recalledNow)).probation_until, START, "probation_until equal to now is not in the past yet");
  assert.ok((await row(app, ids.recalledFuture)).probation_until > START);
  assert.ok((await row(app, ids.unrecalledPast)).probation_until < START, "never recalled, still young, left as it is");
  assert.ok((await row(app, ids.explicit)).probation_until < START);
  assert.equal((await row(app, ids.recalledPast)).deleted_at, null);
});

test("a capture never recalled goes to the trash after 60 days, to the day", async () => {
  const { app, ids, out } = await probation({
    exactly60: { created_at: START - 60 * DAY },
    justUnder: { created_at: START - 60 * DAY + 1 },
    recalledOld: { ageDays: 100, recalls: 1, lastRecalledDaysAgo: 5 },
    countedNoStamp: { ageDays: 100, recalls: 2 },
  });
  assert.equal(out.retired_never_recalled, 1);
  assert.equal((await row(app, ids.exactly60)).deleted_at, START);
  assert.equal((await row(app, ids.justUnder)).deleted_at, null);
  assert.equal((await row(app, ids.recalledOld)).deleted_at, null);
  assert.equal((await row(app, ids.countedNoStamp)).deleted_at, null);
  const versions = await rows(app, "SELECT reason FROM memory_versions WHERE memory_id = ?", ids.exactly60);
  assert.deepEqual(versions.map((v) => v.reason), ["retire_never_recalled"]);
  assert.deepEqual(out.examples.never_recalled, ["exactly60"]);
  assert.equal((await app.call(`/entry?id=${ids.exactly60}`)).status, 404, "it is in the trash");
  assert.equal((await app.call("/restore", { method: "POST", body: { id: ids.exactly60 } })).status, 200, "and can be restored");
});

test("a project capture with no recall in 90 days goes to the trash, to the day", async () => {
  const { app, ids, out } = await probation({
    idle90: { type: "project", ageDays: 200, recalls: 4, lastRecalledDaysAgo: 90 },
    idle89: { type: "project", ageDays: 200, recalls: 4, lastRecalledDaysAgo: 89.999 },
    recentlyUsed: { type: "project", ageDays: 200, recalls: 4, lastRecalledDaysAgo: 3 },
    notProject: { type: "reference", ageDays: 200, recalls: 4, lastRecalledDaysAgo: 120 },
    noStamp: { type: "project", created_at: START - 90 * DAY, recalls: 1 },
    noStampYoung: { type: "project", created_at: START - 90 * DAY + 1, recalls: 1 },
  });
  assert.equal(out.retired_idle_project, 2);
  assert.equal((await row(app, ids.idle90)).deleted_at, START);
  assert.equal((await row(app, ids.noStamp)).deleted_at, START, "created_at stands in when there is no recall time");
  for (const key of ["idle89", "recentlyUsed", "notProject", "noStampYoung"]) assert.equal((await row(app, ids[key])).deleted_at, null, key);
  const reasons = await rows(app, "SELECT reason FROM memory_versions WHERE memory_id = ?", ids.idle90);
  assert.deepEqual(reasons.map((v) => v.reason), ["retire_idle_project"]);
});

test("explicit, profile, person, system, import, pinned, canonical, closed and trashed memories are never retired", async () => {
  const old = { ageDays: 400, recalls: 0 };
  const specs = {};
  for (const origin of ["explicit", "profile", "person", "system", "import"]) specs[origin] = { ...old, origin, type: "project" };
  specs.pinned = { ...old, tags: ["capsule:core", "capsule-slot:identity"] };
  specs.pinnedColumn = { ...old, pinned: 1 };
  specs.canonical = { ...old, status: "canonical" };
  specs.closed = { ...old, valid_until: START - DAY };
  specs.alreadyTrashed = { ...old, deleted_at: START - 2 * DAY };
  const { app, ids, out } = await probation(specs);
  assert.equal(out.retired_never_recalled + out.retired_idle_project, 0);
  for (const [key, id] of Object.entries(ids)) {
    const r = await row(app, id);
    assert.equal(r.deleted_at, key === "alreadyTrashed" ? START - 2 * DAY : null, key);
  }
});

test("retirement is bounded by the budget and the rest waits for the next night", async () => {
  const app = await createApp();
  for (let i = 0; i < 20; i++) await seed(app, { name: `stale-${i}`, text: `zq${i}`, ageDays: 70 });
  const first = await only(app, "probation", { subrequests: 16 });
  assert.ok(first.retired_never_recalled > 0 && first.retired_never_recalled < 20);
  assert.equal(first.more, true);
  assert.ok(first.subrequests <= 16);
  let total = first.retired_never_recalled;
  for (let night = 0; night < 5 && total < 20; night++) total += (await only(app, "probation")).retired_never_recalled;
  assert.equal(total, 20);
});

// ------------------------------------------------------------------ old rows and the token

test("audit and counter rows older than 90 days are purged, the rest stay", async () => {
  const app = await createApp();
  const audit = (ts, route) => recordAudit(app.env.DB, { ts, actor: { kind: "admin", id: "a" }, harness: "", script: "", method: "GET", route, status: 200, durationMs: 1, memoryIds: [] });
  await audit(START - RETENTION_MS - 1, "/old");
  await audit(START - RETENTION_MS, "/edge");
  await app.env.DB.batch(
    [[91, "a"], [90, "b"], [89, "c"]].map(([days, name]) => app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES (?, ?, 1)").bind(name, dayOf(START - days * DAY))),
  );
  const out = await only(app, "purge_old");
  assert.equal(out.audit, 1);
  assert.equal(out.counters, 1);
  assert.deepEqual((await rows(app, "SELECT route FROM audit WHERE route LIKE '/%old' OR route = '/edge' ORDER BY route")).map((r) => r.route), ["/edge"]);
  assert.deepEqual((await rows(app, "SELECT name FROM counters ORDER BY name")).map((r) => r.name), ["b", "c"]);
});

test("the token step records the days left, or that none is configured", async () => {
  const expires = new Date(START + 10 * DAY).toISOString().slice(0, 10);
  const app = await createApp({ env: { ACCESS_TOKEN_EXPIRES: expires } });
  const out = await only(app, "token");
  assert.equal(out.expires, expires);
  assert.equal(out.days_left, Math.floor((Date.parse(`${expires}T00:00:00Z`) - START) / DAY));
  assert.equal(out.warn, true);
  const none = await createApp();
  assert.equal((await only(none, "token")).configured, false);
});

test("without a backup bucket the backup step says so and the run still succeeds", async () => {
  const app = await createApp({ env: { BACKUP_BUCKET: undefined } });
  const res = await runNightly(app, { steps: ["backup", "token"] });
  assert.equal(res.ok, true);
  assert.match(res.summary.backup.skipped, /BACKUP_BUCKET/);
});
