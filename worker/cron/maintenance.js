// The nightly job, at 01:00 UTC, and the same job on demand (POST /admin/run-maintenance). Each step has its own time limit,
// the steps share one subrequest budget for the whole run, and they work in small batches, so a long backlog continues the
// next night. A step that fails is recorded
// and the others still run. One row in runs holds the result: its job, times, whether every step was ok, and a summary
// with the counts of each step.
import { tokenExpiryInfo } from "../dashboard-api.js";
import { HttpError, badRequest, json, readJson } from "../http.js";
import { runBackup } from "../backup/backup.js";
import { createBudget, countedEnv, nightlyLimits } from "./budget.js";
import { classifyStep, reindexStep } from "./indexing.js";
import { mergeDuplicates } from "./merge.js";
import { runProbation } from "./probation.js";
import { purgeOld, purgeTrash } from "./purge.js";

async function backupStep(env, ctx) {
  if (!env.BACKUP_BUCKET) return { skipped: "no BACKUP_BUCKET binding" };
  const { ok, key, entries, bytes, refused } = await runBackup(env, ctx.now);
  return { ok, key, entries, bytes, ...(refused ? { refused } : {}) };
}

const tokenStep = (env, ctx) => {
  const info = tokenExpiryInfo(env, ctx.now);
  return info.configured ? { expires: info.expires, days_left: info.days_left, warn: info.warn } : { configured: false };
};

// A call that never answers must not hold the whole run. A step gets its wall time plus this much, then it is given up on.
const GRACE_MS = 15_000;

function withDeadline(work, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the step took more than ${ms} ms and was given up on`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The steps in the order they run. */
export const STEPS = {
  backup: backupStep,
  purge_trash: purgeTrash,
  reindex: reindexStep,
  classify: classifyStep,
  merge: mergeDuplicates,
  probation: runProbation,
  purge_old: purgeOld,
  token: tokenStep,
};

/**
 * Run the steps and record one runs row.
 * @param {Record<string, any>} env
 * @param {() => number} now
 * @param {{steps?: string[], wallMs?: number, subrequests?: number, job?: string, graceMs?: number}} [opts] subrequests is the budget of the whole run, graceMs is for tests
 * @returns {Promise<{ok: boolean, summary: Record<string, any>}>}
 */
export async function runMaintenance(env, now, { steps = Object.keys(STEPS), wallMs = nightlyLimits(env).wallMs, subrequests = nightlyLimits(env).subrequests, job = "nightly", graceMs = GRACE_MS } = {}) {
  const started = await env.DB.prepare("INSERT INTO runs (job, started_at) VALUES (?, ?)").bind(job, now()).run();
  const runId = started.meta.last_row_id;
  const summary = {};
  let ok = true;
  // One pool for the whole run: the invocation's subrequest cap applies to every step together.
  const pool = { spent: 0 };
  for (const name of Object.keys(STEPS).filter((n) => steps.includes(n))) {
    const budget = createBudget({ now, wallMs, subrequests, pool });
    const before = pool.spent;
    const t0 = now();
    try {
      summary[name] = await withDeadline(Promise.resolve(STEPS[name](countedEnv(env, budget), { now, budget })), wallMs + graceMs);
      if (summary[name].refused) ok = false;
    } catch (err) {
      ok = false;
      summary[name] = { error: String(err?.message ?? err).slice(0, 200) };
    }
    summary[name].subrequests = pool.spent - before;
    summary[name].ms = now() - t0;
  }
  await env.DB.prepare("UPDATE runs SET finished_at = ?, ok = ?, summary = ? WHERE id = ?").bind(now(), ok ? 1 : 0, JSON.stringify(summary), runId).run();
  return { ok, summary };
}

const POSITIVE = (v) => Number.isSafeInteger(v) && v > 0;

/** POST /admin/run-maintenance {steps?, wall_ms?, subrequests?}. Admin only. Runs now and returns the summary. */
export async function runMaintenanceRoute({ request, env, now, maxBody }) {
  const body = request.body ? await readJson(request, maxBody) : {};
  const opts = { job: "manual" };
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps) || !body.steps.length || body.steps.some((s) => !(s in STEPS))) throw badRequest(`steps must be a list of: ${Object.keys(STEPS).join(", ")}.`);
    opts.steps = body.steps;
  }
  for (const [field, key] of [["wall_ms", "wallMs"], ["subrequests", "subrequests"]]) {
    if (body[field] === undefined) continue;
    if (!POSITIVE(body[field])) throw badRequest(`${field} must be a whole number above 0.`);
    opts[key] = body[field];
  }
  try {
    return json(await runMaintenance(env, now, opts));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("maintenance failed", err?.name);
    throw new HttpError(500, "maintenance_failed", "The run could not be recorded.");
  }
}
