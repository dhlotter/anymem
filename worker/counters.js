// Daily counters for the write path and extract. Bumps are collected and written in one D1 batch after the reply.
// A failed write is logged without detail and never changes a reply.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day of a time, as YYYY-MM-DD. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {any} db the D1 binding
 * @param {() => number} now
 */
export function createCounters(db, now) {
  /** @type {Map<string, number>} */
  const pending = new Map();
  return {
    /** Count one event, or n of them. Nothing is written until flush. */
    bump(name, n = 1) {
      pending.set(name, (pending.get(name) ?? 0) + n);
    },
    /** Write everything collected so far. Never throws. */
    async flush() {
      if (!pending.size) return;
      const day = dayOf(now());
      const statements = [...pending].map(([name, n]) =>
        db.prepare("INSERT INTO counters (name, day, count) VALUES (?, ?, ?) ON CONFLICT (name, day) DO UPDATE SET count = count + excluded.count").bind(name, day, n),
      );
      pending.clear();
      try {
        await db.batch(statements);
      } catch {
        console.error("counter write failed");
      }
    },
  };
}

const under = (m, prefix) => Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
const total = (map) => Object.values(map).reduce((a, b) => a + b, 0);

/** The stats sections for one window, from a flat map of counter name to count. */
function sections(m) {
  const rejected = under(m, "capture.rejected.");
  const screened = under(m, "extract.screened.");
  return {
    capture: { accepted: m["capture.accepted"] ?? 0, rejected: total(rejected), reasons: rejected, updated: m["capture.updated_in_place"] ?? 0, model_fallback: m["screen.model_fallback"] ?? 0 },
    extract: { proposed: m["extract.proposed"] ?? 0, screened: total(screened), reasons: screened },
    conflicts: { replaced: m["conflicts.replaced"] ?? 0, similar_warning: m["conflicts.similar_warning"] ?? 0, kept_both: under(m, "conflicts.kept_both.") },
    model_failures: under(m, "model.failure."),
  };
}

/**
 * The counter sections of GET /stats. Each section holds today's values and a last_7_days object of the same shape
 * (the 7 UTC days ending today).
 * @returns {Promise<{capture: object, extract: object, conflicts: object, model_failures: object}>}
 */
export async function readStats(db, at) {
  const { results } = await db.prepare("SELECT name, day, count FROM counters WHERE day >= ?").bind(dayOf(at - 6 * DAY_MS)).all();
  const today = dayOf(at);
  const week = {};
  const now = {};
  for (const r of results) {
    week[r.name] = (week[r.name] ?? 0) + r.count;
    if (r.day === today) now[r.name] = r.count;
  }
  const t = sections(now);
  const w = sections(week);
  return Object.fromEntries(Object.keys(t).map((k) => [k, { ...t[k], last_7_days: w[k] }]));
}
