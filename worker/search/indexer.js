// Keeps the search keys (memory_keys) and the vectors in step with the memories.
//
// A memory needs indexing when any of its keys has no vector id, or when it is not in the trash and has no keys at all.
// A memory in the trash keeps its question rows, because the model wrote them once and a restore needs them. They have no
// vector id while it is in the trash, and that alone does not make it wait.
// The store clears the vector ids in the same batch as every change to the text, the project or the trash state, so a
// stopped Worker never loses track of the work. Vectorize makes new vectors searchable about two minutes after the upsert.
import { buildKeys, vectorId, vectorIdFits } from "./chunk.js";
import { embedTexts } from "./embed.js";
import { FTS_INSERT } from "../memory/store.js";

const UPSERT_BATCH = 500;
const MAX_ATTEMPTS = 3;

/** SQL for memories (alias m) whose keys or vectors are out of date. */
export const NEEDS_INDEX = `(EXISTS (SELECT 1 FROM memory_keys k WHERE k.memory_id = m.id AND k.vector_id IS NULL AND (m.deleted_at IS NULL OR k.key_type <> 'question'))
  OR (m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM memory_keys k WHERE k.memory_id = m.id)))`;

const slices = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/** The ids, oldest first, of memories that need indexing. */
export async function pendingIds(db, limit) {
  const { results } = await db.prepare(`SELECT m.id FROM memories m WHERE ${NEEDS_INDEX} ORDER BY m.created_at, m.id LIMIT ?`).bind(limit).all();
  return results.map((r) => r.id);
}

