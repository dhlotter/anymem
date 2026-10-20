// Export format v2. The whole store as one JSON document: every memory (the trash too) with its tags, every version,
// the model written question keys, the links and the devices. Search keys and vectors are not part of it, a restore
// rebuilds them with the reindex route. Device tokens are only ever stored as hashes, so no token is in an export.
//
// Two ways to read it. exportStore returns one object, a whole store or one page. exportText yields the same document as
// text in pieces, so the nightly backup can stream it to R2 without holding it in memory. A page is read by a cursor, the
// created_at and id of its last memory, so a purge between two pages cannot shift the rows. A page by offset still works
// for callers that send offset, but a purge between its pages moves rows.
import { badRequest, HttpError } from "../http.js";

export const FORMAT = 2;
/** Entries one export reply holds when the caller does not page. */
export const EXPORT_CAP = 3000;
const CHUNK = 500;
// Question rows are short, so a bigger page keeps the nightly backup's query count down on a store with thousands of them. Versions hold whole snapshots and stay at CHUNK.
const QUESTION_CHUNK = 2000;

export const MEMORY_COLUMNS = [
  "id", "name", "description", "type", "body", "content", "content_hash", "status", "origin", "harness", "session", "project", "kind",
  "pinned", "probation_until", "valid_from", "valid_until", "superseded_by", "recall_count", "last_recalled_at", "created_at", "updated_at", "deleted_at",
];

const byId = (rows) => {
  const map = new Map();
  for (const r of rows) (map.get(r.memory_id) ?? map.set(r.memory_id, []).get(r.memory_id)).push(r);
  return map;
};

/** The cursor that names a memory: its created_at and id, as "created_at:id". */
export const cursorOf = (row) => `${row.created_at}:${row.id}`;

/**
 * The position a cursor names. Null for the start, which is no cursor or the word start. A text this Worker did not write is a 400.
 * @param {string | null | undefined} text
 * @returns {{createdAt: number, id: string} | null}
 */
export function parseCursor(text) {
  if (text === null || text === undefined || text === "" || text === "start") return null;
  const m = /^(\d{1,16}):(.{1,200})$/.exec(text);
  if (!m) throw badRequest("cursor must be the next_cursor of an earlier export.", "bad_cursor");
  return { createdAt: Number(m[1]), id: m[2] };
}

/** Attach each memory's tags, in the order the export has them. */
async function withTags(db, rows) {
  if (!rows.length) return [];
  const { results: tags } = await db.prepare("SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY tag").bind(JSON.stringify(rows.map((r) => r.id))).all();
  const tagMap = byId(tags);
  return rows.map((r) => ({ ...r, tags: (tagMap.get(r.id) ?? []).map((t) => t.tag) }));
}

/** Up to limit memories after a position in the export order (created_at, id), or from the start when there is no position. */
async function memoriesAfter(db, after, limit) {
  const place = after ? "WHERE created_at > ? OR (created_at = ? AND id > ?) " : "";
  const args = after ? [after.createdAt, after.createdAt, after.id, limit] : [limit];
  const { results } = await db.prepare(`SELECT ${MEMORY_COLUMNS.join(", ")} FROM memories ${place}ORDER BY created_at, id LIMIT ?`).bind(...args).all();
  return withTags(db, results);
}

/** Up to limit memories from an offset in the export order. */
async function memoriesAt(db, offset, limit) {
  const { results } = await db.prepare(`SELECT ${MEMORY_COLUMNS.join(", ")} FROM memories ORDER BY created_at, id LIMIT ? OFFSET ?`).bind(limit, offset).all();
  return withTags(db, results);
}

/** The versions and question keys of some memories. */
async function relatedRows(db, ids) {
  const list = JSON.stringify(ids);
  const [versions, questions] = await db.batch([
    db.prepare("SELECT memory_id, seq, snapshot, reason, created_at FROM memory_versions WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY memory_id, seq").bind(list),
    db.prepare("SELECT memory_id, position, text, created_at FROM memory_keys WHERE key_type = 'question' AND memory_id IN (SELECT value FROM json_each(?)) ORDER BY memory_id, position").bind(list),
  ]);
  return { versions: versions.results, questions: questions.results };
}

/** The links and the devices, which every whole export and the last page carry. */
async function linksAndDevices(db) {
  const [links, devices] = await db.batch([
    db.prepare("SELECT source_id, target_id, link_type, created_at FROM links ORDER BY source_id, target_id, link_type"),
    db.prepare("SELECT id, label, token_hash, created_at, last_used_at, revoked_at FROM devices ORDER BY created_at, id"),
  ]);
  return { links: links.results, devices: devices.results };
}

/**
 * Export the store, or one page of it. A keyed page starts after the cursor (or at the start) and gives next_cursor. An
 * unkeyed page starts at an offset and gives next_offset. The links and the devices come with the last page.
 * @param {any} db
 * @param {() => number} now
 * @param {{cursor?: string | null, keyed?: boolean, offset?: number, limit?: number | null}} [page] limit null means everything, which is refused above EXPORT_CAP when capped is set
 * @param {{capped?: boolean}} [opts]
 */
