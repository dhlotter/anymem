// The Cloudflare plan limits the Health screen measures against. These are the published Workers Paid figures, checked
// against the Cloudflare documentation on 2026-10-18. They are not read from the account, so a plan change means an edit here.
export const PLAN_LIMITS = {
  plan: "Workers Paid",
  checked: "2026-10-18",
  d1_bytes: 10 * 1024 * 1024 * 1024, // one D1 database
  vectors_per_index: 20_000_000, // one Vectorize index, a hard limit
  vector_dimensions_included: 10_000_000, // stored dimensions, vectors times 384, included in the plan. Beyond it a small charge applies, it is not a stop
};
