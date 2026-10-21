// Import of export format v2 (a backup or GET /export). Idempotent by id: a memory that exists is skipped whole, with its
// versions and questions, so sending a page twice changes nothing. Rows are stored as they are, so ids, times, validity,
// the trash time and the content come back exactly. Search keys are not imported. After the last page call /admin/reindex.
// The links, the link rejections, the subjects and the devices go in with the page that reaches the end of the entries list.
import { badRequest, HttpError } from "../http.js";
import { FTS_INSERT } from "../memory/store.js";
import { memoryIdFits } from "../search/chunk.js";
import { MEMORY_COLUMNS } from "./export.js";

const PARALLEL = 10;
const MAX_ERRORS = 20;
const LINK_BATCH = 100;
const MAX_HASH_CHARS = 128;
const MAX_REASON_CHARS = 64;
const HASH = /^[0-9a-f]{64}$/;
const SUBJECT_KINDS = ["person", "pet", "asset", "project", "area", "topic"];
const SUBJECT_STATUSES = ["proposed", "active", "stale", "retired"];
const REQUIRED_TEXT = ["id", "content", "content_hash"];
const OPTIONAL_TEXT = ["name", "description", "body", "harness", "session", "project"];
const REQUIRED_TIME = ["valid_from", "created_at", "updated_at"];
const OPTIONAL_TIME = ["probation_until", "valid_until", "last_recalled_at", "deleted_at"];

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

/** The column values of one entry, in MEMORY_COLUMNS order. Throws a 400 that names the problem. */
export function memoryValues(e) {
  if (!e || typeof e !== "object") throw badRequest("An entry must be an object.");
  for (const f of REQUIRED_TEXT) if (typeof e[f] !== "string" || !e[f]) throw badRequest(`An entry needs ${f} as text.`);
  if (!memoryIdFits(e.id)) throw badRequest("An entry id is at most 50 bytes, so its search ids fit the 64 byte limit of Vectorize.");
  for (const f of OPTIONAL_TEXT) if (e[f] !== undefined && typeof e[f] !== "string") throw badRequest(`${f} must be text.`);
  for (const f of REQUIRED_TIME) if (!isTime(e[f])) throw badRequest(`${f} must be a whole number of milliseconds.`);
  for (const f of OPTIONAL_TIME) if (e[f] !== undefined && e[f] !== null && !isTime(e[f])) throw badRequest(`${f} must be a whole number of milliseconds or null.`);
  if (e.recall_count !== undefined && !isTime(e.recall_count)) throw badRequest("recall_count must be a whole number.");
  if (e.superseded_by !== undefined && e.superseded_by !== null && typeof e.superseded_by !== "string") throw badRequest("superseded_by must be text or null.");
  if (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== "string" || !t)) throw badRequest("tags must be a list of text.");
  const pinned = e.pinned === true || e.pinned === 1 ? 1 : e.pinned === false || e.pinned === 0 || e.pinned === undefined ? 0 : null;
  if (pinned === null) throw badRequest("pinned must be 0 or 1.");
  return MEMORY_COLUMNS.map((c) => {
    if (c === "pinned") return pinned;
    if (c === "recall_count") return e.recall_count ?? 0;
    if (c === "status") return e.status ?? "active";
    if (OPTIONAL_TEXT.includes(c)) return e[c] ?? "";
    return e[c] ?? null;
  });
}

function checkChild(rows, name, fields) {
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.memory_id !== "string") throw badRequest(`${name} rows need a memory_id.`);
    for (const [f, kind] of Object.entries(fields)) if (typeof r[f] !== kind) throw badRequest(`${name} rows need ${f} as ${kind === "number" ? "a number" : "text"}.`);
  }
}

const groupBy = (rows) => {
  const map = new Map();
  for (const r of rows) (map.get(r.memory_id) ?? map.set(r.memory_id, []).get(r.memory_id)).push(r);
  return map;
};

/** The statements that store one memory with its tags, versions and questions. One batch, so it is all or nothing. */
function statementsFor(db, entry, values, versions, questions) {
  const marks = MEMORY_COLUMNS.map(() => "?").join(", ");
  const out = [db.prepare(`INSERT INTO memories (${MEMORY_COLUMNS.join(", ")}) VALUES (${marks})`).bind(...values)];
  if (entry.tags.length) out.push(db.prepare("INSERT INTO memory_tags (memory_id, tag) SELECT ?, value FROM json_each(?)").bind(entry.id, JSON.stringify([...new Set(entry.tags)])));
  if (versions.length) {
    out.push(
      db
        .prepare("INSERT INTO memory_versions (memory_id, seq, snapshot, reason, created_at) SELECT ?, json_extract(value, '$.seq'), json_extract(value, '$.snapshot'), json_extract(value, '$.reason'), json_extract(value, '$.created_at') FROM json_each(?)")
        .bind(entry.id, JSON.stringify(versions)),
    );
  }
  if (questions.length) {
    out.push(
      db
        .prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) SELECT ?, 'question', json_extract(value, '$.position'), json_extract(value, '$.text'), NULL, json_extract(value, '$.created_at') FROM json_each(?)")
        .bind(entry.id, JSON.stringify(questions)),
    );
  }
  out.push(db.prepare(FTS_INSERT).bind(entry.id));
  return out;
}

