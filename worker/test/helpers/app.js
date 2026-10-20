// Builds a Worker with fake bindings and a controllable clock, and a call() helper for requests.
import { createWorker } from "../../index.js";
import { createKeyCache } from "../../auth.js";
import { migrate, listMigrations } from "../../migrate.js";
import { FakeD1 } from "./d1.js";
import { FakeAI, FakeR2, FakeVectorize } from "./fakes.js";
import { AUD, SERVICE_NAME, TEAM, browserClaims, certsFetch, createIssuer, serviceClaims } from "./jwt.js";

export const ADMIN_TOKEN = "admin-token-for-tests-0123456789abcdef";
export const START = 1_790_000_000_000;
// One signing key for every app in this test file. An RSA key takes most of the suite CPU, and no test needs a fresh one per app.
const ISSUER = createIssuer();

/** A D1 fake with the real migrations applied. */
export async function migratedDb() {
  const db = new FakeD1();
  await migrate({
    migrations: listMigrations(),
    execute: async (sql) => {
      if (/^\s*SELECT/i.test(sql)) return (await db.prepare(sql).all()).results;
      await db.exec(sql);
      return [];
    },
  });
  return db;
}

/**
 * The subjects table and the devices.allow_private column, from the SQL of migration 0006 in the phase 3b contract. A no op once
 * the real migration is in the folder. Not part of migratedDb, so the schema test still compares the migrations with schema.sql alone.
 */
export async function withSubjects(db) {
  if (!db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'subjects'").get()) {
    await db.exec(`CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('person','pet','asset','project','area','topic')),
      status TEXT NOT NULL CHECK (status IN ('proposed','active','stale','retired')),
      scope TEXT NOT NULL DEFAULT 'shared' CHECK (scope IN ('shared','private')),
      fields TEXT NOT NULL DEFAULT '{}',
      aliases TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (id) REFERENCES memories (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subjects_kind ON subjects (kind, status);`);
  }
  if (!db.sqlite.prepare("SELECT 1 FROM pragma_table_info('devices') WHERE name = 'allow_private'").get()) {
    await db.exec("ALTER TABLE devices ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 1 CHECK (allow_private IN (0,1))");
  }
  return db;
}

export async function createApp({ env: envOver = {}, withAccess = true } = {}) {
  const issuer = ISSUER;
  const clock = { t: START };
  const fetchFn = certsFetch([issuer]);
  const worker = createWorker({ fetch: fetchFn, now: () => clock.t, cache: createKeyCache() });
  const env = {
    DB: await withSubjects(await migratedDb()),
    VECTORIZE: new FakeVectorize(),
    AI: new FakeAI(),
    BACKUP_BUCKET: new FakeR2(),
    AUTH_TOKEN: ADMIN_TOKEN,
    ...(withAccess
      ? { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_SERVICE_COMMON_NAMES: `${SERVICE_NAME},other-client.access`, ACCESS_ALLOWED_EMAILS: "Me@Example.com" }
      : { REQUIRE_ACCESS: "false" }),
    ...envOver,
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  /** Wait for background work such as audit writes. */
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };

  /**
   * @param {string} path
   * @param {{method?: string, token?: string | null, jwt?: string | null, body?: any, rawBody?: string, headers?: Record<string, string>}} [opts]
   * token defaults to the admin token and jwt to a good service token JWT. Pass null to leave one out.
   */
  async function call(path, { method = "GET", token = ADMIN_TOKEN, jwt, body, rawBody, headers = {} } = {}) {
    const h = { ...headers };
    if (token !== null) h.authorization = `Bearer ${token}`;
    const access = jwt === undefined ? (withAccess ? issuer.sign(serviceClaims(clock.t)) : null) : jwt;
    if (access) h["cf-access-jwt-assertion"] = access;
    const init = { method, headers: h };
    if (body !== undefined || rawBody !== undefined) {
      init.body = rawBody ?? JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const res = await worker.fetch(new Request(`https://anymem-worker.test${path}`, init), env, ctx);
    await settle();
    return { status: res.status, headers: res.headers, json: await res.json() };
  }

  const browserJwt = (email, over) => issuer.sign(browserClaims(clock.t, email, over));
  const serviceJwt = (over) => issuer.sign(serviceClaims(clock.t, over));
  return { call, env, ctx, clock, issuer, fetchFn, worker, settle, browserJwt, serviceJwt };
}
