import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { api, raw, UI_HEADERS } from "./helpers/ui.js";
import { DAY, seed, storeOf } from "./helpers/maintenance.js";
import { recordAudit } from "../audit.js";
import { ownerName, stepView, titleFrom } from "../dashboard-insights.js";
import { PLAN_LIMITS } from "../plan-limits.js";

const ME = "me@example.com";
const recallRow = (app, over = {}) =>
  recordAudit(app.env.DB, { ts: app.clock.t, actor: { kind: "device", id: "d1" }, harness: "claude", script: "hook:recall", method: "GET", route: "/recall", status: 200, durationMs: 9, memoryIds: ["x"], ...over });
const addRun = (app, { job = "nightly", ago = 0, ok = 1, summary = {} } = {}) =>
  app.env.DB.prepare("INSERT INTO runs (job, started_at, finished_at, ok, summary) VALUES (?, ?, ?, ?, ?)").bind(job, app.clock.t - ago, app.clock.t - ago + 1000, ok, JSON.stringify(summary)).run();

test("titleFrom and ownerName read plain text", () => {
  assert.equal(titleFrom("a-name", "text"), "a-name");
  assert.equal(titleFrom("", "\n\n  first line here  \nsecond"), "first line here");
  assert.equal(titleFrom("", ""), "(empty)");
  assert.equal(titleFrom("", "x".repeat(200)).length, 80);
  assert.equal(ownerName("---\nname: profile\n---\nFull name: Alex Example\nPreferred name: Al (confirmed 2026-10-01)\n"), "Al");
  assert.equal(ownerName("Full name: Alex Example (confirmed 2026-10-01)"), "Alex");
  assert.equal(ownerName("Email: a@b.c"), null);
  assert.equal(ownerName(""), null);
});

test("home counts live memories, the week against the week before, and the sidebar numbers", async () => {
  const app = await createApp();
  await seed(app, { name: "profile", origin: "profile", text: "Full name: Alex Example\nEmail: a@b.c", ageDays: 80 });
  await seed(app, { name: "a", ageDays: 1, recalls: 2, lastRecalledDaysAgo: 2 });
  await seed(app, { name: "b", ageDays: 3 });
  await seed(app, { name: "c", ageDays: 10 });
  await seed(app, { name: "d", ageDays: 40 });
  const gone = await seed(app, { name: "gone", ageDays: 2 });
  await seed(app, { name: "waiting", ageDays: 1, status: "pending", origin: "profile" });
  await storeOf(app).softDelete(gone);
  const old = await seed(app, { name: "older", ageDays: 20 });
  const newer = await seed(app, { name: "newer", ageDays: 1 });
  app.clock.t += 1000;
  await storeOf(app).supersede(old, newer, app.clock.t, "merge");
  await recallRow(app);
  await recallRow(app, { ts: app.clock.t - 8 * DAY });
  await recallRow(app, { actor: { kind: "browser", id: ME }, harness: "" });
  const { status, json } = await api(app, "/ui/api/home");
  assert.equal(status, 200);
  assert.equal(json.owner, "Alex");
  assert.deepEqual(json.headline, { live: 6, added_week: 4, added_prev: 1, recalled_week: 1, recall_calls_week: 1, recall_calls_prev: 1, closed_week: 1, closed_prev: 0 });
  assert.equal(json.nav.live, 6);
  assert.equal(json.nav.trash, 1);
  assert.equal(json.nav.pending, 1);
  assert.equal(json.nav.activity_week, 1);
  assert.equal(json.nav.capsule_chars, 0);
  assert.equal(json.nav.capsule_cap, 9500);
  assert.equal(json.checks.length, 8);
  assert.equal(typeof json.summary.attention, "number");
});

test("the waiting count is the People list: a pending memory of another origin does not raise it", async () => {
  const app = await createApp();
  await seed(app, { name: "waiting", ageDays: 1, status: "pending", origin: "profile" });
  await seed(app, { name: "stray", ageDays: 1, status: "pending", origin: "explicit" });
  await seed(app, { name: "tagged", ageDays: 1, status: "pending", origin: "capture", tags: ["profile-proposal"] });
  const { json } = await api(app, "/ui/api/home");
  const people = (await api(app, "/ui/api/people")).json;
  assert.equal(json.nav.pending, 2, "the profile note and the proposal tagged note, not the explicit memory");
  assert.equal(people.pending.length, json.nav.pending, "People and the badge agree");
  assert.equal(json.checks.find((c) => c.id === "pending").detail, "2 changes to accept or dismiss.");
});

