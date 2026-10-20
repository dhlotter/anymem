// The storage layer. Every change to a memory is one D1 batch that writes the old state to memory_versions,
// the new row, the tags and the search rows together. D1 runs a batch as a transaction.
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http.js";
import { isPinnedByTags, KINDS, parseMemory, STATUSES } from "./parse.js";
import { summarize } from "./diff.js";
import { harnessLabel, harnessValues } from "../harnesses.js";
import { hiddenWhere } from "../subjects/private.js";

export const ORIGINS = ["explicit", "capture", "import", "profile", "person", "system"];
export const TRASH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PINNED_ORIGINS = ["profile", "person"];
const MAX_PAGE = 500;
const LINK_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Columns a change may set. Provenance (origin, harness, session), counters and created_at never change here.
const SETTABLE = ["name", "description", "type", "body", "content", "content_hash", "status", "project", "kind", "pinned", "probation_until", "valid_from", "valid_until", "superseded_by", "deleted_at"];

const INSERT_COLUMNS = ["id", "name", "description", "type", "body", "content", "content_hash", "status", "origin", "harness", "session", "project", "kind", "pinned", "probation_until", "valid_from", "valid_until", "recall_count", "created_at", "updated_at", "deleted_at"];

// A change to any of these makes the search keys and vectors out of date.
const INDEXED = ["content", "project", "deleted_at"];

// The keys column holds the extra keys written by a model (likely questions). Chunks and the description are already in body and description.
export const FTS_INSERT = `INSERT INTO memory_fts (memory_id, name, description, body, keys)
  SELECT id, name, description, body, COALESCE((SELECT group_concat(text, ' ') FROM memory_keys WHERE memory_id = memories.id AND key_type = 'question'), '')
  FROM memories WHERE id = ? AND deleted_at IS NULL`;

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string | null} type
 * @property {string} body
 * @property {string} content
 * @property {string[]} tags
 * @property {string} status
 * @property {string} origin
 * @property {string} harness
 * @property {string} harness_label the words to show for the harness, Imported or Unknown when it is blank
 * @property {string} session
 * @property {string} project
 * @property {string | null} kind
 * @property {boolean} pinned
 * @property {number} valid_from
 * @property {number | null} valid_until
 * @property {string | null} superseded_by
 * @property {number} recall_count
 * @property {number | null} last_recalled_at
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number | null} deleted_at
 */

/** The public shape of a memory. @returns {Entry} */
export function toEntry(row, tags) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    body: row.body,
    content: row.content,
    tags: [...tags].sort(),
    status: row.status,
    origin: row.origin,
    harness: row.harness,
    harness_label: harnessLabel(row.harness, row.origin),
    session: row.session,
    project: row.project,
    kind: row.kind,
    pinned: row.pinned === 1 || row.pinned === true,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    superseded_by: row.superseded_by,
    recall_count: row.recall_count,
    last_recalled_at: row.last_recalled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

/** The orders a list can have, each by the column that leads it. Newest saved first is the default. */
export const SORTS = { created: "created_at", updated: "updated_at", recalls: "recall_count" };

