// The core capsule. A short set of always-on notes that a session loads at start.
// Built from canonical, pinned memories tagged capsule:core and capsule-slot:<slot>. Cached in capsule_cache.
// The cache is dropped when a write touches a capsule memory, and rebuilt by the next read.
import { json } from "./http.js";

// The session start hook cuts the capsule block at 9,500 characters (MAX_CHARS in hooks/memory_capsule.py), so the Worker warns at about the same size. The hook also counts the headings it adds, so a capsule just under the cap can still be cut, and the dashboard's Capsule screen warns about that too.
export const CAP_CHARS = 9_500;
export const SLOT_ORDER = ["identity", "preferences", "constraints", "principles"];
const SLOT_TAG = "capsule-slot:";
const GENERATION_KEY = "capsule_gen";

/** Position of a slot in the reply. The four known slots first, then any other slot alphabetically. */
export function compareSlots(a, b) {
  const x = SLOT_ORDER.indexOf(a);
  const y = SLOT_ORDER.indexOf(b);
  if (x !== -1 || y !== -1) return (x === -1 ? SLOT_ORDER.length : x) - (y === -1 ? SLOT_ORDER.length : y);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the sections' slots, ids and text, as a quoted lowercase hex string. */
export async function etagOf(sections) {
  const text = JSON.stringify(sections.map((s) => [s.slot, s.source_id, s.content]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Read the current capsule memories. One section per memory, ordered by slot, then oldest first. */
async function buildSections(db) {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.name, m.body, m.updated_at, m.created_at, (SELECT group_concat(tag, char(10)) FROM memory_tags WHERE memory_id = m.id AND tag LIKE '${SLOT_TAG}%') AS slots
       FROM memories m
       WHERE m.status = 'canonical' AND m.pinned = 1 AND m.deleted_at IS NULL AND m.valid_until IS NULL
         AND EXISTS (SELECT 1 FROM memory_tags WHERE memory_id = m.id AND tag = 'capsule:core')`,
    )
    .all();
  const sections = [];
  for (const row of results) {
    const content = row.body.trim();
    if (!content || !row.slots) continue;
    // A memory with two slot tags is listed under the first one alphabetically, so it never appears twice.
    const slot = row.slots.split("\n").map((t) => t.slice(SLOT_TAG.length)).filter(Boolean).sort()[0];
    // The name comes with the section, so the dashboard does not read each memory again to label it.
    if (slot) sections.push({ slot, content, source_id: row.id, name: row.name ?? null, updated_at: row.updated_at, created_at: row.created_at });
  }
  sections.sort((a, b) => compareSlots(a.slot, b.slot) || a.created_at - b.created_at || (a.source_id < b.source_id ? -1 : 1));
  return sections.map(({ created_at: _created, ...s }) => s);
}

/**
 * The capsule, from the cache when it is there. A rebuild is stored only when no capsule write happened while it ran.
 * @returns {Promise<{sections: {slot: string, content: string, source_id: string, updated_at: number}[], etag: string, chars: number}>}
 */
export async function getCapsule(db, now) {
  const cached = await db.prepare("SELECT body, etag FROM capsule_cache WHERE id = 1").first();
  if (cached) return { ...JSON.parse(cached.body), etag: cached.etag };
  const generation = (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(GENERATION_KEY).first())?.value ?? "0";
  const sections = await buildSections(db);
  const built = { sections, chars: sections.reduce((n, s) => n + s.content.length, 0) };
  const etag = await etagOf(sections);
  await db
    .prepare("INSERT OR REPLACE INTO capsule_cache (id, body, etag, built_at) SELECT 1, ?, ?, ? WHERE COALESCE((SELECT value FROM meta WHERE key = ?), '0') = ?")
    .bind(JSON.stringify(built), etag, now(), GENERATION_KEY, generation)
    .run();
  return { ...built, etag };
}

/**
 * Called after a write. Drops the cache when one of the written memories carries capsule:core now, or is in the cached
 * capsule (so removing the tag, forgetting or changing the status also counts). With no cache row a rebuild may be running,
 * and it read the generation before this write, so every write bumps the generation then. Otherwise a rebuild that read
 * the tag before its removal would still store a capsule that the removal changed.
 * @param {any} db
 * @param {string[]} ids ids of the memories the write touched
 */
export async function onChange(db, ids) {
  if (!ids.length) return false;
  const list = JSON.stringify(ids);
  const hit = await db
    .prepare(
      `SELECT 1 AS hit FROM memory_tags WHERE tag = 'capsule:core' AND memory_id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT 1 FROM capsule_cache c, json_each(?) j WHERE instr(c.body, j.value) > 0 LIMIT 1`,
    )
    .bind(list, list)
    .first();
  if (!hit && (await db.prepare("SELECT 1 AS n FROM capsule_cache WHERE id = 1").first())) return false;
  await db.batch([
    db.prepare("DELETE FROM capsule_cache WHERE id = 1"),
    db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").bind(GENERATION_KEY),
  ]);
  return true;
}

const matches = (header, etag) => {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
};

/** GET /prompt-capsules/core */
export async function capsuleRoute({ request, env, now, memoryIds }) {
  const capsule = await getCapsule(env.DB, now);
  memoryIds.push(...capsule.sections.map((s) => s.source_id));
  const headers = { etag: capsule.etag, "cache-control": "no-cache" };
  if (matches(request.headers.get("if-none-match"), capsule.etag)) return new Response(null, { status: 304, headers });
  const over = capsule.chars > CAP_CHARS;
  return json(
    {
      ok: true,
      sections: capsule.sections,
      etag: capsule.etag,
      chars: capsule.chars,
      cap: CAP_CHARS,
      ...(over ? { over_cap: true, warning: `The capsule is ${capsule.chars} characters, over the ${CAP_CHARS} limit. Shorten a section.` } : {}),
    },
    200,
    headers,
  );
}
