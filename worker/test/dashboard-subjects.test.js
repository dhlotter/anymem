// The dashboard's numbers around proposed subjects. A proposed subject has a pending card memory, and that card is a subject waiting
// for a click on Home and the Subjects badge. It is never one of the profile changes the Profile badge counts.
// All sample names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { api } from "./helpers/ui.js";
import { seed, storeOf } from "./helpers/maintenance.js";
import { addSubject, about } from "./helpers/subjects.js";

/** A proposed subject: its card is pending, as the system leaves it until a click. */
async function propose(app, slug, over = {}) {
  const id = await addSubject(app, { slug, kind: "pet", name: slug, status: "proposed", ...over });
  await app.env.DB.prepare("UPDATE memories SET status = 'pending' WHERE id = ?").bind(id).run();
  return id;
}

test("a proposed subject changes neither the Profile badge, the Profile list nor the pending count of the overview", async () => {
  const app = await createApp();
  await seed(app, { name: "waiting", ageDays: 1, status: "pending", origin: "profile" });
  const before = { home: (await api(app, "/ui/api/home")).json, people: (await api(app, "/ui/api/people")).json, overview: (await api(app, "/ui/api/overview")).json };
  const card = await propose(app, "pip");
  const after = { home: (await api(app, "/ui/api/home")).json, people: (await api(app, "/ui/api/people")).json, overview: (await api(app, "/ui/api/overview")).json };
  assert.equal(before.home.nav.pending, 1);
  assert.equal(after.home.nav.pending, 1, "the badge on Profile ignores the card");
  assert.equal(after.people.pending_total, 1);
  assert.deepEqual(after.people.pending.map((e) => e.id), before.people.pending.map((e) => e.id), "and so does the list");
  assert.equal(after.people.pending.some((e) => e.id === card), false);
  assert.equal(after.overview.pending, 1, "the plain pending count leaves the card out too");
  assert.equal(after.home.checks.find((c) => c.id === "pending").detail, "1 change to accept or dismiss.");
});

test("a pending card of kind person is not a profile change, whatever origin it carries", async () => {
  const app = await createApp();
  // A card the way a future writer might make it: origin person, so the profile rule alone would take it for a change.
  const dana = await seed(app, { name: "dana", ageDays: 1, status: "pending", origin: "person", tags: ["subject", "subject:dana", "subject-kind:person"] });
  await app.env.DB.prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES (?, 'dana', 'person', 'proposed', 'shared', '{}', '[]', ?, ?)").bind(dana, app.clock.t, app.clock.t).run();
  const home = (await api(app, "/ui/api/home")).json;
  const people = (await api(app, "/ui/api/people")).json;
  assert.equal(home.nav.pending, 0);
  assert.equal(people.pending_total, 0);
  assert.deepEqual(people.pending, []);
  assert.equal(home.nav.subjects_proposed, 1, "it waits under Subjects instead");
});

test("the Subjects badge counts proposed subjects only, and not one whose card is in the trash", async () => {
  const app = await createApp();
  assert.equal((await api(app, "/ui/api/home")).json.nav.subjects_proposed, 0);
  await addSubject(app, { slug: "corolla", kind: "asset", name: "the Corolla" });
  await addSubject(app, { slug: "old-cat", kind: "pet", status: "retired" });
  await addSubject(app, { slug: "stale-one", kind: "topic", status: "stale" });
  await propose(app, "pip");
  const gone = await propose(app, "tabby");
  await propose(app, "dana", { kind: "person" });
  assert.equal((await api(app, "/ui/api/home")).json.nav.subjects_proposed, 3);
  await storeOf(app).softDelete(gone);
  assert.equal((await api(app, "/ui/api/home")).json.nav.subjects_proposed, 2, "a card in the trash does not wait for anyone");
});

test("a proposed subject lists with its evidence as members, so Home can say how many memories back it", async () => {
  const app = await createApp();
  const card = await propose(app, "pip");
  for (const n of ["pip-vet", "pip-food", "pip-walk"]) await about(app, await seed(app, { name: n, ageDays: 1 }), card);
  const { status, json } = await api(app, "/subjects?status=proposed");
  assert.equal(status, 200);
  assert.deepEqual(json.subjects.map((s) => [s.slug, s.status, s.member_count]), [["pip", "proposed", 3]]);
});

test("GET /stats says whether the subject layer and its automation are on, and nothing more", async () => {
  const off = await createApp();
  const a = (await off.call("/stats")).json;
  assert.equal(a.subjects_on, false);
  assert.equal(a.subjects_auto, false);
  const on = await createApp({ env: { SUBJECTS: "on", SUBJECTS_AUTO: "on" } });
  const b = (await on.call("/stats")).json;
  assert.equal(b.subjects_on, true);
  assert.equal(b.subjects_auto, true);
  const half = await createApp({ env: { SUBJECTS_AUTO: "on" } });
  const c = (await half.call("/stats")).json;
  assert.equal(c.subjects_on, false, "the two switches are reported as set, the doctor says what they mean together");
  assert.equal(c.subjects_auto, true);
  const odd = await createApp({ env: { SUBJECTS: "true", SUBJECTS_AUTO: "yes" } });
  const d = (await odd.call("/stats")).json;
  assert.equal(d.subjects_on, false, "only the word on counts, like the Worker's own check");
  assert.equal(d.subjects_auto, false);
});
