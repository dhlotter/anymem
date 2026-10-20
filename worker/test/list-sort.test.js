import { test } from "node:test";
import assert from "node:assert/strict";
import { newStore } from "./helpers/memories.js";
import { SORTS } from "../memory/store.js";
import { appWith } from "./helpers/search.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";

test("the list sorts by saved, changed or recall count, and pages through every order without gaps", async () => {
  const { store, add, clock, db } = await newStore();
  const ids = [];
  for (let i = 0; i < 12; i++) {
    clock.t += 1000;
    ids.push((await add(`memory number ${i}`)).id);
  }
  // recall counts with many ties, and a change to an early memory
  for (const [i, n] of [[0, 5], [1, 5], [2, 5], [3, 1], [4, 1], [5, 9]]) await db.prepare("UPDATE memories SET recall_count = ? WHERE id = ?").bind(n, ids[i]).run();
  clock.t += 1000;
  await store.update({ id: ids[2], content: "memory number 2 changed" });

  const page = async (sort, n = 5) => {
    const out = [];
    let cursor;
    do {
      const res = await store.list({ sort, n, cursor });
      out.push(...res.entries);
      cursor = res.next_cursor ?? undefined;
    } while (cursor);
    return out;
  };
  const created = await page("created");
  assert.deepEqual(created.map((e) => e.id), [...ids].reverse());
  const updated = await page("updated");
  assert.equal(updated[0].id, ids[2], "the memory changed last comes first");
  assert.equal(new Set(updated.map((e) => e.id)).size, 12);
  const recalls = await page("recalls");
  assert.equal(new Set(recalls.map((e) => e.id)).size, 12, "ties on the recall count do not repeat or skip a row");
  assert.deepEqual(recalls.map((e) => e.recall_count), [...recalls.map((e) => e.recall_count)].sort((a, b) => b - a));
  assert.equal(recalls[0].id, ids[5]);
  assert.deepEqual(Object.keys(SORTS), ["created", "updated", "recalls"]);
});

test("a cursor from one order is refused in another, and an unknown order is refused", async () => {
  const { store, add } = await newStore();
  for (let i = 0; i < 4; i++) await add(`memory ${i}`);
  const first = await store.list({ sort: "recalls", n: 2 });
  await assert.rejects(store.list({ sort: "created", n: 2, cursor: first.next_cursor }), { status: 400, code: "bad_cursor" });
  const created = await store.list({ n: 2 });
  await assert.rejects(store.list({ sort: "updated", n: 2, cursor: created.next_cursor }), { status: 400, code: "bad_cursor" });
  await assert.rejects(store.list({ sort: "name" }), { status: 400 });
  await assert.rejects(store.list({ sort: "constructor" }), { status: 400 });
});

test("GET /list takes sort, and a bad sort or a mismatched cursor is a 400", async () => {
  const { app } = await appWith(["one", "two", "three"]);
  const jwt = app.browserJwt("me@example.com");
  const get = async (q) => {
    const res = await raw(app, `/list?${q}`, { jwt, headers: UI_HEADERS });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await get("sort=recalls&n=2")).status, 200);
  assert.equal((await get("sort=updated")).json.entries.length, 3);
  assert.equal((await get("sort=bogus")).status, 400);
  const page = await get("sort=recalls&n=1");
  assert.equal((await get(`sort=updated&n=1&cursor=${page.json.next_cursor}`)).status, 400);
  assert.equal((await raw(app, "/list?sort=recalls", {})).status, 401);
});