test("home says the nightly job failed and names the step, and the backup is checked from the bucket", async () => {
  const app = await createApp();
  await addRun(app, { ago: 3_600_000, ok: 0, summary: { purge_trash: { error: "boom" }, backup: { ok: true } } });
  let { json } = await api(app, "/ui/api/home");
  const check = (id) => json.checks.find((c) => c.id === id);
  assert.equal(check("nightly").state, "fail");
  assert.match(check("nightly").detail, /purge trash/);
  assert.equal(check("backup").state, "fail", "an empty bucket means no backup yet");
  assert.equal(json.summary.worst, "fail");
  await app.call("/backup/run", { method: "POST", body: {} });
  ({ json } = await api(app, "/ui/api/home"));
  assert.equal(check("backup").state, "ok");
  const bare = await createApp({ env: { BACKUP_BUCKET: undefined } });
  ({ json } = await api(bare, "/ui/api/home"));
  assert.equal(check("backup").state, "off");
  assert.equal(check("nightly").state, "warn", "no run at all");
});

test("home reads the counters and the token expiry, and survives Vectorize being down", async () => {
  const app = await createApp({ env: { ACCESS_TOKEN_EXPIRES: "2026-10-10" } });
  app.env.VECTORIZE.failing = true;
  const day = new Date(app.clock.t).toISOString().slice(0, 10);
  await app.env.DB.batch([
    app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES ('capture.rejected.secret', ?, 3)").bind(day),
    app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES ('capture.rejected.rate_limited', ?, 2)").bind(day),
    app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES ('model.failure.embed', ?, 1)").bind(day),
  ]);
  const { status, json } = await api(app, "/ui/api/home");
  assert.equal(status, 200);
  const check = (id) => json.checks.find((c) => c.id === id);
  assert.match(check("captures").detail, /3 captures refused today/);
  assert.match(check("limit").detail, /2 writes held back/);
  assert.equal(check("models").state, "warn");
  assert.equal(check("token").state, "warn", "inside 30 days");
  assert.equal(check("index").state, "ok");
});

test("growth fills every day, counts by origin, and goes weekly for a year", async () => {
  const app = await createApp();
  await seed(app, { name: "e1", origin: "explicit", ageDays: 0 });
  await seed(app, { name: "e2", origin: "explicit", ageDays: 0 });
  await seed(app, { name: "c1", origin: "capture", ageDays: 5 });
  await seed(app, { name: "i1", origin: "import", ageDays: 60 });
  const gone = await seed(app, { name: "gone", origin: "capture", ageDays: 1 });
  await storeOf(app).softDelete(gone);
  const month = (await api(app, "/ui/api/growth")).json;
  assert.equal(month.days, 30);
  assert.equal(month.bucket, "day");
  assert.equal(month.buckets.length, 30);
  assert.deepEqual(month.origins, ["explicit", "capture", "import", "profile", "person", "system"]);
  assert.equal(month.total, 3, "the trashed memory and the one older than 30 days are not counted");
  assert.equal(month.buckets.at(-1).start, new Date(app.clock.t).toISOString().slice(0, 10));
  assert.equal(month.buckets.at(-1).counts.explicit, 2);
  assert.equal(month.buckets.at(-6).counts.capture, 1);
  assert.equal(month.buckets[0].counts.explicit, 0);
  const quarter = (await api(app, "/ui/api/growth?days=90")).json;
  assert.equal(quarter.buckets.length, 90);
  assert.equal(quarter.total, 4);
  const year = (await api(app, "/ui/api/growth?days=365")).json;
  assert.equal(year.bucket, "week");
  assert.ok(year.buckets.length >= 52 && year.buckets.length <= 54, String(year.buckets.length));
  assert.equal(year.total, 4);
  for (const b of year.buckets) assert.equal(new Date(`${b.start}T00:00:00Z`).getUTCDay(), 1, `${b.start} is a Monday`);
  assert.equal(year.buckets.reduce((n, b) => n + Object.values(b.counts).reduce((x, y) => x + y, 0), 0), 4);
});

