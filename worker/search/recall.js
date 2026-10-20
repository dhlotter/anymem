// Recall. Cleans the query, searches by meaning and by keyword in parallel, merges the two lists, filters, and decides
// per hit whether it is relevant. A plain recall writes nothing. The caller adds the recall count when asked.
import { harnessLabel } from "../harnesses.js";
import { memoryIdOf, memoryText } from "./chunk.js";
import { embedTexts } from "./embed.js";
import { keywordSearch } from "./fts.js";
import { cleanQuery } from "./query.js";
import { minRerank, minSimilarity, RARE_IDF, ruleChecks } from "./relevance.js";

export const RRF_K = 60;
export const RARE_BOOST = 2; // a keyword hit that holds a rare word counts double, so an exact identifier beats a vague neighbour
export const PROBATION_FACTOR = 0.95; // a captured memory still on probation ranks a few places lower
const CANDIDATES = 50;
const RERANK_TOP = 8; // scoring more than the hook can use changed nothing on the real prompts and cost time
const SNIPPET_CHARS = 1200;
const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 50;

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
 */

/**
 * @param {{DB: any, AI: any, VECTORIZE: any, RECALL_MIN_SIM?: string}} env
 * @param {RecallParams} params
 * @param {() => number} now
 * @returns {Promise<{query: string, results: any[], degraded?: string}>}
 */
export async function recall(env, params, now) {
  const query = cleanQuery(params.query);
  if (!query) return { query, results: [] };
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
  if (!merged.size) return { query, results: [], ...(degraded ? { degraded } : {}) };

  const rows = await load(env.DB, [...merged.keys()], filters);
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
      score: round(score, 6),
      similarity: round(hit.similarity, 4),
      ...(rerank.has(row.id) ? { rerank: round(rerank.get(row.id), 4) } : {}),
      relevant: checks.some((c) => c.met),
      ...(params.explain
        ? { why: { dense_score: round(hit.similarity, 4), dense_rank: hit.denseRank, keyword_rank: hit.keywordRank, coverage: round(hit.coverage, 3), query_words: words, keyword_terms: hit.terms.map((t) => ({ term: t.term, level: t.level, idf: round(t.idf, 2) })), ...(params.checks ? { checks } : {}) } }
        : {}),
    };
  });
  return { query, results, timings, ...(degraded ? { degraded } : {}) };
}