export async function countPending(db) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${NEEDS_INDEX}`).first()).n;
}

/**
 * One pass. Loads the memories, embeds what they need, upserts the vectors, then swaps the key rows of each memory in one D1
 * batch that only applies while the memory is still the version that was embedded. Returns the ids that changed under it,
 * and the ids Vectorize refused. A refused memory is left out of the swap, so it stays marked as needing work.
 */
async function pass(env, ids, now) {
  const { results: memories } = await env.DB.prepare(
    `SELECT m.id, m.name, m.description, m.body, m.content, m.project, m.origin, m.updated_at, m.deleted_at FROM memories m
     WHERE m.id IN (SELECT value FROM json_each(?)) AND ${NEEDS_INDEX}`,
  ).bind(JSON.stringify(ids)).all();
  if (!memories.length) return { changed: [], refused: [] };
  const { results: oldKeys } = await env.DB.prepare("SELECT memory_id, key_type, position, text, created_at FROM memory_keys WHERE memory_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(memories.map((m) => m.id))).all();

  // Likely questions are written once and kept with the time they were written. A rebuild embeds them again but does not ask
  // the model again. A memory in the trash keeps its question rows but gets no chunk keys and no vectors.
  const questions = (id) => oldKeys.filter((o) => o.memory_id === id && o.key_type === "question").map((o) => ({ key_type: "question", position: o.position, text: o.text, created_at: o.created_at }));
  const plans = memories.map((m) => ({ m, live: m.deleted_at === null, keys: [...(m.deleted_at === null ? buildKeys(m) : []), ...questions(m.id)] }));
  const vectors = await embedTexts(env.AI, plans.flatMap((p) => (p.live ? p.keys.map((k) => k.text) : [])));
  let at = 0;
  const items = [];
  for (const { m, live, keys } of plans) {
    for (const k of keys) {
      k.vector_id = live ? vectorId(m.id, k.key_type, k.position) : null;
      if (live) items.push({ id: k.vector_id, values: vectors[at++], metadata: { memory_id: m.id, project: m.project, origin: m.origin } });
    }
  }
  // Vectorize refuses a whole upsert when one id in it is too long, so one bad memory fails its batch. Such a batch is
  // retried one memory at a time, and only the memory that is refused is left out. If Vectorize does not answer the
  // describe call either, the index is down, and the batch error stands.
  const refused = new Set();
  for (const batch of slices(items, UPSERT_BATCH)) {
    try {
      await env.VECTORIZE.upsert(batch);
    } catch (err) {
      for (const id of new Set(batch.map((v) => v.metadata.memory_id))) {
        try {
          await env.VECTORIZE.upsert(batch.filter((v) => v.metadata.memory_id === id));
        } catch {
          await env.VECTORIZE.describe().catch(() => {
            throw err;
          });
          refused.add(id);
        }
      }
    }
  }

  const stale = [];
  const changed = [];
  for (const { m, keys } of plans) {
    if (refused.has(m.id)) continue;
    const guard = "EXISTS (SELECT 1 FROM memories WHERE id = ? AND updated_at = ?)";
    const g = [m.id, m.updated_at];
    const statements = [
      env.DB.prepare(`DELETE FROM memory_keys WHERE memory_id = ? AND ${guard}`).bind(m.id, ...g),
      ...keys.map((k) => env.DB.prepare(`INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`).bind(m.id, k.key_type, k.position, k.text, k.vector_id, k.created_at ?? now(), ...g)),
      env.DB.prepare(`DELETE FROM memory_fts WHERE memory_id = ? AND ${guard}`).bind(m.id, ...g),
      env.DB.prepare(`${FTS_INSERT} AND ${guard}`).bind(m.id, ...g),
      env.DB.prepare(`SELECT ${guard} AS ok`).bind(...g),
    ];
    const res = await env.DB.batch(statements);
    if (res.at(-1).results[0].ok !== 1) {
      // The memory changed while it was embedded. The vectors this pass upserted are for the old text, and a key that is
      // not in the key rows is never found by purge. So they go, the key rows lose their ids so the memory is indexed again,
      // and the next pass embeds the current text.
      for (const v of items) if (v.metadata.memory_id === m.id && vectorIdFits(v.id)) stale.push(v.id);
      await env.DB.prepare("UPDATE memory_keys SET vector_id = NULL WHERE memory_id = ?").bind(m.id).run();
      changed.push(m.id);
      continue;
    }
    const wanted = new Set(keys.map((k) => k.vector_id));
    for (const k of oldKeys.filter((o) => o.memory_id === m.id)) {
      const id = vectorId(m.id, k.key_type, k.position);
      if (!wanted.has(id) && vectorIdFits(id)) stale.push(id);
    }
  }
  for (const batch of slices(stale, UPSERT_BATCH)) await env.VECTORIZE.deleteByIds(batch);
  return { changed, refused: [...refused] };
}

/**
 * Bring the keys and vectors of these memories up to date. A memory in the trash loses its vectors and all keys except its
 * questions, a live one gets new ones. A memory that is already up to date is left alone. Throws when the AI or Vectorize fails, and the memories
 * stay marked as needing work. Returns the ids that Vectorize refused, which stay marked as needing work too.
 * @param {{DB: any, AI: any, VECTORIZE: any}} env
 * @param {string[]} ids
 * @param {() => number} now
 * @returns {Promise<string[]>}
 */
export async function indexMemories(env, ids, now) {
  let todo = [...new Set(ids)];
  const refused = new Set();
  for (let attempt = 0; attempt < MAX_ATTEMPTS && todo.length; attempt++) {
    const out = await pass(env, todo, now);
    for (const id of out.refused) refused.add(id);
    todo = out.changed;
  }
  return [...refused];
}

/**
 * Index up to limit of the memories that need it. Returns how many of them were done and how many are still waiting. failed
 * counts the memories Vectorize refused in this call, and it is only there when some were.
 * @returns {Promise<{processed: number, remaining: number, failed?: number}>}
 */
export async function reindex(env, limit, now) {
  const ids = await pendingIds(env.DB, limit);
  const refused = await indexMemories(env, ids, now);
  const remaining = await countPending(env.DB);
  const stillWaiting = ids.length ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${NEEDS_INDEX}`).bind(JSON.stringify(ids)).first()).n : 0;
  return { processed: ids.length - stillWaiting, remaining, ...(refused.length ? { failed: refused.length } : {}) };
}
