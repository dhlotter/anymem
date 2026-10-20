// Keyword search over memory_fts, weighted by how rare each word is in the store.
//
// The table uses the trigram tokenizer, so a quoted word matches anywhere inside a longer word ("deploy" finds "deployment").
// The vocabulary table of a trigram index lists trigrams, not words, so a word's document frequency is counted here with
// one query per word instead.

const MIN_TERM_CHARS = 3;
const MAX_TERMS = 16;
const MAX_MATCHES = 1000;
const CHECKED = 12; // how many of the best hits are read again to check each match
const NOT_A_WORD = 0.5; // a match inside a longer word (R84 inside B07ACR84189) counts for half
const SAME_CASE = 1.5; // a match in the case the person typed counts one and a half times

const STOPWORDS = new Set(
  `the and for are but not you all any can had her was one our out has have him his how its let may new now old see she too two use way who why did get got said than that them then they this those was what when where which while will with would your about above after again also been before being below between both could does doing down during each from further here into just more most much must myself other over same should some such their there these through under until very were because only off once own than yet whom does don did isn aren wasn weren won wouldn couldn shouldn hasn haven hadn didn doesn`.split(/\s+/),
);

/** A light stem, so "deployed" and "deploying" both look for "deploy". Stems keep at least four letters. */
export function stem(word) {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es"]) if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * The words of a query worth searching for: lowercase, stemmed, no stop words, no word under three letters, no repeats.
 * @param {string} query
 * @returns {string[]}
 */
export function queryTerms(query) {
  return queryTokens(query).map((t) => t.term);
}

/** The same words as queryTerms, each with the word as it was typed, so the case can be compared later. */
function queryTokens(query) {
  const tokens = [];
  for (const typed of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const raw = typed.toLowerCase();
    if (raw.length < MIN_TERM_CHARS || STOPWORDS.has(raw)) continue;
    const term = stem(raw);
    if (!tokens.some((t) => t.term === term)) tokens.push({ term, typed });
  }
  return tokens.slice(0, MAX_TERMS);
}

/** True when the term stands as a word in the text. A term with a digit must not run into more letters or digits. */
function isWord(term, text) {
  const tail = /\d/.test(term) ? "(?![\\p{L}\\p{N}])" : "(?!\\p{N})";
  return new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${tail}`, "iu").test(text);
}

/** Inverse document frequency, high for a word found in few memories. */
export const idf = (total, df) => Math.log(1 + (total - df + 0.5) / (df + 0.5));

/**
 * Search the keyword index. A memory scores the sum over its matched words of idf times the level, where the level is 2
 * for a hit in the name or description and 1 for a hit in the body or the extra keys.
 * Each hit also carries its coverage, the share of the idf of all the query words that the hit matched. A word found in
 * no memory still counts, with the idf it would have in one, so a hit that matches one word of a query full of unknown
 * words has a low coverage. The reply gives the number of query words too.
 * @param {any} db
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{hits: {id: string, score: number, coverage: number, terms: {term: string, level: 1 | 2, idf: number}[]}[], words: number}>} hits best first
 */
export async function keywordSearch(db, query, { limit = 50 } = {}) {
  const tokens = queryTokens(query);
  const terms = tokens.map((t) => t.term);
  if (!terms.length) return { hits: [], words: 0 };
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  // The document frequency is a COUNT, so it is exact. The id lists are capped for the scoring only, and a COUNT returns
  // one row where the id list returned up to MAX_MATCHES. Before, the cap also stood in for the frequency, which skewed idf.
  const count = "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?";
  const sql = "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?";
  const [total, ...rest] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL"),
    ...quoted.flatMap((q) => [db.prepare(count).bind(q), db.prepare(sql).bind(q, MAX_MATCHES), db.prepare(sql).bind(`{name description} : ${q}`, MAX_MATCHES)]),
  ]);
  const n = total.results[0].n;
  const byMemory = new Map();
  let idfTotal = 0;
  terms.forEach((term, i) => {
    const anywhere = rest[i * 3 + 1].results.map((r) => r.memory_id);
    const weight = idf(n, rest[i * 3].results[0].n);
    idfTotal += weight;
    if (!anywhere.length) return;
    const named = new Set(rest[i * 3 + 2].results.map((r) => r.memory_id));
    for (const id of anywhere) {
      const hit = byMemory.get(id) ?? { id, score: 0, terms: [] };
      const level = named.has(id) ? 2 : 1;
      hit.score += weight * level;
      hit.terms.push({ term, level, idf: weight });
      byMemory.set(id, hit);
    }
  });
  const byScore = (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1);
  const hits = [...byMemory.values()].sort(byScore);
  await checkMatches(db, hits.slice(0, CHECKED), tokens);
  for (const hit of hits) hit.coverage = hit.terms.reduce((sum, t) => sum + t.idf, 0) / idfTotal;
  return { hits: hits.sort(byScore).slice(0, limit), words: terms.length };
}

/**
 * Reads the best hits again and rescales the score of each word. The trigram index matches inside words and ignores case,
 * so a word found only inside a longer word counts for less, and a match in the case the person typed counts for more.
 */
async function checkMatches(db, hits, tokens) {
  if (!hits.length) return;
  const { results } = await db
    .prepare(
      `SELECT id, name || ' ' || description || ' ' || body || ' ' || COALESCE((SELECT group_concat(text, ' ') FROM memory_keys WHERE memory_id = memories.id AND key_type = 'question'), '') AS text
       FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(hits.map((h) => h.id)))
    .all();
  const text = new Map(results.map((r) => [r.id, r.text]));
  for (const hit of hits) {
    const body = text.get(hit.id) ?? "";
    for (const t of hit.terms) {
      const typed = tokens.find((k) => k.term === t.term).typed;
      const factor = (isWord(t.term, body) ? 1 : NOT_A_WORD) * (/\p{Lu}/u.test(typed) && body.includes(typed) ? SAME_CASE : 1);
      hit.score += t.idf * t.level * (factor - 1);
    }
  }
}
