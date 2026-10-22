// GET /admin/subjects/assign-preview: what assignment would do to recent memories, with nothing written. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { addSubject, about, device } from "./helpers/subjects.js";
import { QUIET, THIRTY_WORDS, distinct, scriptModel } from "./helpers/write.js";
import { parseMemory } from "../memory/parse.js";
import { createStore } from "../memory/store.js";
import { indexMemories } from "../search/indexer.js";

const DAY = 24 * 60 * 60 * 1000;
const PATH = "/admin/subjects/assign-preview";

async function world(env = {}) {
  const app = await createApp({ env });
  scriptModel(app.env.AI, { ...QUIET, "contradiction-detect": { match: 0 } });
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip" });
  return { app, pip };
}

/** A memory in the store with its own created_at, so a test can age it. */
async function mem(app, text, { origin = "capture", ageDays = 0 } = {}) {
  const parsed = await parseMemory(text);
  const at = app.clock.t - ageDays * DAY;
  return (await createStore(app.env.DB, () => at).create({ ...parsed, origin })).id;
}

const table = (app, name) => app.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first().then((r) => r.n);

test("a device token is refused and an anonymous call is too", async () => {
  const { app } = await world();
  const d = await device(app, { allowPrivate: true });
  assert.equal((await app.call(PATH, { token: d.token })).status, 403);
  assert.equal((await app.call(PATH, { token: null })).status, 401);
  assert.equal((await app.call(PATH)).status, 200);
});

test("it works with both flags off, shows the links it would make, and writes nothing", async () => {
  const { app, pip } = await world();
  const id = await mem(app, "Pip chewed the sofa while we were out");
  const quiet = await mem(app, distinct(1));
  const before = [await table(app, "links"), await table(app, "memories"), await table(app, "link_rejections"), await table(app, "counters"), await table(app, "memory_keys")];
  const res = await app.call(PATH);
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.memories.map((m) => [m.id, m]));
  assert.deepEqual(byId[id].links, [{ slug: "pip", confidence: 1, how: "alias" }]);
  assert.deepEqual(byId[quiet].links, []);
  assert.equal(byId[id].snippet, "Pip chewed the sofa while we were out");
  assert.equal(res.json.next_cursor, null);
  assert.deepEqual([await table(app, "links"), await table(app, "memories"), await table(app, "link_rejections"), await table(app, "counters"), await table(app, "memory_keys")], before);
  assert.deepEqual((await app.env.DB.prepare("SELECT route FROM audit WHERE actor_kind = 'system'").all()).results, []);
  assert.equal((await app.env.DB.prepare("SELECT target_id FROM links WHERE source_id = ?").bind(id).all()).results.length, 0);
  assert.ok(pip);
});

test("it shows the same on a Worker with both flags on", async () => {
  const { app } = await world({ SUBJECTS: "on", SUBJECTS_AUTO: "on" });
  await mem(app, "Pip chewed the sofa while we were out");
  assert.equal((await app.call(PATH)).json.memories[0].links[0].slug, "pip");
});

test("only live captured and explicit memories of the last days are shown, newest first", async () => {
  const { app } = await world();
  const fresh = await mem(app, "Fresh capture about Pip");
  app.clock.t += 10;
  const explicit = await mem(app, "Explicit note about Pip", { origin: "explicit" });
  await mem(app, "Imported note about Pip", { origin: "import" });
  await mem(app, "System note about Pip", { origin: "system" });
  await mem(app, "Profile note about Pip", { origin: "profile" });
  await mem(app, "Old capture about Pip", { ageDays: 9 });
  const gone = await mem(app, "Trashed capture about Pip");
  await createStore(app.env.DB, () => app.clock.t).softDelete(gone);
  const res = await app.call(`${PATH}?days=7`);
  assert.deepEqual(res.json.memories.map((m) => m.id), [explicit, fresh]);
  assert.equal(res.json.days, 7);
  assert.equal((await app.call(`${PATH}?days=30`)).json.memories.length, 3, "the old one is inside 30 days");
});