// A cursor is [value of the leading column, id] and, for any order but the default, the name of the order as a third item.
const encodeCursor = (row, sort) => btoa(JSON.stringify(sort === "created" ? [row.created_at, row.id] : [row[SORTS[sort]], row.id, sort])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeCursor(cursor, sort) {
  try {
    const [value, id, named = "created"] = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (Number.isSafeInteger(value) && typeof id === "string" && named === sort) return { value, id };
  } catch {
    // falls through to the error below
  }
  throw badRequest("cursor is not valid.", "bad_cursor");
}

const sameSet = (a, b) => a.length === b.length && a.every((t) => b.includes(t));

/**
 * @param {any} db the D1 binding
 * @param {() => number} [now] milliseconds
 */
export function createStore(db, now = Date.now) {
  /** The row, its tags and its highest version number, or null. Includes trashed memories. */
  async function load(id) {
    const [rows, tags, seq] = await db.batch([
      db.prepare("SELECT * FROM memories WHERE id = ?").bind(id),
      db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ?").bind(id),
      db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_versions WHERE memory_id = ?").bind(id),
    ]);
    if (!rows.results.length) return null;
    return { row: rows.results[0], tags: tags.results.map((r) => r.tag), seq: seq.results[0].seq };
  }

  const snapshotOf = (cur) => ({ ...cur.row, tags: [...cur.tags].sort() });

  /**
   * Apply one change with a version row in front of it.
   * The version number is the next free one. Two writers that read the same state both try the same number,
   * the unique key rejects the second, and its whole batch rolls back. That is the lost race.
   * @param {string} id
   * @param {string} reason
   * @param {(cur: any, at: number) => Promise<{set?: Record<string, any>, tags?: string[]} | null>} plan
   * @param {number} [ifUpdatedAt]
   * @returns {Promise<Entry>}
   */
  async function mutate(id, reason, plan, ifUpdatedAt) {
    const cur = await load(id);
    if (!cur) throw notFound("No memory with that id.");
    if (ifUpdatedAt !== undefined && ifUpdatedAt !== cur.row.updated_at) {
      throw conflict(`The memory changed since you read it (updated_at is ${cur.row.updated_at}, you sent ${ifUpdatedAt}).`, "stale_update");
    }
    const at = Math.max(now(), cur.row.updated_at + 1);
    const change = await plan(cur, at);
    const set = Object.fromEntries(Object.entries(change?.set ?? {}).filter(([k, v]) => cur.row[k] !== v));
    const tagsChanged = change?.tags !== undefined && !sameSet(change.tags, cur.tags);
    if (!Object.keys(set).length && !tagsChanged) return toEntry(cur.row, cur.tags);
    const columns = [...Object.keys(set), "updated_at"];
    const statements = [
      db.prepare("INSERT INTO memory_versions (memory_id, seq, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, cur.seq + 1, JSON.stringify(snapshotOf(cur)), reason, at),
      db.prepare(`UPDATE memories SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...Object.values(set), at, id),
    ];
    // Marking the keys stale in the same batch is what lets the indexer find work after a change, even if the Worker stops right here.
    if (INDEXED.some((c) => c in set)) statements.push(db.prepare("UPDATE memory_keys SET vector_id = NULL WHERE memory_id = ?").bind(id));
    if (tagsChanged) {
      statements.push(db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id));
      statements.push(db.prepare("INSERT INTO memory_tags (memory_id, tag) SELECT ?, value FROM json_each(?)").bind(id, JSON.stringify(change.tags)));
    }
    statements.push(db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(id), db.prepare(FTS_INSERT).bind(id));
    try {
      await db.batch(statements);
    } catch (err) {
      if (/UNIQUE constraint failed: memory_versions/.test(String(err?.message))) throw conflict("Another change landed first. Read the memory again and retry.", "lost_race");
      throw err;
    }
    const fresh = await load(id);
    return toEntry(fresh.row, fresh.tags);
  }

  /** Columns and tags for new content, from the parsed text. */
  const contentChange = (cur, parsed) => ({
    set: {
      name: parsed.name ?? "",
      description: parsed.description,
      type: parsed.type,
      body: parsed.body,
      content: parsed.content,
      content_hash: parsed.content_hash,
      pinned: parsed.pinned || PINNED_ORIGINS.includes(cur.row.origin) ? 1 : 0,
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.kind ? { kind: parsed.kind } : {}),
      ...(parsed.project !== null ? { project: parsed.project } : {}),
    },
    tags: parsed.tags,
  });

  /** @returns {Promise<Entry | null>} */
  async function get(id, { trash = false } = {}) {
    const cur = await load(id);
    if (!cur || (cur.row.deleted_at !== null && !trash)) return null;
    return toEntry(cur.row, cur.tags);
  }

  return {
    /**
     * Store a new memory. Takes the output of parseMemory plus provenance. An import may also give the id, the times,
     * validity, the trash time and the recall count.
     * With unlessLiveDuplicate the row is only inserted when no live memory of the same project, or a global one, has the same content hash. The check and the insert
     * are one statement, so two racing writes of the same text store exactly one of them. Returns null when it lost.
     * @param {import("./parse.js").Parsed & {origin: string, harness?: string, session?: string, project?: string | null, kind?: string | null, status?: string | null, probation_until?: number | null, id?: string, created_at?: number, updated_at?: number, valid_until?: number | null, deleted_at?: number | null, recall_count?: number}} f
     * @param {{unlessLiveDuplicate?: boolean}} [opts]
     * @returns {Promise<Entry | null>}
     */
    async create(f, { unlessLiveDuplicate = false } = {}) {
      if (!ORIGINS.includes(f.origin)) throw badRequest(`origin must be one of ${ORIGINS.join(", ")}.`);
      const status = f.status ?? "active";
      if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(", ")}.`);
      if (f.kind && !KINDS.includes(f.kind)) throw badRequest(`kind must be one of ${KINDS.join(", ")}.`);
      const id = f.id ?? crypto.randomUUID();
      const at = f.created_at ?? now();
      const values = {
        id,
        name: f.name ?? "",
        description: f.description,
        type: f.type,
        body: f.body,
        content: f.content,
        content_hash: f.content_hash,
        status,
        origin: f.origin,
        harness: f.harness ?? "",
        session: f.session ?? "",
        project: f.project ?? "",
        kind: f.kind ?? null,
        pinned: f.pinned || isPinnedByTags(f.tags) || PINNED_ORIGINS.includes(f.origin) ? 1 : 0,
        probation_until: f.probation_until ?? null,
        valid_from: at,
        valid_until: f.valid_until ?? null,
        recall_count: f.recall_count ?? 0,
        created_at: at,
        updated_at: f.updated_at ?? at,
        deleted_at: f.deleted_at ?? null,
      };
      const columns = INSERT_COLUMNS.join(", ");
      const marks = INSERT_COLUMNS.map(() => "?").join(", ");
      const args = INSERT_COLUMNS.map((c) => values[c]);
      const insert = unlessLiveDuplicate
        ? db.prepare(`INSERT INTO memories (${columns}) SELECT ${marks} WHERE NOT EXISTS (SELECT 1 FROM memories WHERE content_hash = ? AND project IN (?, '') AND deleted_at IS NULL AND valid_until IS NULL)`).bind(...args, f.content_hash, values.project)
        : db.prepare(`INSERT INTO memories (${columns}) VALUES (${marks})`).bind(...args);
      const statements = [insert];
      // The tag rows only go in when the memory row did.
      if (f.tags.length) statements.push(db.prepare("INSERT INTO memory_tags (memory_id, tag) SELECT ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)").bind(id, JSON.stringify(f.tags), id));
      statements.push(db.prepare(FTS_INSERT).bind(id));
      const done = await db.batch(statements);
      if (done[0].meta.changes === 0) return null;
      const stored = await load(id);
      return toEntry(stored.row, stored.tags);
    },

    /**
     * One memory, or null when it is missing. A trashed memory is hidden unless trash is true.
     * @param {string} id
     * @param {{trash?: boolean}} [opts]
     * @returns {Promise<Entry | null>}
     */
    get,

    /**
     * An earlier state of a memory.
     * @param {string} id
     * @param {number} seq
     * @param {{trash?: boolean}} [opts]
     * @returns {Promise<(Entry & {version: number}) | null>}
     */
    async getVersion(id, seq, { trash = false } = {}) {
      if (!(await get(id, { trash }))) return null;
      const v = await db.prepare("SELECT snapshot FROM memory_versions WHERE memory_id = ? AND seq = ?").bind(id, seq).first();
      if (!v) return null;
      const snap = JSON.parse(v.snapshot);
      return { ...toEntry(snap, snap.tags), version: seq };
    },

    /**
     * Change content and tags. With ifUpdatedAt a stale caller gets a conflict. Tags given replace the stored tags,
     * tags left out keep them. Hashtags in the content always count.
     * @param {{id: string, content?: string, tags?: string[], ifUpdatedAt?: number}} args
     * @returns {Promise<Entry>}
     */
    update({ id, content, tags, ifUpdatedAt }) {
      return mutate(id, "update", async (cur) => contentChange(cur, await parseMemory(content ?? cur.row.content, tags ?? cur.tags)), ifUpdatedAt);
    },

    /**
     * Add text after the stored content, separated by a blank line.
     * @param {string} id
     * @param {string} addition
     * @returns {Promise<Entry>}
     */
    async append(id, addition) {
      if (typeof addition !== "string" || !addition.trim()) throw badRequest("addition must be non-empty text.");
      return mutate(id, "append", async (cur) => contentChange(cur, await parseMemory(`${cur.row.content}\n\n${addition.trim()}`, cur.tags)));
    },

    /** @returns {Promise<Entry>} */
    async setStatus(id, status) {
      if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(", ")}.`);
      return mutate(id, "status", async () => ({ set: { status } }));
    },

    /** Move to the trash. Rows stay. Forgetting a trashed memory changes nothing. The reason names the version row. @returns {Promise<Entry>} */
    softDelete(id, reason = "forget") {
      return mutate(id, reason, async (cur, at) => (cur.row.deleted_at === null ? { set: { deleted_at: at } } : null));
    },

    /** Take a memory out of the trash, within 14 days of deleted_at. @returns {Promise<Entry>} */
    restore(id) {
      return mutate(id, "restore", async (cur, at) => {
        if (cur.row.deleted_at === null) throw new HttpError(409, "not_in_trash", "That memory is not in the trash.");
        if (at - cur.row.deleted_at > TRASH_WINDOW_MS) throw new HttpError(410, "restore_window_passed", "That memory has been in the trash for more than 14 days.");
        return { set: { deleted_at: null } };
      });
    },

    /**
     * Close a memory because a newer one replaces it, valid until at.
     * @param {string} oldId
     * @param {string} newId
     * @param {number} at
     * @param {string} [reason] the reason on the version row
     * @returns {Promise<Entry>}
     */
    async supersede(oldId, newId, at, reason = "supersede") {
      if (oldId === newId) throw badRequest("A memory cannot supersede itself.");
      if (!(await get(newId))) throw notFound("No memory with the replacing id.");
      return mutate(oldId, reason, async (cur) => {
        if (cur.row.deleted_at !== null) throw notFound("No memory with that id.");
        if (cur.row.valid_until !== null) throw conflict("That memory is already closed.", "already_closed");
        return { set: { valid_until: at, superseded_by: newId } };
      });
    },

    /**
     * Go back to the most recent version and record the current state as a new version, so a second undo goes forward again.
     * Counters, provenance and created_at stay as they are.
     * @param {string} id
     * @returns {Promise<Entry>}
     */
    undo(id) {
      return mutate(id, "undo", async (cur, at) => {
        if (cur.seq === 0) throw new HttpError(409, "nothing_to_undo", "That memory has no earlier version.");
        const v = await db.prepare("SELECT snapshot FROM memory_versions WHERE memory_id = ? AND seq = ?").bind(cur.row.id, cur.seq).first();
        const snap = JSON.parse(v.snapshot);
        if (cur.row.deleted_at !== null && snap.deleted_at === null && at - cur.row.deleted_at > TRASH_WINDOW_MS) {
          throw new HttpError(410, "restore_window_passed", "That memory has been in the trash for more than 14 days.");
        }
        return { set: Object.fromEntries(SETTABLE.map((c) => [c, snap[c]])), tags: snap.tags };
      });
    },

    /**
     * Versions newest first, each with a short summary of the change that replaced it.
     * @param {string} id
     * @returns {Promise<{seq: number, reason: string, at: number, summary: string}[] | null>} null when the memory does not exist
     */
    async history(id) {
      const cur = await load(id);
      if (!cur) return null;
      const { results } = await db.prepare("SELECT seq, reason, created_at, snapshot FROM memory_versions WHERE memory_id = ? ORDER BY seq").bind(id).all();
      const states = [...results.map((r) => JSON.parse(r.snapshot)), snapshotOf(cur)];
      return results.map((r, i) => ({ seq: r.seq, reason: r.reason, at: r.created_at, summary: summarize(states[i], states[i + 1]) })).reverse();
    },

    /**
     * Add a typed link between two live memories. Returns created false when it already existed. The vocabulary is checked by the route.
     * @param {{madeBy?: "user" | "system", confidence?: number | null}} [by] who made it, and how sure the system was
     * @returns {Promise<{created: boolean}>}
     */
    async link(sourceId, targetId, type, { madeBy = "user", confidence = null } = {}) {
      if (typeof type !== "string" || !LINK_TYPE.test(type.trim().toLowerCase())) throw badRequest("type must be a short lowercase word such as about_person.");
      if (sourceId === targetId) throw badRequest("A memory cannot link to itself.");
      const { results } = await db.prepare("SELECT id FROM memories WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([sourceId, targetId])).all();
      if (results.length < 2) throw notFound("One of the two memories does not exist.");
      const res = await db.prepare("INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, ?, ?, ?, ?)").bind(sourceId, targetId, type.trim().toLowerCase(), now(), madeBy, confidence).run();
      return { created: res.meta.changes > 0 };
    },

    /**
     * Remove a link. A link the system made is also written to link_rejections, so the system never remakes it.
     * With userOnly, a link the system made is refused (403 admin_only) and left in place.
     * @returns {Promise<{removed: boolean}>}
     */
    async unlink(sourceId, targetId, type, { userOnly = false } = {}) {
      if (typeof type !== "string" || !LINK_TYPE.test(type.trim().toLowerCase())) throw badRequest("type must be a short lowercase word such as about_person.");
      const t = type.trim().toLowerCase();
      const where = "source_id = ? AND target_id = ? AND link_type = ?";
      const row = await db.prepare(`SELECT made_by FROM links WHERE ${where}`).bind(sourceId, targetId, t).first();
      if (!row) return { removed: false };
      if (row.made_by === "system" && userOnly) throw forbidden("Only the admin token or a browser login can remove a link the system made.", "admin_only");
      // The rejection is written first, from the row that the second statement then deletes.
      const [, del] = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO link_rejections (source_id, target_id, link_type, created_at) SELECT source_id, target_id, link_type, ? FROM links WHERE ${where} AND made_by = 'system'`).bind(now(), sourceId, targetId, t),
        db.prepare(`DELETE FROM links WHERE ${where}`).bind(sourceId, targetId, t),
      ]);
      return { removed: del.meta.changes > 0 };
    },

    /**
     * The links of one memory in both directions, grouped by type and newest first. The other end must be live.
     * @returns {Promise<{type: string, direction: "out" | "in", other_id: string, other_name: string, made_by: string, confidence: number | null, created_at: number}[] | null>} null when the memory does not exist
     */
    async links(id) {
      if (!(await db.prepare("SELECT 1 AS n FROM memories WHERE id = ?").bind(id).first())) return null;
      const side = (dir, own, other) => `SELECT l.link_type AS type, '${dir}' AS direction, l.${other} AS other_id, m.name AS other_name, l.made_by AS made_by, l.confidence AS confidence, l.created_at AS created_at FROM links l JOIN memories m ON m.id = l.${other} WHERE l.${own} = ? AND m.deleted_at IS NULL`;
      const { results } = await db.prepare(`${side("out", "source_id", "target_id")} UNION ALL ${side("in", "target_id", "source_id")} ORDER BY type, created_at DESC, other_id`).bind(id, id).all();
      return results;
    },

    /**
     * Memories with a cursor, newest saved first unless sort says otherwise. Open memories only, except trash which lists the trashed ones.
     * @param {{tags?: string[], status?: string, origin?: string, harness?: string, type?: string, project?: string, after?: number, before?: number, minRecalls?: number, maxRecalls?: number, trash?: boolean, sort?: "created" | "updated" | "recalls", n?: number, cursor?: string}} f
     * @returns {Promise<{entries: Entry[], next_cursor: string | null}>}
     */
    async list(f = {}) {
      const n = Math.min(f.n ?? 50, MAX_PAGE);
      const where = [f.trash ? "m.deleted_at IS NOT NULL" : "m.deleted_at IS NULL AND m.valid_until IS NULL"];
      const args = [];
      const add = (sql, ...a) => (where.push(sql), args.push(...a));
      if (f.tags?.length) add("m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY memory_id HAVING COUNT(*) = ?)", JSON.stringify(f.tags), f.tags.length);
      if (f.status) add("m.status = ?", f.status);
      if (f.origin) add("m.origin = ?", f.origin);
      if (f.harness === "none") where.push("m.harness = ''");
      else if (f.harness) add("lower(m.harness) IN (SELECT value FROM json_each(?))", JSON.stringify(harnessValues(f.harness)));
      if (f.type) add("m.type = ?", f.type);
      if (f.project) add("m.project = ?", f.project);
      if (f.after !== undefined) add("m.created_at >= ?", f.after);
      if (f.before !== undefined) add("m.created_at < ?", f.before);
      if (f.minRecalls !== undefined) add("m.recall_count >= ?", f.minRecalls);
      if (f.maxRecalls !== undefined) add("m.recall_count <= ?", f.maxRecalls);
      if (f.hideFrom) add(`NOT ${hiddenWhere("m.id")}`, f.hideFrom); // a device that may not see private subjects pages past them, so the cursor never names a hidden row
      const sort = f.sort ?? "created";
      if (!Object.hasOwn(SORTS, sort)) throw badRequest(`sort must be one of ${Object.keys(SORTS).join(", ")}.`);
      const lead = `m.${SORTS[sort]}`;
      if (f.cursor) {
        const c = decodeCursor(f.cursor, sort);
        add(`(${lead} < ? OR (${lead} = ? AND m.id < ?))`, c.value, c.value, c.id);
      }
      const { results } = await db.prepare(`SELECT m.* FROM memories m WHERE ${where.join(" AND ")} ORDER BY ${lead} DESC, m.id DESC LIMIT ?`).bind(...args, n + 1).all();
      const page = results.slice(0, n);
      const byId = new Map(page.map((r) => [r.id, []]));
      if (page.length) {
        const tagRows = await db.prepare("SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(page.map((r) => r.id))).all();
        for (const t of tagRows.results) byId.get(t.memory_id).push(t.tag);
      }
      return { entries: page.map((r) => toEntry(r, byId.get(r.id))), next_cursor: results.length > n ? encodeCursor(page.at(-1), sort) : null };
    },
  };
}
