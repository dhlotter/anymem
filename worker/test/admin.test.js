import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLegacy } from "../admin/legacy.js";
import { createApp } from "./helpers/app.js";
import { row } from "./helpers/maintenance.js";
import { note } from "./helpers/search.js";

const T = 1_791_000_000_000;
const legacy = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  content: note("old-memory", "An old memory", "The body."),
  tags: ["status:canonical", "kind:semantic"],
  source: "claude",
  created_at: T,
  updated_at: T + 5000,
  recall_count: 3,
  importance_score: 2,
  contradiction_wins: 1,
  contradiction_losses: 0,
  valid_from: null,
  valid_until: null,
  ...over,
});
const post = (app, body, path = "/import") => app.call(path, { method: "POST", body });
const tagsOf = async (app, id) => (await app.env.DB.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag").bind(id).all()).results.map((r) => r.tag);

test("source maps to origin", async () => {
  const cases = { "session-capture": "capture", claude: "explicit", "vault-memory-import": "import", "zcode-native-memory": "import", profile: "profile", person: "person", system: "system", "capsule-author": "explicit", "session-note": "explicit", "claude-code": "explicit", undefined: "explicit" };
  for (const [source, origin] of Object.entries(cases)) assert.equal((await mapLegacy(legacy({ source: source === "undefined" ? undefined : source }), T)).origin, origin, source);
});

test("tags map to columns, the status rule, and the plain tags are kept", async () => {
  const m = await mapLegacy(legacy({ tags: ["auto-capture", "captured-by:codex", "session:ab12cd34", "project:anymem", "kind:episodic", "status:deprecated", "Edited-Canonical:2026-10-13", "person:zuck", "two words", "#hash"] }), T);
  assert.deepEqual([m.status, m.kind, m.project, m.harness, m.session], ["deprecated", "episodic", "anymem", "codex", "ab12cd34"]);
  assert.equal((await mapLegacy(legacy({ tags: ["captured-by:claude-code"] }), T)).harness, "claude", "an alias is stored as its harness id");
  assert.equal((await mapLegacy(legacy({ tags: ["captured-by:Antigravity"] }), T)).harness, "agy");
  assert.deepEqual(m.tags.sort(), ["auto-capture", "edited-canonical:2026-10-13", "hash", "person:zuck", "two-words"]);
  assert.equal((await mapLegacy(legacy({ tags: ["status:draft"] }), T)).status, "active", "draft becomes active");
  assert.equal((await mapLegacy(legacy({ tags: [] }), T)).status, "active", "no status becomes active");
  assert.equal((await mapLegacy(legacy({ tags: ["status:canonical", "status:other"] }), T)).status, "canonical");
  assert.equal((await mapLegacy(legacy({ tags: ["kind:weird", "project:Bad Slug"] }), T)).kind, null);
  assert.equal((await mapLegacy(legacy({ tags: ["project:two", "project:three"] }), T)).project, "two");
});

test("tags may be a JSON string or a comma string", async () => {
  assert.deepEqual((await mapLegacy(legacy({ tags: JSON.stringify(["status:canonical", "alpha"]) }), T)).tags, ["alpha"]);
  assert.equal((await mapLegacy(legacy({ tags: JSON.stringify(["status:canonical"]) }), T)).status, "canonical");
  assert.deepEqual((await mapLegacy(legacy({ tags: "red,blue" }), T)).tags.sort(), ["blue", "red"]);
  assert.deepEqual((await mapLegacy(legacy({ tags: null }), T)).tags, []);
});

test("times, recall count and validity carry over", async () => {
  const m = await mapLegacy(legacy({ valid_until: T + 9000 }), T + 99);
  assert.deepEqual([m.created_at, m.updated_at, m.valid_until, m.recall_count], [T, T + 5000, T + 9000, 3]);
  const bare = await mapLegacy(legacy({ created_at: undefined, updated_at: undefined, recall_count: undefined }), T + 99);
  assert.deepEqual([bare.created_at, bare.updated_at, bare.recall_count, bare.valid_until], [T + 99, T + 99, 0, null]);
});

test("synthesized and rolled-up entries go to the trash with the import time", async () => {
  assert.equal((await mapLegacy(legacy({ tags: ["synthesized"] }), T + 7)).deleted_at, T + 7);
  assert.equal((await mapLegacy(legacy({ tags: ["auto-capture", "rolled-up"] }), T + 7)).deleted_at, T + 7);
  assert.equal((await mapLegacy(legacy(), T + 7)).deleted_at, null);
});

test("bad entries are refused", async () => {
  for (const bad of [null, "x", {}, legacy({ id: "" }), legacy({ id: "x".repeat(65) }), legacy({ id: "x".repeat(51) }), legacy({ id: "é".repeat(26) }), legacy({ content: "" }), legacy({ content: 5 })]) await assert.rejects(mapLegacy(bad, T), /./);
  assert.equal((await mapLegacy(legacy({ id: "x".repeat(50) }), T)).id, "x".repeat(50), "50 bytes is the most an id can be");
});

test("an id over 50 bytes is refused with the reason in the import reply, and the good ones go in", async () => {
  const app = await createApp();
  const fits = "a".repeat(50);
  const res = await post(app, { entries: [legacy({ id: fits }), legacy({ id: "b".repeat(51) }), legacy({ id: "é".repeat(26), content: "second text" })] });
  assert.deepEqual([res.json.imported, res.json.skipped], [1, 2]);
  assert.equal(res.json.errors.length, 2);
  assert.match(res.json.errors[0].error, /50 bytes/);
  assert.ok(await row(app, fits));
  assert.equal(await row(app, "b".repeat(51)), null);
});

test("POST /import stores entries through the store, with ids, times and provenance kept", async () => {
  const app = await createApp();
  const res = await post(app, { entries: [legacy(), legacy({ id: "22222222-2222-4222-8222-222222222222", source: "session-capture", tags: ["auto-capture", "captured-by:claude", "session:abc", "project:anymem"], content: "plain capture text" })] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, imported: 2, skipped: 0, next_offset: 2, remaining: 0 });
  const a = await row(app, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual([a.created_at, a.updated_at, a.valid_from, a.origin, a.status, a.kind, a.name, a.recall_count], [T, T + 5000, T, "explicit", "canonical", "semantic", "old-memory", 3]);
  const b = await row(app, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual([b.origin, b.harness, b.session, b.project, b.status, b.pinned, b.body], ["capture", "claude", "abc", "anymem", "active", 0, "plain capture text"]);
  assert.deepEqual(await tagsOf(app, b.id), ["auto-capture"]);
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fts").first()).n, 2, "the keyword index is filled");
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_versions").first()).n, 0);
  assert.equal((await app.call("/entry?id=11111111-1111-4111-8111-111111111111")).json.entry.updated_at, T + 5000);
});

test("capsule tags and the profile and person origins make a memory pinned", async () => {
  const app = await createApp();
  await post(app, { entries: [
    legacy({ id: "c1", tags: ["capsule:core", "capsule-slot:identity", "status:canonical"], source: "capsule-author" }),
    legacy({ id: "p1", source: "profile", tags: ["profile", "name"] }),
    legacy({ id: "p2", source: "person", tags: ["person", "person:zuck"] }),
    legacy({ id: "n1" }),
  ] });
  assert.deepEqual((await Promise.all(["c1", "p1", "p2", "n1"].map((id) => row(app, id)))).map((r) => r.pinned), [1, 1, 1, 0]);
});

test("rolled-up entries are imported into the trash and are not live", async () => {
  const app = await createApp();
  await post(app, { entries: [legacy({ id: "r1", tags: ["auto-capture", "rolled-up"] }), legacy({ id: "r2", tags: ["synthesized"], source: "system" }), legacy({ id: "ok" })] });
  const r1 = await row(app, "r1");
  assert.equal(r1.deleted_at, app.clock.t);
  assert.equal((await app.call("/count")).json.count, 1);
  assert.equal((await app.call("/entry?id=r1")).status, 404);
  assert.equal((await app.call("/entry?id=r1&deleted=1")).status, 200);
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_fts").first()).n, 1, "a trashed memory is not in the keyword index");
});

test("an entry with validity closed is imported but not live", async () => {
  const app = await createApp();
  await post(app, { entries: [legacy({ id: "closed", valid_until: T + 1 })] });
  assert.equal((await app.call("/count")).json.count, 0);
  assert.equal((await app.call("/entry?id=closed")).status, 200);
});

test("importing the same ids again changes nothing", async () => {
  const app = await createApp();
  const entries = [legacy(), legacy({ id: "22222222-2222-4222-8222-222222222222", content: "second" })];
  await post(app, { entries });
  const before = JSON.stringify((await app.env.DB.prepare("SELECT * FROM memories ORDER BY id").all()).results);
  const again = await post(app, { entries: entries.map((e) => ({ ...e, content: `${e.content} changed`, updated_at: T + 99999 })) });
  assert.deepEqual(again.json, { ok: true, imported: 0, skipped: 2, next_offset: 2, remaining: 0 });
  assert.equal(JSON.stringify((await app.env.DB.prepare("SELECT * FROM memories ORDER BY id").all()).results), before);
  const twice = await post(app, { entries: [legacy({ id: "same" }), legacy({ id: "same" })] });
  assert.deepEqual([twice.json.imported, twice.json.skipped], [1, 1], "the same id twice in one page is one memory");
});

test("pages: offset and limit, next_offset and remaining", async () => {
  const app = await createApp();
  const entries = Array.from({ length: 25 }, (_, i) => legacy({ id: `id-${String(i).padStart(2, "0")}`, content: `memory ${i}` }));
  const first = await post(app, { entries, offset: 0, limit: 10 });
  assert.deepEqual(first.json, { ok: true, imported: 10, skipped: 0, next_offset: 10, remaining: 15 });
  const second = await post(app, { entries, offset: 10, limit: 10 });
  assert.deepEqual([second.json.imported, second.json.next_offset, second.json.remaining], [10, 20, 5]);
  const last = await post(app, { entries, offset: 20, limit: 10 });
  assert.deepEqual([last.json.imported, last.json.next_offset, last.json.remaining], [5, 25, 0]);
  assert.equal((await app.call("/count")).json.count, 25);
  const past = await post(app, { entries, offset: 30 });
  assert.deepEqual([past.json.imported, past.json.next_offset, past.json.remaining], [0, 30, 0]);
});

test("a bad entry is skipped and reported, the others still import", async () => {
  const app = await createApp();
  const res = await post(app, { entries: [legacy({ id: "good" }), { id: "bad", content: "" }, legacy({ id: "good2" })] });
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.imported, res.json.skipped], [2, 1]);
  assert.deepEqual(res.json.errors, [{ id: "bad", error: "content is empty." }]);
});

test("import input checks", async () => {
  const app = await createApp();
  assert.equal((await post(app, {})).status, 400);
  assert.equal((await post(app, { entries: "x" })).status, 400);
  assert.equal((await post(app, { entries: [], offset: -1 })).status, 400);
  assert.equal((await post(app, { entries: [], limit: 0 })).status, 400);
  assert.equal((await post(app, { entries: [], limit: 201 })).status, 400);
  assert.equal((await app.call("/import", { method: "POST", rawBody: "{nope" })).status, 400);
  assert.deepEqual((await post(app, { entries: [] })).json, { ok: true, imported: 0, skipped: 0, next_offset: 0, remaining: 0 });
});

test("import, then reindex until nothing remains, then recall finds the data", async () => {
  const app = await createApp();
  await post(app, { entries: Array.from({ length: 9 }, (_, i) => legacy({ id: `m-${i}`, content: note(`mem-${i}`, `About topic ${i}`, `unique body ${i} about pelicans${i}`) })) });
  assert.equal((await app.call("/stats")).json.unvectorized, 9);
  let remaining = 9;
  let calls = 0;
  while (remaining > 0 && calls++ < 10) remaining = (await post(app, { limit: 4 }, "/admin/reindex")).json.remaining;
  assert.equal(remaining, 0);
  assert.equal(calls, 3);
  assert.equal(app.env.VECTORIZE.vectors.size, 18, "a chunk and a description for each of 9");
  assert.equal((await app.call("/count")).json.count, 9);
  const res = await app.call(`/recall?query=${encodeURIComponent("what is unique body 4 about pelicans4")}`);
  assert.equal(res.json.results[0].id, "m-4");
});

test("both routes are admin only: no token, a bad token, a device token and a browser login are refused", async () => {
  const app = await createApp();
  const device = (await post(app, { label: "laptop" }, "/devices")).json.token;
  const jwt = app.browserJwt("me@example.com");
  for (const path of ["/import", "/admin/reindex"]) {
    const body = path === "/import" ? { entries: [] } : {};
    assert.equal((await post(app, body, path)).status, 200, path);
    assert.equal((await app.call(path, { method: "POST", body, token: null })).status, 401, `${path} no token`);
    assert.equal((await app.call(path, { method: "POST", body, token: "wrong" })).status, 401, `${path} bad token`);
    assert.equal((await app.call(path, { method: "POST", body, token: device })).status, 403, `${path} device`);
    assert.equal((await app.call(path, { method: "POST", body, token: null, jwt })).status, 403, `${path} browser`);
    assert.equal((await app.call(path)).status, 405, `${path} GET`);
  }
});
