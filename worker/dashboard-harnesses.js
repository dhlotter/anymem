// The read route behind the harness views on the dashboard home and the memory filter. It only reads. Three sources, and each
// says what it can and cannot answer.
//
//   memories    where the live memories came from, by the harness column. A blank one is Imported or Unknown by its origin.
//   recalls     recall calls from machines in the last 30 days, from the audit table. That says who asked, not what was used.
//   used        which memories each tool was given, from recall_log. It only holds counted recalls since migration 0003 and keeps
//               90 days, so the reply says since when. Titles only, never memory text beyond the first line.
//   outcomes    what the hook did with each prompt, from the counters hook.recall.*. Only clients that report appear in it, so
//               the reply says since which day.
import { MACHINE_RECALL, titleFrom } from "./dashboard-insights.js";
import { callerLabel, foldByHarness, harnessLabel, knownHarness } from "./harnesses.js";
import { json } from "./http.js";
import { PREFIX, WORDS } from "./outcomes.js";
import { LIVE } from "./system.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 30;
const TOP = 3;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const percent = (part, whole) => (whole > 0 ? Math.round((100 * part) / whole) : null);

/** The label of a counter's harness key, which is a known id, unknown or other. */
const keyLabel = (key) => (key === "unknown" ? "Unknown" : key === "other" ? "Other" : callerLabel(key));

/** Where the live memories came from. One row per harness, and a blank one apart for imports and for everything else. */
export function sources(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = knownHarness(r.harness)?.id ?? r.harness;
    const label = harnessLabel(r.harness, r.origin);
    const key = `${id}\u0000${label}`;
    const g = groups.get(key) ?? { harness: id, label, filter: id === "" ? "none" : id, memories: 0 };
    g.memories += r.n;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.memories - a.memories || (a.label < b.label ? -1 : 1));
  return { total: list.reduce((n, g) => n + g.memories, 0), rows: list };
}

/** The share of prompts the hook left quiet, as a whole percent, from the counts of a window. Null when no prompt was reported. */
export const quietPercent = (c) => percent(c.quiet, c.quiet + c.injected);

/** Counter rows to totals for a window and per harness. */
export function outcomes(rows, at) {
  const sinceDay = (days) => dayKey(dayStart(at) - (days - 1) * DAY_MS);
  const blank = () => ({ injected: 0, quiet: 0, failed: 0 });
  const windows = [7, DAYS].map((days) => ({ days, ...blank() }));
  const perHarness = new Map();
  for (const r of rows) {
    const [, , word, key] = r.name.split(".");
    if (!WORDS.includes(word) || !key) continue;
    for (const w of windows) if (r.day >= sinceDay(w.days)) w[word] += r.count;
    if (r.day >= sinceDay(DAYS)) {
      const h = perHarness.get(key) ?? { harness: key, label: keyLabel(key), ...blank() };
      h[word] += r.count;
      perHarness.set(key, h);
    }
  }
  const byHarness = [...perHarness.values()].map((h) => ({ ...h, quiet_percent: quietPercent(h) })).sort((a, b) => b.injected + b.quiet - (a.injected + a.quiet) || (a.harness < b.harness ? -1 : 1));
  return { windows: windows.map((w) => ({ ...w, prompts: w.injected + w.quiet, quiet_percent: quietPercent(w) })), by_harness: byHarness };
}

/** GET /ui/api/harnesses. */
export async function harnesses({ env, now, memoryIds }) {
  const at = now();
  const since = dayStart(at) - (DAYS - 1) * DAY_MS;
  const [memoryRows, calls, used, top, log, counterRows, firstCounter] = await env.DB.batch([
    env.DB.prepare(`SELECT harness, origin, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY harness, origin`),
    env.DB.prepare(`SELECT harness, COUNT(*) AS calls, COALESCE(SUM(memory_ids = '[]'), 0) AS empty FROM audit WHERE ${MACHINE_RECALL} AND ts >= ? GROUP BY harness`).bind(since),
    env.DB.prepare("SELECT harness, COUNT(*) AS recalls, COUNT(DISTINCT memory_id) AS memories FROM recall_log WHERE ts >= ? GROUP BY harness").bind(since),
    // The top few of each tool, so a small tool is never crowded out by a big one.
    env.DB.prepare(
      `SELECT harness, id, n, name, head FROM (
         SELECT r.harness, r.memory_id AS id, COUNT(*) AS n, m.name, substr(m.content, 1, 200) AS head,
                ROW_NUMBER() OVER (PARTITION BY r.harness ORDER BY COUNT(*) DESC, r.memory_id) AS place
         FROM recall_log r JOIN memories m ON m.id = r.memory_id
         WHERE r.ts >= ? AND m.deleted_at IS NULL AND m.valid_until IS NULL GROUP BY r.harness, r.memory_id)
       WHERE place <= ? ORDER BY harness, place`,
    ).bind(since, TOP),
    env.DB.prepare("SELECT MIN(ts) AS first, COUNT(*) AS total FROM recall_log"),
    env.DB.prepare("SELECT name, day, count FROM counters WHERE name LIKE ? AND day >= ?").bind(`${PREFIX}%`, dayKey(since)),
    env.DB.prepare("SELECT MIN(day) AS first FROM counters WHERE name LIKE ?").bind(`${PREFIX}%`),
  ]);
  const topOf = new Map();
  for (const r of top.results) {
    const list = topOf.get(r.harness) ?? [];
    if (list.length < TOP) list.push({ id: r.id, title: titleFrom(r.name, r.head), count: r.n });
    topOf.set(r.harness, list);
  }
  const usedRows = foldByHarness(used.results, ["recalls", "memories"]).map((h) => ({ ...h, top: topOf.get(h.harness) ?? [] }));
  memoryIds.push(...usedRows.flatMap((h) => h.top.map((m) => m.id)));
  const callRows = foldByHarness(calls.results, ["calls", "empty"]);
  return json({
    ok: true,
    now: at,
    days: DAYS,
    sources: sources(memoryRows.results),
    recalls: { total: callRows.reduce((n, r) => n + r.calls, 0), empty: callRows.reduce((n, r) => n + r.empty, 0), by_harness: callRows },
    used: { since: log.results[0].first, total: used.results.reduce((n, r) => n + r.recalls, 0), by_harness: usedRows },
    outcomes: { since: firstCounter.results[0].first, ...outcomes(counterRows.results, at) },
  });
}

/** GET /ui/api/sources. Where the live memories came from, and nothing else. The Memories screen needs only the filter options, so it does not run the queries above. */
export async function sourcesRoute({ env }) {
  const { results } = await env.DB.prepare(`SELECT harness, origin, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY harness, origin`).all();
  return json({ ok: true, sources: sources(results) });
}
