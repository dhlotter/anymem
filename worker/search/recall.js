// Recall. Cleans the query, searches by meaning and by keyword in parallel, merges the two lists, filters, and decides
// per hit whether it is relevant. A plain recall writes nothing. The caller adds the recall count when asked.
import { harnessLabel } from "../harnesses.js";
import { memoryIdOf, memoryText } from "./chunk.js";
import { embedTexts } from "./embed.js";
import { keywordSearch } from "./fts.js";
import { cleanQuery } from "./query.js";
import { minRerank, minSimilarity, RARE_IDF, ruleChecks } from "./relevance.js";
import { mayBeRestricted, SEES_PRIVATE_SQL, visibleOnly } from "../subjects/private.js";

export const RRF_K = 60;
export const RARE_BOOST = 2; // a keyword hit that holds a rare word counts double, so an exact identifier beats a vague neighbour
export const PROBATION_FACTOR = 0.95; // a captured memory still on probation ranks a few places lower
const CANDIDATES = 50;
const RERANK_TOP = 8; // scoring more than the hook can use changed nothing on the real prompts and cost time
const SNIPPET_CHARS = 1200;
const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 50;
const MAX_SUBJECTS = 2; // cards shown above the results

/**
 * Vector search. The best chunk of each memory counts, with its raw cosine similarity.
 * @returns {Promise<{id: string, similarity: number}[]>} best first
 */
async function vectorSearch(env, query, stamp) {
  const [vector] = await embedTexts(env.AI, [query]);
  stamp("embed");
  const { matches } = await env.VECTORIZE.query(vector, { topK: CANDIDATES, returnMetadata: "none" });
  stamp("vectorize");
  const best = new Map();
  for (const m of matches) {
    const id = memoryIdOf(m.id);
    if (!best.has(id) || m.score > best.get(id)) best.set(id, m.score);
  }
  return [...best].map(([id, similarity]) => ({ id, similarity })).sort((a, b) => b.similarity - a.similarity);
}

/** Merge ranked lists by reciprocal rank fusion. @returns {Map<string, any>} */
export function fuse(dense, keyword) {
  const merged = new Map();
  const entry = (id) => merged.get(id) ?? merged.set(id, { id, rrf: 0, similarity: null, denseRank: null, keywordRank: null, terms: [], coverage: 0 }).get(id);
  dense.forEach((d, i) => {
    const e = entry(d.id);
    e.rrf += 1 / (RRF_K + i + 1);
    e.similarity = d.similarity;
    e.denseRank = i + 1;
  });
  keyword.forEach((k, i) => {
    const e = entry(k.id);
    e.rrf += (k.terms.some((t) => t.idf >= RARE_IDF) ? RARE_BOOST : 1) / (RRF_K + i + 1);
    e.terms = k.terms;
    e.coverage = k.coverage;
    e.keywordRank = i + 1;
  });
  return merged;
}

/** Score hits against the query with the reranker, 0 to 1. A failure gives no scores and the other relevance rules decide. @returns {Promise<Map<string, number>>} */
async function rerankHits(env, query, top) {
  if (!top.length) return new Map();
  try {
    const res = await env.AI.run("@cf/baai/bge-reranker-base", { query, top_k: top.length, contexts: top.map((r) => ({ text: memoryText({ ...r, body: r.snippet }).slice(0, 1200) })) });
    return new Map(res.response.map((x) => [top[x.id].id, x.score]));
  } catch {
    console.error("rerank failed");
    return new Map();
  }
}

/** The memories that pass the filters, without their full text. A snippet of the body is enough for the reranker. */
async function load(db, ids, f) {
  const where = ["m.id IN (SELECT value FROM json_each(?))", "m.deleted_at IS NULL", "m.status <> 'pending'"];
  const args = [JSON.stringify(ids)];
  const add = (sql, ...a) => (where.push(sql), args.push(...a));
  if (f.asOf === undefined) where.push("m.valid_until IS NULL");
  else add("m.valid_from <= ? AND (m.valid_until IS NULL OR m.valid_until > ?)", f.asOf, f.asOf);
  if (f.project) add("m.project IN ('', ?)", f.project);
  if (f.excludeIds.length) add("m.id NOT IN (SELECT value FROM json_each(?))", JSON.stringify(f.excludeIds));
  if (f.tags.length) add("m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY memory_id HAVING COUNT(*) = ?)", JSON.stringify(f.tags), f.tags.length);
  if (f.kind) add("m.kind = ?", f.kind);
  if (f.type) add("m.type = ?", f.type);
  if (f.origin) add("m.origin = ?", f.origin);
  if (f.after !== undefined) add("m.created_at >= ?", f.after);
  if (f.before !== undefined) add("m.created_at < ?", f.before);
  if (f.minRecalls !== undefined) add("m.recall_count >= ?", f.minRecalls);
  if (!f.capsule) where.push("NOT EXISTS (SELECT 1 FROM memory_tags c WHERE c.memory_id = m.id AND (c.tag = 'capsule:core' OR c.tag LIKE 'capsule-slot:%'))");
  const { results } = await db
    .prepare(`SELECT m.id, m.name, m.description, m.type, substr(m.body, 1, ${SNIPPET_CHARS}) AS snippet, m.status, m.origin, m.harness, m.project, m.probation_until, m.created_at, m.updated_at FROM memories m WHERE ${where.join(" AND ")}`)
    .bind(...args)
    .all();
  return results;
}

