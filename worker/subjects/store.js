// The subject layer. A subject is a thing memories are about. Its card is an ordinary memory that holds the brief,
// written through the memory store, and a row in `subjects` holds the kind, status, scope, fields and aliases.
// A memory is a member when an `about` link runs from it to the card.
import { badRequest, conflict, notFound } from "../http.js";
import { createStore } from "../memory/store.js";
import { parseMemory } from "../memory/parse.js";
import { LIVE } from "../system.js";

export const KINDS = ["person", "pet", "asset", "project", "area", "topic"];
export const STATUSES = ["proposed", "active", "stale", "retired"];
/** The statuses a person may set. The other two belong to the system. */
export const SETTABLE_STATUSES = ["active", "retired"];
export const SCOPES = ["shared", "private"];
/** The keys a subject of each kind may hold. No health or money field is ever allowed on a person. */
export const FIELD_KEYS = {
  person: ["relationship", "known_as", "work", "contact", "birthday"],
  pet: ["name", "species", "breed", "born", "vet", "status", "health_note"],
  asset: ["type", "name", "identifier", "acquired", "status", "value_note"],
  project: ["what", "status", "owner", "repo"],
  area: ["what", "status"],
  topic: ["what"],
};

export const MEMBER_CAP = 200;
const MAX_NAME_CHARS = 80;
const MAX_VALUE_CHARS = 200;
const MAX_ALIASES = 20;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const hasControl = (s) => /\p{Cc}/u.test(s);

function checkText(value, max, what, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || hasControl(text)) throw badRequest(`${what} must be 1 to ${max} characters without control characters.`, code);
  return text;
}

/** @returns {string} */
export function checkSlug(slug) {
  if (typeof slug !== "string" || slug.length < 2 || slug.length > 40 || !SLUG.test(slug)) {
    throw badRequest("slug must be 2 to 40 characters: lowercase letters and digits, with single dashes between them.", "bad_slug");
  }
  return slug;
}

/** @returns {string} */
export const checkName = (name) => checkText(name, MAX_NAME_CHARS, "name", "bad_name");

