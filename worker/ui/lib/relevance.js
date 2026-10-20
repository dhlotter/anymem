// How a recall hit is shown. The rules live in worker/search/relevance.js, which is the source of truth. The Worker sends each
// rule and whether it held (why.checks, asked for with checks=1), so this file only reads them.
export const RARE_IDF = 5; // a word this rare counts as a rare word
export const INJECT_LIMIT = 3; // a prompt gets at most this many relevant hits (TOP_K in hooks/memory_recall.py)
const BODY_CHARS = 320; // how much of a body the hook puts in a line
const BUDGET = 1800; // the most characters the hook adds to a prompt

/** The rare words a hit matched, from the explain object. */
export function rareWords(hit) {
  const terms = hit?.why?.keyword_terms;
  return Array.isArray(terms) ? terms.filter((t) => t.level === 2 && t.idf >= RARE_IDF).map((t) => t.term) : [];
}

/** True closeness: the raw cosine similarity of the best chunk, three decimals, or "none" when only keywords matched. */
export function closeness(hit) {
  return typeof hit?.similarity === "number" ? hit.similarity.toFixed(3) : "none";
}

/** Which of the two searches found a hit, and how high each ranked it. */
export function arms(hit) {
  const why = hit?.why ?? {};
  const out = [];
  if (Number.isInteger(why.dense_rank)) out.push({ arm: "meaning", rank: why.dense_rank });
  if (Number.isInteger(why.keyword_rank)) out.push({ arm: "keyword", rank: why.keyword_rank });
  return out;
}

/** The rules that held and the rules that did not, as the Worker listed them. Empty when the Worker sent none. */
export function ruleSplit(hit) {
  const checks = Array.isArray(hit?.why?.checks) ? hit.why.checks : [];
  return { held: checks.filter((c) => c.met), missed: checks.filter((c) => !c.met) };
}

/** The plain name of a rule. */
export const RULE_NAMES = {
  reranker_supported: "Reranker and closeness agree",
  reranker_low_close: "Low reranker score, close and ranked high",
  close_in_meaning: "Close in meaning",
  agreement: "Both searches agree on the first hit",
  lookup: "Short prompt that names one identifier",
  two_rare_words: "Two rare words",
  name_word: "A rare word that reads as a name",
};

const reserved = (e) => (e.tags ?? []).some((t) => t.startsWith("capsule:") || t.startsWith("capsule-slot:")) || e.status === "pending";

/** A global memory is in scope everywhere. A project memory only in its own project, and with no project none of them, as in the hook's in_scope. */
const inScope = (hit, project = "") => !hit?.project || hit.project === String(project ?? "").trim().toLowerCase();

/** The hits a prompt would actually get. Capsule memories and pending ones are never injected, whatever their score, and neither is a project memory out of its project. */
export const injectedHits = (results, project = "") => (Array.isArray(results) ? results.filter((r) => r.relevant && !reserved(r) && inScope(r, project)).slice(0, INJECT_LIMIT) : []);

/** Why a relevant hit was still left out of the prompt, or empty text. */
export const heldBack = (hit, project = "") => (!hit?.relevant ? "" : (hit.tags ?? []).some((t) => t.startsWith("capsule:") || t.startsWith("capsule-slot:")) ? "It is a capsule memory, which starts every session anyway." : hit.status === "pending" ? "It is still pending, so it is never injected." : inScope(hit, project) ? "" : `It belongs to project ${hit.project}, so the hook adds it only inside that project.`);

/** The name, description and opening of the body, the way the hook reads a memory. */
export function parseEntry(e) {
  const content = String(e.content ?? "").trimStart();
  const m = /^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content);
  const head = m ? m[1] : "";
  const body = m ? m[2] : content;
  const name = /^name:\s*(.+)$/m.exec(head)?.[1].trim().replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m.exec(head)?.[1].trim().replace(/^["']|["']$/g, "");
  return { name: name || String(e.id ?? "").slice(0, 8), description: description ?? "", body: body.split(/\s+/).filter(Boolean).join(" ").slice(0, BODY_CHARS) };
}

/** The block the recall hook adds to a prompt. Empty text when nothing would be added. */
export function injectedText(hits) {
  const lines = ["## Relevant memories (anymem, recalled for this prompt)", "Context only, check it against the prompt. Fuller detail: the anymem skill's recall script."];
  let used = lines.reduce((n, l) => n + l.length, 0);
  for (const hit of hits) {
    const it = parseEntry(hit);
    const line = `- ${it.name}: ${it.description} ${it.body}`.trim();
    if (used + line.length > BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

const FORMAT = /^\W*(?:please\s+)?(?:answer|reply|respond|say\s+(?:none|nothing|so)|keep\s+(?:it|the answer|your)|be\s+(?:brief|concise|short)|do\s+not\s+use|don'?t\s+use|use\s+(?:bullet|plain|only|the\s+(?:memories|context))|explain\s+(?:briefly|in\s+(?:one|two|simple))|in\s+(?:one|two|three)\s+(?:sentence|word|line)|one\s+(?:sentence|line|word)|if\s+(?:there\s+is|nothing|none|no\s+)|from\s+the\s+(?:memories|context)|only\s+use|no\s+markdown|limit\s+(?:it|your)|under\s+\w+\s+words)/i;
const QUERY_CHARS = 240;

/**
 * What the recall hook would search for, a port of clean_query in hooks/memory_recall.py. Null with a reason when the hook would not search at all.
 * @returns {{query: string} | {query: null, reason: string}}
 */
export function hookQuery(prompt) {
  const text = String(prompt ?? "").replace(/```[\s\S]*?```/g, " ").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").split(/\s+/).filter(Boolean).join(" ");
  if (text.length < 20) return { query: null, reason: "The hook skips a prompt under 20 characters, so it would not search at all." };
  if (text.startsWith("/")) return { query: null, reason: "The hook skips a prompt that starts with a slash, so it would not search at all." };
  const kept = text.split(/(?<=[.?!])\s+/).filter((part) => !FORMAT.test(part));
  const q = (kept.length ? kept.join(" ") : text).slice(0, QUERY_CHARS);
  if (q.length < 12) return { query: null, reason: "Too little is left of this prompt once the formatting instructions go, so the hook would not search." };
  return { query: q };
}
