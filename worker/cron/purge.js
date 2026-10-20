// Nightly purges. The trash after 14 days, with its vectors and history, and old counters and audit rows.
import { purgeAudit, RETENTION_MS } from "../audit.js";
import { dayOf } from "../counters.js";
import { TRASH_WINDOW_MS } from "../memory/store.js";
import { vectorId, vectorIdFits } from "../search/chunk.js";
import { clearProbe } from "../search/probe.js";

const BATCH = 100;
const COST_PER_BATCH = 4;
const VECTOR_CALL = 500; // ids in one Vectorize delete, the size the indexer uses for its deletes
/** The meta key that counts every memory the trash purge has deleted. The backup reads it to allow for the drop a purge makes. */
export const PURGED_KEY = "purged_total";

/**
 * Delete memories that have been in the trash for more than 14 days, with their tags, keys, links, versions and vectors.
 * Each batch of 100 costs 4 subrequests, plus one more for every 500 vectors it deletes.
 * @returns {Promise<{purged: number, vectors: number, remaining: boolean}>}
 */
export async function purgeTrash(env, { now, budget }) {
  const cutoff = now() - TRASH_WINDOW_MS;
  let purged = 0;
  let vectors = 0;
  let more = false;
  while (budget.has(COST_PER_BATCH)) {
    const { results } = await env.DB.prepare("SELECT id FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, id LIMIT ?").bind(cutoff, BATCH).all();
    more = results.length === BATCH;
    if (!results.length) break;
    const ids = JSON.stringify(results.map((r) => r.id));
    // The vector ids are worked out from the key rows, so a key whose vector id was cleared by the trash change still counts.
    const { results: keys } = await env.DB.prepare("SELECT memory_id, key_type, position FROM memory_keys WHERE memory_id IN (SELECT value FROM json_each(?))").bind(ids).all();
    // An id Vectorize refused was never stored, so there is nothing to delete for it.
    const toDelete = keys.map((k) => vectorId(k.memory_id, k.key_type, k.position)).filter(vectorIdFits);
    for (let i = 0; i < toDelete.length; i += VECTOR_CALL) await env.VECTORIZE.deleteByIds(toDelete.slice(i, i + VECTOR_CALL));
    const own = "memory_id IN (SELECT value FROM json_each(?))";
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM memory_fts WHERE ${own}`).bind(ids),
      env.DB.prepare(`DELETE FROM memory_versions WHERE ${own}`).bind(ids),
      env.DB.prepare(`DELETE FROM memory_tags WHERE ${own}`).bind(ids),
      env.DB.prepare(`DELETE FROM memory_keys WHERE ${own}`).bind(ids),
      env.DB.prepare(`DELETE FROM recall_log WHERE ${own}`).bind(ids),
      env.DB.prepare("DELETE FROM links WHERE source_id IN (SELECT value FROM json_each(?)) OR target_id IN (SELECT value FROM json_each(?))").bind(ids, ids),
      env.DB.prepare("DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?))").bind(ids),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)").bind(PURGED_KEY, String(results.length)),
    ]);
    purged += results.length;
    vectors += keys.length;
    if (!more) break;
  }
  return { purged, vectors, remaining: more };
}

/** Delete counters, audit rows and recall log rows older than 90 days, and the last doctor probe vector. */
export async function purgeOld(env, { now }) {
  const counters = await env.DB.prepare("DELETE FROM counters WHERE day < ?").bind(dayOf(now() - RETENTION_MS)).run();
  const used = await env.DB.prepare("DELETE FROM recall_log WHERE ts < ?").bind(now() - RETENTION_MS).run();
  return { audit: await purgeAudit(env.DB, now()), counters: counters.meta.changes, recall_log: used.meta.changes, probe_cleared: await clearProbe(env) };
}
