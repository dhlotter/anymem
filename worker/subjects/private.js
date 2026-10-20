// STUB. The recall team writes the real private rule in this file. The integrator replaces this file with theirs.
// Same exports, same arguments. This one hides nothing, so the subject routes can be built and tested without it.

/** The ids from `ids` that the actor may not see. @returns {Promise<Set<string>>} */
export async function hiddenIds(_db, _ids, _actor) {
  return new Set();
}

/** @returns {Promise<boolean>} */
export async function canSee(_db, _id, _actor) {
  return true;
}

/** The rows the actor may see. idOf says where a row keeps its memory id. */
export async function visibleOnly(_db, rows, _actor, _idOf = (r) => r.id) {
  return rows;
}
