// The nightly clustering step and its preview. All sample subjects are invented (a Corolla, a garden app, Pip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterStep, cohesion, slugOf } from "../cron/cluster.js";
import { createBudget, countedEnv } from "../cron/budget.js";
import { ADMIN_TOKEN } from "./helpers/app.js";
import { apart, clusterApp, group, indexAll, runStep, stubPropose } from "./helpers/cluster.js";
import { rows } from "./helpers/maintenance.js";
import { addSubject, about, device } from "./helpers/subjects.js";

const names = (calls) => calls.map((c) => c.name).sort();

// ------------------------------------------------------------------ what groups

test("a group of 5 that shares a tag is proposed once, with its evidence and the cohesion as confidence", async () => {
  const app = await clusterApp();
  const ids = await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(summary.proposed, 1);
  assert.deepEqual(summary.slugs, ["corolla"]);
  assert.equal(propose.calls.length, 1);
  const call = propose.calls[0];
  assert.equal(call.name, "corolla");
  assert.equal(call.kind, "topic");
  assert.deepEqual(call.evidence.map((e) => e.id).sort(), [...ids].sort());
  for (const e of call.evidence) assert.ok(e.confidence >= 0.55 && e.confidence <= 1, `confidence ${e.confidence}`);
  // the stub does what createProposed does: every evidence memory has an about link to the proposed card, made by the system
  const links = await rows(app, "SELECT source_id, link_type, made_by, confidence FROM links WHERE target_id = (SELECT id FROM subjects WHERE slug = 'corolla')");
  assert.equal(links.length, 5);
  assert.ok(links.every((l) => l.link_type === "about" && l.made_by === "system" && l.confidence === call.evidence[0].confidence));
  // the step asks createProposed to audit as the cluster step, which is what gives the row its route and actor
  assert.equal(call.step, "cluster");
  const audit = await rows(app, "SELECT * FROM audit WHERE route = 'cluster.propose'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_kind, "system");
  assert.equal(audit[0].actor_id, "cluster");
  assert.equal(JSON.parse(audit[0].memory_ids).length, 6, "the card and the five memories");
});

test("a group of 4 is not proposed", async () => {
  const app = await clusterApp();
  await group(app, { n: 4, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(summary.proposed, 0);
  assert.equal(propose.calls.length, 0);
  assert.equal(summary.groups, 0);
});

test("tags the system writes by itself never group, however many memories share them", async () => {
  const app = await clusterApp();
  await group(app, { n: 6, topic: "alpha", extraTags: ["auto-capture", "captured-by:codex", "session:1a2b3c4d", "subject:ghost", "subject-kind:pet", "capsule:core"] });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(propose.calls.length, 0);
  assert.equal(summary.groups, 0);
  assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM subjects"))[0].n, 0);
});

test("a shared project makes a project proposal", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "garden", project: "garden-app" });
  await indexAll(app);
  const propose = stubPropose();
  await runStep(app, clusterStep, { propose });
  assert.deepEqual(propose.calls.map((c) => [c.name, c.kind]), [["garden-app", "project"]]);
});

test("a shared leading word of the memory name groups, a stop word and a short word do not", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", lead: "corolla" });
  await group(app, { n: 5, topic: "update", lead: "update" }); // a common word
  await group(app, { n: 5, topic: "van", lead: "van" }); // three letters
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.deepEqual(names(propose.calls), ["corolla"]);
  assert.equal(summary.groups, 1);
});

test("a tag and a leading word with the same text are one group, and a project wins the kind", async () => {
  const app = await clusterApp();
  const ids = await group(app, { n: 3, topic: "pipeline", lead: "pipeline", tag: "pipeline" });
  const more = await group(app, { n: 3, topic: "pipeline", tag: "pipeline", project: "pipeline" });
  await indexAll(app);
  const propose = stubPropose();
  await runStep(app, clusterStep, { propose });
  assert.equal(propose.calls.length, 1);
  assert.equal(propose.calls[0].kind, "project");
  assert.equal(propose.calls[0].evidence.length, ids.length + more.length);
});

