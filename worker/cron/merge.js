// Merge near duplicate captures. For live captures from the last 14 days that are not pinned, find neighbours at 0.90
// similarity or more that are also live, unpinned captures of the same project, and close the NEWER memory into the OLDER
// one with store.supersede (the version row has the reason "merge"). Memories of any other origin are never touched, and
// a neighbour of another origin is never a match. Canonical memories are never touched on either side. A pair also has
// to share at least 0.45 of its words, because embedding similarity alone joined memories that only looked alike.
//
// The vector search finds neighbours with the same helper the write pipeline uses. When it finds none, a keyword match on
// the exact name is the fallback, which covers a neighbour that is not searchable yet or a Vectorize failure. The fallback
// only accepts a near identical text (word overlap of 0.85 or more).
//
// The step walks the candidates oldest first and keeps its place in meta (merge_cursor), so a backlog continues the next
// night. When it runs out of candidates the cursor is cleared and the next run starts again from the window start.
import { createStore } from "../memory/store.js";
import { CLEAR_COST, clearCiting } from "../subjects/clear.js";
import { findNeighbours } from "../write/neighbours.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_MS = 14 * DAY_MS;
export const THRESHOLD = 0.9;
export const MIN_OVERLAP = 0.45;
const NAME_OVERLAP = 0.85;
const CURSOR_KEY = "merge_cursor";
// The price of one candidate until a real one has been measured. A candidate costs a vector lookup and a keyword lookup,
// plus a supersede when it matches, about 6 calls on a store with no match. The step then prices the rest at what they cost.
const COST_PER_CANDIDATE = 10;
const FIXED_COST = 3; // the candidate query, plus the cursor write at the end of the step
const FETCH = 100; // one query reads this many candidates, the budget decides how many are examined
const EXAMPLES = 5;

const words = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Share of words two texts have in common, over all the words of both. */
export function overlap(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

const olderThan = (row, cand) => row.created_at < cand.created_at || (row.created_at === cand.created_at && row.id < cand.id);
const ELIGIBLE = (alias) => `${alias}.origin = 'capture' AND ${alias}.pinned = 0 AND ${alias}.deleted_at IS NULL AND ${alias}.valid_until IS NULL AND ${alias}.status NOT IN ('pending', 'canonical')`;

/** The older live capture a candidate duplicates, by vector similarity. Null when there is none or the search failed. */
async function byVector(env, cand, now) {
  let neighbours;
  try {
    neighbours = await findNeighbours(env, cand, now, 10);
  } catch {
    return null;
  }
  const near = neighbours.filter((n) => n.id !== cand.id && !n.pinned && n.similarity >= THRESHOLD && overlap(n.content, cand.content) >= MIN_OVERLAP);
  if (!near.length) return null;
  const { results } = await env.DB.prepare(`SELECT id, project, created_at FROM memories m WHERE ${ELIGIBLE("m")} AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(near.map((n) => n.id))).all();
  const ok = new Map(results.filter((r) => r.project === cand.project && olderThan(r, cand)).map((r) => [r.id, r]));
  const best = near.find((n) => ok.has(n.id));
  return best ? { id: best.id, name: best.name } : null;
}

/** The older live capture with exactly this name and a near identical text. */
async function byName(env, cand) {
  const name = cand.name.trim();
  if (name.length < 3) return null;
  const { results } = await env.DB
    .prepare(
      `SELECT m.id, m.name, m.content, m.created_at FROM memories m
       WHERE m.id IN (SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?) AND ${ELIGIBLE("m")} AND m.id <> ? AND m.project = ? AND m.created_at <= ?
       ORDER BY m.created_at, m.id LIMIT 10`,
    )
    .bind(`name : "${name.replace(/"/g, '""')}"`, cand.id, cand.project, cand.created_at)
    .all();
  const hit = results.find((r) => r.name.trim().toLowerCase() === name.toLowerCase() && olderThan(r, cand) && overlap(r.content, cand.content) >= NAME_OVERLAP);
  return hit ? { id: hit.id, name: hit.name } : null;
}

async function readCursor(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(CURSOR_KEY).first();
  try {
    const [createdAt, id] = JSON.parse(row?.value ?? "null") ?? [];
    return Number.isSafeInteger(createdAt) && typeof id === "string" ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/** @returns {Promise<{examined: number, merged: number, completed: boolean, examples: {from: string, into: string}[]}>} */
export async function mergeDuplicates(env, { now, budget }) {
  const store = createStore(env.DB, now);
  const out = { examined: 0, merged: 0, completed: false, examples: [] };
  if (!budget.has(FIXED_COST + COST_PER_CANDIDATE)) return out;
  const windowStart = now() - WINDOW_MS;
  const cursor = await readCursor(env.DB);
  const from = cursor ?? { createdAt: windowStart, id: "" };
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, body, content, project, created_at FROM memories m
       WHERE ${ELIGIBLE("m")} AND m.created_at >= ? AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
       ORDER BY m.created_at, m.id LIMIT ?`,
    )
    .bind(windowStart, from.createdAt, from.createdAt, from.id, FETCH)
    .all();
  // The price of a candidate is what the ones examined so far have cost, so the batch is sized from real use.
  let price = COST_PER_CANDIDATE;
  let spent = 0;
  let last = null;
  const merged = [];
  for (const cand of results) {
    if (!budget.has(price + FIXED_COST)) break;
    last = cand;
    out.examined++;
    const before = budget.spent;
    const match = (await byVector(env, cand, now)) ?? (await byName(env, cand));
    if (match) {
      try {
        await store.supersede(cand.id, match.id, now(), "merge");
        out.merged++;
        merged.push(cand.id);
        if (out.examples.length < EXAMPLES) out.examples.push({ from: cand.name || cand.id.slice(0, 8), into: match.name || match.id.slice(0, 8) });
      } catch (err) {
        // Someone changed it since it was read. It is looked at again on the next sweep.
        if (!(err?.status >= 400 && err.status < 500)) throw err;
      }
    }
    spent += budget.spent - before;
    price = Math.max(1, Math.ceil(spent / out.examined));
  }
  // A memory that was folded into another may have fed a brief, and that brief goes with it. The briefs step checks this too, a night later.
  if (merged.length && budget.has(CLEAR_COST + 1)) await clearCiting(env, { ids: merged, now, why: "member.gone", room: () => budget.has(CLEAR_COST + 4) }).catch(() => console.error("brief clear failed"));
  out.completed = out.examined === results.length && results.length < FETCH;
  if (out.completed) await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(CURSOR_KEY).run();
  else if (last) await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(CURSOR_KEY, JSON.stringify([last.created_at, last.id])).run();
  return out;
}