test("growth refuses a range it does not offer", async () => {
  const app = await createApp();
  for (const q of ["days=7", "days=0", "days=1000", "days=abc", "days=31"]) assert.equal((await api(app, `/ui/api/growth?${q}`)).status, 400, q);
});

test("recalls counts machine recalls per day, the quiet ones, the most recalled and the never recalled", async () => {
  const app = await createApp();
  const hot = await seed(app, { name: "hot", recalls: 9, lastRecalledDaysAgo: 1, ageDays: 40 });
  await seed(app, { name: "warm", recalls: 3, lastRecalledDaysAgo: 5, ageDays: 40 });
  await seed(app, { name: "stale", recalls: 20, lastRecalledDaysAgo: 45, ageDays: 90 });
  const idle = await seed(app, { name: "idle", ageDays: 30 });
  await seed(app, { name: "fresh", ageDays: 2 });
  await seed(app, { name: "pinned-note", ageDays: 30, pinned: 1, origin: "explicit" });
  await recallRow(app);
  await recallRow(app, { memoryIds: [] });
  await recallRow(app, { ts: app.clock.t - 2 * DAY, harness: "codex" });
  await recallRow(app, { status: 502 });
  await recallRow(app, { actor: { kind: "browser", id: ME }, harness: "" });
  await recallRow(app, { route: "/capture", method: "POST" });
  const { json } = await api(app, "/ui/api/recalls");
  assert.equal(json.days.length, 30);
  assert.equal(json.total, 3);
  assert.equal(json.empty, 1);
  assert.deepEqual(json.days.at(-1), { day: new Date(app.clock.t).toISOString().slice(0, 10), calls: 2, empty: 1 });
  assert.deepEqual(json.by_harness, [{ harness: "claude", label: "Claude Code", calls: 2, empty: 1 }, { harness: "codex", label: "Codex", calls: 1, empty: 0 }]);
  assert.deepEqual(json.most_recalled.map((m) => [m.title, m.recall_count]), [["hot", 9], ["warm", 3]]);
  assert.equal(json.most_recalled[0].id, hot);
  assert.equal(json.never_recalled.count, 1);
  assert.deepEqual(json.never_recalled.sample.map((m) => m.id), [idle]);
});

test("never recalled leaves out profile and person notes even when a row is not pinned", async () => {
  const app = await createApp();
  const idle = await seed(app, { name: "idle", ageDays: 30 });
  const profile = await seed(app, { name: "profile", origin: "profile", ageDays: 30 });
  const person = await seed(app, { name: "person", origin: "person", ageDays: 30 });
  // The write path pins these origins. An imported row can still arrive with pinned 0, so the query must not rely on the flag alone.
  await app.env.DB.prepare("UPDATE memories SET pinned = 0 WHERE id IN (?, ?)").bind(profile, person).run();
  const { json } = await api(app, "/ui/api/recalls");
  assert.equal(json.never_recalled.count, 1);
  assert.deepEqual(json.never_recalled.sample.map((m) => m.id), [idle]);
});

test("never recalled leaves out the capsule, whatever its origin and pin, and the copy on Home says so", async () => {
  const app = await createApp();
  const idle = await seed(app, { name: "idle", ageDays: 30 });
  const core = await seed(app, { name: "core imported", origin: "import", ageDays: 30 });
  const slot = await seed(app, { name: "slot imported", origin: "import", ageDays: 30 });
  await app.env.DB.prepare("UPDATE memories SET pinned = 0 WHERE id IN (?, ?)").bind(core, slot).run();
  await app.env.DB.batch([
    app.env.DB.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, 'capsule:core')").bind(core),
    app.env.DB.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, 'capsule-slot:identity')").bind(slot),
  ]);
  const { json } = await api(app, "/ui/api/recalls");
  assert.equal(json.never_recalled.count, 1, "the count leaves the capsule out");
  assert.deepEqual(json.never_recalled.sample.map((m) => m.id), [idle], "the sample leaves the capsule out");
});