test("only live captures and explicit notes from the last 90 days with no about link and no card tag are candidates", async () => {
  const app = await clusterApp();
  await group(app, { n: 2, topic: "corolla", tag: "corolla" });
  await group(app, { n: 2, topic: "corolla", tag: "corolla", ageDays: 120 }); // too old
  await group(app, { n: 2, topic: "corolla", tag: "corolla", origin: "import" }); // not a capture
  await group(app, { n: 2, topic: "corolla", tag: "corolla", origin: "profile" });
  await group(app, { n: 2, topic: "corolla", tag: "corolla", extraTags: ["subject"] }); // a card
  const trashed = await group(app, { n: 2, topic: "corolla", tag: "corolla" });
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id IN (SELECT value FROM json_each(?))").bind(app.clock.t, JSON.stringify(trashed)).run();
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(propose.calls.length, 0, "ten of the twelve are excluded, so two remain");
  assert.equal(summary.memories, 2);
});

test("members already linked to a subject, a private one included, are never pulled into a proposal", async () => {
  const app = await clusterApp();
  const ids = await group(app, { n: 8, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  for (const id of ids.slice(0, 4)) await about(app, id, pip);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(propose.calls.length, 0, "only 4 are free");
  assert.equal(summary.memories, 4);
  // with a fifth free memory the group is proposed, and none of the linked four is in its evidence
  const [extra] = await group(app, { n: 1, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const again = stubPropose();
  await runStep(app, clusterStep, { propose: again });
  assert.equal(again.calls.length, 1);
  const evidence = again.calls[0].evidence.map((e) => e.id);
  assert.ok(evidence.includes(extra));
  for (const id of ids.slice(0, 4)) assert.ok(!evidence.includes(id));
});

// ------------------------------------------------------------------ the limits

test("at most 3 proposals a night, the biggest groups first, and the rest wait", async () => {
  const app = await clusterApp();
  const sizes = { alpha: 9, bravo: 8, charlie: 7, delta: 6, echo: 5 };
  for (const [topic, n] of Object.entries(sizes)) await group(app, { n, topic, tag: topic });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.deepEqual(summary.slugs, ["alpha", "bravo", "charlie"]);
  assert.equal(propose.calls.length, 3);
  assert.equal(summary.dropped.over_cap, 2);
  // the next night picks up the two that waited, because the first three now exist
  const next = stubPropose();
  const second = (await runStep(app, clusterStep, { propose: next })).summary;
  assert.deepEqual(second.slugs.sort(), ["delta", "echo"]);
});

test("a name that is a subject slug or alias in any status is not proposed", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await group(app, { n: 5, topic: "dana", tag: "dana" });
  await group(app, { n: 5, topic: "cottage", tag: "cottage" });
  await indexAll(app);
  await addSubject(app, { slug: "corolla", kind: "asset", status: "retired" });
  await addSubject(app, { slug: "dana-lee", kind: "person" });
  await app.env.DB.prepare("UPDATE subjects SET aliases = '[\"Dana\"]' WHERE slug = 'dana-lee'").run();
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.deepEqual(names(propose.calls), ["cottage"]);
  assert.equal(summary.dropped.exists, 2);
});

test("a generic name is dropped without a vector call", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "work", tag: "work" });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(propose.calls.length, 0);
  assert.equal(summary.dropped.generic, 1);
  assert.equal(summary.checked, 0);
  assert.equal(app.env.VECTORIZE.getCalls ?? 0, 0);
});

test("a group whose members are not about one thing is dropped", async () => {
  const app = await clusterApp();
  await group(app, { n: 6, topic: "ceramics", tag: "ceramics", text: apart });
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.deepEqual(names(propose.calls), ["corolla"]);
  assert.equal(summary.dropped.low_cohesion, 1);
  assert.equal(summary.checked, 2);
});

