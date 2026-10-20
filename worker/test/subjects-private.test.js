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

// The routes, once as a device without allow_private and once as one with it.
const get = (app, d, path) => app.call(path, { token: d.token });

test("GET /entry: a hidden memory and a private card are a 404 that matches a missing id, the others are shown", async () => {
  const { app, w, closed, open } = await world();
  const missing = await get(app, closed, "/entry?id=no-such-id");
  assert.equal(missing.status, 404);
  for (const id of [w.hidden, w.pip]) {
    const shut = await get(app, closed, `/entry?id=${id}`);
    assert.equal(shut.status, 404, id);
    assert.deepEqual(shut.json, missing.json, "the reply does not say that the memory exists");
    assert.equal((await get(app, open, `/entry?id=${id}`)).status, 200, `open ${id}`);
    assert.equal((await app.call(`/entry?id=${id}`)).status, 200, `admin ${id}`);
  }
  for (const id of [w.mixed, w.shared, w.plain, w.cottage]) assert.equal((await get(app, closed, `/entry?id=${id}`)).status, 200, id);
  assert.equal((await get(app, closed, `/entry?id=${w.hidden}&version=1`)).status, 404, "an old version is as hidden as the memory");
  await app.call("/forget", { method: "POST", body: { id: w.hidden } });
  assert.equal((await get(app, closed, `/entry?id=${w.hidden}&deleted=1`)).status, 404, "so is the same memory in the trash");
  assert.equal((await get(app, open, `/entry?id=${w.hidden}&deleted=1`)).status, 200);
});

test("GET /list: a device without allow_private gets no hidden memory and no private card, and the others keep their order", async () => {
  const { app, w, closed, open } = await world();
  const idsOf = async (d) => (await get(app, d, "/list?n=50")).json.entries.map((e) => e.id);
  const everything = await idsOf(open);
  assert.ok(everything.includes(w.hidden) && everything.includes(w.pip));
  assert.deepEqual(await idsOf(closed), everything.filter((id) => id !== w.hidden && id !== w.pip));
  assert.ok((await idsOf(closed)).includes(w.mixed));
  const page = (await get(app, closed, "/list?n=2")).json;
  assert.ok(page.entries.length <= 2 && page.entries.every((e) => e.id !== w.hidden && e.id !== w.pip));
  assert.ok(page.next_cursor, "a short page still carries its cursor, so the client keeps paging");
});

test("GET /history: a hidden memory is a 404 for a device without allow_private", async () => {
  const { app, w, closed, open } = await world();
  for (const id of [w.hidden, w.pip]) {
    assert.equal((await get(app, closed, `/history?id=${id}`)).status, 404, id);
    assert.equal((await get(app, open, `/history?id=${id}`)).status, 200, `open ${id}`);
  }
  for (const id of [w.mixed, w.shared, w.plain]) assert.equal((await get(app, closed, `/history?id=${id}`)).status, 200, id);
});

test("GET /links: the links of a hidden memory are a 404, and a hidden memory or card is left out as the other end", async () => {
  const { app, w, closed, open } = await world();
  await app.call("/link", { method: "POST", body: { source_id: w.hidden, target_id: w.plain, type: "related" } });
  await app.call("/link", { method: "POST", body: { source_id: w.mixed, target_id: w.plain, type: "related" } });
  const others = async (d, id) => (await get(app, d, `/links?id=${id}`)).json.links.map((l) => l.other_id).sort();
  assert.equal((await get(app, closed, `/links?id=${w.hidden}`)).status, 404);
  assert.equal((await get(app, closed, `/links?id=${w.pip}`)).status, 404);
  assert.equal((await get(app, open, `/links?id=${w.hidden}`)).status, 200);
  assert.deepEqual(await others(open, w.plain), [w.hidden, w.mixed].sort());
  assert.deepEqual(await others(closed, w.plain), [w.mixed], "the link from the hidden memory is gone");
  assert.deepEqual(await others(open, w.mixed), [w.cottage, w.pip, w.plain].sort());
  assert.deepEqual(await others(closed, w.mixed), [w.cottage, w.plain].sort(), "the about link to the private card is gone, the one to the shared card stays");
  assert.deepEqual(await others(closed, w.cottage), [w.mixed, w.shared].sort(), "the cottage card lists its members, not the hidden one");
});

test("an admin token, a browser login and a device with allow_private 1 get the same reads as before", async () => {
  const { app, w, open } = await world();
  const jwt = app.browserJwt("me@example.com");
  for (const call of [(p) => app.call(p), (p) => app.call(p, { token: null, jwt }), (p) => get(app, open, p)]) {
    assert.equal((await call(`/entry?id=${w.hidden}`)).status, 200);
    assert.equal((await call(`/history?id=${w.pip}`)).status, 200);
    assert.ok((await call("/list?n=50")).json.entries.some((e) => e.id === w.hidden));
    assert.equal((await call(`/links?id=${w.mixed}`)).json.links.length, 2);
  }
});

test("each wired read costs a device one query more than the admin token and does not grow with the rows", async () => {
  const { app, w, closed } = await world();
  const real = app.env.DB;
  let queries = 0;
  app.env.DB = { prepare: (sql) => (queries++, real.prepare(sql)), batch: (s) => real.batch(s), exec: (sql) => real.exec(sql) };
  const cost = async (path, d) => {
    queries = 0;
    await app.call(path, { token: d?.token });
    return queries;
  };
  // What a device costs over the admin token on a route that does not use the rule: its token lookup.
  const overhead = (await cost("/count", closed)) - (await cost("/count"));
  const paths = [`/entry?id=${w.plain}`, `/history?id=${w.plain}`, `/links?id=${w.cottage}`, "/list?n=50"];
  for (const path of paths) assert.equal((await cost(path, closed)) - (await cost(path)), overhead + 1, path);
  for (let i = 0; i < 30; i++) await app.call("/capture", { method: "POST", body: { content: `Extra note number ${i} about nothing` } });
  for (const path of paths) assert.equal((await cost(path, closed)) - (await cost(path)), overhead + 1, `${path} with more rows`);
});

test("GET /ui/api/memory-extras: a hidden memory is a 404, and the names of hidden ends are left out of the links", async () => {
  const { app, w, closed, open } = await world();
  const extras = (d, id) => get(app, d, `/ui/api/memory-extras?id=${id}`);
  assert.equal((await extras(closed, w.hidden)).status, 404);
  assert.equal((await extras(closed, w.pip)).status, 404);
  assert.equal((await extras(open, w.pip)).json.links.length, 2, "the private card lists both of its members");
  assert.deepEqual((await extras(closed, w.cottage)).json.links.map((l) => l.id).sort(), [w.mixed, w.shared].sort());
  assert.deepEqual((await extras(closed, w.mixed)).json.links.map((l) => l.id), [w.cottage], "the link to the private card is gone");
  assert.deepEqual((await extras(open, w.mixed)).json.links.map((l) => l.id).sort(), [w.cottage, w.pip].sort());
  assert.equal((await app.call(`/ui/api/memory-extras?id=${w.hidden}`)).status, 200);
});
