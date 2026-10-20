// What the recall hook did with each prompt. The hook decides on the client, so the client reports its totals in one header on
// its next request, for example a header value of injected=2,quiet=5 (see client/hm/outcomes.py). The Worker adds them to the
// daily counters hook.recall.<word>.<harness>. No prompt, no memory and no id is in the header or stored.
import { createCounters } from "./counters.js";
import { knownHarness } from "./harnesses.js";
import { cleanLabel } from "./audit.js";

export const WORDS = ["injected", "quiet", "failed"];
export const MAX_COUNT = 1000;
const MAX_HEADER_CHARS = 64;
export const PREFIX = "hook.recall.";

/** The counts in a header value, or null when it is not in the shape or holds no count. Anything odd means the whole header is ignored. */
export function parseOutcomes(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > MAX_HEADER_CHARS) return null;
  const out = {};
  for (const part of text.split(",")) {
    const m = /^(injected|quiet|failed)=(\d{1,6})$/.exec(part.trim());
    if (!m || Object.hasOwn(out, m[1])) return null;
    out[m[1]] = Math.min(Number(m[2]), MAX_COUNT);
  }
  return Object.values(out).some((n) => n > 0) ? out : null;
}

/** The harness part of a counter name. A known harness keeps its id, a blank name is unknown, any other name is other. */
export function counterKey(name) {
  const clean = cleanLabel(name);
  if (!clean) return "unknown";
  return knownHarness(clean)?.id ?? "other";
}

/**
 * Add the counts a call reports. Writes after the reply, and a failed write is logged without detail like every counter.
 * A browser login never reports, the dashboard is not a hook.
 */
export function noteOutcomes({ request, env, ctx, now, actor }) {
  if (actor.kind === "browser") return;
  const counts = parseOutcomes(request.headers.get("x-anymem-outcomes"));
  if (!counts) return;
  const key = counterKey(request.headers.get("x-anymem-harness"));
  const counters = createCounters(env.DB, now);
  for (const [word, n] of Object.entries(counts)) if (n > 0) counters.bump(`${PREFIX}${word}.${key}`, n);
  ctx.waitUntil(counters.flush());
}
