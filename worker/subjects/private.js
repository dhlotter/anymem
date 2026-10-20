// The private rule, in one place. A device token whose device has allow_private 0 never sees a private subject, its card
// memory, or a memory whose only about links go to private subjects. The admin token, a browser login and a device with
// allow_private 1 see everything. Every route that returns a memory or a subject asks this module, none repeats the rule.
// Each call is one query, however many ids it is given, and an actor that sees everything costs no query at all.

/** True for an actor the rule can hide things from: a device token. The admin token and a browser login never are. */
export const mayBeRestricted = (actor) => actor?.kind === "device";

/**
 * SQL that is true when the device may see private subjects. A device row that cannot be found does not, so the rule fails closed.
 * Bind the device id once for each time the text is used.
 */
export const SEES_PRIVATE_SQL = "EXISTS (SELECT 1 FROM devices WHERE id = ? AND allow_private = 1)";

// The memory is the card of a private subject, or it has an about link to a private subject and none to a shared one.
const ABOUT = (col, scope) => `EXISTS (SELECT 1 FROM links l JOIN subjects s ON s.id = l.target_id WHERE l.source_id = ${col} AND l.link_type = 'about' AND s.scope ${scope})`;
const HIDDEN_FOR = (col) => `NOT ${SEES_PRIVATE_SQL} AND (EXISTS (SELECT 1 FROM subjects c WHERE c.id = ${col} AND c.scope = 'private') OR (${ABOUT(col, "= 'private'")} AND NOT ${ABOUT(col, "<> 'private'")}))`;
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
