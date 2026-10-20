import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FakeD1 } from "./helpers/d1.js";
import { migratedDb } from "./helpers/app.js";
import { listMigrations, migrate, parseJsonc, restExecutor } from "../migrate.js";

const tables = (db) => db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts_%' ORDER BY name").all().map((r) => r.name);

test("migrations create every v2 table", async () => {
  const db = await migratedDb();
  const want = ["audit", "capsule_cache", "counters", "devices", "links", "memories", "memory_fts", "memory_keys", "memory_tags", "memory_versions", "meta", "recall_log", "runs", "write_counter"];
  assert.deepEqual(tables(db), want);
});

test("the migrations build the same schema as db/schema.sql", async () => {
  const db = await migratedDb();
  const direct = new DatabaseSync(":memory:");
  direct.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const dump = (s) => s.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => `${r.type} ${r.name} ${r.sql}`);
  assert.deepEqual(dump(db.sqlite), dump(direct));
});

test("migrate records the version and a second run does nothing", async () => {
  const db = new FakeD1();
  const execute = async (sql) => {
    if (/^\s*SELECT/i.test(sql)) return (await db.prepare(sql).all()).results;
    await db.exec(sql);
    return [];
  };
  const migrations = listMigrations();
  const versions = migrations.map((m) => m.version);
  assert.deepEqual(await migrate({ execute, migrations }), versions);
  assert.equal((await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first()).value, String(versions.at(-1)));
  assert.deepEqual(await migrate({ execute, migrations }), []);
});

test("migrate applies only newer migrations", async () => {
  const sent = [];
  const rows = [{ value: "1" }];
  const execute = async (sql) => {
    sent.push(sql);
    return /^\s*SELECT/i.test(sql) ? rows : [];
  };
  const migrations = [
    { version: 1, file: "0001_a.sql", sql: "-- one" },
    { version: 2, file: "0002_b.sql", sql: "ALTER TABLE x ADD COLUMN y TEXT;" },
  ];
  assert.deepEqual(await migrate({ execute, migrations }), [2]);
  assert.ok(sent.some((s) => s.includes("ALTER TABLE x") && s.includes("'schema_version', '2'")));
  assert.ok(!sent.some((s) => s.includes("-- one")));
});

test("listMigrations needs numbers without gaps", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  writeFileSync(join(dir, "0001_a.sql"), "-- a");
  writeFileSync(join(dir, "0003_c.sql"), "-- c");
  assert.throws(() => listMigrations(dir), /0001, 0002/);
});

test("the REST executor posts to the D1 query endpoint and reports errors without the token", async () => {
  const seen = [];
  const ok = async (url, init) => (seen.push({ url, init }), Response.json({ success: true, result: [{ results: [{ a: 1 }] }] }));
  const rows = await restExecutor({ token: "secret-token", accountId: "acct", dbId: "db1", fetchFn: ok })("SELECT 1");
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.equal(seen[0].url, "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db1/query");
  assert.equal(seen[0].init.headers.authorization, "Bearer secret-token");
  const bad = async () => Response.json({ success: false, errors: [{ code: 7500, message: "no such table" }] }, { status: 400 });
  await assert.rejects(restExecutor({ token: "secret-token", accountId: "a", dbId: "d", fetchFn: bad })("x"), (e) => /7500 no such table/.test(e.message) && !e.message.includes("secret-token"));
});

test("the trigram index finds a fragment of a word", async () => {
  const db = await migratedDb();
  await db.prepare("INSERT INTO memory_fts (memory_id, name, description, body, keys) VALUES ('m1', 'deploy notes', '', 'the deployment pipeline', '')").run();
  const hit = await db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?").bind('"ployme"').all();
  assert.deepEqual(hit.results.map((r) => r.memory_id), ["m1"]);
});

test("constraints hold and deleting a memory removes its tags and keys", async () => {
  const db = await migratedDb();
  const add = (id, over = {}) =>
    db.prepare("INSERT INTO memories (id, content, content_hash, origin, valid_from, created_at, updated_at, status) VALUES (?, 'c', 'h', ?, 1, 1, 1, ?)").bind(id, over.origin ?? "explicit", over.status ?? "active").run();
  await add("a");
  await assert.rejects(add("b", { origin: "nonsense" }));
  await assert.rejects(add("c", { status: "draft" }));
  await db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES ('a', 'x')").run();
  await db.prepare("INSERT INTO memory_keys (memory_id, key_type, text, created_at) VALUES ('a', 'chunk', 't', 1)").run();
  await assert.rejects(db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES ('missing', 'x')").run());
  await db.prepare("DELETE FROM memories WHERE id = 'a'").run();
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_tags").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_keys").first()).n, 0);
});

test("the expected indexes exist", async () => {
  const db = await migratedDb();
  const names = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  for (const n of ["idx_memories_content_hash", "idx_memories_status", "idx_memories_origin", "idx_memories_project", "idx_memories_created_at", "idx_memories_deleted_at", "idx_memories_valid_until", "idx_memory_tags_tag", "idx_audit_ts", "idx_memory_versions_reason"]) {
    assert.ok(names.includes(n), n);
  }
});

test("the Home and Activity reads on memory_versions use the reason index, not a scan", async () => {
  const db = await migratedDb();
  const plan = db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM memory_versions WHERE reason IN ('supersede', 'merge') AND created_at >= ?").all(0).map((r) => r.detail).join(" | ");
  assert.match(plan, /idx_memory_versions_reason/, plan);
});

test("the D1 fake batches as a transaction and reports meta fields", async () => {
  const db = new FakeD1();
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)");
  const ins = await db.prepare("INSERT INTO t (v) VALUES (?)").bind("a").run();
  assert.equal(ins.meta.changes, 1);
  assert.equal(ins.meta.last_row_id, 1);
  await assert.rejects(db.batch([db.prepare("INSERT INTO t (v) VALUES (?)").bind("b"), db.prepare("INSERT INTO t (v) VALUES (?)").bind("a")]));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM t").first("n")), 1);
  assert.throws(() => db.prepare("SELECT ?").bind(undefined), /undefined/);
  assert.throws(() => db.prepare("SELECT 1").bind(...new Array(101).fill(1)), /too many/);
});

test("the wrangler config read by migrate.js allows whole line comments, as setup does", () => {
  const text = '{\n  // the database this Worker uses\n  "d1_databases": [{ "binding": "DB", "database_id": "abc" }]\n  // end\n}';
  assert.equal(parseJsonc(text).d1_databases[0].database_id, "abc");
  assert.throws(() => parseJsonc('{ "a": 1 } // trailing'), SyntaxError, "a comment after a value is not allowed, as in setup");
});
