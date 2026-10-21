// Taking a brief away at once. A brief is text a model wrote from the memories its card cites (the derived_from links). When
// one of those memories stops being allowed to feed it, the text must be gone for a device that may not see it at the moment
// that happens, not at the next nightly run. A cited memory stops being allowed when it is trashed, replaced, or joins a private
// subject (a shared card must never keep text from a private subject's member).
//
// clearCiting blanks every card that cites the memories it is given. clearIneligible finds the cards that cite a memory that is
// no longer allowed, and blanks them. The nightly step runs the second as a backup for everything the first did not see.
//
// "Blanked" means all of these in one batch: the card has no brief, its derived_from links are gone, the subject is stale with the
// reason members_changed and no build time, and every older version of the card that holds brief text is deleted, so the old
// text cannot be read through the history or an earlier version either. The questions the model wrote about the old text go too
// (rows, search text and vectors), and the card is indexed again, because its other vectors carry the old text. A pin does not protect a brief (text that must go goes), a retired subject is cleared too, and none of it
// depends on SUBJECTS_AUTO or on SUBJECTS_BRIEFS, because the text may have been built under either earlier.
import { auditStatement } from "../audit.js";
import { createStore, FTS_INSERT } from "../memory/store.js";
import { vectorIdFits } from "../search/chunk.js";
import { indexMemories } from "../search/indexer.js";
import { withBrief } from "./brief.js";

/** The stale_reason of a subject whose brief was blanked because the members it came from changed. */
export const CLEARED = "members_changed";
/** At most this many cards are blanked in one nightly pass, so the pass stays inside its budget. The next night does the rest. */
export const MAX_CLEARS = 20;
/** What blanking one card costs: the read of the card, and the one batch that writes it. Removing the question vectors and indexing come after. */
export const CLEAR_COST = 2;
// The ids of the vectors the model's questions about a card have, read with the card.
const QUESTION_VECTORS = (c) => `(SELECT json_group_array(k.vector_id) FROM memory_keys k WHERE k.memory_id = ${c} AND k.key_type = 'question' AND k.vector_id IS NOT NULL)`;

// A memory (alias) that has an about link to a private subject.
const IN_PRIVATE = (m) => `EXISTS (SELECT 1 FROM links x JOIN subjects p ON p.id = x.target_id WHERE x.source_id = ${m} AND x.link_type = 'about' AND p.scope = 'private')`;

/** The audit row of one system action on a subject. The script column keeps letters, digits and . : - only, so the check names use dots. */
export function auditRow(now, { route, ok, how, ids, started }) {
  return {
    ts: now(),
    actor: { kind: "system", id: "brief" },
    harness: "system",
    script: `how:${how}`.replace(/_/g, "."),
    method: "SYSTEM",
    route,
    status: ok ? 200 : 500,
    durationMs: now() - started,
    memoryIds: ids,
  };
}

/**
 * Blank one card in one batch. No ifUpdatedAt: a privacy clear must not lose to an edit that landed a moment before.
 * @returns {Promise<void>}
 */
async function blank(env, { now, store }, card, why, ids) {
  const started = now();
  // A card edited by hand may have lost its frontmatter. The card is then made again with the frontmatter it needs.
  const content = withBrief(card.content, "") ?? `---\nname: ${card.slug}\ndescription: ${card.description}\nmetadata:\n  type: project\n---\n\n`;
  const at = now();
  await store.update({
    id: card.id,
    content,
    reason: "brief",
    quiet: true,
    extra: [
      env.DB.prepare("DELETE FROM links WHERE source_id = ? AND link_type = 'derived_from'").bind(card.id),
      // Every earlier version whose text is not empty holds some brief, the one just replaced included (it is written in this batch, before
      // these statements). The history shows the versions that are left, and an earlier version cannot be read back to get the text.
      // The likely questions were written from the old text and are searched with it, so they go too: rows, then the search text is made again.
      env.DB.prepare("DELETE FROM memory_keys WHERE memory_id = ? AND key_type = 'question'").bind(card.id),
      env.DB.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(card.id),
      env.DB.prepare(FTS_INSERT).bind(card.id),
      env.DB.prepare("DELETE FROM memory_versions WHERE memory_id = ? AND TRIM(COALESCE(json_extract(snapshot, '$.body'), '')) <> ''").bind(card.id),
      // A retired subject keeps its status, and the change time only moves when the status does, as everywhere else.
      env.DB
        .prepare(
          `UPDATE subjects SET built_at = NULL, member_hash = '',
             stale_reason = CASE WHEN status IN ('active', 'stale') THEN ? ELSE stale_reason END,
             updated_at = CASE WHEN status = 'active' THEN ? ELSE updated_at END,
             status = CASE WHEN status IN ('active', 'stale') THEN 'stale' ELSE status END
           WHERE id = ?`,
        )
        .bind(CLEARED, at, card.id),
      auditStatement(env.DB, auditRow(now, { route: "brief.clear", ok: true, how: why, ids: [card.id, ...ids], started })),
    ],
  });
}

