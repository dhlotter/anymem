// Applies unapplied migrations from db/migrations to a Cloudflare D1 database over the REST API.
// Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment. The database id comes from
// D1_DATABASE_ID, or from wrangler.local.jsonc. The schema version is kept in the meta table, so a second run does nothing.
// Run it with the two variables set, for example  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node migrate.js
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * @param {string} dir
 * @returns {{version: number, file: string, sql: string}[]}
 */
export function listMigrations(dir = join(here, "db", "migrations")) {
  const found = readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((file) => ({ version: Number(FILE_PATTERN.exec(file)[1]), file, sql: readFileSync(join(dir, file), "utf8") }));
  found.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration numbers must run 0001, 0002 and so on. Found ${m.file} at position ${i + 1}.`);
  });
  return found;
}

/**
 * Apply every migration newer than the recorded schema version, in order.
 * @param {{execute: (sql: string) => Promise<any[]>, migrations: ReturnType<typeof listMigrations>, log?: (line: string) => void}} args
 * @returns {Promise<number[]>} the versions applied
 */
export async function migrate({ execute, migrations, log = () => {} }) {
  // Same text as in db/schema.sql, so the table is identical whichever creates it first.
  await execute("CREATE TABLE IF NOT EXISTS meta (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n) WITHOUT ROWID");
  const rows = await execute("SELECT value FROM meta WHERE key = 'schema_version'");
  const current = rows.length ? Number(rows[0].value) : 0;
  const applied = [];
  for (const m of migrations.filter((x) => x.version > current)) {
    log(`applying ${m.file}`);
    // The version is written in the same request as the schema change.
    await execute(`${m.sql}\nINSERT INTO meta (key, value) VALUES ('schema_version', '${m.version}') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`);
    applied.push(m.version);
  }
  log(applied.length ? `schema is now at version ${migrations.at(-1).version}` : `schema already at version ${current}`);
  return applied;
}

/** A wrangler config as an object. Whole line comments are allowed, as in setup/worker.py. */
export function parseJsonc(text) {
  return JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
}

function databaseId() {
  if (process.env.D1_DATABASE_ID) return process.env.D1_DATABASE_ID;
  const config = parseJsonc(readFileSync(join(here, "wrangler.local.jsonc"), "utf8"));
  const id = config.d1_databases?.[0]?.database_id;
  if (!id) throw new Error("No database id. Set D1_DATABASE_ID or fill database_id in wrangler.local.jsonc.");
  return id;
}

/** An execute function that talks to the D1 REST API. */
export function restExecutor({ token, accountId, dbId, fetchFn = fetch }) {
  return async (sql) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
      const why = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new Error(`D1 refused the query (${why})`);
    }
    return body.result.at(-1)?.results ?? [];
  };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.");
  await migrate({ execute: restExecutor({ token, accountId, dbId: databaseId() }), migrations: listMigrations(), log: console.log });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`migrate failed: ${err.message}`);
    process.exit(1);
  });
}