test("pages end with a cursor, a larger limit is cut to a page the request can afford, and every memory comes once", async () => {
  const { app } = await world();
  const made = [];
  for (let i = 0; i < 9; i++) {
    made.push(await mem(app, `${distinct(i)} and Pip`));
    app.clock.t += 7;
  }
  const seen = [];
  let cursor = "";
  let pages = 0;
  do {
    const res = await app.call(`${PATH}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.limit, 4);
    assert.ok(res.json.memories.length <= 4);
    seen.push(...res.json.memories.map((m) => m.id));
    cursor = res.json.next_cursor ?? "";
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, [...made].reverse());
  assert.equal((await app.call(PATH)).json.memories.length, 3, "the default page is 3");
  assert.equal((await app.call(`${PATH}?limit=2`)).json.memories.length, 2);
});

test("memories saved in the same millisecond page without a gap or a repeat", async () => {
  const { app } = await world();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await mem(app, `${distinct(i)} and Pip`));
  const seen = [];
  let cursor = "";
  do {
    const res = await app.call(`${PATH}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    seen.push(...res.json.memories.map((m) => m.id));
    cursor = res.json.next_cursor ?? "";
  } while (cursor);
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("a page of the most memories stays under 40 subrequests", async () => {
  const { app } = await world();
  for (let i = 0; i < 5; i++) await mem(app, `${THIRTY_WORDS.slice(i).join(" ")} Pip`);
  const real = { DB: app.env.DB, AI: app.env.AI, VECTORIZE: app.env.VECTORIZE };
  let calls = 0;
  const count = (fn) => (...a) => (calls++, fn(...a));
  const wrap = (st) => ({ inner: st, bind: (...a) => wrap(st.bind(...a)), first: count((c) => st.first(c)), all: count(() => st.all()), run: count(() => st.run()), raw: count(() => st.raw()) });
  app.env.DB = { prepare: (sql) => wrap(real.DB.prepare(sql)), batch: count((list) => real.DB.batch(list.map((s) => s.inner ?? s))), exec: (sql) => real.DB.exec(sql) };
  app.env.AI = { run: count((...a) => real.AI.run(...a)) };
  app.env.VECTORIZE = { query: count((...a) => real.VECTORIZE.query(...a)), upsert: count((...a) => real.VECTORIZE.upsert(...a)), getByIds: count((...a) => real.VECTORIZE.getByIds(...a)) };
  const res = await app.call(`${PATH}?limit=50`);
  assert.equal(res.json.memories.length, 4);
  assert.ok(calls < 40, `subrequests ${calls}`);
});

test("a vote shows in the preview, found through the same neighbour search the write uses", async () => {
  const { app } = await world();
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "the Cottage" });
  const swap = (n, tag) => THIRTY_WORDS.map((w, i) => (i < n ? `${tag}${i}x` : w)).join(" ");
  for (let i = 0; i < 3; i++) {
    const member = await mem(app, swap(3, `m${i}`), { ageDays: 20 });
    await about(app, member, cottage);
    await indexMemories(app.env, [member], () => app.clock.t - 3 * DAY); // old enough to be searchable
  }
  const fresh = await mem(app, THIRTY_WORDS.join(" "));
  const res = await app.call(`${PATH}?days=1`);
  assert.deepEqual(res.json.memories.map((m) => m.id), [fresh]);
  assert.deepEqual(res.json.memories[0].links.map((l) => [l.slug, l.how]), [["cottage", "vote"]]);
  assert.ok(res.json.memories[0].links[0].confidence >= 0.5);
});

test("a link already made is not shown again, an ambiguous name is named, and a card is never a neighbour", async () => {
  const { app, pip } = await world();
  await addSubject(app, { slug: "rowan-dog", kind: "pet", name: "Rowan the dog" });
  await addSubject(app, { slug: "rowan-lee", kind: "person", name: "Rowan Lee" });
  await app.env.DB.prepare("UPDATE subjects SET aliases = ? WHERE slug LIKE 'rowan-%'").bind(JSON.stringify(["rowan"])).run();
  const linked = await mem(app, "Pip is a good dog");
  await about(app, linked, pip);
  const tie = await mem(app, "Rowan said hello");
  app.clock.t += 1;
  const res = await app.call(PATH);
  const byId = Object.fromEntries(res.json.memories.map((m) => [m.id, m]));
  assert.deepEqual(byId[linked].links, []);
  assert.deepEqual(byId[tie].ambiguous, ["rowan-dog", "rowan-lee"]);
  assert.deepEqual(byId[tie].links, []);
});

test("the snippet is cut to 160 characters on one line", async () => {
  const { app } = await world();
  await mem(app, `Pip is a dog.\n\n${"word ".repeat(120)}`);
  const [m] = (await app.call(PATH)).json.memories;
  assert.equal(m.snippet.length, 160);
  assert.ok(!/\s{2}|\n/.test(m.snippet));
  assert.ok(m.snippet.startsWith("Pip is a dog. word word"));
});

test("a bad cursor, days or limit is a 400", async () => {
  const { app } = await world();
  for (const q of ["cursor=nonsense", "cursor=1;DROP", "days=0", "days=400", "days=x", "limit=0", "limit=-1"]) {
    assert.equal((await app.call(`${PATH}?${q}`)).status, 400, q);
  }
});

test("the request is audited like any other admin call, and no system row comes from it", async () => {
  const { app } = await world();
  await mem(app, "Pip is a dog");
  await app.call(PATH);
  const rows = (await app.call(`/audit?route=${encodeURIComponent(PATH)}`)).json.entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_kind, "admin");
});