/** A backup from before link provenance has no made_by or confidence, so the defaults apply: a user link, no confidence. */
async function importLinks(db, links) {
  let added = 0;
  for (let i = 0; i < links.length; i += LINK_BATCH) {
    const statements = links.slice(i, i + LINK_BATCH).map((l) => {
      if (![l?.source_id, l?.target_id, l?.link_type].every((v) => typeof v === "string" && v) || !isTime(l.created_at)) throw badRequest("A link needs source_id, target_id, link_type and created_at.");
      if (l.made_by !== undefined && l.made_by !== "user" && l.made_by !== "system") throw badRequest("made_by must be user or system.");
      if (l.confidence !== undefined && l.confidence !== null && typeof l.confidence !== "number") throw badRequest("confidence must be a number or null.");
      return db
        .prepare("INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?) AND EXISTS (SELECT 1 FROM memories WHERE id = ?)")
        .bind(l.source_id, l.target_id, l.link_type, l.created_at, l.made_by ?? "user", l.confidence ?? null, l.source_id, l.target_id);
    });
    added += (await db.batch(statements)).reduce((n, r) => n + r.meta.changes, 0);
  }
  return added;
}

/** The links the user turned down, which an older backup does not have. */
async function importLinkRejections(db, rejections) {
  let added = 0;
  for (let i = 0; i < rejections.length; i += LINK_BATCH) {
    const statements = rejections.slice(i, i + LINK_BATCH).map((l) => {
      if (![l?.source_id, l?.target_id, l?.link_type].every((v) => typeof v === "string" && v) || !isTime(l.created_at)) throw badRequest("A link rejection needs source_id, target_id, link_type and created_at.");
      return db
        .prepare("INSERT OR IGNORE INTO link_rejections (source_id, target_id, link_type, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?) AND EXISTS (SELECT 1 FROM memories WHERE id = ?)")
        .bind(l.source_id, l.target_id, l.link_type, l.created_at, l.source_id, l.target_id);
    });
    added += (await db.batch(statements)).reduce((n, r) => n + r.meta.changes, 0);
  }
  return added;
}

/** The text of a subjects.fields or subjects.aliases column when it holds JSON of the wanted shape, else null. A missing one takes the column default. */
function jsonColumn(value, fallback, isArray) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) === isArray && parsed !== null && typeof parsed === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The subjects. A row goes in only when its card memory is in the store by now, so a card that was not imported takes its
 * subject with it. A slug that is taken already is skipped. A backup from before subjects has none.
 * Returns the number of rows added.
 */
async function importSubjects(db, subjects, errors) {
  const statements = [];
  for (const s of subjects) {
    const id = typeof s?.id === "string" ? s.id.slice(0, 64) : null;
    const scope = s?.scope ?? "shared";
    const fields = jsonColumn(s?.fields, "{}", false);
    const aliases = jsonColumn(s?.aliases, "[]", true);
    // The brief columns arrived in 0007. A backup from before has none, which means a brief that was never built.
    const memberHash = s?.member_hash ?? "";
    const staleReason = s?.stale_reason ?? "";
    const builtAt = s?.built_at ?? null;
    const briefOk = typeof memberHash === "string" && memberHash.length <= MAX_HASH_CHARS && typeof staleReason === "string" && staleReason.length <= MAX_REASON_CHARS && (builtAt === null || isTime(builtAt));
    if (!id || typeof s.slug !== "string" || !s.slug || !SUBJECT_KINDS.includes(s.kind) || !SUBJECT_STATUSES.includes(s.status) || !["shared", "private"].includes(scope) || fields === null || aliases === null || !briefOk || !isTime(s.created_at) || !isTime(s.updated_at)) {
      errors.push({ id, error: "A subject needs id, slug, a kind and status it knows, scope shared or private, fields as a JSON object, aliases as a JSON list, created_at and updated_at, and member_hash, built_at and stale_reason when it has them." });
    } else {
      statements.push(
        db
          .prepare("INSERT OR IGNORE INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at, member_hash, built_at, stale_reason) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)")
          .bind(id, s.slug, s.kind, s.status, scope, fields, aliases, s.created_at, s.updated_at, memberHash, builtAt, staleReason, id),
      );
    }
  }
  let added = 0;
  for (let i = 0; i < statements.length; i += LINK_BATCH) added += (await db.batch(statements.slice(i, i + LINK_BATCH))).reduce((n, r) => n + r.meta.changes, 0);
  return added;
}

/**
 * A device comes back revoked unless the admin named it in reactivate. A backup taken before a revocation still shows the
 * device as active, so a restore must not revive it silently. A device already revoked in the backup keeps its time.
 * Returns the number of rows added and the ids that came back active, which is what the admin asked for.
 * allow_private comes back as stored, and a backup from before it has none, which means the device may see private subjects.
 */
