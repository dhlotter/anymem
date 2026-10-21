// What the write path does about subjects once the reply has gone: link the memory to the subjects it is about, record each
// link in the audit trail, and when nothing matched and the extractor named a new subject, hand that name to the proposal step.
// It never throws and it does nothing at all unless autoOn(env). A failure is counted and swallowed, the nightly job and
// the person's own clicks do not depend on it.
import { auditStatement } from "../audit.js";
import { createStore } from "../memory/store.js";
import { assignMemory } from "./assign.js";
import { autoOn } from "./auto.js";

/**
 * The audit row of a system action, not yet run. The script column keeps how it was decided, in the letters the column allows.
 * @param {{DB: any}} env
 * @param {number} ts
 * @param {string} step assign, propose, cluster or brief
 * @param {string} route
 * @param {string} how
 * @param {string[]} memoryIds the memory and the card involved
 */
export const systemAudit = (env, ts, step, route, how, memoryIds, status = 200) =>
  auditStatement(env.DB, { ts, actor: { kind: "system", id: step }, harness: "system", script: how, method: "SYSTEM", route, status, durationMs: 0, memoryIds });

/** 1 is written 1.0 and 0.54 stays 0.54, so the audit text reads the same as the confidence column. */
const confText = (c) => (Number.isInteger(c) ? c.toFixed(1) : String(c));

/** The proposal step comes from its own module. It is loaded on use so this one stands without it. */
const loadPropose = async () => (await import("./propose.js")).proposeFromHint;

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
    const store = createStore(env.DB, now);
    const rows = [];
    let assigned = 0;
    for (const l of found.links) {
      try {
        const { created } = await store.link(id, l.subject_id, "about", { madeBy: "system", confidence: l.confidence });
        if (!created) continue;
      } catch {
        // A memory or card that went away between the read and the write is not an error worth more than a count.
        counters.bump("subjects.failed");
        continue;
      }
      assigned++;
      counters.bump("subjects.assigned");
      rows.push(systemAudit(env, now(), "assign", "assign.link", `how:${l.how}.conf:${confText(l.confidence)}`, [id, l.subject_id]));
    }
    if (found.ambiguous.length) {
      counters.bump("subjects.ambiguous");
      rows.push(systemAudit(env, now(), "assign", "assign.ambiguous", `how:ambiguous.n:${found.ambiguous.length}`, [id, ...found.ambiguous_ids]));
    }
    if (rows.length) await env.DB.batch(rows);
    if (hint && !assigned) {
      await (propose ?? (await loadPropose()))(env, { memoryId: id, hint, now });
    }
  } catch {
    counters.bump("subjects.failed");
    console.error("subject assignment failed");
  }
}