/** The full text and the tags of the memories that are returned. */
async function loadFull(db, ids) {
  if (!ids.length) return { content: new Map(), tagsOf: new Map() };
  const [rows, tags] = await db.batch([
    db.prepare("SELECT id, content FROM memories WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
    db.prepare("SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
  ]);
  const tagsOf = new Map();
  for (const t of tags.results) tagsOf.set(t.memory_id, [...(tagsOf.get(t.memory_id) ?? []), t.tag]);
  return { content: new Map(rows.results.map((r) => [r.id, r.content])), tagsOf };
}

/** The part of a result that is the memory itself. */
const entryOf = (row, full) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  type: row.type,
  content: full.content.get(row.id),
  tags: (full.tagsOf.get(row.id) ?? []).sort(),
  project: row.project,
  origin: row.origin,
  harness: row.harness,
  harness_label: harnessLabel(row.harness, row.origin),
  status: row.status,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const round = (n, places) => (n === null ? null : Math.round(n * 10 ** places) / 10 ** places);

/**
 * @typedef {object} RecallParams
 * @property {string} query the raw prompt
 * @property {number} [topK]
 * @property {string | null} [project] with scope project:<slug>, that project plus global memories
 * @property {string[]} [excludeIds]
 * @property {string[]} [tags] all must match
 * @property {string} [kind]
 * @property {string} [type]
 * @property {string} [origin]
 * @property {number} [after] created at or after
 * @property {number} [before] created before
 * @property {number} [minRecalls]
 * @property {number} [asOf] show what was valid at this time
 * @property {boolean} [capsule] include capsule memories
 * @property {boolean} [explain] add the why object
 * @property {boolean} [checks] with explain, add every relevance rule and whether it held
 * @property {{kind: string, id: string}} [actor] who asks. A device without allow_private never gets a private memory, see subjects/private.js. Left out, nothing is hidden.
 */

/**
 * @param {{DB: any, AI: any, VECTORIZE: any, RECALL_MIN_SIM?: string, SUBJECTS?: string}} env with SUBJECTS "on" the reply also has subjects, the cards the relevant results are about
 * @param {RecallParams} params
 * @param {() => number} now
 * @returns {Promise<{query: string, results: any[], subjects?: any[], degraded?: string}>}
 */
export async function recall(env, params, now) {
  const query = cleanQuery(params.query);
  const none = env.SUBJECTS === "on" ? { subjects: [] } : {};
  if (!query) return { query, results: [], ...none };
  const filters = { ...params, project: params.project ?? null, excludeIds: params.excludeIds ?? [], tags: params.tags ?? [] };
  let degraded;
  const timings = {};
  const t0 = now();
  const [dense, { hits: keyword, words }] = await Promise.all([
    vectorSearch(env, query, (step) => (timings[step] = now() - t0)).catch(() => {
      console.error("vector search failed");
      degraded = "vector";
      return [];
    }),
    keywordSearch(env.DB, query, { limit: CANDIDATES }).then((k) => ((timings.keyword = now() - t0), k)),
  ]);
  const tSearched = now();
  const merged = fuse(dense, keyword);
  if (!merged.size) return { query, results: [], ...none, ...(degraded ? { degraded } : {}) };

  // Hidden memories go before ranking, so top_k is still filled and the relevance of the others does not change.
  const rows = await visibleOnly(env.DB, await load(env.DB, [...merged.keys()], filters), params.actor);
  timings.load = now() - tSearched;
  const at = now();
  const cutoff = minSimilarity(env);
  const rerankCutoff = minRerank(env);
  const ranked = rows
    .map((row) => {
      const hit = merged.get(row.id);
      const onProbation = row.origin === "capture" && row.probation_until !== null && row.probation_until > at;
      return { row, hit, score: hit.rrf * (onProbation ? PROBATION_FACTOR : 1) };
    })
    .sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));
  const returned = ranked.slice(0, Math.min(params.topK ?? DEFAULT_TOP_K, MAX_TOP_K));

  // The reranker only scores, it does not reorder. Reordering by it lost on the benchmark, scoring relevance with it won.
  // It runs while the full text of the returned memories is read.
  const tLoaded = now();
  const [rerank, full] = await Promise.all([
    env.RERANK === "0" ? new Map() : rerankHits(env, query, ranked.slice(0, RERANK_TOP).map((r) => r.row)),
    loadFull(env.DB, returned.map((r) => r.row.id)),
  ]);
  timings.rerank = now() - tLoaded;
  const results = returned.map(({ row, hit, score }, position) => {
    const checks = ruleChecks({ similarity: hit.similarity, rerank: rerank.get(row.id) ?? null, terms: hit.terms, query, cutoff, rerankCutoff, position, denseRank: hit.denseRank, keywordRank: hit.keywordRank, coverage: hit.coverage, words });
    return {
      ...entryOf(row, full),
      score: round(score, 6),
      similarity: round(hit.similarity, 4),
      ...(rerank.has(row.id) ? { rerank: round(rerank.get(row.id), 4) } : {}),
      relevant: checks.some((c) => c.met),
      ...(params.explain
        ? { why: { dense_score: round(hit.similarity, 4), dense_rank: hit.denseRank, keyword_rank: hit.keywordRank, coverage: round(hit.coverage, 3), query_words: words, keyword_terms: hit.terms.map((t) => ({ term: t.term, level: t.level, idf: round(t.idf, 2) })), ...(params.checks ? { checks } : {}) } }
        : {}),
    };
  });
  const subjects = env.SUBJECTS === "on" ? await subjectsFor(env.DB, results, params.actor) : undefined;
  return { query, results, ...(subjects ? { subjects } : {}), timings, ...(degraded ? { degraded } : {}) };
}