async function importDevices(db, devices, errors, reactivate, now) {
  const statements = [];
  const reactivated = [];
  for (const d of devices) {
    const id = typeof d?.id === "string" ? d.id.slice(0, 64) : null;
    if (d && typeof d === "object" && "token" in d) {
      errors.push({ id, error: "A device is only imported with its token hash, never with the token." });
    } else if (!id || typeof d.label !== "string" || !HASH.test(d.token_hash ?? "") || !isTime(d.created_at) || [d.last_used_at, d.revoked_at].some((t) => t !== undefined && t !== null && !isTime(t))) {
      errors.push({ id, error: "A device needs id, label, created_at and a token_hash that is a 64 character SHA-256 hex digest." });
    } else if (d.allow_private !== undefined && d.allow_private !== 0 && d.allow_private !== 1) {
      errors.push({ id, error: "A device's allow_private must be 0 or 1." });
    } else {
      let revokedAt = d.revoked_at ?? now;
      if (reactivate.includes(d.id)) {
        revokedAt = d.revoked_at ?? null;
        if (revokedAt === null) reactivated.push(id);
      }
      statements.push(db.prepare("INSERT OR IGNORE INTO devices (id, label, token_hash, created_at, last_used_at, revoked_at, allow_private) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, d.label, d.token_hash, d.created_at, d.last_used_at ?? null, revokedAt, d.allow_private ?? 1));
    }
  }
  if (!statements.length) return { changes: 0, reactivated };
  const changes = (await db.batch(statements)).reduce((n, r) => n + r.meta.changes, 0);
  return { changes, reactivated };
}

/**
 * Import one page of a v2 document.
 * @param {{DB: any}} env
 * @param {Record<string, any>} body the parsed document
 * @param {{offset: number, limit: number}} page
 * @param {string[]} memoryIds receives the ids that were stored
 */
export async function importV2(env, body, { offset, limit }, memoryIds) {
  const db = env.DB;
  if (!Array.isArray(body.entries)) throw badRequest("entries must be a list.");
  const lists = Object.fromEntries(["versions", "questions", "links", "link_rejections", "subjects", "devices"].map((k) => [k, body[k] ?? []]));
  for (const [k, v] of Object.entries(lists)) if (!Array.isArray(v)) throw badRequest(`${k} must be a list.`);
  const reactivate = body.reactivate_devices ?? [];
  if (!Array.isArray(reactivate) || !reactivate.every((x) => typeof x === "string")) throw badRequest("reactivate_devices must be a list of device ids.");
  checkChild(lists.versions, "versions", { seq: "number", snapshot: "string", reason: "string", created_at: "number" });
  checkChild(lists.questions, "questions", { position: "number", text: "string", created_at: "number" });

  const page = body.entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const ids = page.map((e) => (typeof e?.id === "string" ? e.id : "")).filter(Boolean);
  const { results } = await db.prepare("SELECT id FROM memories WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
  const seen = new Set(results.map((r) => r.id));
  const versionsOf = groupBy(lists.versions);
  const questionsOf = groupBy(lists.questions);

  const errors = [];
  const counts = { imported: 0, skipped: 0, versions: 0, questions: 0 };
  const note = (entry, err) => {
    if (errors.length < MAX_ERRORS) errors.push({ id: typeof entry?.id === "string" ? entry.id.slice(0, 64) : null, error: err instanceof HttpError ? err.message : `The entry could not be stored (${String(err?.message ?? err).slice(0, 120)}).` });
  };
  const one = async (entry) => {
    if (typeof entry?.id === "string" && seen.has(entry.id)) return void counts.skipped++;
    try {
      const values = memoryValues(entry);
      seen.add(entry.id);
      const versions = versionsOf.get(entry.id) ?? [];
      const questions = questionsOf.get(entry.id) ?? [];
      await db.batch(statementsFor(db, entry, values, versions, questions));
      memoryIds.push(entry.id);
      counts.imported++;
      counts.versions += versions.length;
      counts.questions += questions.length;
    } catch (err) {
      seen.delete(entry?.id);
      counts.skipped++;
      note(entry, err);
    }
  };
  for (let i = 0; i < page.length; i += PARALLEL) await Promise.all(page.slice(i, i + PARALLEL).map(one));

  const remaining = Math.max(0, body.entries.length - nextOffset);
  let links = 0;
  let linkRejections = 0;
  let subjects = 0;
  let devices = 0;
  let reactivated = [];
  if (remaining === 0) {
    links = await importLinks(db, lists.links);
    linkRejections = await importLinkRejections(db, lists.link_rejections);
    subjects = await importSubjects(db, lists.subjects, errors);
    const dev = await importDevices(db, lists.devices, errors, reactivate, Date.now());
    devices = dev.changes;
    reactivated = dev.reactivated;
  }
  return { ok: true, format: 2, ...counts, links, link_rejections: linkRejections, subjects, devices, reactivated_devices: reactivated, errors, next_offset: nextOffset, remaining };
}
