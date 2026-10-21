// The audit trail. One row per request that reaches the handler. Never content, never a secret.
import { callerLabel, harnessValues } from "./harnesses.js";
import { badRequest, intParam, json } from "./http.js";

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_IDS = 100;
const MAX_ROUTE_CHARS = 120;
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

/** The result filter of GET /audit. Each name is a class of HTTP status. */
export const RESULTS = {
  ok: "status < 400",
  refused: "status = 422",
  limited: "status = 429",
  denied: "status IN (401, 403)",
  failed: "status >= 400 AND status NOT IN (401, 403, 422, 429)",
};

/** Header values are only kept when they look like a name, so nothing odd lands in the table. */
export function cleanLabel(value) {
  const v = (value ?? "").trim().slice(0, 64);
  return /^[A-Za-z0-9._:-]*$/.test(v) ? v : "";
}

/**
 * The insert of one audit row, not yet run, so a caller can put several rows in one batch.
 * @param {any} db
 * @param {{ts: number, actor: {kind: string, id: string}, harness: string, script: string, method: string, route: string, status: number, durationMs: number, memoryIds: string[]}} row
 */
export function auditStatement(db, row) {
  return db
    .prepare("INSERT INTO audit (ts, actor_kind, actor_id, harness, script, method, route, status, duration_ms, memory_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.ts, row.actor.kind, row.actor.id, cleanLabel(row.harness), cleanLabel(row.script), row.method.slice(0, 16), row.route.slice(0, MAX_ROUTE_CHARS), row.status, Math.max(0, Math.round(row.durationMs)), JSON.stringify(row.memoryIds.slice(0, MAX_IDS)));
}

/** @param {any} db @param {Parameters<typeof auditStatement>[1]} row */
export async function recordAudit(db, row) {
  await auditStatement(db, row).run();
}

/** Delete rows older than the retention window and return how many went. */
export async function purgeAudit(db, now) {
  const res = await db.prepare("DELETE FROM audit WHERE ts < ?").bind(now - RETENTION_MS).run();
  return res.meta.changes;
}

/** GET /audit, newest first. Filters since, until, actor, route, harness and result. Page with limit and cursor. */
export async function listAudit({ env, url }) {
  const since = intParam(url, "since", { min: 0, max: Number.MAX_SAFE_INTEGER });
  const until = intParam(url, "until", { min: 0, max: Number.MAX_SAFE_INTEGER });
  const cursor = intParam(url, "cursor", { min: 1, max: Number.MAX_SAFE_INTEGER });
  const limit = intParam(url, "limit", { min: 1, max: PAGE_MAX, fallback: PAGE_DEFAULT });
  const actor = url.searchParams.get("actor");
  const route = url.searchParams.get("route");
  const harness = url.searchParams.get("harness");
  const result = url.searchParams.get("result");
  if ((actor ?? "").length > 128 || (route ?? "").length > MAX_ROUTE_CHARS) throw badRequest("A filter value is too long.");
  if (harness !== null && (harness.length > 64 || cleanLabel(harness) !== harness)) throw badRequest("harness must be a short name.");
  if (result !== null && !Object.hasOwn(RESULTS, result)) throw badRequest(`result must be one of ${Object.keys(RESULTS).join(", ")}.`);
  const where = [];
  const args = [];
  if (since !== undefined) (where.push("ts >= ?"), args.push(since));
  if (until !== undefined) (where.push("ts < ?"), args.push(until));
  if (cursor !== undefined) (where.push("id < ?"), args.push(cursor));
  if (actor) (where.push("actor_id = ?"), args.push(actor));
  if (route) (where.push("route = ?"), args.push(route));
  if (harness) (where.push("lower(harness) IN (SELECT value FROM json_each(?))"), args.push(JSON.stringify(harnessValues(harness))));
  if (result) where.push(`(${RESULTS[result]})`);
  const sql = `SELECT id, ts, actor_kind, actor_id, harness, script, method, route, status, duration_ms, memory_ids FROM audit${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit + 1).all();
  const page = results.slice(0, limit).map((r) => ({ ...r, harness_label: callerLabel(r.harness), memory_ids: JSON.parse(r.memory_ids) }));
  return json({ entries: page, next_cursor: results.length > limit ? page.at(-1).id : null });
}
