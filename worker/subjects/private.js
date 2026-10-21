// The private rule, in one place. A device token whose device has allow_private 0 never sees a private subject, its card
// memory, or a memory whose only about links go to private subjects. The admin token, a browser login and a device with
// allow_private 1 see everything. A proposal nobody accepted yet is hidden from a closed device as well. Every route that returns a memory or a subject asks this module, none repeats the rule.
// Each call is one query, however many ids it is given, and an actor that sees everything costs no query at all.

/** True for an actor the rule can hide things from: a device token. The admin token and a browser login never are. */
export const mayBeRestricted = (actor) => actor?.kind === "device";

/**
 * SQL that is true when the device may see private subjects. A device row that cannot be found does not, so the rule fails closed.
 * Bind the device id once for each time the text is used.
 */
export const SEES_PRIVATE_SQL = "EXISTS (SELECT 1 FROM devices WHERE id = ? AND allow_private = 1)";

// A proposal is a subject the system suggested and nobody accepted: its row is `proposed`, or it was dismissed and its card is still
// pending. A closed device never sees one (not the card, not the links to it), and a link to one never counts as a shared link, so it
// cannot un-hide a memory that also belongs to a private subject. A proposal is always scope shared, so scope alone would not hide it.
const PROPOSAL = (t) => `(${t}.status = 'proposed' OR EXISTS (SELECT 1 FROM memories pc WHERE pc.id = ${t}.id AND pc.status = 'pending'))`;
// The memory is the card of a private subject or of a proposal, or it has an about link to a private subject and none to a shared one.
const ABOUT = (col, cond) => `EXISTS (SELECT 1 FROM links l JOIN subjects s ON s.id = l.target_id WHERE l.source_id = ${col} AND l.link_type = 'about' AND ${cond})`;
const HIDDEN_FOR = (col) => `NOT ${SEES_PRIVATE_SQL} AND (EXISTS (SELECT 1 FROM subjects c WHERE c.id = ${col} AND (c.scope = 'private' OR ${PROPOSAL("c")})) OR (${ABOUT(col, "s.scope = 'private'")} AND NOT ${ABOUT(col, `s.scope <> 'private' AND NOT ${PROPOSAL("s")}`)}))`;
const HIDDEN_SQL = `SELECT j.value AS id FROM json_each(?) j WHERE ${HIDDEN_FOR("j.value")}`;

/**
 * SQL that is true for a row the device may not see, for paging in SQL so a page and its cursor never name a hidden row.
 * Bind the device id once. Use it only for a device actor.
 * @param {string} col the column that holds the memory id
 */
export const hiddenWhere = (col) => `(${HIDDEN_FOR(col)})`;

/**
 * The ids the actor may not see.
 * @param {any} db
 * @param {string[]} ids
 * @param {{kind: string, id: string} | undefined} actor
 * @returns {Promise<Set<string>>}
 */
export async function hiddenIds(db, ids, actor) {
  if (!mayBeRestricted(actor) || !ids.length) return new Set();
  const { results } = await db.prepare(HIDDEN_SQL).bind(JSON.stringify([...new Set(ids)]), actor.id).all();
  return new Set(results.map((r) => r.id));
}

/** @returns {Promise<boolean>} */
export async function canSee(db, id, actor) {
  return !(await hiddenIds(db, [id], actor)).has(id);
}

/** The rows the actor may see, in their order. idOf says where a row keeps the memory id. */
export async function visibleOnly(db, rows, actor, idOf = (r) => r.id) {
  const hidden = await hiddenIds(db, rows.map(idOf), actor);
  return hidden.size ? rows.filter((r) => !hidden.has(idOf(r))) : rows;
}