/** The display name of a card. The card's description is "<kind> card for <name>". */
const nameOf = (row) => (row.description.startsWith(`${row.kind} card for `) ? row.description.slice(`${row.kind} card for `.length) : row.slug);

/** The subject as recall shows it. brief is the text of the card memory. */
const subjectOf = (row) => ({ id: row.id, slug: row.slug, name: nameOf(row), kind: row.kind, brief: row.body.trim(), fields: JSON.parse(row.fields) });

// A subject card as a row: the subject, its card memory, and for a device without allow_private only a shared subject.
const CARD = "SELECT s.id, s.slug, s.kind, s.fields, m.description, m.body FROM subjects s JOIN memories m ON m.id = s.id WHERE m.deleted_at IS NULL";
const sharedOnly = (actor) => (mayBeRestricted(actor) ? { sql: ` AND (s.scope <> 'private' OR ${SEES_PRIVATE_SQL})`, args: [actor.id] } : { sql: "", args: [] });

/**
 * The cards of the active or stale subjects that the relevant results are about, the best result's subject first, at most MAX_SUBJECTS.
 * One query, after ranking. Showing a card is not a recall of it, so nothing is counted.
 * @returns {Promise<any[]>} empty when nothing relevant is about a subject
 */
async function subjectsFor(db, results, actor) {
  const via = results.filter((r) => r.relevant).map((r) => r.id);
  if (!via.length) return [];
  const gate = sharedOnly(actor);
  const { results: rows } = await db
    .prepare(`SELECT c.*, l.source_id AS via FROM (${CARD} AND s.status IN ('active', 'stale')${gate.sql}) c JOIN links l ON l.target_id = c.id AND l.link_type = 'about' WHERE l.source_id IN (SELECT value FROM json_each(?))`)
    .bind(...gate.args, JSON.stringify(via))
    .all();
  const found = new Map();
  for (const row of rows) found.set(row.id, { row, via: [...(found.get(row.id)?.via ?? []), row.via] });
  const rank = (entry) => Math.min(...entry.via.map((id) => via.indexOf(id)));
  return [...found.values()]
    .sort((a, b) => rank(a) - rank(b) || b.via.length - a.via.length || (a.row.id < b.row.id ? -1 : 1))
    .slice(0, MAX_SUBJECTS)
    .map(({ row, via: ids }) => ({ ...subjectOf(row), via: ids.sort((a, b) => via.indexOf(a) - via.indexOf(b)) }));
}

/**
 * The memories that are about one subject, newest first, at most topK, and no scores because nothing was ranked. A private subject is
 * not found for a device without allow_private. Its members are then all visible, since each has an about link to a subject the device can see.
 * @returns {Promise<{subject: any, results: any[]} | null>} null when there is no such subject for this caller
 */
export async function recallSubject(env, { slug, topK, actor }) {
  const gate = sharedOnly(actor);
  const card = await env.DB.prepare(`${CARD} AND s.status <> 'proposed' AND m.status <> 'pending' AND s.slug = ?${gate.sql}`).bind(slug, ...gate.args).first();
  if (!card) return null;
  const { results: rows } = await env.DB
    .prepare("SELECT m.id, m.name, m.description, m.type, m.status, m.origin, m.harness, m.project, m.created_at, m.updated_at FROM memories m WHERE m.deleted_at IS NULL AND m.valid_until IS NULL AND m.status <> 'pending' AND m.id IN (SELECT source_id FROM links WHERE target_id = ? AND link_type = 'about') ORDER BY m.updated_at DESC, m.id DESC LIMIT ?")
    .bind(card.id, Math.min(topK ?? DEFAULT_TOP_K, MAX_TOP_K))
    .all();
  const visible = await visibleOnly(env.DB, rows, actor);
  const full = await loadFull(env.DB, visible.map((r) => r.id));
  return { subject: subjectOf(card), results: visible.map((row) => entryOf(row, full)) };
}
