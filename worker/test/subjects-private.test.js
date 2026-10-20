// The private rule (worker/subjects/private.js) on its own, and wired into the memory routes. All sample text is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenIds, canSee, visibleOnly } from "../subjects/private.js";
import { appWith, note } from "./helpers/search.js";
import { device, wire } from "./helpers/subjects.js";

const SAMPLE = [
  note("vet-visit", "The vet visit", "Pip saw the vet about a limp"),
  note("garden-plan", "The garden plan", "Pip digs up the Cottage garden"),
  note("roof-repair", "The roof repair", "The Cottage roof needs new tiles"),
  note("tax-note", "A tax note", "Nothing about any subject"),
];

async function world() {
  const { app, ids } = await appWith(SAMPLE);
  const w = await wire(app, ids);
  return { app, w, closed: await device(app, { allowPrivate: false }), open: await device(app, { allowPrivate: true }) };
}
const actorOf = (d) => ({ kind: "device", id: d.id });

test("a device without allow_private cannot see a private card, or a memory whose only about links are private", async () => {
  const { app, w, closed } = await world();
  const all = [w.pip, w.cottage, w.hidden, w.mixed, w.shared, w.plain];
  const hidden = await hiddenIds(app.env.DB, all, actorOf(closed));
  assert.deepEqual([...hidden].sort(), [w.pip, w.hidden].sort());
  assert.equal(await canSee(app.env.DB, w.hidden, actorOf(closed)), false);
  assert.equal(await canSee(app.env.DB, w.mixed, actorOf(closed)), true, "an about link to a shared subject keeps it visible");
  assert.deepEqual((await visibleOnly(app.env.DB, [{ id: w.plain }, { id: w.hidden }, { id: w.shared }], actorOf(closed))).map((r) => r.id), [w.plain, w.shared]);
  assert.deepEqual((await visibleOnly(app.env.DB, [{ memory: w.hidden }, { memory: w.plain }], actorOf(closed), (r) => r.memory)).map((r) => r.memory), [w.plain]);
});

test("the admin token, a browser login and a device with allow_private 1 see everything, with no query for the first two", async () => {
  const { app, w, open } = await world();
  const all = [w.pip, w.hidden, w.mixed];
  assert.equal((await hiddenIds(app.env.DB, all, actorOf(open))).size, 0);
  const real = app.env.DB;
  let queries = 0;
  const counting = { prepare: (sql) => (queries++, real.prepare(sql)) };
  for (const actor of [{ kind: "admin", id: "admin" }, { kind: "browser", id: "me@example.com" }, undefined]) assert.equal((await hiddenIds(counting, all, actor)).size, 0);
  assert.equal(queries, 0);
});

test("a call is one query however many ids it is given, and a device that cannot be found sees nothing private", async () => {
  const { app, w, closed } = await world();
  const real = app.env.DB;
  let queries = 0;
  const counting = { prepare: (sql) => (queries++, real.prepare(sql)) };
  await hiddenIds(counting, [w.pip, w.hidden, w.mixed, w.shared, w.plain, "no-such-id"], actorOf(closed));
  assert.equal(queries, 1);
  assert.deepEqual([...(await hiddenIds(real, [w.pip, w.hidden], { kind: "device", id: "gone" }))].sort(), [w.pip, w.hidden].sort());
  assert.equal((await hiddenIds(real, [], actorOf(closed))).size, 0);
});

test("a subject that is made private later hides its members, and one made shared again shows them", async () => {
  const { app, w, closed } = await world();
  const db = app.env.DB;
  await db.prepare("UPDATE subjects SET scope = 'private' WHERE id = ?").bind(w.cottage).run();
  assert.deepEqual([...(await hiddenIds(db, [w.mixed, w.shared], actorOf(closed)))].sort(), [w.mixed, w.shared].sort());
  await db.prepare("UPDATE subjects SET scope = 'shared' WHERE id = ?").bind(w.pip).run();
  assert.equal((await hiddenIds(db, [w.hidden, w.pip], actorOf(closed))).size, 0);
});