export async function exportStore(db, now, { cursor = null, keyed = false, offset = 0, limit = null } = {}, { capped = false } = {}) {
  const after = parseCursor(cursor);
  const [total, schema] = await Promise.all([db.prepare("SELECT COUNT(*) AS n FROM memories").first(), db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first()]);
  if (capped && limit === null && total.n > EXPORT_CAP) {
    throw new HttpError(413, "export_too_large", `This store holds ${total.n} memories, more than the ${EXPORT_CAP} that one reply carries. Page it with ?offset=0&limit=500 and follow next_offset.`);
  }
  const out = { entries: [], versions: [], questions: [] };
  let position = after;
  let seen = 0;
  let lastRow = null;
  for (;;) {
    const want = limit === null ? CHUNK : Math.min(CHUNK, limit - seen);
    if (want <= 0) break;
    const rows = keyed ? await memoriesAfter(db, position, want) : await memoriesAt(db, offset + seen, want);
    if (!rows.length) break;
    const related = await relatedRows(db, rows.map((r) => r.id));
    out.entries.push(...rows);
    out.versions.push(...related.versions);
    out.questions.push(...related.questions);
    seen += rows.length;
    lastRow = rows.at(-1);
    position = { createdAt: lastRow.created_at, id: lastRow.id };
    if (rows.length < want) break;
  }
  const more = keyed ? Boolean(position && (await hasAfter(db, position))) : offset + seen < total.n;
  const tail = more ? { links: [], devices: [] } : await linksAndDevices(db);
  return {
    ok: true,
    format: FORMAT,
    created_at: now(),
    schema_version: schema ? Number(schema.value) : null,
    total: total.n,
    offset,
    next_offset: keyed ? null : more ? offset + seen : null,
    next_cursor: keyed && more && lastRow ? cursorOf(lastRow) : null,
    ...out,
    links: tail.links,
    devices: tail.devices,
  };
}

async function hasAfter(db, { createdAt, id }) {
  return Boolean(await db.prepare("SELECT 1 AS n FROM memories WHERE created_at > ? OR (created_at = ? AND id > ?) LIMIT 1").bind(createdAt, createdAt, id).first());
}

/**
 * The rows of one table in key order, a chunk at a time, as JSON text with a comma before every chunk but the first.
 * The select must name the two key columns, the first of them is k1.
 */
async function* rowPieces(db, { select, where = "1", k1, k2, chunk = CHUNK }) {
  let after = null;
  let count = 0;
  for (;;) {
    const cond = after ? `(${k1} > ? OR (${k1} = ? AND ${k2} > ?))` : "1";
    const args = after ? [after[0], after[0], after[1]] : [];
    const { results } = await db.prepare(`${select} WHERE (${where}) AND ${cond} ORDER BY ${k1}, ${k2} LIMIT ?`).bind(...args, chunk).all();
    if (!results.length) return;
    yield `${count ? "," : ""}${results.map((r) => JSON.stringify(r)).join(",")}`;
    count += results.length;
    const last = results.at(-1);
    after = [last[k1], last[k2]];
    if (results.length < chunk) return;
  }
}

/** The memories, a chunk at a time, with their tags. */
async function* memoryPieces(db) {
  let after = null;
  let count = 0;
  for (;;) {
    const rows = await memoriesAfter(db, after, CHUNK);
    if (!rows.length) return;
    yield `${count ? "," : ""}${rows.map((r) => JSON.stringify(r)).join(",")}`;
    count += rows.length;
    const last = rows.at(-1);
    after = { createdAt: last.created_at, id: last.id };
    if (rows.length < CHUNK) return;
  }
}

/**
 * The whole store as the same document exportStore returns with no limit, as text in pieces. The nightly backup streams
 * these pieces to R2, so the store is never held in memory. The sections are read one after another, because a JSON array
 * has to close before the next key starts.
 * @param {any} db
 * @param {() => number} now
 * @returns {AsyncGenerator<string>}
 */
export async function* exportText(db, now) {
  const [total, schema] = await Promise.all([db.prepare("SELECT COUNT(*) AS n FROM memories").first(), db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first()]);
  yield `{"ok":true,"format":${FORMAT},"created_at":${JSON.stringify(now())},"schema_version":${JSON.stringify(schema ? Number(schema.value) : null)},"total":${total.n},"offset":0,"entries":[`;
  yield* memoryPieces(db);
  yield '],"versions":[';
  yield* rowPieces(db, { select: "SELECT memory_id, seq, snapshot, reason, created_at FROM memory_versions", k1: "memory_id", k2: "seq" });
  yield '],"questions":[';
  yield* rowPieces(db, { select: "SELECT memory_id, position, text, created_at FROM memory_keys", where: "key_type = 'question'", k1: "memory_id", k2: "position", chunk: QUESTION_CHUNK });
  const tail = await linksAndDevices(db);
  yield `],"next_offset":null,"next_cursor":null,"links":${JSON.stringify(tail.links)},"devices":${JSON.stringify(tail.devices)}}`;
}
