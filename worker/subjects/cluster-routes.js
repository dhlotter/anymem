// GET /admin/subjects/cluster-preview. Admin only. It runs the same grouping as the nightly step with apply off, so it
// writes nothing, and it works whatever SUBJECTS and SUBJECTS_AUTO say. The person can read what the step would propose
// before turning SUBJECTS_AUTO on, and see which groups were dropped and why.
import { createBudget, countedEnv } from "../cron/budget.js";
import { MAX_PROPOSALS, planClusters } from "../cron/cluster.js";
import { json } from "../http.js";

// A preview is one request, so it gets the same subrequest cap a request has.
const PREVIEW_SUBREQUESTS = 40;

export async function clusterPreview({ env, now }) {
  const budget = createBudget({ now, subrequests: PREVIEW_SUBREQUESTS });
  const r = await planClusters(countedEnv(env, budget), { now, budget, apply: false });
  return json({
    ok: true,
    candidates: r.candidates,
    dropped: r.dropped,
    counts: { memories: r.memories, groups: r.groups, checked: r.checked, subrequests: budget.spent },
    cap: MAX_PROPOSALS,
  });
}
