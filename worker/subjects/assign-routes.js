// GET /admin/subjects/assign-preview. Shows the links assignment WOULD make for recent memories, and writes nothing.
// It works whatever SUBJECTS and SUBJECTS_AUTO say, so a person can see what switching them on would do before doing it.
// A page is small because each memory costs about eight subrequests (four to find its neighbours, one to drop cards, three
// to decide), and a request may make 50 on the free plan.
import { badRequest, intParam, json } from "../http.js";
import { findNeighbours } from "../write/neighbours.js";
import { LIVE } from "../system.js";
import { assignMemory, withoutCards } from "./assign.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const PAGE_DEFAULT = 3;
export const PAGE_MAX = 4;
const SNIPPET_CHARS = 160;
const ORIGINS = ["capture", "explicit"];
const CURSOR = /^(\d{1,16}):([\w-]{1,64})$/;

const snippetOf = (body) => {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
};

/**
 * GET /admin/subjects/assign-preview?days=7&cursor=&limit=3
 * Pages through live captured and explicit memories made in the last days, newest first. Reply: {ok, days, limit, memories: [{id, name,
 * snippet, links: [{slug, confidence, how}], ambiguous, skipped}], next_cursor}. A memory that is already linked to a
 * subject shows only the links it does not have yet.
 */
export async function assignPreview({ env, url, now, memoryIds }) {
  const days = intParam(url, "days", { min: 1, max: 365, fallback: 7 });
  // A larger limit is cut to a page the request can afford, so a caller that asks for 50 gets PAGE_MAX and a cursor.
  const limit = Math.min(intParam(url, "limit", { min: 1, max: 1000, fallback: PAGE_DEFAULT }), PAGE_MAX);
  const raw = url.searchParams.get("cursor");
  const cursor = raw ? CURSOR.exec(raw) : null;
  if (raw && !cursor) throw badRequest("cursor is not one this route gave out.");
  const since = now() - days * DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, name, description, body, project, created_at FROM memories
     WHERE ${LIVE} AND origin IN (${ORIGINS.map(() => "?").join(", ")}) AND created_at >= ?${cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...ORIGINS, since, ...(cursor ? [Number(cursor[1]), Number(cursor[1]), cursor[2]] : []), limit + 1).all();
  const page = results.slice(0, limit);

  const memories = [];
  for (const m of page) {
    const entry = { id: m.id, name: m.name, snippet: snippetOf(m.body || m.description), links: [], ambiguous: [], skipped: null };
    try {
      // The memory is in the index already, so it is its own nearest neighbour. assignMemory leaves it out.
      const found = await findNeighbours(env, { name: m.name, description: m.description, body: m.body, content: [m.description, m.body].join("\n") }, now, 10, m.project ?? "");
      const neighbours = await withoutCards(env, found.filter((n) => n.id !== m.id));
      const result = await assignMemory(env, { id: m.id, content: [m.description, m.body].filter(Boolean).join("\n"), neighbours, origin: "capture", now, dry: true });
      entry.links = result.links.map((l) => ({ slug: l.slug, confidence: l.confidence, how: l.how }));
      entry.ambiguous = result.ambiguous;
      entry.skipped = result.skipped;
    } catch {
      entry.skipped = "error";
    }
    memories.push(entry);
  }
  memoryIds.push(...page.map((m) => m.id));
  const last = page.at(-1);
  return json({ ok: true, days, limit, memories, next_cursor: results.length > limit ? `${last.created_at}:${last.id}` : null });
}
