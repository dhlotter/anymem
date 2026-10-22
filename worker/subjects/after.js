// What the write path does about subjects once the reply has gone: link the memory to the subjects it is about, record each
// link in the audit trail, and when nothing matched and the extractor named a new subject, hand that name to the proposal step.
// It never throws and it does nothing at all unless autoOn(env). A failure is counted and swallowed, the nightly job and
// the person's own clicks do not depend on it.
import { auditStatement } from "../audit.js";
import { assignMemory } from "./assign.js";
import { autoOn } from "./auto.js";
import { clearCiting } from "./clear.js";
import { SHED_SHARED_SQL } from "../memory/store.js";
import { SEES_PRIVATE_SQL } from "./private.js";
import { proposeFromHint } from "./propose.js";

/**
 * The audit row of a system action, not yet run. The script column keeps how it was decided, in the letters the column allows.
 * @param {{DB: any}} env
 * @param {number} ts
 * @param {string} step assign, propose, cluster or brief
 * @param {string} route
 * @param {string} how
 * @param {string[]} memoryIds the memory and the card involved
 */
export const systemAudit = (env, ts, step, route, how, memoryIds, status = 200, opts) =>
  auditStatement(env.DB, { ts, actor: { kind: "system", id: step }, harness: "system", script: how, method: "SYSTEM", route, status, durationMs: 0, memoryIds }, opts);

/**
 * One system link, as a statement for a batch. It is made only when both ends are live, the pair was not rejected by a person,
 * and (the one thing the nightly read cannot promise, because a person may link the memory a moment later) a memory that belongs to a
 * private subject is not given a shared subject, which would make it visible to every device. A private target is always allowed.
 */
const linkStatement = (env, ts, memoryId, l) =>
  env.DB
    .prepare(
      `INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence)
       SELECT ?, ?, 'about', ?, 'system', ?
       WHERE EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL) AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM link_rejections WHERE source_id = ? AND target_id = ? AND link_type = 'about')
         AND (EXISTS (SELECT 1 FROM subjects WHERE id = ? AND scope = 'private')
              OR NOT EXISTS (SELECT 1 FROM links x JOIN subjects p ON p.id = x.target_id WHERE x.source_id = ? AND x.link_type = 'about' AND p.scope = 'private'))`,
    )
    .bind(memoryId, l.subject_id, ts, l.confidence, memoryId, l.subject_id, memoryId, l.subject_id, l.subject_id, memoryId);

/** True when the writer is a device that may not see private subjects, or a device that cannot be found. Costs one read. */
async function isClosedDevice(env, actor) {
  if (actor?.kind !== "device") return false;
  const open = await env.DB.prepare(`SELECT 1 AS n WHERE ${SEES_PRIVATE_SQL}`).bind(actor.id).first();
  return !open;
}

/** 1 is written 1.0 and 0.54 stays 0.54, so the audit text reads the same as the confidence column. */
const confText = (c) => (Number.isInteger(c) ? c.toFixed(1) : String(c));

/**
 * @param {{DB: any}} env
 * @param {{id: string, content: string, neighbours?: {id: string, similarity: number}[], hint?: {name: string, kind: string}, actor?: {kind: string, id: string}, origin?: string, now: () => number, counters: {bump: (name: string, n?: number) => void}, propose?: Function}} f
 * propose replaces the proposal step, for tests.
 * @returns {Promise<void>}
 */
export async function afterSubjects(env, { id, content, neighbours = [], hint, actor, origin, now, counters, propose }) {
  if (!autoOn(env)) return;
  try {
    const found = await assignMemory(env, { id, content, neighbours, origin, actor });
    // The links and their audit rows go in one batch, so a failure leaves neither, and a link that was not made leaves no row.
    const ts = now();
    const statements = [];
    for (const l of found.links) {
      statements.push(linkStatement(env, ts, id, l));
      statements.push(systemAudit(env, ts, "assign", "assign.link", `how:${l.how}.conf:${confText(l.confidence)}`, [id, l.subject_id], 200, { ifChanged: true }));
    }
    if (found.ambiguous.length) {
      statements.push(systemAudit(env, ts, "assign", "assign.ambiguous", `how:ambiguous.n:${found.ambiguous.length}`, [id, ...found.ambiguous_ids]));
    }
    let assigned = 0;
    if (statements.length) {
      // A memory that now belongs to a private subject loses the links the system made to shared ones, in the same batch (the update in
      // place of a memory a capture linked to a shared subject is the case: it must not keep being visible).
      for (const privateId of found.private_ids) statements.push(env.DB.prepare(SHED_SHARED_SQL).bind(id, "about", privateId, id));
      const done = await env.DB.batch(statements);
      // A link that was decided but not made lost a race (the card went, a person said no, a private link appeared), so it counts as failed.
      for (let i = 0; i < found.links.length; i++) {
        if (done[i * 2].meta.changes > 0) assigned++;
        else counters.bump("subjects.failed");
      }
      if (assigned) counters.bump("subjects.assigned", assigned);
      // The shared briefs that cite a memory that is now private go at once.
      if (found.private_ids.length) await clearCiting(env, { ids: [id], now, sharedOnly: true, why: "member.private" });
      if (found.ambiguous.length) counters.bump("subjects.ambiguous");
    }
    // A hint proposes a new subject only when the memory was linked to nothing. A device that may not see private subjects never proposes:
    // whether the name "exists" or not would tell it whether a private subject has that name. The proposal step also leaves a memory alone
    // that already has an about link, because a link to a new shared card could make a private memory visible.
    if (hint && !assigned && !(await isClosedDevice(env, actor))) {
      await (propose ?? proposeFromHint)(env, { memoryId: id, hint, now });
    }
  } catch {
    counters.bump("subjects.failed");
    console.error("subject assignment failed");
  }
}
