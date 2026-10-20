import { test } from "node:test";
import assert from "node:assert/strict";
import { takeWriteSlot, WINDOW_MS, WRITE_LIMIT } from "../limits.js";
import { createApp, migratedDb } from "./helpers/app.js";

const T = 1_790_000_000_000;

test("the limit is 40 writes in 10 minutes", () => {
  assert.equal(WRITE_LIMIT, 40);
  assert.equal(WINDOW_MS, 600_000);
});

test("the 41st write in the window is refused with the seconds until the oldest write leaves", async () => {
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) assert.deepEqual(await takeWriteSlot(db, "admin", T + i * 1000), { ok: true });
  const refused = await takeWriteSlot(db, "admin", T + 40_000);
  assert.deepEqual(refused, { ok: false, retryAfter: 560 });
  assert.equal((await db.prepare("SELECT SUM(writes) AS n FROM write_counter").first()).n, 40, "the refused attempt gives its slot back");
});

test("the window rolls, one write at a time", async () => {
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) await takeWriteSlot(db, "admin", T + i * 1000);
  assert.equal((await takeWriteSlot(db, "admin", T + WINDOW_MS - 1)).ok, false, "one millisecond early");
  assert.deepEqual(await takeWriteSlot(db, "admin", T + WINDOW_MS), { ok: true }, "the first write has left the window");
  assert.equal((await takeWriteSlot(db, "admin", T + WINDOW_MS + 1)).ok, false, "but only that one");
  assert.deepEqual(await takeWriteSlot(db, "admin", T + WINDOW_MS + 1000), { ok: true });
});

test("writes in the same millisecond are all counted", async () => {
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) await takeWriteSlot(db, "admin", T);
  const refused = await takeWriteSlot(db, "admin", T);
  assert.deepEqual(refused, { ok: false, retryAfter: 600 });
  assert.equal((await db.prepare("SELECT writes FROM write_counter").first()).writes, 40);
});

test("each token has its own count, and old rows are removed", async () => {
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) await takeWriteSlot(db, "device-a", T + i);
  assert.equal((await takeWriteSlot(db, "device-a", T + 100)).ok, false);
  assert.deepEqual(await takeWriteSlot(db, "device-b", T + 100), { ok: true });
  await takeWriteSlot(db, "device-a", T + 2 * WINDOW_MS);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM write_counter WHERE token_id = 'device-a'").first()).n, 1);
});

test("retry_after is at least one second", async () => {
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) await takeWriteSlot(db, "admin", T);
  const refused = await takeWriteSlot(db, "admin", T + WINDOW_MS - 1);
  assert.deepEqual(refused, { ok: false, retryAfter: 1 });
});

test("a device token's model calls have their own count of 60, and its writes are not used up by them", async () => {
  const { takeModelSlot, MODEL_LIMIT } = await import("../limits.js");
  assert.equal(MODEL_LIMIT, 60);
  const db = await migratedDb();
  for (let i = 0; i < 40; i++) await takeWriteSlot(db, "device-a", T + i);
  for (let i = 0; i < 60; i++) assert.deepEqual(await takeModelSlot(db, "device-a", T + i), { ok: true });
  assert.equal((await takeModelSlot(db, "device-a", T + 100)).ok, false, "the 61st model call is refused");
  assert.equal((await takeWriteSlot(db, "device-a", T + 100)).ok, false, "the writes are still at their own limit");
  assert.deepEqual(await takeModelSlot(db, "device-b", T + 100), { ok: true }, "another token has its own count");
});

test("GET /recall and POST /extract are limited per device token, and the admin token is not", async () => {
  const app = await createApp();
  const { token } = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  for (let i = 0; i < 60; i++) assert.notEqual((await app.call("/recall?query=widgets", { token })).status, 429, `recall ${i}`);
  const refused = await app.call("/recall?query=widgets", { token });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, "rate_limited");
  assert.match(refused.json.error, /model calls/);
  assert.match(refused.headers.get("retry-after"), /^\d+$/);
  assert.equal((await app.call("/extract", { method: "POST", body: { transcript: "USER: hi" }, token })).status, 429, "the same count covers extract, so this is refused too");
  assert.equal((await app.call("/recall?query=widgets")).status, 200, "the admin token is not counted");
  assert.equal((await app.call("/count", { token })).status, 200, "other routes are not limited");
});
