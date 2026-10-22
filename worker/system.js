// Health, count and stats.
import { readStats } from "./counters.js";
import { json } from "./http.js";
import { NEEDS_INDEX } from "./search/indexer.js";
import { VERSION } from "./version.js";
import { hiddenWhere } from "./subjects/private.js";

const EMBEDDING_DIMENSIONS = 384;

/** A memory that people can see and recall. */
export const LIVE = "deleted_at IS NULL AND valid_until IS NULL AND status <> 'pending'";

async function vectorizeStatus(env) {
  try {
    const info = await env.VECTORIZE.describe();
    const dimensions = info.dimensions ?? info.config?.dimensions;
    return { ok: dimensions === EMBEDDING_DIMENSIONS, dimensions: dimensions ?? null };
  } catch {
    return { ok: false, dimensions: null };
  }
}

/** GET /health. A database that cannot answer is a 503. An empty or missing vector index is only reported. */
export async function health({ env }) {
  let schemaVersion = null;
  let dbOk = true;
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
    schemaVersion = row ? Number(row.value) : null;
    dbOk = schemaVersion !== null;
  } catch {
    dbOk = false;
  }
  return json({ ok: dbOk, version: VERSION, schema_version: schemaVersion, vectorize: await vectorizeStatus(env) }, dbOk ? 200 : 503);
}

/** GET /count */
export async function count({ env, actor }) {
  // A device that may not see private subjects is not counted the memories it cannot see.
  const hidden = actor?.kind === "device" ? ` AND NOT ${hiddenWhere("memories.id")}` : "";
  const stmt = env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${LIVE}${hidden}`);
  const row = await (hidden ? stmt.bind(actor.id) : stmt).first();
  return json({ count: row.n });
}

/** The summary of a run, or an empty object when the stored text is damaged, so one bad row cannot take /stats down. */
function parseSummary(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const tally = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));

/** GET /stats */
export async function stats({ env, now }) {
  const [byStatus, byOrigin, unvectorized, unclassified, lastRun] = await env.DB.batch([
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY status`),
    env.DB.prepare(`SELECT origin, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY origin`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${LIVE} AND ${NEEDS_INDEX}`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${LIVE} AND kind IS NULL`),
    env.DB.prepare("SELECT job, started_at, finished_at, ok, summary FROM runs ORDER BY id DESC LIMIT 1"),
  ]);
  const run = lastRun.results[0];
  const by_status = tally(byStatus.results, "status");
  return json({
    count: Object.values(by_status).reduce((a, b) => a + b, 0),
    by_status,
    by_origin: tally(byOrigin.results, "origin"),
    unvectorized: unvectorized.results[0].n,
    unclassified: unclassified.results[0].n,
    // The two switches of the subject layer, so `doctor` can say whether the system acts on its own. Never a secret, only on or off.
    subjects_on: env.SUBJECTS === "on",
    subjects_auto: env.SUBJECTS_AUTO === "on",
    subjects_briefs: env.SUBJECTS_BRIEFS === "on",
    ...(await readStats(env.DB, now())),
    last_run: run ? { job: run.job, started_at: run.started_at, finished_at: run.finished_at, ok: run.ok === 1, summary: parseSummary(run.summary) } : null,
  });
}