test("probation lists captures with the days left and when a never recalled one goes", async () => {
  const app = await createApp();
  const soon = await seed(app, { name: "soon", ageDays: 58, probationInDays: 2 });
  const used = await seed(app, { name: "used", ageDays: 20, probationInDays: 40, recalls: 2, lastRecalledDaysAgo: 3 });
  await seed(app, { name: "done", ageDays: 20 });
  const gone = await seed(app, { name: "gone", ageDays: 20, probationInDays: 40 });
  await storeOf(app).softDelete(gone);
  const { json } = await api(app, "/ui/api/probation");
  assert.equal(json.total, 2);
  assert.deepEqual(json.entries.map((e) => [e.id, e.days_left]), [[soon, 2], [used, 40]]);
  assert.equal(json.entries[0].retire_at, json.entries[0].created_at + 60 * DAY);
  assert.equal(json.entries[1].retire_at, null);
  assert.equal(json.entries[1].recall_count, 2);
});

test("a capture that the nightly job would never retire shows no trash date", async () => {
  const app = await createApp();
  const plain = await seed(app, { name: "plain", ageDays: 20, probationInDays: 40 });
  const pinned = await seed(app, { name: "pinned-one", ageDays: 20, probationInDays: 41, pinned: 1 });
  const canonical = await seed(app, { name: "canonical-one", ageDays: 20, probationInDays: 42, status: "canonical" });
  const imported = await seed(app, { name: "imported-one", ageDays: 20, probationInDays: 43, origin: "import" });
  const { json } = await api(app, "/ui/api/probation");
  const retire = Object.fromEntries(json.entries.map((e) => [e.id, e.retire_at]));
  assert.equal(retire[plain], json.entries.find((e) => e.id === plain).created_at + 60 * DAY);
  assert.deepEqual([retire[pinned], retire[canonical], retire[imported]], [null, null, null]);
  assert.deepEqual(json.entries.map((e) => e.retires), json.entries.map((e) => e.id === plain), "only the plain capture is one the job retires");
});

test("home still answers when the last run left a damaged summary", async () => {
  const app = await createApp();
  await app.env.DB.prepare("INSERT INTO runs (job, started_at, finished_at, ok, summary) VALUES ('nightly', ?, ?, 1, 'not json')").bind(app.clock.t - 1000, app.clock.t).run();
  const { status, json } = await api(app, "/ui/api/home");
  assert.equal(status, 200);
  assert.equal(json.checks.find((c) => c.id === "nightly").state, "ok");
  assert.equal((await app.call("/stats")).status, 200, "and so does /stats");
});

test("activity lists what the system changed, with undo only where it still works", async () => {
  const app = await createApp();
  const store = storeOf(app);
  const old1 = await seed(app, { name: "old-fact", ageDays: 30 });
  const new1 = await seed(app, { name: "new-fact", ageDays: 2 });
  const old2 = await seed(app, { name: "twin-old", ageDays: 20 });
  const new2 = await seed(app, { name: "twin-new", ageDays: 2 });
  const idle = await seed(app, { name: "never-used", ageDays: 70 });
  const user = await seed(app, { name: "user-forgot", ageDays: 3 });
  app.clock.t += 1000;
  await store.supersede(old1, new1, app.clock.t, "supersede");
  app.clock.t += 1000;
  await store.supersede(old2, new2, app.clock.t, "merge");
  app.clock.t += 1000;
  await store.softDelete(idle, "retire_never_recalled");
  app.clock.t += 1000;
  await store.softDelete(user);
  const all = (await api(app, "/ui/api/activity")).json;
  assert.deepEqual(all.entries.map((e) => [e.title, e.kind, e.state, e.can_undo]), [
    ["never-used", "retired", "trashed", true],
    ["twin-old", "merged", "closed", true],
    ["old-fact", "replaced", "closed", true],
  ]);
  assert.equal(all.entries[0].purge_at, app.clock.t - 1000 + 14 * DAY);
  assert.deepEqual(all.entries[2].replaced_by, { id: new1, title: "new-fact" });
  assert.deepEqual(all.last_30_days, { replaced: 1, merged: 1, retired: 1 });
  assert.equal(all.purge_soon, 0);
  // undo through the real route, then the feed says it was changed since
  const undo = await app.call("/undo", { method: "POST", body: { id: old1 }, jwt: app.browserJwt(ME), token: null, headers: { origin: "https://anymem-worker.test", "sec-fetch-site": "same-origin", "x-anymem-ui": "1" } });
  assert.equal(undo.status, 200);
  const after = (await api(app, "/ui/api/activity")).json;
  const row = after.entries.find((e) => e.title === "old-fact");
  assert.deepEqual([row.state, row.can_undo, row.replaced_by], ["changed_since", false, null]);
  assert.equal(after.entries.find((e) => e.title === "never-used").can_undo, true);
});

