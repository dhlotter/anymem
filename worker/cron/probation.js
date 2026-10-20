// Probation and retirement of captured memories. Only origin capture is ever touched. Explicit, profile, person,
// system and import memories, pinned memories and canonical ones are never retired here.
//
// 1. A capture whose probation time has passed and that has been recalled at least once ends probation.
// 2. A capture never recalled, 60 days after it was created, goes to the trash.
// 3. A capture of type project with no recall in 90 days (last_recalled_at, or created_at when there is none) goes to the trash.
// A row with a recall count above 0 and no last_recalled_at counts as recalled on the day it was created, so it is never
// retired as never recalled and the idle rule measures from created_at.
// The trash keeps a memory for 14 days, so every retirement can be undone.
import { createStore } from "../memory/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEVER_RECALLED_MS = 60 * DAY_MS;
export const IDLE_PROJECT_MS = 90 * DAY_MS;
const END_BATCH = 200;
const COST_PER_RETIRE = 3;
const EXAMPLES = 5;

const ELIGIBLE = "origin = 'capture' AND pinned = 0 AND status <> 'canonical' AND deleted_at IS NULL AND valid_until IS NULL";

/** @returns {Promise<{probation_ended: number, retired_never_recalled: number, retired_idle_project: number, more: boolean, examples: Record<string, string[]>}>} */
export async function runProbation(env, { now, budget }) {
  const store = createStore(env.DB, now);
  const at = now();
  const out = { probation_ended: 0, retired_never_recalled: 0, retired_idle_project: 0, more: false, examples: { never_recalled: [], idle_project: [] } };

  const ended = await env.DB
    .prepare(`UPDATE memories SET probation_until = NULL WHERE id IN (SELECT id FROM memories WHERE ${ELIGIBLE} AND probation_until IS NOT NULL AND probation_until < ? AND recall_count >= 1 LIMIT ?)`)
    .bind(at, END_BATCH)
    .run();
  out.probation_ended = ended.meta.changes;
  if (ended.meta.changes === END_BATCH) out.more = true;

  const rules = [
    ["never_recalled", "retired_never_recalled", `${ELIGIBLE} AND recall_count = 0 AND last_recalled_at IS NULL AND created_at <= ?`, at - NEVER_RECALLED_MS, "retire_never_recalled"],
    ["idle_project", "retired_idle_project", `${ELIGIBLE} AND type = 'project' AND COALESCE(last_recalled_at, created_at) <= ?`, at - IDLE_PROJECT_MS, "retire_idle_project"],
  ];
  for (const [label, counter, where, cutoff, reason] of rules) {
    const room = Math.floor((budget.left() - 1) / COST_PER_RETIRE);
    if (room < 1 || !budget.has(1 + COST_PER_RETIRE)) {
      out.more = true;
      continue;
    }
    const { results } = await env.DB.prepare(`SELECT id, name FROM memories WHERE ${where} ORDER BY created_at, id LIMIT ?`).bind(cutoff, room).all();
    for (const row of results) {
      if (!budget.has(COST_PER_RETIRE)) {
        out.more = true;
        break;
      }
      await store.softDelete(row.id, reason);
      out[counter]++;
      if (out.examples[label].length < EXAMPLES) out.examples[label].push(row.name || row.id.slice(0, 8));
    }
    if (results.length === room) out.more = true;
  }
  return out;
}