test("the cohesion is the mean cosine of the pairs", () => {
  assert.equal(cohesion([[1, 0], [1, 0], [1, 0]]), 1);
  assert.equal(cohesion([[1, 0], [0, 1]]), 0);
  assert.equal(cohesion([[2, 0], [3, 0]]), 1, "length does not matter, only direction");
  assert.ok(Math.abs(cohesion([[1, 0], [0, 1], [1, 1]]) - (0 + 0.7071 + 0.7071) / 3) < 1e-3);
  assert.equal(cohesion([[1, 0]]), 0);
});

test("a group with fewer than 5 indexed members waits, and a down index is a drop, not a proposal", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  const propose = stubPropose();
  // nothing is indexed yet
  let r = await runStep(app, clusterStep, { propose });
  assert.equal(r.summary.dropped.not_indexed, 1);
  assert.equal(propose.calls.length, 0);
  await indexAll(app);
  app.env.VECTORIZE.failing = true;
  r = await runStep(app, clusterStep, { propose });
  assert.equal(r.summary.dropped.vectors_failed, 1);
  assert.equal(propose.calls.length, 0);
  app.env.VECTORIZE.failing = false;
  r = await runStep(app, clusterStep, { propose });
  assert.equal(r.summary.proposed, 1);
});

test("a vector index without getByIds never makes a proposal", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  app.env.VECTORIZE.getByIds = undefined;
  const propose = stubPropose();
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.equal(summary.proposed, 0);
  assert.equal(summary.dropped.vectors_failed, 1);
});

// ------------------------------------------------------------------ the budget

test("without the budget for a check the group is dropped and counted, never proposed unchecked", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const propose = stubPropose();
  // three reads and nothing else
  const tight = await runStep(app, clusterStep, { propose, subrequests: 3 });
  assert.equal(tight.summary.proposed, 0);
  assert.equal(tight.summary.skipped_budget, 1);
  assert.equal(tight.summary.checked, 0);
  assert.equal(propose.calls.length, 0);
  assert.equal(app.env.VECTORIZE.getCalls ?? 0, 0, "no vector call was made without the budget");
  // not even the reads
  const none = await runStep(app, clusterStep, { propose, subrequests: 2 });
  assert.equal(none.summary.skipped_budget, 1);
  assert.equal(none.spent, 0);
});