test("activity filters by kind, pages with a cursor, and refuses bad input", async () => {
  const app = await createApp();
  const store = storeOf(app);
  const target = await seed(app, { name: "target", ageDays: 1 });
  for (let i = 0; i < 5; i++) {
    const id = await seed(app, { name: `old-${i}`, ageDays: 10 + i });
    app.clock.t += 1000;
    await store.supersede(id, target, app.clock.t, i % 2 ? "merge" : "supersede");
  }
  const merged = (await api(app, "/ui/api/activity?kind=merged")).json;
  assert.equal(merged.entries.length, 2);
  assert.ok(merged.entries.every((e) => e.kind === "merged"));
  const first = (await api(app, "/ui/api/activity?n=2")).json;
  assert.equal(first.entries.length, 2);
  const second = (await api(app, `/ui/api/activity?n=2&cursor=${first.next_cursor}`)).json;
  const third = (await api(app, `/ui/api/activity?n=2&cursor=${second.next_cursor}`)).json;
  assert.equal(third.entries.length, 1);
  assert.equal(third.next_cursor, null);
  const ids = [...first.entries, ...second.entries, ...third.entries].map((e) => e.version_id);
  assert.equal(new Set(ids).size, 5);
  for (const q of ["kind=bogus", "kind=constructor", "n=0", "n=101", "cursor=abc", "cursor=0"]) assert.equal((await api(app, `/ui/api/activity?${q}`)).status, 400, q);
});

test("activity filters by state on the server, so every page answers the filter and not only the loaded ones", async () => {
  const app = await createApp();
  const store = storeOf(app);
  const target = await seed(app, { name: "target", ageDays: 1 });
  const old = [];
  for (let i = 0; i < 4; i++) {
    const id = await seed(app, { name: `old-${i}`, ageDays: 10 + i });
    app.clock.t += 1000;
    await store.supersede(id, target, app.clock.t, "supersede");
    old.push(id);
  }
  // The nightly job trashes a memory without a newer version, so the superseded row is still the latest one.
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(app.clock.t, old[0]).run();
  const trashed = (await api(app, "/ui/api/activity?state=trashed")).json;
  assert.deepEqual(trashed.entries.map((e) => e.memory_id), [old[0]], "a trashed memory is trashed, even though it is also closed");
  const closed = (await api(app, "/ui/api/activity?state=closed")).json;
  assert.equal(closed.entries.length, 3);
  assert.ok(closed.entries.every((e) => e.state === "closed"));
  const page = (await api(app, "/ui/api/activity?state=closed&n=1")).json;
  assert.equal(page.entries.length, 1);
  assert.ok(page.next_cursor, "the filter carries on to the next page");
  const next = (await api(app, `/ui/api/activity?state=closed&n=1&cursor=${page.next_cursor}`)).json;
  assert.ok(next.entries.every((e) => e.state === "closed"));
  assert.equal((await api(app, "/ui/api/activity?state=all")).json.entries.length, 4);
  assert.equal((await api(app, "/ui/api/activity?state=nope")).status, 400);
});

