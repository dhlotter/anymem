// The two things the brief step needs from the memory store and the audit module: an update that carries its own statements in the
// same batch, and an audit row that can be saved in a batch. All sample text is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditStatement, recordAudit } from "../audit.js";
import { createApp } from "./helpers/app.js";
import { rows, seed, storeOf } from "./helpers/maintenance.js";
import { note } from "./helpers/search.js";

const audit = (n = 1) => ({ ts: n, actor: { kind: "system", id: "brief" }, harness: "", script: "how:model.lines:2", method: "SYSTEM", route: "brief.build", status: 200, durationMs: 3, memoryIds: ["a"] });

test("update takes a reason for the version row, and keeps update as the default", async () => {
  const app = await createApp();
  const id = await seed(app, { name: "pip-note", text: "Pip is a beagle." });
  const store = storeOf(app);
  app.clock.t += 10;
  await store.update({ id, content: note("pip-note", "A sample.", "Pip is a dog.") });
  app.clock.t += 10;
  await store.update({ id, content: note("pip-note", "A sample.", "Pip is a good dog."), reason: "brief" });
  assert.deepEqual((await rows(app, "SELECT reason FROM memory_versions WHERE memory_id = ? ORDER BY seq", id)).map((r) => r.reason), ["update", "brief"]);
});

test("extra statements are saved with the change, and quiet returns nothing", async () => {
  const app = await createApp();
  const id = await seed(app, { name: "pip-note", text: "Pip is a beagle." });
  app.clock.t += 10;
  const db = app.env.DB;
  const got = await storeOf(app).update({ id, content: note("pip-note", "A sample.", "Pip is a dog."), quiet: true, extra: [db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'yes')")] });
  assert.equal(got, null);
  assert.equal((await db.prepare("SELECT value FROM meta WHERE key = 'probe'").first()).value, "yes");
  assert.equal((await rows(app, "SELECT body FROM memories WHERE id = ?", id))[0].body, "Pip is a dog.");
});

test("extra statements and the change are saved together or not at all", async () => {
  const app = await createApp();
  const id = await seed(app, { name: "pip-note", text: "Pip is a beagle." });
  const db = app.env.DB;
  await db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'first')").run();
  app.clock.t += 10;
  await assert.rejects(storeOf(app).update({ id, content: note("pip-note", "A sample.", "Pip is a dog."), extra: [db.prepare("INSERT INTO meta (key, value) VALUES ('later', 'x')"), db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'second')")] }), /UNIQUE/);
  assert.equal((await rows(app, "SELECT body FROM memories WHERE id = ?", id))[0].body, "Pip is a beagle.", "the memory change was rolled back");
  assert.equal((await rows(app, "SELECT * FROM memory_versions WHERE memory_id = ?", id)).length, 0);
  assert.equal((await rows(app, "SELECT * FROM meta WHERE key = 'later'")).length, 0, "and so was the statement before the failing one");
});

test("extra statements still run when the update changes nothing", async () => {
  const app = await createApp();
  const id = await seed(app, { name: "pip-note", text: "Pip is a beagle." });
  const db = app.env.DB;
  const same = (await rows(app, "SELECT content FROM memories WHERE id = ?", id))[0].content;
  await storeOf(app).update({ id, content: same, extra: [db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'ran')")] });
  assert.equal((await db.prepare("SELECT value FROM meta WHERE key = 'probe'").first()).value, "ran");
  assert.equal((await rows(app, "SELECT * FROM memory_versions WHERE memory_id = ?", id)).length, 0, "no version for no change");
});

test("auditStatement builds the row recordAudit writes, for a batch", async () => {
  const app = await createApp();
  const db = app.env.DB;
  await db.batch([auditStatement(db, audit(1)), auditStatement(db, audit(2))]);
  await recordAudit(db, audit(3));
  const got = await rows(app, "SELECT ts, actor_kind, actor_id, script, method, route, status, memory_ids FROM audit ORDER BY ts");
  assert.deepEqual(got.map((r) => ({ ...r })), [1, 2, 3].map((ts) => ({ ts, actor_kind: "system", actor_id: "brief", script: "how:model.lines:2", method: "SYSTEM", route: "brief.build", status: 200, memory_ids: '["a"]' })));
});
