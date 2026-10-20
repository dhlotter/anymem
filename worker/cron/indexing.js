// The nightly reindex and classify steps. Both work through a backlog in batches sized from the budget.
import { reindex } from "../search/indexer.js";
import { LIVE } from "../system.js";
import { classifyKind } from "../write/kind.js";

const MAX_REINDEX_BATCH = 50;
const REINDEX_FIXED = 10;
const CLASSIFY_PARALLEL = 4;
const CLASSIFY_FIXED = 5;
const CLASSIFY_COST = 3;

/**
 * Index memories that lack vectors. A batch of n memories costs about n + 8 subrequests, so the batch is sized from what is left.
 * A memory that Vectorize refuses waits, and the rest of its batch is indexed. failed is the number refused in the last batch,
 * since a refused memory comes back in every batch until it is fixed.
 * @returns {Promise<{processed: number, failed: number, remaining: number | null}>}
 */
export async function reindexStep(env, { now, budget }) {
  let processed = 0;
  let failed = 0;
  let remaining = null;
  while (budget.has(REINDEX_FIXED + 2)) {
    const limit = Math.min(MAX_REINDEX_BATCH, Math.floor((budget.left() - REINDEX_FIXED) / 2));
    const res = await reindex(env, limit, now);
    processed += res.processed;
    failed = res.failed ?? 0;
    remaining = res.remaining;
    if (!res.processed || !res.remaining) break;
  }
  return { processed, failed, remaining };
}

/**
 * Set the kind of live memories that have none, with the small model. Stops early when the first calls all fail.
 * @returns {Promise<{classified: number, failed: number, remaining: number | null}>}
 */
export async function classifyStep(env, { budget }) {
  const out = { classified: 0, failed: 0, remaining: null };
  if (!budget.has(CLASSIFY_FIXED + CLASSIFY_COST)) return out;
  const limit = Math.floor((budget.left() - CLASSIFY_FIXED) / CLASSIFY_COST);
  const { results } = await env.DB.prepare(`SELECT id FROM memories WHERE ${LIVE} AND kind IS NULL ORDER BY created_at, id LIMIT ?`).bind(limit).all();
  for (let i = 0; i < results.length; i += CLASSIFY_PARALLEL) {
    const kinds = await Promise.all(results.slice(i, i + CLASSIFY_PARALLEL).map((r) => classifyKind(env, r.id)));
    for (const kind of kinds) kind ? out.classified++ : out.failed++;
    if (out.classified === 0 && out.failed >= CLASSIFY_PARALLEL) break;
  }
  out.remaining = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${LIVE} AND kind IS NULL`).first()).n;
  return out;
}