test("trash lists what can still be restored, closest to the end first, filtered and sorted on the server", async () => {
  const app = await createApp();
  const trashedAgo = async (name, days, over = {}) => {
    const id = await seed(app, { name, ...over });
    await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(app.clock.t - Math.round(days * DAY), id).run();
    return id;
  };
  const a = await trashedAgo("two-days", 2, { origin: "explicit", project: "alpha" });
  const b = await trashedAgo("thirteen-days", 13, { origin: "capture", project: "beta" });
  await trashedAgo("twenty-days", 20, { origin: "capture" });
  const d = await trashedAgo("an-hour", 1 / 24, { origin: "import" });
  const { json } = await api(app, "/ui/api/trash");
  assert.deepEqual(json.entries.map((e) => e.id), [b, a, d], "closest to the end first");
  assert.equal(json.entries[0].purge_at - json.entries[0].deleted_at, 14 * DAY, "the purge time is the Worker's window");
  assert.equal(json.window_days, 14, "the screen says the window from the Worker");
  assert.equal(json.total, 3, "the twenty day old one is not restorable");
  assert.equal(json.older, 1);
  assert.equal(json.soon, 1, "only the thirteen day old one goes within three days");
  assert.deepEqual(json.projects, ["alpha", "beta"]);
  assert.deepEqual((await api(app, "/ui/api/trash?sort=forgotten")).json.entries.map((e) => e.id), [d, a, b], "newest forgotten first");
  const byOrigin = (await api(app, "/ui/api/trash?origin=capture")).json;
  assert.deepEqual(byOrigin.entries.map((e) => e.id), [b]);
  assert.equal(byOrigin.matching, 1);
  assert.equal(byOrigin.total, 3, "the total is for everything restorable, whatever the filter");
  assert.deepEqual((await api(app, "/ui/api/trash?project=alpha")).json.entries.map((e) => e.id), [a]);
  assert.equal((await api(app, `/ui/api/trash?origin=${"x".repeat(41)}`)).status, 400);
  const extras = (await api(app, `/ui/api/memory-extras?id=${b}`)).json;
  assert.equal(extras.purge_at, json.entries[0].purge_at, "the drawer and the list agree on when a memory goes");
  assert.equal((await api(app, `/ui/api/memory-extras?id=${a}`)).json.purge_at, json.entries[1].purge_at);
});

test("activity counts trashed memories that will be purged within three days", async () => {
  const app = await createApp();
  const id = await seed(app, { name: "nearly-gone", ageDays: 30 });
  await storeOf(app).softDelete(id);
  app.clock.t += 12 * DAY;
  assert.equal((await api(app, "/ui/api/activity")).json.purge_soon, 1);
  app.clock.t -= 6 * DAY;
  assert.equal((await api(app, "/ui/api/activity")).json.purge_soon, 0);
});

test("stepView turns one step of a run into a state and a short phrase", () => {
  assert.deepEqual(stepView("purge_trash", { error: "the step took too long" }), { name: "purge trash", state: "failed", headline: "the step took too long" });
  assert.equal(stepView("backup", { refused: { entries: 1 } }).state, "refused");
  assert.deepEqual(stepView("backup", { skipped: "no BACKUP_BUCKET binding" }), { name: "backup", state: "skipped", headline: "no BACKUP_BUCKET binding" });
  const ok = stepView("probation", { probation_ended: 2, retired_never_recalled: 1, more: true, examples: { never_recalled: ["x"] }, subrequests: 4, ms: 30 });
  assert.deepEqual(ok, { name: "probation", state: "ok", headline: "probation ended 2, retired never recalled 1", more: true, ms: 30, subrequests: 4 });
  assert.equal(stepView("x", null).state, "ok");
});

test("runs lists the latest runs newest first with each step, and tolerates a damaged summary", async () => {
  const app = await createApp();
  await addRun(app, { ago: 2 * DAY, summary: { merge: { merged: 1, subrequests: 5, ms: 20 } } });
  await addRun(app, { job: "manual", ago: DAY, ok: 0, summary: { backup: { refused: { entries: 1 } }, token: { days_left: 5, warn: true } } });
  await app.env.DB.prepare("INSERT INTO runs (job, started_at, summary) VALUES ('nightly', ?, 'not json')").bind(app.clock.t).run();
  const { json } = await api(app, "/ui/api/runs");
  assert.equal(json.runs.length, 3);
  assert.deepEqual(json.runs[0].steps, []);
  assert.equal(json.runs[0].ok, null);
  assert.deepEqual(json.runs[1].steps.map((s) => [s.name, s.state]), [["backup", "refused"], ["token", "ok"]]);
  assert.equal(json.runs[1].job, "manual");
  assert.equal(json.runs[2].steps[0].headline, "merged 1");
  assert.equal((await api(app, "/ui/api/runs?n=1")).json.runs.length, 1);
  for (const q of ["n=0", "n=31", "n=x"]) assert.equal((await api(app, `/ui/api/runs?${q}`)).status, 400, q);
});

