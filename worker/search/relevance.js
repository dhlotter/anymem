// Decides whether a hit is close enough to inject into a prompt. The same rule the client applied (client/hm/relevance.py).
//
// A hit is relevant when the reranker scores it at or above its cutoff and its best chunk is not far in meaning (support), or
// the reranker gives a lower score and the hit is close in meaning and near the top of the meaning search, or its best chunk
// is close in meaning (cosine at or above the cutoff), or it matched rare words by name, which means two of them or one that reads as a
// name or identifier in the prompt. One plain rare word is not enough. The reranker alone let generic questions through, it
// scores "how do I rename a branch in git" 0.83 against a note about branch switching. The first hit is also relevant when both searches put it in their top three and the
// words it matched in its name or description add up to a rare match (agreement). A short query that names one rare thing,
// an identifier or a capitalised name, is relevant when a top keyword hit holds it and covers most of the query (lookup).
// Coverage is the share of the idf of all query words that a hit matched. Cutoffs were tuned on the benchmark sets and the
// 100 real prompts and checked on prompts that should inject nothing, see ARCHITECTURE.md.

export const DEFAULT_MIN_SIM = 0.75;
export const DEFAULT_MIN_RERANK = 0.2;
export const SUPPORT_SIM = 0.6; // a reranker score at its cutoff counts only when the cosine is at least this
export const LOW_RERANK = 0.05; // a lower reranker score counts when the cosine and the dense rank below agree
export const LOW_RERANK_SIM = 0.66;
export const LOW_RERANK_DENSE_RANK = 3;
export const RARE_IDF = 5;
export const NAME_IDF = 6; // a lone name like word must be rarer still, it matched only one memory
export const AGREE_RANK = 3; // both searches must rank the first hit this high
export const AGREE_IDF = 6.5; // the idf of the words it matched in its name or description must add up to this
export const LOOKUP_WORDS = 3; // a lookup query has at most this many words
export const LOOKUP_PLACES = 3; // and the hit is among the first three of the reply
export const LOOKUP_KEYWORD_RANK = 2; // and in the top two of the keyword search
export const LOOKUP_COVERAGE = 0.6; // and it matched this share of the idf of the query words

/** The cutoff from the RECALL_MIN_SIM setting, or the default when it is missing or not a number from 0 to 1. */
export function minSimilarity(env) {
  const raw = env?.RECALL_MIN_SIM;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MIN_SIM;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_SIM;
}

/** The cutoff from the RERANK_MIN setting, or the default. */
export function minRerank(env) {
  const raw = env?.RERANK_MIN;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MIN_RERANK;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_RERANK;
}

/** The words a hit matched in its name or description that are rare in the store. */
export const rareTerms = (terms, idf = RARE_IDF) => terms.filter((t) => t.level === 2 && t.idf >= idf).map((t) => t.term);

/**
 * True when the rare word reads as a name or identifier in the prompt: capitalised after the first word, or containing a
 * digit, underscore, hyphen or dot, or camel case. Words are stemmed, so a word and a prompt word match on their shared start.
 */
export function looksLikeName(term, query) {
  const t = term.toLowerCase();
  if (!t || !query) return false;
  for (const m of query.matchAll(/[A-Za-z0-9_.-]+/g)) {
    const tok = m[0];
    const low = tok.toLowerCase();
    if (!(low.startsWith(t.slice(0, Math.max(4, t.length - 2))) || t.startsWith(low.slice(0, Math.max(4, low.length - 2))))) continue;
    if (/[0-9_.-]/.test(tok) || /[a-z][A-Z]/.test(tok) || (/[A-Z]/.test(tok[0]) && m.index > 0)) return true;
  }
  return false;
}

/** True for the first hit when the meaning search and the keyword search both rank it in their top three and its name and description matched enough rare words. */
export function agreed({ position, denseRank, keywordRank, terms }) {
  if (position !== 0 || !denseRank || !keywordRank || denseRank > AGREE_RANK || keywordRank > AGREE_RANK) return false;
  return terms.filter((t) => t.level === 2).reduce((sum, t) => sum + t.idf, 0) >= AGREE_IDF;
}

/**
 * True when the word, stemmed, sits inside a token of the query that reads as a name or identifier. That is a token with
 * a digit, underscore, hyphen or dot inside it, or camel case, or one that is capitalised after the first word.
 */
