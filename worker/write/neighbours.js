// The one place the write path touches search. It embeds a new memory and asks which live memories are closest.
// It depends only on embedTexts, memoryText and chunkText, so a change to the search code stays out of the write path.
//
// Vectorize makes a new vector searchable about two minutes after the upsert (measured on 2026-10-17, 2 minutes in the
// live test, not a few seconds). A memory written inside that gap is invisible to the vector query. So the memories
// changed in the last ten minutes are also read from D1 and embedded together with the new text, and compared directly.
// This covers a batch of proposals written seconds apart and a correction sent right after the fact it corrects.
import { chunkText, memoryIdOf, memoryText } from "../search/chunk.js";
import { embedTexts } from "../search/embed.js";
import { LIVE } from "../system.js";

const CANDIDATES = 30;
export const RECENT_MS = 10 * 60 * 1000;
export const MAX_RECENT = 20;

/**
 * @typedef {object} Neighbour
 * @property {string} id
 * @property {number} similarity cosine of the new text against this memory's best chunk
 * @property {string} name
 * @property {string} content
 * @property {boolean} pinned
 * @property {boolean} canonical
 */

const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const firstChunk = (m) => chunkText(memoryText(m))[0] ?? (m.content ?? "").slice(0, 1600);

/**
 * The live memories closest to a new one, best first. Throws when the embedding model or Vectorize fails.
 * With a project, only memories of that project and global ones (project '') are candidates. Without one, every memory is.
 * @param {{DB: any, AI: any, VECTORIZE: any}} env
 * @param {{name: string | null, description: string, body: string, content: string}} parsed
 * @param {() => number} now
 * @param {number} limit
 * @param {string} [project] the project of the new memory, '' for a global one
 * @returns {Promise<Neighbour[]>}
 */
export async function findNeighbours(env, parsed, now, limit = 10, project) {
  const scoped = project === undefined ? null : [project, ""];
  const scope = scoped ? " AND project IN (SELECT value FROM json_each(?))" : "";
  const scopeArgs = scoped ? [JSON.stringify(scoped)] : [];
  const { results: recent } = await env.DB.prepare(
    `SELECT id, name, description, body, content, pinned, status, project FROM memories WHERE ${LIVE} AND updated_at >= ?${scope} ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).bind(now() - RECENT_MS, ...scopeArgs, MAX_RECENT).all();

  const [vector, ...recentVectors] = await embedTexts(env.AI, [firstChunk(parsed), ...recent.map(firstChunk)]);
  const best = new Map(recent.map((r, i) => [r.id, cosine(vector, recentVectors[i])]));
  const { matches } = await env.VECTORIZE.query(vector, { topK: CANDIDATES, returnMetadata: "none" });
  const fromIndex = new Map();
  for (const m of matches) {
    if (!m.id.includes(":chunk:")) continue;
    const id = memoryIdOf(m.id);
    if (!fromIndex.has(id) || m.score > fromIndex.get(id)) fromIndex.set(id, m.score);
  }
  const rows = new Map(recent.map((r) => [r.id, r]));
  const missing = [...fromIndex.keys()].filter((id) => !rows.has(id));
  if (missing.length) {
    const { results } = await env.DB.prepare(`SELECT id, name, content, pinned, status, project FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND ${LIVE}${scope}`).bind(JSON.stringify(missing), ...scopeArgs).all();
    for (const r of results) rows.set(r.id, r);
  }
  for (const [id, score] of fromIndex) if (rows.has(id) && !(best.get(id) >= score)) best.set(id, score);
  return [...rows.values()]
    .map((r) => ({ id: r.id, similarity: best.get(r.id), name: r.name, content: r.content, pinned: r.pinned === 1, canonical: r.status === "canonical" }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