test("usage reports size against the plan, the write limit by token, and the counters per day", async () => {
  const app = await createApp();
  await app.call("/devices", { method: "POST", body: { label: "laptop" } });
  const device = (await app.env.DB.prepare("SELECT id FROM devices").first()).id;
  for (let i = 0; i < 3; i++) await app.call("/capture", { method: "POST", body: { content: `a unique memory number ${i}` } });
  await app.env.DB.prepare("INSERT INTO write_counter (token_id, window_start, writes) VALUES (?, ?, 5)").bind(device, app.clock.t - 60_000).run();
  const day = new Date(app.clock.t).toISOString().slice(0, 10);
  const old = new Date(app.clock.t - 3 * DAY).toISOString().slice(0, 10);
  await app.env.DB.batch(
    [["extract.proposed", day, 4], ["extract.screened.secret", day, 1], ["extract.screened.bad_name", old, 2], ["capture.rejected.secret", day, 2], ["capture.rejected.duplicate", day, 6], ["capture.rejected.rate_limited", old, 3], ["model.failure.kind", day, 1]].map(([n, d, c]) =>
      app.env.DB.prepare("INSERT INTO counters (name, day, count) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET count = count + excluded.count").bind(n, d, c),
    ),
  );
  const { status, json } = await api(app, "/ui/api/usage");
  assert.equal(status, 200);
  assert.ok(json.db.size_bytes > 0);
  assert.equal(json.db.limit_bytes, PLAN_LIMITS.d1_bytes);
  assert.equal(json.vectors.dimensions, 384);
  assert.equal(json.vectors.limit, PLAN_LIMITS.vectors_per_index);
  assert.equal(json.vectors.stored_dimensions, json.vectors.count * 384);
  assert.equal(json.vectors.included_dimensions, PLAN_LIMITS.vector_dimensions_included);
  assert.equal(json.plan.plan, "Workers Paid");
  assert.equal(json.write_limit.limit, 40);
  assert.equal(json.write_limit.window_minutes, 10);
  const byLabel = Object.fromEntries(json.write_limit.tokens.map((t) => [t.label, t]));
  assert.equal(byLabel["Admin token"].used, 3);
  assert.equal(byLabel.laptop.used, 5);
  assert.equal(byLabel.laptop.resets_in_seconds, 540);
  assert.equal(json.days.length, 14);
  const today = json.days.at(-1);
  assert.equal(today.proposed, 4);
  assert.equal(today.screened, 1);
  assert.ok(today.saved >= 3);
  assert.equal(today.refused, 2);
  assert.equal(today.duplicates, 6);
  const failures = (await app.env.DB.prepare("SELECT SUM(count) AS n FROM counters WHERE name LIKE 'model.failure.%' AND day = ?").bind(day).first()).n;
  assert.ok(failures >= 1);
  assert.equal(today.model_failures, failures);
  assert.equal(json.days.find((d) => d.day === old).screened, 2);
  assert.equal(json.days.find((d) => d.day === old).limited, 3);
});

test("usage labels a browser login's writes as the dashboard, never as an unknown device", async () => {
  const app = await createApp();
  await app.call("/capture", { method: "POST", body: { content: "a memory the admin token saved" } });
  await raw(app, "/capture", { method: "POST", jwt: app.browserJwt(ME), headers: UI_HEADERS, body: { content: "Preferred name: Alex", source: "profile" } });
  const { json } = await api(app, "/ui/api/usage");
  const labels = Object.fromEntries(json.write_limit.tokens.map((t) => [t.label, t]));
  assert.equal(labels["Admin token"].used, 1);
  assert.equal(labels.Dashboard.used, 1);
  assert.equal(labels["Unknown device"], undefined);
});