test("a group is not even checked when the budget cannot also pay for its proposal", async () => {
  const app = await clusterApp();
  await group(app, { n: 6, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const propose = stubPropose();
  // three reads, then one vector call and createProposed are priced together, so a group is never checked and then left unproposed
  const thin = await runStep(app, clusterStep, { propose, subrequests: 3 + 1 + 9 });
  assert.equal(thin.summary.proposed, 0);
  assert.equal(propose.calls.length, 0);
  assert.equal(thin.summary.skipped_budget, 1);
  assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM subjects"))[0].n, 0);
  const enough = await runStep(app, clusterStep, { propose, subrequests: 3 + 1 + 10 });
  assert.equal(enough.summary.proposed, 1);
});

test("the step stays inside the budget it is given and reports what it spent", async () => {
  const app = await clusterApp();
  for (const topic of ["alpha", "bravo", "charlie"]) await group(app, { n: 6, topic, tag: topic });
  await indexAll(app);
  for (const limit of [3, 8, 12, 25, 40, 80]) {
    const fresh = await clusterApp();
    for (const topic of ["alpha", "bravo", "charlie"]) await group(fresh, { n: 6, topic, tag: topic });
    await indexAll(fresh);
    const r = await runStep(fresh, clusterStep, { propose: stubPropose(), subrequests: limit });
    assert.ok(r.spent <= limit, `spent ${r.spent} of ${limit}`);
  }
});

test("a night with nothing to propose costs 2 subrequests, and with nothing grouped it never reads subjects", async () => {
  const app = await clusterApp();
  await group(app, { n: 3, topic: "corolla", tag: "corolla" });
  const r = await runStep(app, clusterStep, { propose: stubPropose() });
  assert.equal(r.spent, 2);
  const empty = await runStep(await clusterApp(), clusterStep, { propose: stubPropose() });
  assert.equal(empty.spent, 2);
});

test("a night with one candidate: three reads, one vector call and the proposal", async () => {
  const app = await clusterApp();
  await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const r = await runStep(app, clusterStep, { propose: stubPropose() });
  assert.equal(r.summary.proposed, 1);
  assert.equal(app.env.VECTORIZE.getCalls, 1);
  assert.ok(r.spent <= 40, `spent ${r.spent}`);
});

// ------------------------------------------------------------------ the flags

test("with either flag off the step does nothing at all", async () => {
  for (const env of [{ SUBJECTS_AUTO: undefined }, { SUBJECTS: undefined }, { SUBJECTS_AUTO: "off" }, { SUBJECTS: "off" }]) {
    const app = await clusterApp(env);
    await group(app, { n: 5, topic: "corolla", tag: "corolla" });
    await indexAll(app);
    const propose = stubPropose();
    const r = await runStep(app, clusterStep, { propose });
    assert.deepEqual(r.summary, { skipped: "off" });
    assert.equal(r.spent, 0);
    assert.equal(propose.calls.length, 0);
    assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM subjects"))[0].n, 0);
    assert.equal((await rows(app, "SELECT COUNT(*) AS n FROM audit WHERE route = 'cluster.propose'"))[0].n, 0);
  }
});

// ------------------------------------------------------------------ failures

test("a proposal that is refused or throws is dropped and the next group is still tried", async () => {
  const app = await clusterApp();
  await group(app, { n: 6, topic: "alpha", tag: "alpha" });
  await group(app, { n: 5, topic: "bravo", tag: "bravo" });
  await indexAll(app);
  const real = stubPropose();
  const calls = [];
  const propose = async (env, args) => {
    calls.push(args.name);
    if (args.name === "alpha") throw new Error("the module failed to load");
    return real(env, args);
  };
  const { summary } = await runStep(app, clusterStep, { propose });
  assert.deepEqual(calls, ["alpha", "bravo"]);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.slugs, ["bravo"]);
  assert.equal(summary.dropped.failed, 1);

  const app2 = await clusterApp();
  await group(app2, { n: 5, topic: "alpha", tag: "alpha" });
  await indexAll(app2);
  const refused = await runStep(app2, clusterStep, { propose: stubPropose({ refuse: "bad_name" }) });
  assert.equal(refused.summary.proposed, 0);
  assert.equal(refused.summary.dropped.bad_name, 1);
  assert.equal((await rows(app2, "SELECT COUNT(*) AS n FROM audit WHERE route = 'cluster.propose'"))[0].n, 0, "a refusal leaves no audit row of a proposal");
});

test("the slug rule is the subject slug rule", () => {
  assert.equal(slugOf("Corolla"), "corolla");
  assert.equal(slugOf("my  garden_app"), "my-garden-app");
  assert.equal(slugOf("x"), null);
  assert.equal(slugOf("a".repeat(41)), null);
  assert.equal(slugOf("---"), null);
});

// ------------------------------------------------------------------ the preview

async function preview(app, opts = {}) {
  return app.call("/admin/subjects/cluster-preview", opts);
}

async function snapshot(app) {
  const q = (sql) => rows(app, sql);
  return JSON.stringify([await q("SELECT * FROM memories ORDER BY id"), await q("SELECT * FROM subjects"), await q("SELECT * FROM links"), await q("SELECT * FROM audit WHERE route <> '/admin/subjects/cluster-preview'"), await q("SELECT * FROM memory_tags ORDER BY memory_id, tag")]);
}

test("the preview lists what the step would propose and what it dropped, and writes nothing, with the flags off", async () => {
  const app = await clusterApp({ SUBJECTS: undefined, SUBJECTS_AUTO: undefined });
  const ids = await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await group(app, { n: 6, topic: "ceramics", tag: "ceramics", text: apart });
  await group(app, { n: 5, topic: "work", tag: "work" });
  await indexAll(app);
  await addSubject(app, { slug: "cottage", kind: "asset" });
  const before = await snapshot(app);
  const res = await preview(app);
  assert.equal(res.status, 200);
  assert.equal(res.json.candidates.length, 1);
  const c = res.json.candidates[0];
  assert.equal(c.name, "corolla");
  assert.equal(c.kind, "topic");
  assert.equal(c.source, "tag");
  assert.ok(c.cohesion >= 0.55);
  assert.deepEqual(c.evidence.map((e) => e.id).sort(), [...ids].sort());
  assert.ok(c.evidence.every((e) => typeof e.name === "string" && e.name.startsWith("itemcorolla")));
  assert.deepEqual(res.json.dropped.map((d) => [d.slug, d.reason]).sort(), [["ceramics", "low_cohesion"], ["work", "generic"]]);
  assert.equal(res.json.dropped.find((d) => d.slug === "ceramics").cohesion < 0.55, true);
  assert.equal(res.json.cap, 3);
  assert.ok(res.json.counts.subrequests <= 40);
  assert.equal(await snapshot(app), before, "nothing was written");
});

test("the preview stops at the cap and says which groups it did not reach", async () => {
  const app = await clusterApp();
  for (const topic of ["alpha", "bravo", "charlie", "delta"]) await group(app, { n: 5, topic, tag: topic });
  await indexAll(app);
  const res = await preview(app);
  assert.equal(res.json.candidates.length, 3);
  assert.deepEqual(res.json.dropped.map((d) => d.reason), ["over_cap"]);
});

test("the preview is admin only", async () => {
  const app = await clusterApp();
  const d = await device(app, { allowPrivate: true });
  assert.equal((await preview(app, { token: d.token })).status, 403);
  assert.equal((await preview(app, { token: null })).status, 401);
  assert.equal((await preview(app, { token: ADMIN_TOKEN })).status, 200);
  assert.equal((await app.call("/admin/subjects/cluster-preview", { method: "POST", body: {} })).status, 405);
});

test("a browser login may not run the preview either, it is for the admin token", async () => {
  const app = await clusterApp();
  const res = await app.call("/admin/subjects/cluster-preview", { token: null, jwt: app.browserJwt("Me@Example.com") });
  assert.ok([401, 403].includes(res.status), `status ${res.status}`);
});

// ------------------------------------------------------------------ with the real proposer, when it is in the tree

const hasProposer = await import("../subjects/propose.js").then(() => true, () => false);

test("with the real createProposed a proposal is a pending card that recall never shows, with about links from the evidence", { skip: !hasProposer && "worker/subjects/propose.js is not in this tree" }, async () => {
  const app = await clusterApp();
  const ids = await group(app, { n: 5, topic: "corolla", tag: "corolla" });
  await indexAll(app);
  const { summary } = await runStep(app, clusterStep);
  assert.equal(summary.proposed, 1, JSON.stringify(summary));
  const subject = (await rows(app, "SELECT s.id, s.status, m.status AS card FROM subjects s JOIN memories m ON m.id = s.id WHERE s.slug = 'corolla'"))[0];
  assert.equal(subject.status, "proposed");
  assert.equal(subject.card, "pending");
  const links = await rows(app, "SELECT source_id, made_by FROM links WHERE target_id = ? AND link_type = 'about'", subject.id);
  assert.deepEqual(links.map((l) => l.source_id).sort(), [...ids].sort());
  assert.ok(links.every((l) => l.made_by === "system"));
  const recall = await app.call("/recall?q=corolla+service+history", {});
  assert.ok(!JSON.stringify(recall.json).includes(subject.id), "a proposed subject is not in recall");
  // the next night does not propose it again
  const second = (await runStep(app, clusterStep)).summary;
  assert.equal(second.proposed, 0);
});

test("countedEnv leaves getByIds counted like any other Vectorize call", async () => {
  const app = await clusterApp();
  const budget = createBudget({ now: () => app.clock.t });
  const env = countedEnv(app.env, budget);
  await env.VECTORIZE.getByIds([]);
  assert.equal(budget.spent, 1);
});