/**
 * Blank these cards, then bring their search keys and vectors up to date. With ctx the indexing runs after the reply, without it
 * (the nightly step) it is waited for. A card that cannot be blanked is logged and the others still are.
 * @param {{DB: any}} env
 * @param {{id: string, slug: string, description: string, content: string, qvec?: string}[]} cards
 * @param {{now: () => number, ctx?: {waitUntil: (p: Promise<any>) => void}, why: string, ids?: string[], room?: () => boolean}} f room says whether there is budget for one more card
 * @returns {Promise<string[]>} the ids of the cards that were blanked
 */
async function clearCards(env, cards, { now, ctx, why, ids = [], room = () => true }) {
  const store = createStore(env.DB, now);
  const done = [];
  for (const card of cards) {
    if (!room()) break;
    try {
      await blank(env, { now, store }, card, why, ids);
      done.push(card.id);
      // The vectors of the questions are not in the key rows any more, so nothing else would ever delete them.
      const vectors = JSON.parse(card.qvec ?? "[]").filter((v) => typeof v === "string" && vectorIdFits(v));
      if (vectors.length) await env.VECTORIZE.deleteByIds(vectors).catch(() => console.error("vector delete failed"));
    } catch (err) {
      console.error("brief clear failed", err?.name);
    }
  }
  if (done.length) {
    const index = indexMemories(env, done, now).catch(() => console.error("indexing failed"));
    if (ctx) ctx.waitUntil(index);
    else await index;
  }
  return done;
}

/**
 * Blank every card that cites one of these memories. Call it after a memory is forgotten, replaced, or linked to a private subject.
 * With sharedOnly, a private subject's card is left alone, because a private card may hold text from a private subject's members.
 * Costs one read when no card cites them.
 * @param {{DB: any}} env
 * @param {{ids: string[], now: () => number, ctx?: {waitUntil: (p: Promise<any>) => void}, sharedOnly?: boolean, why?: string, room?: () => boolean}} f
 * @returns {Promise<string[]>} the ids of the cards that were blanked
 */
export async function clearCiting(env, { ids, now, ctx, sharedOnly = false, why = "member.gone", room }) {
  const list = [...new Set(ids)].filter((id) => typeof id === "string" && id);
  if (!list.length) return [];
  const { results } = await env.DB
    .prepare(
      `SELECT DISTINCT s.id, s.slug, c.description, c.content, ${QUESTION_VECTORS("s.id")} AS qvec FROM links l JOIN subjects s ON s.id = l.source_id JOIN memories c ON c.id = s.id
       WHERE l.link_type = 'derived_from' AND l.target_id IN (SELECT value FROM json_each(?))${sharedOnly ? " AND s.scope <> 'private'" : ""} ORDER BY s.id`,
    )
    .bind(JSON.stringify(list))
    .all();
  return clearCards(env, results, { now, ctx, why, ids: list.slice(0, 5), room });
}

/**
 * Find the cards that cite a memory that may no longer feed them, and blank them. A cited memory may not feed a card when it is
 * trashed, replaced, gone, or (for a shared card) has an about link to a private subject. A memory that was only added to the
 * subject, or edited, does not count. Used by the nightly step as a backup.
 * @param {{DB: any}} env
 * With only, just that subject's card is looked at (a private subject that has become shared is the case).
 * @param {{now: () => number, room?: () => boolean, only?: string, ctx?: {waitUntil: (p: Promise<any>) => void}}} f
 * @returns {Promise<string[]>} the ids of the cards that were blanked
 */
export async function clearIneligible(env, { now, room, only, ctx }) {
  const { results } = await env.DB
    .prepare(
      `SELECT s.id, s.slug, c.description, c.content, ${QUESTION_VECTORS("s.id")} AS qvec FROM subjects s JOIN memories c ON c.id = s.id
       WHERE ${only ? "s.id = ? AND " : ""}EXISTS (SELECT 1 FROM links l LEFT JOIN memories m ON m.id = l.target_id
                     WHERE l.source_id = s.id AND l.link_type = 'derived_from'
                       AND (m.id IS NULL OR m.deleted_at IS NOT NULL OR m.valid_until IS NOT NULL OR (s.scope <> 'private' AND ${IN_PRIVATE("m.id")})))
       ORDER BY s.id LIMIT ${MAX_CLEARS}`,
    )
    .bind(...(only ? [only] : []))
    .all();
  return clearCards(env, results, { now, ctx, why: "member.gone", room });
}