test("usage does not list a device's model call slots as a second, unknown device", async () => {
  const app = await createApp();
  await app.call("/devices", { method: "POST", body: { label: "laptop" } });
  const device = (await app.env.DB.prepare("SELECT id FROM devices").first()).id;
  await app.env.DB.prepare("INSERT INTO write_counter (token_id, window_start, writes) VALUES (?, ?, 7)").bind(`model:${device}`, app.clock.t - 60_000).run();
  const { json } = await api(app, "/ui/api/usage");
  assert.deepEqual(json.write_limit.tokens.map((t) => t.id), [], "the model call row is not a write row");
});

test("usage leaves out what Vectorize or D1 will not say", async () => {
  const app = await createApp();
  app.env.VECTORIZE.failing = true;
  const { status, json } = await api(app, "/ui/api/usage");
  assert.equal(status, 200);
  assert.equal(json.vectors, null);
});

test("audit facets list the harnesses, routes and calls per day", async () => {
  const app = await createApp();
  await recallRow(app);
  await recallRow(app, { harness: "codex" });
  await recallRow(app, { harness: "codex", status: 500, ts: app.clock.t - 2 * DAY });
  await recallRow(app, { harness: "kilo", route: "/capture", method: "POST" });
  await recallRow(app, { ts: app.clock.t - 40 * DAY });
  const { json } = await api(app, "/ui/api/audit-facets");
  assert.equal(json.days, 14);
  assert.deepEqual(json.harnesses[0], { harness: "codex", label: "Codex", calls: 2 });
  assert.deepEqual(Object.fromEntries(json.harnesses.map((h) => [h.harness, h.calls])), { codex: 2, claude: 1, kilo: 1 }, "a call from 40 days ago is outside the window");
  assert.equal(json.routes[0].route, "/recall");
  assert.equal(json.per_day.length, 14);
  assert.deepEqual(json.per_day.at(-3), { day: new Date(app.clock.t - 2 * DAY).toISOString().slice(0, 10), ok: 0, bad: 1 });
  assert.equal((await api(app, "/ui/api/audit-facets?days=90")).json.per_day.length, 90);
  for (const q of ["days=0", "days=91", "days=x"]) assert.equal((await api(app, `/ui/api/audit-facets?${q}`)).status, 400, q);
});

const ROUTES = ["home", "growth", "recalls", "probation", "activity", "trash", "runs", "usage", "audit-facets", "harnesses", "sources"];

test("every insight route needs a browser login or the admin token, and a device token is refused", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  for (const name of ROUTES) {
    const path = `/ui/api/${name}`;
    assert.equal((await raw(app, path, {})).status, 401, `${path} with no login`);
    assert.equal((await raw(app, path, { jwt: app.browserJwt("stranger@example.com") })).status, 403, `${path} for a stranger`);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token })).status, 403, `${path} with a device token`);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token: ADMIN_TOKEN })).status, 200, `${path} with the admin token`);
    assert.equal((await raw(app, path, { jwt: app.browserJwt(ME) })).status, 200, `${path} with a browser login`);
    assert.equal((await raw(app, path, { method: "POST", jwt: app.browserJwt(ME), body: {} })).status, 405, `${path} is read only`);
  }
});

test("the insight routes write nothing but their own audit row", async () => {
  const app = await createApp();
  await seed(app, { name: "one", ageDays: 1 });
  const snapshot = async () =>
    JSON.stringify(await Promise.all(["memories", "memory_versions", "runs", "counters", "write_counter", "meta", "capsule_cache", "recall_log"].map(async (t) => (await app.env.DB.prepare(`SELECT * FROM ${t}`).all()).results)));
  await api(app, "/ui/api/home");
  const before = await snapshot();
  for (const name of ROUTES) await api(app, `/ui/api/${name}`);
  assert.equal(await snapshot(), before);
  const rows = (await app.env.DB.prepare("SELECT DISTINCT route FROM audit").all()).results.map((r) => r.route);
  assert.ok(ROUTES.every((n) => rows.includes(`/ui/api/${n}`)));
});