export function inNameToken(term, query) {
  for (const m of query.matchAll(/[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/g)) {
    const tok = m[0];
    if (!tok.toLowerCase().includes(term)) continue;
    if (/[0-9_.-]/.test(tok) || /[a-z][A-Z]/.test(tok) || (/[A-Z]/.test(tok[0]) && m.index > 0)) return true;
  }
  return false;
}

/** True when a short query names one rare thing, a top keyword hit holds it, and the hit covers most of the query. */
export function lookedUp({ position, keywordRank, terms, coverage, words, query }) {
  if (!words || words > LOOKUP_WORDS || position < 0 || position >= LOOKUP_PLACES || !keywordRank || keywordRank > LOOKUP_KEYWORD_RANK || coverage < LOOKUP_COVERAGE) return false;
  return terms.some((t) => t.idf >= RARE_IDF && inNameToken(t.term, query));
}

const num = (n) => (n === null || n === undefined ? "none" : String(n));

/**
 * Every rule of the relevance test, whether it held for this hit and a plain sentence saying why. A hit is relevant when any rule held.
 * position is the place of the hit in the reply, 0 for the first.
 * @param {{similarity: number | null, rerank?: number | null, terms: {term: string, level: number, idf: number}[], query: string, cutoff: number, rerankCutoff?: number, position?: number, denseRank?: number | null, keywordRank?: number | null, coverage?: number, words?: number}} hit
 * @returns {{rule: string, met: boolean, detail: string}[]}
 */
export function ruleChecks({ similarity, rerank = null, terms, query, cutoff, rerankCutoff = DEFAULT_MIN_RERANK, position = -1, denseRank = null, keywordRank = null, coverage = 0, words = 0 }) {
  const scored = rerank !== null && similarity !== null;
  const rare = rareTerms(terms);
  const nameWords = rareTerms(terms, NAME_IDF).filter((term) => looksLikeName(term, query));
  return [
    {
      rule: "reranker_supported",
      met: scored && rerank >= rerankCutoff && similarity >= SUPPORT_SIM,
      detail: `The reranker scored it ${num(rerank)} and it needs ${rerankCutoff}, with a closeness of ${num(similarity)} that needs ${SUPPORT_SIM}.`,
    },
    {
      rule: "reranker_low_close",
      met: scored && rerank >= LOW_RERANK && similarity >= LOW_RERANK_SIM && denseRank !== null && denseRank <= LOW_RERANK_DENSE_RANK,
      detail: `A low reranker score of ${LOW_RERANK} or more counts when the closeness is ${LOW_RERANK_SIM} or more and the meaning search ranks it ${LOW_RERANK_DENSE_RANK} or better. Here the score is ${num(rerank)}, the closeness ${num(similarity)} and the rank ${num(denseRank)}.`,
    },
    {
      rule: "close_in_meaning",
      met: similarity !== null && similarity >= cutoff,
      detail: `Its closeness in meaning is ${num(similarity)} and it needs ${cutoff}.`,
    },
    {
      rule: "agreement",
      met: agreed({ position, denseRank, keywordRank, terms }),
      detail: `The first hit counts when both searches rank it ${AGREE_RANK} or better and its name and description matched rare words worth ${AGREE_IDF} or more. Here the meaning rank is ${num(denseRank)} and the keyword rank ${num(keywordRank)}.`,
    },
    {
      rule: "lookup",
      met: lookedUp({ position, keywordRank, terms, coverage, words, query }),
      detail: `A short prompt of ${LOOKUP_WORDS} words or fewer that names one identifier counts when the hit leads the keyword search and covers ${Math.round(LOOKUP_COVERAGE * 100)} percent of the words. Here the prompt has ${words} words and coverage is ${coverage}.`,
    },
    {
      rule: "two_rare_words",
      met: rare.length >= 2,
      detail: `Two rare words in the name or description count. It matched ${rare.length}${rare.length ? ` (${rare.join(", ")})` : ""}.`,
    },
    {
      rule: "name_word",
      met: nameWords.length > 0,
      detail: `One very rare word that reads as a name in the prompt counts. It matched ${nameWords.length ? nameWords.join(", ") : "none"}.`,
    },
  ];
}

/** True when any rule of ruleChecks holds. @returns {boolean} */
export function isRelevant(hit) {
  return ruleChecks(hit).some((c) => c.met);
}
