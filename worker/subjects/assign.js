// Assignment: which subjects a memory belongs to. It only decides, it never writes. after.js writes the links.
//
// Two signals, both cheap and both explainable:
//  1. alias    the slug, the name or an alias of an active or stale subject appears in the text as a whole word or phrase.
//  2. vote     at least 3 of the 5 nearest memories are members of one subject and the nearest of them is close enough.
// An alias match is certain (confidence 1.0) and beats a vote for the same subject. Nothing under 0.5 is linked.
//
// Budget: one read for the candidate subjects, one for the neighbours' memberships, one for the pairs already linked or
// rejected. At most 3 reads, and the 4th call of the whole step is the write batch in after.js.
import { SEES_PRIVATE_SQL } from "./private.js";

export const MIN_ALIAS_CHARS = 3;
export const VOTE_WINDOW = 5;
export const MIN_VOTES = 3;
export const MIN_VOTE_SIMILARITY = 0.6;
export const CONFIDENCE_FLOOR = 0.5;
/** A memory that belongs to more subjects than this is noise, so the best ones are kept. It also keeps the write step inside its budget. */
export const MAX_LINKS = 3;
const MAX_TEXT_CHARS = 4000;
const MAX_SUBJECTS = 2000;
const NOT_ASSIGNED_ORIGINS = ["profile", "person", "system"];
const WORD = /[\p{L}\p{N}_]/u;

const round2 = (n) => Math.round(n * 100) / 100;
const fold = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The display name sits in the card's description after "<kind> card for ". A hand edited card falls back to the slug. */
const nameOf = (row) => (row.description.startsWith(`${row.kind} card for `) ? row.description.slice(`${row.kind} card for `.length) : row.slug);

