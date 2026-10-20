import { test } from "node:test";
import assert from "node:assert/strict";
import { createCounters, dayOf, readStats } from "../counters.js";
import { migratedDb, START } from "./helpers/app.js";

const DAY = 24 * 60 * 60 * 1000;
const rows = async (db) => (await db.prepare("SELECT name, day, count FROM counters ORDER BY name, day").all()).results.map((r) => ({ ...r }));

test("bumps are collected and written in one flush, and add to what is there", async () => {
  const db = await migratedDb();
  const c = createCounters(db, () => START);
  c.bump("a");
  c.bump("a");
  c.bump("b", 3);
  assert.deepEqual(await rows(db), [], "nothing is written before the flush");
  await c.flush();
  c.bump("a");
  await c.flush();
  await c.flush();
  assert.deepEqual(await rows(db), [{ name: "a", day: dayOf(START), count: 3 }, { name: "b", day: dayOf(START), count: 3 }]);
});

test("a flush that fails does not throw", async () => {
  const db = await migratedDb();
  await db.exec("DROP TABLE counters");
  const c = createCounters(db, () => START);
  c.bump("a");
  await c.flush();
});

test("readStats shapes today and the last 7 days, the days counted in UTC", async () => {
  const db = await migratedDb();
  for (const [offset, n] of [[0, 1], [-1, 2], [-6, 4], [-7, 8]]) {
    const c = createCounters(db, () => START + offset * DAY);
    c.bump("capture.accepted", n);
    c.bump("capture.rejected.secret", n);
    c.bump("capture.rejected.duplicate");
    c.bump("extract.screened.bad_name", n);
    c.bump("conflicts.kept_both.pinned", n);
    c.bump("model.failure.kind", n);
    await c.flush();
  }
  const s = await readStats(db, START);
  assert.deepEqual(s.capture, { accepted: 1, rejected: 2, reasons: { secret: 1, duplicate: 1 }, updated: 0, model_fallback: 0, last_7_days: { accepted: 7, rejected: 10, reasons: { secret: 7, duplicate: 3 }, updated: 0, model_fallback: 0 } });
  assert.deepEqual(s.extract, { proposed: 0, screened: 1, reasons: { bad_name: 1 }, last_7_days: { proposed: 0, screened: 7, reasons: { bad_name: 7 } } });
  assert.deepEqual(s.conflicts.kept_both, { pinned: 1 });
  assert.deepEqual(s.conflicts.last_7_days.kept_both, { pinned: 7 });
  assert.deepEqual(s.model_failures, { kind: 1, last_7_days: { kind: 7 } });
  assert.equal((await readStats(db, START + 30 * DAY)).capture.last_7_days.accepted, 0);
});
