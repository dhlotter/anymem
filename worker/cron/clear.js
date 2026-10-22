// The first step of the nightly run: blank the briefs that hold text which must be gone. The routes blank a brief at the moment its
// text must go (a forget, a replace, a link to a private subject). This step is the backup for what they could not do (a purge, a merge,
// a request that died, a restore of an older backup). It runs before everything else because the run shares one subrequest budget and
// a reindex backlog can use all of it, which would leave a backup that never runs the one night it is needed. It does not depend on
// SUBJECTS, SUBJECTS_AUTO or SUBJECTS_BRIEFS, because the text may have been built while any of them was on.
import { CLEAR_COST, clearIneligible } from "../subjects/clear.js";

/** The most cards one night blanks. The next night does the rest, and the routes have done nearly all of them already. */
export const CLEAR_CAP = 8;
/** What the step needs before it starts: one read, and one card (the read of the card, the batch, the question vectors and the index). */
export const CLEAR_RESERVE = 1 + CLEAR_COST + 2;

/**
 * @param {{DB: any}} env
 * @param {{now: () => number, budget: {has: (n?: number) => boolean}}} ctx
 * @returns {Promise<{cleared: number, skipped?: string}>}
 */
export async function clearStep(env, { now, budget }) {
  if (!budget.has(CLEAR_RESERVE)) return { cleared: 0, skipped: "budget" };
  const cleared = await clearIneligible(env, { now, limit: CLEAR_CAP, room: () => budget.has(CLEAR_COST + 2) });
  return { cleared: cleared.length };
}