/** True when term appears in text with no letter, digit or underscore next to it. Both are already folded. */
function hasWord(text, term) {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + term.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

/** The folded words a subject answers to: its slug (also with spaces for dashes), its name and its aliases. Short ones never match. */
function termsOf(row) {
  const raw = [row.slug, row.slug.replaceAll("-", " "), nameOf(row), ...JSON.parse(row.aliases)];
  return [...new Set(raw.map(fold).filter((t) => t.length >= MIN_ALIAS_CHARS))];
}

/**
 * @typedef {object} Assignment
 * @property {{subject_id: string, slug: string, confidence: number, how: "alias" | "vote"}[]} links best first, at most MAX_LINKS
 * @property {string[]} ambiguous slugs of subjects that tied on an alias another subject has too, and so were not linked
 * @property {string[]} ambiguous_ids the card ids of the same subjects, in the same order
 * @property {string | null} skipped why nothing was tried, or null
 */

/**
 * Decide the subjects of one memory. Reads only. dry is accepted so a caller can say it in the call, the result is the same.
 * A device that may not see private subjects (actor) is never given one, so a capture cannot find out that a private
 * subject exists by seeing its own memory disappear. The neighbours must already be cut to the ones the writer may see.
 * @param {{DB: any}} env
 * @param {{id: string, content: string, neighbours?: {id: string, similarity: number}[], origin?: string | null, actor?: {kind: string, id: string}, now?: () => number, dry?: boolean}} f
 * @returns {Promise<Assignment>}
 */
export async function assignMemory(env, { id, content, neighbours = [], origin = null, actor }) {
  const out = { links: [], ambiguous: [], ambiguous_ids: [], skipped: null };
  if (origin && NOT_ASSIGNED_ORIGINS.includes(origin)) return { ...out, skipped: "origin" };
  const text = fold(String(content ?? "").slice(0, MAX_TEXT_CHARS));
  if (!text && !neighbours.length) return { ...out, skipped: "no_text" };

  // 1. The candidates. A device without allow_private never gets a private subject.
  const closed = actor?.kind === "device";
  const { results: rows } = await env.DB.prepare(
    `SELECT s.id, s.slug, s.kind, s.scope, s.aliases, m.description FROM subjects s JOIN memories m ON m.id = s.id
     WHERE s.status IN ('active', 'stale') AND m.deleted_at IS NULL${closed ? ` AND (s.scope = 'shared' OR ${SEES_PRIVATE_SQL})` : ""} ORDER BY s.id LIMIT ${MAX_SUBJECTS}`,
  ).bind(...(closed ? [actor.id] : [])).all();
  if (!rows.length) return { ...out, skipped: "no_subjects" };
  const subjects = new Map(rows.map((r) => [r.id, r]));
  if (subjects.has(id)) return { ...out, skipped: "card" };

  // 2. Alias match. A term that two subjects share ties them, and the tie is settled only by a term only one of them has.
  const holders = new Map();
  const matched = new Map(); // subject id to the terms of it that appear in the text
  if (text) {
    for (const r of rows) {
      for (const term of termsOf(r)) {
        if (!hasWord(text, term)) continue;
        if (!matched.has(r.id)) matched.set(r.id, new Set());
        matched.get(r.id).add(term);
        if (!holders.has(term)) holders.set(term, new Set());
        holders.get(term).add(r.id);
      }
    }
  }
  const candidates = new Map(); // subject id to {confidence, how}
  const tied = new Set();
  for (const [sid, terms] of matched) {
    const alone = [...terms].some((t) => holders.get(t).size === 1);
    if (alone) candidates.set(sid, { confidence: 1, how: "alias" });
    else tied.add(sid);
  }

  // 3. Neighbour vote, for subjects that are neither matched by alias nor tied.
  const near = neighbours.filter((n) => n.id !== id).slice(0, VOTE_WINDOW);
  if (near.length >= MIN_VOTES) {
    const { results: member } = await env.DB.prepare("SELECT source_id, target_id FROM links WHERE link_type = 'about' AND source_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(near.map((n) => n.id))).all();
    const votes = new Map(); // subject id to {n, best}
    for (const n of near) {
      for (const m of member) {
        if (m.source_id !== n.id || !subjects.has(m.target_id)) continue;
        const v = votes.get(m.target_id) ?? { n: 0, best: 0 };
        votes.set(m.target_id, { n: v.n + 1, best: Math.max(v.best, n.similarity) });
      }
    }
    for (const [sid, v] of votes) {
      if (candidates.has(sid) || tied.has(sid) || v.n < MIN_VOTES || v.best < MIN_VOTE_SIMILARITY) continue;
      const confidence = round2((v.n / VOTE_WINDOW) * v.best);
      if (confidence >= CONFIDENCE_FLOOR) candidates.set(sid, { confidence, how: "vote" });
    }
  }
  if (!candidates.size && !tied.size) return out;

  // 4. Pairs that are already linked, and pairs a person said no to.
  const { results: known } = await env.DB.prepare(
    "SELECT l.target_id AS target_id, s.scope AS scope FROM links l LEFT JOIN subjects s ON s.id = l.target_id WHERE l.source_id = ? AND l.link_type = 'about' UNION ALL SELECT target_id, 'rejected' FROM link_rejections WHERE source_id = ? AND link_type = 'about'",
  ).bind(id, id).all();
  const taken = new Set(known.map((k) => k.target_id));
  // A memory that belongs to a private subject, or is about to, stays private: a shared link would make every device able to read it,
  // because the private rule hides a memory only while it has no link to a shared subject. So it gets its private links and no others.
  const fresh = [...candidates].filter(([sid]) => !taken.has(sid));
  const keepsPrivate = known.some((k) => k.scope === "private") || fresh.some(([sid]) => subjects.get(sid).scope === "private");
  out.links = fresh
    .filter(([sid]) => !keepsPrivate || subjects.get(sid).scope === "private")
    .map(([sid, c]) => ({ subject_id: sid, slug: subjects.get(sid).slug, confidence: c.confidence, how: c.how }))
    .sort((a, b) => b.confidence - a.confidence || (a.slug < b.slug ? -1 : 1))
    .slice(0, MAX_LINKS);
  const left = [...tied].filter((sid) => !taken.has(sid)).sort((a, b) => (subjects.get(a).slug < subjects.get(b).slug ? -1 : 1));
  out.ambiguous = left.map((sid) => subjects.get(sid).slug);
  out.ambiguous_ids = left;
  return out;
}

/**
 * Drop the subject cards from a neighbour list, the way the write path does before it passes the list on. One read.
 * @param {{DB: any}} env
 * @template {{id: string}} T
 * @param {T[]} neighbours
 * @returns {Promise<T[]>}
 */
export async function withoutCards(env, neighbours) {
  if (!neighbours.length) return neighbours;
  const { results } = await env.DB.prepare("SELECT id FROM subjects WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(neighbours.map((n) => n.id))).all();
  const cards = new Set(results.map((r) => r.id));
  return cards.size ? neighbours.filter((n) => !cards.has(n.id)) : neighbours;
}
