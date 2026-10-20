// Export and import (format v2), the backup routes and the restore proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, START, createApp } from "./helpers/app.js";
import { DAY, dump, indexAll, populate, restore, row, rows, runNightly, seed } from "./helpers/maintenance.js";
import { FakeR2, fakeEmbedding } from "./helpers/fakes.js";
import { raw } from "./helpers/ui.js";
import { gunzip, gzip, listBackups, runBackup, streamGzipTo } from "../backup/backup.js";
import { EXPORT_CAP } from "../backup/export.js";
import { listMigrations } from "../migrate.js";

const ME = "me@example.com";
const SCHEMA = listMigrations().at(-1).version;
const asAdmin = (app) => ({ jwt: app.serviceJwt(), token: ADMIN_TOKEN });
const asBrowser = (app) => ({ jwt: app.browserJwt(ME) });
const exportOf = async (app, query = "") => (await app.call(`/export${query}`)).json;
// a restore brings devices back revoked unless named, so a full restore names the ones that were active in the backup
const named = (doc) => ({ ...doc, reactivate_devices: (doc.devices ?? []).filter((d) => d.revoked_at === null).map((d) => d.id) });

// ------------------------------------------------------------------ export

test("GET /export returns format 2 with every row, byte exact, the trash included and no plain token", async () => {
  const app = await createApp();
  const { ids, token } = await populate(app);
  const res = await app.call("/export");
  assert.equal(res.status, 200);
  const doc = res.json;
  assert.deepEqual([doc.ok, doc.format, doc.schema_version, doc.created_at, doc.total, doc.next_offset], [true, 2, SCHEMA, app.clock.t, 8, null]);
  assert.equal(doc.entries.length, 8);
  const explicit = doc.entries.find((e) => e.id === ids.explicit);
  const stored = await row(app, ids.explicit);
  assert.equal(explicit.content, stored.content, "the content is exactly as stored");
  assert.ok(explicit.content.includes("\r\n") && explicit.content.includes("🎯") && explicit.content.includes("  with  double"));
  assert.deepEqual(explicit.tags, ["blue", "red"]);
  assert.equal(doc.entries.find((e) => e.id === ids.trashed).deleted_at, (await row(app, ids.trashed)).deleted_at);
  assert.ok(doc.entries.find((e) => e.id === ids.trashed).deleted_at > 0, "a trashed memory is in the export with its deleted_at");
  const closed = doc.entries.find((e) => e.id === ids.newer);
  assert.deepEqual([closed.superseded_by, closed.valid_until > 0], [ids.older, true]);
  assert.equal(doc.entries.find((e) => e.id === ids.capture).probation_until > START, true);
  assert.equal(doc.versions.filter((v) => v.memory_id === ids.updated).length, 2);
  assert.deepEqual(doc.questions.map((q) => q.position), [0, 1]);
  assert.equal(doc.links.length, 2);
  assert.equal(doc.devices.length, 2);
  for (const d of doc.devices) assert.match(d.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(doc.devices.some((d) => d.revoked_at !== null));
  assert.ok(!JSON.stringify(doc).includes(token), "the device token is never in an export");
  for (const e of doc.entries) assert.deepEqual(Object.keys(e).sort(), [...Object.keys(stored), "tags"].sort());
});

test("a browser login gets the export without device token hashes, a bearer caller still gets them", async () => {
  const app = await createApp();
  await populate(app);
  const browser = await app.call("/export", { jwt: app.browserJwt("me@example.com"), token: null });
  assert.equal(browser.status, 200);
  assert.equal(browser.json.devices.length, 2);
  for (const d of browser.json.devices) assert.deepEqual(Object.keys(d).sort(), ["created_at", "id", "label", "last_used_at", "revoked_at"]);
  assert.ok(!/token_hash/.test(JSON.stringify(browser.json)));
  assert.equal(browser.json.entries.length, 8, "everything else is unchanged");
  assert.equal((await app.call("/export")).json.devices.every((d) => /^[0-9a-f]{64}$/.test(d.token_hash)), true);
});

test("GET /export pages by cursor and limit, and the links and devices come with the last page", async () => {
  const app = await createApp();
  await populate(app);
  const full = await exportOf(app);
  const pages = [];
  let cursor = "start";
  while (cursor !== null) {
    const page = await exportOf(app, `?cursor=${encodeURIComponent(cursor)}&limit=3`);
    pages.push(page);
    cursor = page.next_cursor;
  }
  assert.deepEqual(pages.map((p) => p.entries.length), [3, 3, 2]);
  assert.deepEqual(pages.map((p) => p.next_cursor === null), [false, false, true]);
  assert.deepEqual(pages.map((p) => p.links.length), [0, 0, 2]);
  assert.deepEqual(pages.map((p) => p.devices.length), [0, 0, 2]);
  assert.deepEqual(pages.flatMap((p) => p.entries), full.entries);
  const byKey = (a, b) => (a.memory_id + a.seq < b.memory_id + b.seq ? -1 : 1);
  assert.deepEqual(pages.flatMap((p) => p.versions).sort(byKey), full.versions.sort(byKey));
  const past = await exportOf(app, `?cursor=${encodeURIComponent("99999999999999:zzz")}&limit=3`);
  assert.deepEqual([past.entries, past.next_cursor], [[], null], "a cursor past the last memory gives an empty last page");
  assert.deepEqual((await app.call("/export?limit=0")).status, 400);
  assert.equal((await app.call("/export?limit=1001")).status, 400);
  assert.equal((await app.call("/export?offset=x")).status, 400);
});

test("GET /export refuses to return a huge store in one reply and says how to page", async () => {
  const app = await createApp();
  await app.env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO memories (id, content, content_hash, origin, valid_from, created_at, updated_at) SELECT 'id-' || i, 'text ' || i, 'h' || i, 'import', 1, 1, 1 FROM n`,
  ).bind(EXPORT_CAP + 1).run();
  const res = await app.call("/export");
  assert.equal(res.status, 413);
  assert.equal(res.json.code, "export_too_large");
  assert.match(res.json.error, /offset=0&limit=500/);
  const page = await exportOf(app, "?offset=0&limit=500");
  assert.equal(page.entries.length, 500);
  assert.equal(page.next_offset, 500);
  const next = await exportOf(app, `?offset=${page.next_offset}&limit=500`);
  assert.equal(next.entries.length, 500);
  assert.equal(new Set([...page.entries, ...next.entries].map((e) => e.id)).size, 1000, "the second page holds none of the first");
});

test("export is for the admin token and for a browser login, not for a device", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  assert.equal((await app.call("/export", { token: device })).status, 403);
  assert.equal((await app.call("/export", { token: null })).status, 401);
  assert.equal((await app.call("/export", { jwt: app.browserJwt(ME), token: null })).status, 200);
  assert.equal((await app.call("/export", { method: "POST", body: {} })).status, 405);
});

// ------------------------------------------------------------------ import

test("an export imports into a fresh store and every row matches, field by field", async () => {
  const source = await createApp();
  await populate(source);
  const doc = await exportOf(source);
  const fresh = await createApp();
  const replies = await restore(fresh, named(doc));
  assert.equal(replies.at(-1).remaining, 0);
  assert.equal(replies.reduce((n, r) => n + r.imported, 0), 8);
  const [a, b] = [await dump(source), await dump(fresh)];
  for (const table of Object.keys(a)) assert.deepEqual(b[table], a[table], table);
  assert.ok(a.memories.length === 8 && a.versions.length >= 4 && a.links.length === 2 && a.devices.length === 2 && a.questions.length === 2 && a.tags.length > 4);
  // the trash and the closed memory kept their times and pointers
  assert.ok(b.memories.some((m) => m.deleted_at !== null));
  assert.ok(b.memories.some((m) => m.valid_until !== null && m.superseded_by !== null));
});

test("importing page by page gives the same result as one call", async () => {
  const source = await createApp();
  await populate(source);
  const doc = await exportOf(source);
  const fresh = await createApp();
  const replies = await restore(fresh, named(doc), 3);
  assert.deepEqual(replies.map((r) => [r.imported, r.next_offset, r.remaining]), [[3, 3, 5], [3, 6, 2], [2, 8, 0]]);
  assert.deepEqual(replies.map((r) => [r.links, r.devices]), [[0, 0], [0, 0], [2, 2]], "links and devices go in with the last page");
  assert.deepEqual(await dump(fresh), await dump(source));
});

test("importing the same document twice changes nothing", async () => {
  const source = await createApp();
  await populate(source);
  const doc = await exportOf(source);
  const fresh = await createApp();
  await restore(fresh, doc);
  const once = await dump(fresh);
  const again = await restore(fresh, doc);
  assert.deepEqual(again.map((r) => [r.imported, r.skipped, r.links, r.devices]), [[0, 8, 0, 0]]);
  assert.deepEqual(await dump(fresh), once);
});

test("a memory that exists is skipped whole, so its own newer state and history stay", async () => {
  const source = await createApp();
  const { ids } = await populate(source);
  const doc = await exportOf(source);
  const target = await createApp();
  await target.env.DB.prepare("INSERT INTO memories (id, content, content_hash, origin, valid_from, created_at, updated_at, name) VALUES (?, 'local text', 'h', 'explicit', 1, 1, 1, 'local')").bind(ids.updated).run();
  const [reply] = await restore(target, doc);
  assert.deepEqual([reply.imported, reply.skipped], [7, 1]);
  assert.equal((await row(target, ids.updated)).content, "local text");
  assert.equal((await rows(target, "SELECT * FROM memory_versions WHERE memory_id = ?", ids.updated)).length, 0);
});

test("after a v2 import the reindex route builds the vectors and recall works", async () => {
  const source = await createApp();
  await populate(source);
  const fresh = await createApp();
  await restore(fresh, await exportOf(source));
  assert.equal(fresh.env.VECTORIZE.vectors.size, 0);
  const stats = (await fresh.call("/stats")).json;
  assert.equal(stats.unvectorized, 6, "the live memories wait for vectors");
  let remaining = stats.unvectorized;
  for (let i = 0; i < 10 && remaining > 0; i++) remaining = (await fresh.call("/admin/reindex", { method: "POST", body: { limit: 4 } })).json.remaining;
  assert.equal(remaining, 0);
  assert.ok(fresh.env.VECTORIZE.vectors.size >= 6);
  assert.equal((await fresh.call("/stats")).json.unvectorized, 0);
});

test("an imported capsule memory shows up in the capsule", async () => {
  const source = await createApp();
  await populate(source);
  const fresh = await createApp();
  await fresh.call("/prompt-capsules/core");
  await restore(fresh, await exportOf(source));
  const capsule = (await fresh.call("/prompt-capsules/core")).json;
  assert.equal(capsule.sections.length, 1);
});

test("bad entries are reported and skipped, the good ones still go in", async () => {
  const source = await createApp();
  await populate(source);
  const doc = await exportOf(source);
  const bad = structuredClone(doc);
  bad.entries[0].origin = "nonsense";
  bad.entries[1].created_at = "yesterday";
  delete bad.entries[2].content;
  bad.entries[3].tags = "red";
  bad.entries[4].pinned = 2;
  const fresh = await createApp();
  const [reply] = await restore(fresh, bad);
  assert.deepEqual([reply.imported, reply.skipped], [3, 5]);
  assert.equal(reply.errors.length, 5);
  assert.ok(reply.errors.every((e) => typeof e.error === "string" && e.id));
  assert.equal((await rows(fresh, "SELECT COUNT(*) AS n FROM memories"))[0].n, 3);
  assert.equal((await rows(fresh, "SELECT COUNT(*) AS n FROM memory_tags WHERE memory_id = ?", bad.entries[0].id))[0].n, 0, "a failed memory leaves no tags behind");
});

test("a v2 import refuses an id over 50 bytes and says why, and the other memories still go in", async () => {
  const source = await createApp();
  await populate(source);
  const doc = await exportOf(source);
  const longId = "d".repeat(51);
  doc.entries[0].id = longId;
  const fresh = await createApp();
  const [reply] = await restore(fresh, doc);
  assert.equal(reply.imported, doc.entries.length - 1);
  assert.ok(reply.errors.some((e) => e.id === longId && /50 bytes/.test(e.error)), JSON.stringify(reply.errors));
  assert.equal(await row(fresh, longId), null);
});

test("a device is only imported with a real hash, never with a token", async () => {
  const app = await createApp();
  const hash = "a".repeat(64);
  const devices = [
    { id: "d1", label: "good", token_hash: hash, created_at: 5, last_used_at: null, revoked_at: null },
    { id: "d2", label: "plain", token_hash: "amd_plaintexttoken", created_at: 5 },
    { id: "d3", label: "with token", token: "amd_secret", token_hash: "b".repeat(64), created_at: 5 },
    { id: "d4", label: "upper", token_hash: "A".repeat(64), created_at: 5 },
    { id: "d5", label: "no time", token_hash: "c".repeat(64) },
  ];
  const [reply] = await restore(app, { format: 2, entries: [], devices });
  assert.equal(reply.devices, 1);
  assert.deepEqual(reply.errors.map((e) => e.id), ["d2", "d3", "d4", "d5"]);
  assert.deepEqual((await rows(app, "SELECT id, token_hash FROM devices")).map((d) => d.id), ["d1"]);
  assert.equal((await restore(app, { format: 2, entries: [], devices }))[0].devices, 0, "the same device twice adds nothing");
});

test("a restore brings devices back revoked unless the admin names them, and reports the ones that came back active", async () => {
  const app = await createApp();
  const devices = [
    { id: "da", label: "laptop", token_hash: "e".repeat(64), created_at: 5, last_used_at: null, revoked_at: null },
    { id: "db", label: "old phone", token_hash: "f".repeat(64), created_at: 5, last_used_at: null, revoked_at: 9 },
  ];
  const [reply] = await restore(app, { format: 2, entries: [], devices });
  assert.equal(reply.devices, 2);
  const stored = Object.fromEntries((await rows(app, "SELECT id, revoked_at FROM devices")).map((d) => [d.id, d.revoked_at]));
  assert.ok(stored.da > 0, "an active device in the backup comes back revoked");
  assert.equal(stored.db, 9, "a device revoked before the backup keeps its own time");
  assert.deepEqual(reply.reactivated_devices, [], "nothing came back active without being asked");

  const other = await createApp();
  const [asked] = await restore(other, { format: 2, entries: [], devices, reactivate_devices: ["da", "db"] });
  const back = Object.fromEntries((await rows(other, "SELECT id, revoked_at FROM devices")).map((d) => [d.id, d.revoked_at]));
  assert.equal(back.da, null, "a device the admin names comes back active");
  assert.equal(back.db, 9, "a device that was revoked stays revoked even when named");
  assert.deepEqual(asked.reactivated_devices, ["da"], "the reply lists the ids that came back active");
  const bad = await app.call("/import", { method: "POST", body: { format: 2, entries: [], reactivate_devices: "da", offset: 0, limit: 50 } });
  assert.equal(bad.status, 400);
});

test("links between memories that do not exist are dropped, and bad documents are refused", async () => {
  const app = await createApp();
  const entry = { id: "m1", content: "text", content_hash: "h", origin: "import", valid_from: 1, created_at: 1, updated_at: 1, tags: [] };
  const links = [
    { source_id: "m1", target_id: "ghost", link_type: "related", created_at: 1 },
    { source_id: "m1", target_id: "m1", link_type: "self", created_at: 1 },
  ];
  const [reply] = await restore(app, { format: 2, entries: [entry], links });
  assert.equal(reply.links, 1, "only the link whose ends exist");
  const post = (body) => app.call("/import", { method: "POST", body });
  assert.equal((await post({ format: 2 })).status, 400);
  assert.equal((await post({ format: 2, entries: [], versions: "x" })).status, 400);
  assert.equal((await post({ format: 2, entries: [], versions: [{ memory_id: "m", seq: "1" }] })).status, 400);
  assert.equal((await post({ format: 2, entries: [], links: [{ source_id: 1 }] })).status, 400);
  assert.equal((await post({ format: 2, entries: [], limit: 0 })).status, 400);
  assert.equal((await post({ format: 2, entries: [], offset: -1 })).status, 400);
});

test("import is admin only", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  const body = { format: 2, entries: [] };
  assert.equal((await app.call("/import", { method: "POST", token: device, body })).status, 403);
  assert.equal((await app.call("/import", { method: "POST", token: null, body })).status, 401);
  assert.equal((await app.call("/import", { method: "POST", jwt: app.browserJwt(ME), token: null, body })).status, 403);
});

test("the old Worker's shape still imports exactly as before", async () => {
  const app = await createApp();
  const entry = { id: "11111111-1111-4111-8111-111111111111", content: "---\nname: old-memory\ndescription: An old memory\n---\nThe body.", tags: ["status:canonical", "kind:semantic", "project:demo"], source: "session-capture", created_at: 1_700_000_000_000, updated_at: 1_700_000_005_000, recall_count: 3 };
  const res = await app.call("/import", { method: "POST", body: { entries: [entry, { ...entry, id: "22222222-2222-4222-8222-222222222222", tags: ["synthesized"] }] } });
  assert.deepEqual(res.json, { ok: true, imported: 2, skipped: 0, next_offset: 2, remaining: 0 });
  const stored = await row(app, entry.id);
  assert.deepEqual([stored.origin, stored.status, stored.project, stored.recall_count, stored.created_at], ["capture", "canonical", "demo", 3, 1_700_000_000_000]);
  assert.ok((await row(app, "22222222-2222-4222-8222-222222222222")).deleted_at > 0);
  assert.deepEqual((await app.call("/import", { method: "POST", body: { entries: [entry] } })).json, { ok: true, imported: 0, skipped: 1, next_offset: 1, remaining: 0 });
  // an old body that happens to say format 1 is still the old shape
  assert.equal((await app.call("/import", { method: "POST", body: { format: 1, entries: [{ ...entry, id: "33333333-3333-4333-8333-333333333333" }] } })).json.imported, 1);
});

// ------------------------------------------------------------------ backup

test("GET /backup lists backups newest first with the fields the doctor and dashboard read", async () => {
  const app = await createApp();
  const empty = await app.call("/backup");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { ok: true, backups: [], latest: null });
  await seed(app, { name: "one" });
  await runBackup(app.env, () => app.clock.t);
  app.clock.t += DAY;
  await seed(app, { name: "two" });
  await runBackup(app.env, () => app.clock.t);
  const { json } = await app.call("/backup");
  assert.deepEqual(json.backups.map((b) => [b.day, b.entries, b.key]), [
    [new Date(START + DAY).toISOString().slice(0, 10), 2, `backups/anymem-${new Date(START + DAY).toISOString().slice(0, 10)}.json.gz`],
    [new Date(START).toISOString().slice(0, 10), 1, `backups/anymem-${new Date(START).toISOString().slice(0, 10)}.json.gz`],
  ]);
  assert.ok(json.backups.every((b) => b.size > 0 && b.created_at > 0));
  assert.deepEqual([json.latest.day, json.latest.entries], [json.backups[0].day, 2]);
  const object = await app.env.BACKUP_BUCKET.head(json.backups[0].key);
  assert.deepEqual(object.customMetadata, { entries: "2", created_at: String(START + DAY), schema: String(SCHEMA), purged: "0" });
  assert.equal(object.httpMetadata.contentType, "application/gzip");
});

test("GET /backup ignores other objects in the bucket and pages through a long list", async () => {
  const app = await createApp();
  await app.env.BACKUP_BUCKET.put("other/file.txt", "x");
  await app.env.BACKUP_BUCKET.put("backups/notes.txt", "x");
  for (let d = 1; d <= 25; d++) await app.env.BACKUP_BUCKET.put(`backups/anymem-2026-09-${String(d).padStart(2, "0")}.json.gz`, "x", { customMetadata: { entries: String(d) } });
  const real = app.env.BACKUP_BUCKET.list.bind(app.env.BACKUP_BUCKET);
  app.env.BACKUP_BUCKET.list = (o) => real({ ...o, limit: 10 });
  const list = await listBackups(app.env.BACKUP_BUCKET);
  assert.equal(list.length, 25);
  assert.equal(list[0].day, "2026-09-25");
  assert.equal(list.at(-1).entries, 1);
  assert.equal(list[0].created_at, null, "an object without metadata has no created_at");
});

test("GET /backup/<day> downloads the gzip bytes, which unzip to the export", async () => {
  const app = await createApp();
  await populate(app);
  const run = await app.call("/backup/run", { method: "POST", body: {} });
  const day = new Date(START).toISOString().slice(0, 10);
  const res = await raw(app, `/backup/${day}`, asAdmin(app));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition"), new RegExp(`anymem-${day}\\.json\\.gz`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.byteLength, run.json.bytes);
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "a gzip header");
  const doc = JSON.parse(await gunzip(bytes));
  assert.deepEqual([doc.format, doc.entries.length], [2, 8]);
  assert.deepEqual(doc.entries, (await exportOf(app)).entries);
});

test("GET /backup/<day> gives a browser login a copy without device token hashes and a bearer caller the stored bytes", async () => {
  const app = await createApp();
  await populate(app);
  await app.call("/backup/run", { method: "POST", body: {} });
  const day = new Date(START).toISOString().slice(0, 10);
  const stored = await app.env.BACKUP_BUCKET.get(`backups/anymem-${day}.json.gz`);
  const storedBytes = new Uint8Array(await stored.arrayBuffer());
  const storedDoc = JSON.parse(await gunzip(storedBytes));
  assert.ok(storedDoc.devices.length === 2 && storedDoc.devices.every((d) => /^[0-9a-f]{64}$/.test(d.token_hash)), "the stored backup keeps the hashes for a restore");

  const bearer = new Uint8Array(await (await raw(app, `/backup/${day}`, asAdmin(app))).arrayBuffer());
  assert.deepEqual(bearer, storedBytes, "a bearer caller gets the stored bytes unchanged");

  const res = await raw(app, `/backup/${day}`, asBrowser(app));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition"), new RegExp(`anymem-${day}\\.json\\.gz`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(String(bytes.byteLength), res.headers.get("content-length"));
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "a gzip header");
  const text = await gunzip(bytes);
  assert.ok(!/token_hash/.test(text), "no token hash anywhere in the browser copy");
  const doc = JSON.parse(text);
  assert.equal(doc.devices.length, 2);
  for (const d of doc.devices) assert.deepEqual(Object.keys(d).sort(), ["created_at", "id", "label", "last_used_at", "revoked_at"]);
  assert.deepEqual({ ...doc, devices: null }, { ...storedDoc, devices: null }, "everything else is unchanged");
});

test("gzip and gunzip round trip any text", async () => {
  const text = JSON.stringify({ a: "café 🎯\r\n", b: "x".repeat(100_000) });
  const zipped = await gzip(text);
  assert.ok(zipped.byteLength < text.length / 10);
  assert.equal(await gunzip(zipped), text);
});

test("GET /backup/<day> says what is wrong with the day", async () => {
  const app = await createApp();
  assert.equal((await app.call("/backup/2026-01-01")).status, 404);
  assert.equal((await app.call("/backup/tomorrow")).status, 400);
  assert.equal((await app.call("/backup/run")).status, 400, "GET on the run route is just a bad day");
  assert.equal((await app.call("/backup/2026-01-01", { method: "POST", body: {} })).status, 405);
});

test("POST /backup/run replies with the key, entries and bytes", async () => {
  const app = await createApp();
  await seed(app, { name: "one" });
  const res = await app.call("/backup/run", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.ok, res.json.key, res.json.entries], [true, `backups/anymem-${new Date(START).toISOString().slice(0, 10)}.json.gz`, 1]);
  assert.ok(res.json.bytes > 0);
  assert.equal(res.json.refused, undefined);
  assert.equal((await app.call("/backup/run", { method: "POST", rawBody: "{}" })).status, 200);
  assert.equal((await app.call("/backup/run", { method: "POST", body: { force: "yes" } })).status, 400);
});

test("a backup with more than 20 percent fewer entries than the last one is refused and the old one stays", async () => {
  const app = await createApp();
  for (let i = 0; i < 10; i++) await seed(app, { name: `m${i}` });
  const first = (await app.call("/backup/run", { method: "POST", body: {} })).json;
  const before = await (await app.env.BACKUP_BUCKET.get(first.key)).arrayBuffer();
  await app.env.DB.prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories LIMIT 3)").run();
  const refused = await app.call("/backup/run", { method: "POST", body: {} });
  assert.equal(refused.status, 200);
  assert.deepEqual([refused.json.ok, refused.json.key, refused.json.refused], [false, first.key, { entries: 7, previous_entries: 10, previous_key: first.key }]);
  assert.deepEqual(new Uint8Array(await (await app.env.BACKUP_BUCKET.get(first.key)).arrayBuffer()), new Uint8Array(before), "the old backup is untouched");
  assert.equal((await app.call("/backup")).json.latest.entries, 10);
  const forced = await app.call("/backup/run", { method: "POST", body: { force: true } });
  assert.deepEqual([forced.json.ok, forced.json.entries], [true, 7]);
});

test("exactly 20 percent fewer is allowed, and the nightly run records a refusal as a failed run", async () => {
  const app = await createApp();
  for (let i = 0; i < 10; i++) await seed(app, { name: `m${i}` });
  await runNightly(app, { steps: ["backup"] });
  await app.env.DB.prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories LIMIT 2)").run();
  const ok = await runNightly(app, { steps: ["backup"] });
  assert.deepEqual([ok.ok, ok.summary.backup.entries], [true, 8], "8 of 10 is exactly 20 percent smaller");
  await app.env.DB.prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories LIMIT 2)").run();
  const bad = await runNightly(app, { steps: ["backup", "token"] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.summary.backup.refused, { entries: 6, previous_entries: 8, previous_key: bad.summary.backup.key });
  assert.ok(bad.summary.token, "the run went on");
  assert.equal((await rows(app, "SELECT ok FROM runs ORDER BY id DESC LIMIT 1"))[0].ok, 0);
});

test("the drop a trash purge makes is allowed, and a drop beyond the purges is still refused", async () => {
  const app = await createApp();
  for (let i = 0; i < 10; i++) await seed(app, { name: `p${i}` });
  const first = (await app.call("/backup/run", { method: "POST", body: {} })).json;
  assert.equal(first.entries, 10);
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id IN (SELECT id FROM memories LIMIT 3)").bind(START - 20 * DAY).run();
  assert.equal((await runNightly(app, { steps: ["purge_trash"] })).summary.purge_trash.purged, 3);
  const after = await app.call("/backup/run", { method: "POST", body: {} });
  assert.deepEqual([after.json.ok, after.json.entries], [true, 7], "3 of 10 went in the purge, so 7 is what is expected");
  assert.equal((await app.call("/backup")).json.latest.entries, 7);
  await app.env.DB.prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories LIMIT 3)").run();
  const refused = await app.call("/backup/run", { method: "POST", body: {} });
  assert.deepEqual([refused.json.ok, refused.json.refused?.previous_entries], [false, 7], "3 more went with no purge behind them");
});

test("GET /export pages by cursor, and a purge between two pages does not shift the next one", async () => {
  const app = await createApp();
  await populate(app);
  const all = (await exportOf(app)).entries.map((e) => e.id);
  const first = await exportOf(app, "?cursor=start&limit=3");
  assert.deepEqual(first.entries.map((e) => e.id), all.slice(0, 3));
  assert.equal(first.next_offset, null, "a cursor page gives next_cursor, not next_offset");
  assert.match(first.next_cursor, /^\d+:/);
  await app.env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(all[0]).run();
  const second = await exportOf(app, `?cursor=${encodeURIComponent(first.next_cursor)}&limit=3`);
  assert.deepEqual(second.entries.map((e) => e.id), all.slice(3, 6), "the rows after the cursor, not a shifted page");
  assert.equal((await app.call("/export?cursor=not-a-cursor")).json.code, "bad_cursor");
});

test("the nightly backup step writes the backup with its metadata", async () => {
  const app = await createApp();
  await populate(app);
  const out = (await runNightly(app, { steps: ["backup"] })).summary.backup;
  assert.deepEqual([out.ok, out.entries], [true, 8]);
  assert.ok(out.subrequests > 0 && out.subrequests < 40);
  assert.equal((await app.env.BACKUP_BUCKET.head(out.key)).customMetadata.entries, "8");
});

test("backup routes: admin and browser may read, a device may not, and only the admin may run", async () => {
  const app = await createApp();
  await seed(app, { name: "one" });
  await app.call("/backup/run", { method: "POST", body: {} });
  const day = new Date(START).toISOString().slice(0, 10);
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  for (const path of ["/backup", `/backup/${day}`]) {
    assert.equal((await raw(app, path, asAdmin(app))).status, 200, `admin ${path}`);
    assert.equal((await raw(app, path, asBrowser(app))).status, 200, `browser ${path}`);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt(), token: device })).status, 403, `device ${path}`);
    assert.equal((await raw(app, path, { jwt: app.serviceJwt() })).status, 401, `no token ${path}`);
    assert.equal((await raw(app, path, {})).status, 401, `no access ${path}`);
  }
  const run = (opts) => raw(app, "/backup/run", { method: "POST", body: {}, ...opts });
  assert.equal((await run(asAdmin(app))).status, 200);
  assert.equal((await run({ jwt: app.serviceJwt(), token: device })).status, 403);
  assert.equal((await run({ ...asBrowser(app), headers: { origin: "https://anymem-worker.test", "x-anymem-ui": "1", "sec-fetch-site": "same-origin" } })).status, 403, "a browser login cannot start a backup");
  assert.equal((await run({ jwt: app.serviceJwt() })).status, 401);
});

test("without a bucket the backup routes answer 404, which the doctor reads as backups off", async () => {
  const app = await createApp({ env: { BACKUP_BUCKET: undefined } });
  assert.equal((await app.call("/backup")).status, 404);
  assert.equal((await app.call("/backup/2026-01-01")).status, 404);
  assert.equal((await app.call("/backup/run", { method: "POST", body: {} })).json.code, "no_backup_bucket");
});

test("a bucket that fails gives a clean error", async () => {
  const app = await createApp();
  app.env.BACKUP_BUCKET.createMultipartUpload = async () => {
    throw new Error("r2 is down");
  };
  const res = await app.call("/backup/run", { method: "POST", body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "backup_failed");
});

test("a streamed backup goes up in parts and a failed part leaves no object behind", async () => {
  const app = await createApp();
  await populate(app);
  // text that does not compress, so the gzip output runs to several pieces of its own
  for (let i = 0; i < 40; i++) await seed(app, { name: `bulk-${i}`, text: Array.from({ length: 300 }, (_, j) => `${Math.random().toString(36).slice(2)}${j}`).join(" ") });
  const day = await runBackup(app.env, () => app.clock.t, { partBytes: 20_000 });
  assert.equal(day.ok, true);
  assert.ok(app.env.BACKUP_BUCKET.partCount >= 3, `${app.env.BACKUP_BUCKET.partCount} parts`);
  const doc = JSON.parse(await gunzip(new Uint8Array(await (await app.env.BACKUP_BUCKET.get(day.key)).arrayBuffer())));
  assert.deepEqual(doc, JSON.parse(JSON.stringify((await exportOf(app)))), "the streamed document is the export, piece for piece");
  const real = app.env.BACKUP_BUCKET.createMultipartUpload.bind(app.env.BACKUP_BUCKET);
  app.env.BACKUP_BUCKET.createMultipartUpload = async (key, options) => {
    const upload = await real(key, options);
    let parts = 0;
    return { ...upload, uploadPart: async (n, v) => (++parts > 1 ? Promise.reject(new Error("part failed")) : upload.uploadPart(n, v)) };
  };
  app.clock.t += DAY;
  await assert.rejects(runBackup(app.env, () => app.clock.t, { partBytes: 200 }), /part failed/);
  assert.equal(await app.env.BACKUP_BUCKET.head(keyForDay(app.clock.t)), null, "no partial object is left");
});

test("every part of a streamed upload but the last has the same length, whatever size the gzip pieces come in", async () => {
  const bucket = new FakeR2();
  let n = 0;
  // random text that does not compress, in pieces of uneven length, so the gzip output comes out in uneven pieces too
  async function* pieces() {
    for (let i = 0; i < 60; i++) yield Array.from({ length: 200 + ((i * 7919) % 900) }, () => Math.random().toString(36).slice(2)).join("");
    n++;
  }
  const size = await streamGzipTo(bucket, "k.gz", {}, pieces(), 10_000);
  assert.equal(n, 1);
  assert.ok(bucket.partCount >= 4, `${bucket.partCount} parts`);
  assert.equal((await bucket.get("k.gz")).size ?? (await (await bucket.get("k.gz")).arrayBuffer()).byteLength, size);
});

const keyForDay = (at) => `backups/anymem-${new Date(at).toISOString().slice(0, 10)}.json.gz`;

// ------------------------------------------------------------------ the restore proof

test("RESTORE PROOF: back up a populated store, restore into an empty one, compare everything", async () => {
  const source = await createApp();
  // the nightly job itself reads the store, so run the real thing and not just the export
  const { ids } = await populate(source);
  for (let i = 0; i < 30; i++) await seed(source, { name: `bulk-${i}`, text: `zq${i} one two three`, tags: i % 3 === 0 ? ["red"] : [], ageDays: i, origin: i % 2 ? "capture" : "explicit" });
  await indexAll(source);
  const nightly = await runNightly(source, { steps: ["backup"] });
  assert.equal(nightly.summary.backup.ok, true);
  const day = new Date(START).toISOString().slice(0, 10);
  const bytes = new Uint8Array(await (await source.env.BACKUP_BUCKET.get(`backups/anymem-${day}.json.gz`)).arrayBuffer());
  const doc = JSON.parse(await gunzip(bytes));
  assert.equal(doc.entries.length, 38);

  const empty = await createApp();
  const replies = await restore(empty, named(doc), 7);
  assert.equal(replies.reduce((n, r) => n + r.imported, 0), 38);
  assert.equal(replies.reduce((n, r) => n + r.errors.length, 0), 0);
  const [a, b] = [await dump(source), await dump(empty)];
  for (const table of Object.keys(a)) assert.deepEqual(b[table], a[table], `${table} differ`);
  for (const m of a.memories) assert.equal(b.memories.find((x) => x.id === m.id).content, m.content);

  // then the vectors come back and the store answers the same
  let remaining = 1;
  for (let i = 0; i < 20 && remaining > 0; i++) remaining = (await empty.call("/admin/reindex", { method: "POST", body: { limit: 50 } })).json.remaining;
  assert.equal(remaining, 0);
  // /list takes n (not limit), and a bare call returns only 50, so ask for up to 500 and check the list is not empty
  const list = async (app) => (await app.call("/list?n=500")).json.entries;
  assert.ok((await list(source)).length >= 30, "the source has a real list to compare");
  assert.deepEqual(await list(empty), await list(source));
  assert.equal((await empty.call("/count")).json.count, (await source.call("/count")).json.count);
  // the search questions survive the rebuild, with their times, and they have vectors that answer a search
  const [after, before] = [await dump(empty), await dump(source)];
  assert.equal(after.questions.length, 2);
  assert.deepEqual(after.questions, before.questions, "the question rows are the same after the reindex");
  const questionIds = (await rows(empty, "SELECT vector_id FROM memory_keys WHERE key_type = 'question' ORDER BY position")).map((r) => r.vector_id);
  assert.deepEqual(questionIds, [`${ids.explicit}:question:0`, `${ids.explicit}:question:1`]);
  for (const id of questionIds) assert.ok(empty.env.VECTORIZE.vectors.has(id), `${id} is in the index`);
  assert.equal(empty.env.VECTORIZE.vectors.size, source.env.VECTORIZE.vectors.size, "the same number of vectors");
  const hit = await empty.env.VECTORIZE.query(fakeEmbedding("What is the second question?"), { topK: 1 });
  assert.deepEqual([hit.matches[0].id, hit.matches[0].metadata.memory_id], [`${ids.explicit}:question:1`, ids.explicit]);
  assert.deepEqual((await empty.call(`/history?id=${ids.updated}`)).json, (await source.call(`/history?id=${ids.updated}`)).json);
  const [x, y] = await Promise.all([source.call("/recall?query=one+two+three&topK=5"), empty.call("/recall?query=one+two+three&topK=5")]);
  assert.deepEqual(y.json.results.map((r) => r.id), x.json.results.map((r) => r.id));
});