/** @returns {string} */
export function checkKind(kind) {
  if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(", ")}.`, "bad_kind");
  return kind;
}

/** @returns {string} */
export function checkScope(scope) {
  if (!SCOPES.includes(scope)) throw badRequest(`scope must be one of ${SCOPES.join(", ")}.`, "bad_scope");
  return scope;
}

/** @returns {string} */
export function checkBrief(brief) {
  if (typeof brief !== "string") throw badRequest("brief must be a string.", "bad_brief");
  return brief.trim();
}

/** Lowercase, trimmed, no duplicates. @returns {string[]} */
export function checkAliases(aliases) {
  if (!Array.isArray(aliases) || aliases.length > MAX_ALIASES) throw badRequest(`aliases must be a list of at most ${MAX_ALIASES} names.`, "bad_alias");
  return [...new Set(aliases.map((a) => checkText(a, MAX_NAME_CHARS, "an alias", "bad_alias").toLowerCase()))];
}

/**
 * Merge new field values into the stored ones. A value is a string, null removes the key, a key the kind does not allow is 400 bad_field.
 * Setting a key confirms it again, so it gets a new confirmed_at.
 * @param {string} kind
 * @param {Record<string, {value: string, confirmed_at: number, source: string}>} current
 * @param {unknown} input
 * @param {number} at
 */
export function mergeFields(kind, current, input, at) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw badRequest("fields must be an object.", "bad_field");
  const out = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!FIELD_KEYS[kind].includes(key)) throw badRequest(`${key} is not a field of a ${kind}. Use ${FIELD_KEYS[kind].join(", ")}.`, "bad_field");
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = { value: checkText(value, MAX_VALUE_CHARS, `The value of ${key} (send null to remove it)`, "bad_field"), confirmed_at: at, source: "user" };
  }
  return out;
}

/** The text of a card memory. The name line is the slug, the description holds the display name. */
const cardContent = ({ slug, kind, name, brief }) => `---\nname: ${slug}\ndescription: ${kind} card for ${name}\nmetadata:\n  type: project\n---\n\n${brief}`;

/** The display name sits in the card's description after "<kind> card for ". A card that was edited by hand falls back to the slug. */
const nameOf = (row) => (row.description.startsWith(`${row.kind} card for `) ? row.description.slice(`${row.kind} card for `.length) : row.slug);

const PICK = "s.id, s.slug, s.kind, s.status, s.scope, s.fields, s.aliases, s.created_at, s.updated_at, m.description, m.body";

/**
 * @param {any} db the D1 binding
 * @param {() => number} [now] milliseconds
 */
export function createSubjectStore(db, now = Date.now) {
  const memories = createStore(db, now);

  const shape = (row, memberCount) => ({
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    scope: row.scope,
    name: nameOf(row),
    aliases: JSON.parse(row.aliases),
    fields: JSON.parse(row.fields),
    member_count: memberCount,
    updated_at: row.updated_at,
  });

  /** Live memories with an about link to each card, by card id. */
  async function counts(ids) {
    if (!ids.length) return new Map();
    const { results } = await db.prepare(`SELECT l.target_id AS id, COUNT(*) AS n FROM links l JOIN memories m ON m.id = l.source_id WHERE l.link_type = 'about' AND l.target_id IN (SELECT value FROM json_each(?)) AND m.${LIVE} GROUP BY l.target_id`).bind(JSON.stringify(ids)).all();
    return new Map(results.map((r) => [r.id, r.n]));
  }

  /** The row of a subject whose card is not in the trash, found by id or by slug. */
  const row = (where, value) => db.prepare(`SELECT ${PICK} FROM subjects s JOIN memories m ON m.id = s.id WHERE m.deleted_at IS NULL AND s.${where} = ?`).bind(value).first();

  /** The id of a subject, from the id or the slug the caller sent. Null when there is none. */
  async function idOf({ id, slug }) {
    const found = typeof id === "string" && id ? await row("id", id) : typeof slug === "string" && slug ? await row("slug", slug) : null;
    return found?.id ?? null;
  }

  async function get(id) {
    const found = await row("id", id);
    if (!found) return null;
    const { results } = await db.prepare(`SELECT m.id, m.name, m.updated_at FROM links l JOIN memories m ON m.id = l.source_id WHERE l.target_id = ? AND l.link_type = 'about' AND m.${LIVE} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`).bind(id, MEMBER_CAP).all();
    return { ...shape(found, (await counts([id])).get(id) ?? 0), brief: found.body, members: results.map((r) => ({ id: r.id, name: r.name, updated_at: r.updated_at })) };
  }

  return {
    idOf,
    get,

    /**
     * Make a subject: the card memory first (origin system), then the row. A slug that is taken is 409 subject_exists.
     * @param {{slug: string, kind: string, name: string, brief?: string, fields?: unknown, aliases?: unknown, scope?: string, harness?: string}} f the harness is the caller's name from the request header, never from the body
     */
    async create(f) {
      const slug = checkSlug(f.slug);
      const kind = checkKind(f.kind);
      const name = checkName(f.name);
      const brief = f.brief === undefined ? "" : checkBrief(f.brief);
      const aliases = f.aliases === undefined ? [] : checkAliases(f.aliases);
      const scope = f.scope === undefined ? "shared" : checkScope(f.scope);
      const at = now();
      const fields = f.fields === undefined ? {} : mergeFields(kind, {}, f.fields, at);
      const taken = () => conflict(`A subject with the slug ${slug} exists already.`, "subject_exists");
      if (await db.prepare("SELECT 1 AS n FROM subjects WHERE slug = ?").bind(slug).first()) throw taken();
      const parsed = await parseMemory(cardContent({ slug, kind, name, brief }), ["subject", `subject:${slug}`, `subject-kind:${kind}`]);
      const card = await memories.create({ ...parsed, origin: "system", harness: f.harness ?? "" });
      try {
        await db.prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)").bind(card.id, slug, kind, scope, JSON.stringify(fields), JSON.stringify(aliases), at, at).run();
      } catch (err) {
        // Two requests for one slug: the loser's card goes to the trash, and the nightly purge removes it.
        await memories.softDelete(card.id).catch(() => {});
        if (/UNIQUE constraint failed: subjects/.test(String(err?.message))) throw taken();
        throw err;
      }
      return get(card.id);
    },

    /**
     * Change a subject. fields merge (null removes a key), aliases replace the list, a new brief or name writes a new version of the card.
     * @param {string} id
     * @param {{name?: string, brief?: string, fields?: unknown, aliases?: unknown, scope?: string, status?: string}} f
     */
    async update(id, f) {
      const cur = await row("id", id);
      if (!cur) throw notFound("No subject with that id or slug.");
      const set = {};
      const at = now();
      if (f.scope !== undefined) set.scope = checkScope(f.scope);
      if (f.status !== undefined) {
        if (!SETTABLE_STATUSES.includes(f.status)) throw badRequest(`status must be one of ${SETTABLE_STATUSES.join(", ")}. The other statuses are set by the system.`, "bad_status");
        set.status = f.status;
      }
      if (f.aliases !== undefined) set.aliases = JSON.stringify(checkAliases(f.aliases));
      if (f.fields !== undefined) set.fields = JSON.stringify(mergeFields(cur.kind, JSON.parse(cur.fields), f.fields, at));
      const name = f.name === undefined ? nameOf(cur) : checkName(f.name);
      const brief = f.brief === undefined ? cur.body : checkBrief(f.brief);
      if (f.name !== undefined || f.brief !== undefined) await memories.update({ id, content: cardContent({ slug: cur.slug, kind: cur.kind, name, brief }) });
      set.updated_at = at;
      const columns = Object.keys(set);
      await db.prepare(`UPDATE subjects SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...columns.map((c) => set[c]), id).run();
      // A dismissed proposal still has a pending card. Bringing the subject back makes the card active too, or recall would never offer it.
      if (f.status === "active" && (await db.prepare("SELECT status FROM memories WHERE id = ?").bind(id).first())?.status === "pending") await memories.setStatus(id, "active");
      return get(id);
    },

    /**
     * Subjects newest updated first. q is a case blind piece of the slug, the name or an alias.
     * @param {{kind?: string, status?: string, scope?: string, q?: string}} [f]
     */
    async list({ kind, status, scope, q } = {}) {
      const where = ["m.deleted_at IS NULL"];
      const args = [];
      for (const [column, value] of [["kind", kind], ["status", status], ["scope", scope]]) {
        if (value) (where.push(`s.${column} = ?`), args.push(value));
      }
      const { results } = await db.prepare(`SELECT ${PICK} FROM subjects s JOIN memories m ON m.id = s.id WHERE ${where.join(" AND ")} ORDER BY s.updated_at DESC, s.id DESC LIMIT 1000`).bind(...args).all();
      const needle = q?.trim().toLowerCase();
      const rows = needle ? results.filter((r) => [r.slug, nameOf(r), ...JSON.parse(r.aliases)].some((t) => t.toLowerCase().includes(needle))) : results;
      const n = await counts(rows.map((r) => r.id));
      return rows.map((r) => shape(r, n.get(r.id) ?? 0));
    },
  };
}
