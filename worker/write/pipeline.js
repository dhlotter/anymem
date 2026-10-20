// The write pipeline. POST /capture and everything that writes through it goes down this path, in this order.
//
//  1. normalise   parse the text, tags and frontmatter (memory/parse.js)
//  2. screen      a capture gets every screen, an explicit write gets only the secret check
//  3. limit       40 writes per token in 10 minutes, then 429 and nothing is held
//  4. exact       a live memory of the same project (or a global one) with the same content hash refuses the write
//  5. same name   a capture, profile or person write with the name of a live memory of the same origin and project updates it in place
//  6. neighbours  embed and find the closest live memories, from Vectorize plus the memories of the last ten minutes
//  7. near        0.95 or above refuses, 0.85 to 0.95 stores with a warning
//  8. contradict  a clash with a neighbour is settled by two agreeing model answers, else both stay live
//  9. store       one D1 batch
// 10. after       index and classify the kind in the background
//
// The profile and person origins are pinned. They skip steps 6 to 8 and go straight to the store.
import { createCounters } from "../counters.js";
import { takeWriteSlot, writeRefused } from "../limits.js";
import { ADMIN_ORIGINS, adminHeld, adminOnlyMessage, adminOnlyTags, parseMemory } from "../memory/parse.js";
import { createStore } from "../memory/store.js";
import { hiddenIds } from "../subjects/private.js";
import { indexMemories } from "../search/indexer.js";
import { judgeConflict } from "./conflict.js";
import { classifyKind } from "./kind.js";
import { findNeighbours } from "./neighbours.js";
import { REASONS, screenCapture, screenExplicit } from "./screen.js";

export const PROBATION_MS = 60 * 24 * 60 * 60 * 1000;
export const REFUSE_SIMILARITY = 0.95;
export const WARN_SIMILARITY = 0.85;
const PINNED_ORIGINS = ["profile", "person"];
const SAME_NAME_ORIGINS = ["capture", ...PINNED_ORIGINS];
const LIVE_SAME = "deleted_at IS NULL AND valid_until IS NULL";
const round4 = (n) => Math.round(n * 10_000) / 10_000;

/** Index and classify after the reply has gone. Each can fail alone, and the nightly job picks up what is missing. */
async function afterWrite(env, id, now) {
  const counters = createCounters(env.DB, now);
  await Promise.allSettled([
    indexMemories(env, [id], now).catch(() => console.error("indexing failed")),
    classifyKind(env, id, counters),
  ]);
  await counters.flush();
}

/**
 * @typedef {object} WriteContext
 * @property {{DB: any, AI: any, VECTORIZE: any}} env
 * @property {{waitUntil: (p: Promise<any>) => void}} ctx
 * @property {() => number} now
 * @property {string} actorId the device id, or "admin"
 * @property {string} actorKind "admin", "browser" or "device"
 * @property {string[]} memoryIds filled with the ids the write touched, for the audit row
 */

/**
 * @typedef {object} Write
 * @property {string} content
 * @property {string[]} tags including a project tag when there is a project
 * @property {string} origin
 * @property {string} harness
 * @property {string} session
 */

/**
 * @param {WriteContext} c
 * @param {Write} w
 * @returns {Promise<{status: number, body: object, headers?: Record<string, string>}>}
 */
export async function writeMemory(c, w) {
  const counters = createCounters(c.env.DB, c.now);
  try {
    return await run(c, w, counters);
  } finally {
    c.ctx.waitUntil(counters.flush());
  }
}

async function run({ env, ctx, now, actorId, actorKind, memoryIds }, w, counters) {
  const store = createStore(env.DB, now);
  const isCapture = w.origin === "capture";
  const pinned = PINNED_ORIGINS.includes(w.origin);

  // 1
  const parsed = await parseMemory(w.content, w.tags);
  // A device token may not write an admin only origin or tag. This is checked before the screens, so it is the same answer for any text.
  if (actorKind === "device") {
    const restricted = [...(ADMIN_ORIGINS.includes(w.origin) ? [`origin ${w.origin}`] : []), ...adminOnlyTags([...parsed.tags, ...(parsed.status ? [`status:${parsed.status}`] : [])])];
    if (restricted.length) return { status: 403, body: { ok: false, error: adminOnlyMessage(restricted), code: "admin_only" } };
  }

  // 2
  const screened = isCapture ? await screenCapture(env, parsed.content, counters) : screenExplicit(parsed.content);
  if (!screened.ok) {
    counters.bump(`capture.rejected.${screened.reason}`);
    return { status: 422, body: { ok: false, error: REASONS[screened.reason], code: "refused", reason: screened.reason } };
  }

  // 3
  const slot = await takeWriteSlot(env.DB, actorId, now());
  if (!slot.ok) {
    counters.bump("capture.rejected.rate_limited");
    return writeRefused(slot);
  }

  // 4. Duplicates, near duplicates and contradictions only look at the memories of this project and the global ones (project '').
  const scope = parsed.project ?? "";
  const exact = async () => env.DB.prepare(`SELECT id FROM memories WHERE content_hash = ? AND project IN (?, '') AND ${LIVE_SAME} LIMIT 1`).bind(parsed.content_hash, scope).first();
  // A device that may not see private subjects is told "duplicate" for a match it may not see, without the id, so a capture cannot probe a hidden memory.
  const actor = { kind: actorKind, id: actorId };
  const hides = async (id) => Boolean(id) && (await hiddenIds(env.DB, [id], actor)).has(id);
  const duplicate = async (found) => {
    counters.bump("capture.rejected.duplicate");
    if (await hides(found.id)) return { status: 200, body: { ok: true, duplicate: true } };
    memoryIds.push(found.id);
    return { status: 200, body: { ok: true, duplicate: true, matchId: found.id } };
  };
  const dup = await exact();
  if (dup) return duplicate(dup);

  // 5. Only a memory of the same project is updated. An update also sets the project from the write's tags, so a memory of
  // another project (or a global one, for a project write) would move.
  if (SAME_NAME_ORIGINS.includes(w.origin) && parsed.name) {
    let same = await env.DB.prepare(`SELECT id FROM memories WHERE name = ? AND origin = ? AND project = ? AND ${LIVE_SAME} ORDER BY created_at DESC, id DESC LIMIT 1`).bind(parsed.name, w.origin, scope).first();
    if (same && (await hides(same.id))) same = null; // a hidden memory is not updated by a device, the capture is stored as a new memory
    // A device token never reaches a memory that holds capsule tags or canonical status, so a same name capture is stored as a new memory.
    const sameEntry = same && actorKind === "device" ? await store.get(same.id) : null;
    const held = sameEntry ? adminHeld(sameEntry) : [];
    if (same && !held.length) {
      const entry = await store.update({ id: same.id, content: parsed.content, tags: w.tags });
      memoryIds.push(entry.id);
      counters.bump("capture.updated_in_place");
      ctx.waitUntil(afterWrite(env, entry.id, now));
      return { status: 200, body: { ok: true, id: entry.id, status: entry.status, tags: entry.tags, updated: true } };
    }
  }

  // 6 to 8
  let neighbours = [];
  if (!pinned) {
    try {
      neighbours = await findNeighbours(env, parsed, now, 10, scope);
    } catch {
      counters.bump("model.failure.embed");
    }
  }
  const hidden = await hiddenIds(env.DB, neighbours.map((n) => n.id), actor);
  const nearest = neighbours[0];
  if (nearest && nearest.similarity >= REFUSE_SIMILARITY) {
    counters.bump("capture.rejected.near_duplicate");
    if (hidden.has(nearest.id)) return { status: 200, body: { ok: true, duplicate: true } };
    memoryIds.push(nearest.id);
    return { status: 200, body: { ok: true, duplicate: true, matchId: nearest.id, score: round4(nearest.similarity) } };
  }
  // The warning and the contradiction check only look at memories the writer may see.
  if (hidden.size) neighbours = neighbours.filter((n) => !hidden.has(n.id));
  const top = neighbours[0];
  const decision = await judgeConflict(env, parsed.content, neighbours, counters);

  // 9
  const entry = await store.create(
    { ...parsed, origin: w.origin, harness: w.harness, session: w.session, probation_until: isCapture ? now() + PROBATION_MS : null },
    { unlessLiveDuplicate: true },
  );
  if (!entry) {
    // A racing write of the same text landed between the check and the insert.
    const winner = await exact();
    return duplicate(winner ?? { id: "" });
  }
  memoryIds.push(entry.id);
  counters.bump("capture.accepted");

  const body = { ok: true, id: entry.id, status: entry.status, tags: entry.tags };
  if (top && top.similarity >= WARN_SIMILARITY) {
    counters.bump("conflicts.similar_warning");
    Object.assign(body, { warning: "similar", matchId: top.id, score: round4(top.similarity) });
  }
  if (decision.action === "replace") {
    try {
      await store.supersede(decision.oldId, entry.id, now());
      memoryIds.push(decision.oldId);
      counters.bump("conflicts.replaced");
      body.replaced = { id: decision.oldId, reason: "contradiction" };
    } catch {
      // The old memory changed or went away in the meantime. Both stay as they are.
      counters.bump("conflicts.kept_both.unsure");
      body.kept_both = { id: decision.oldId, reason: "unsure" };
    }
  } else if (decision.action === "keep_both") {
    counters.bump(`conflicts.kept_both.${decision.reason}`);
    body.kept_both = { id: decision.id, reason: decision.reason };
  }

  // 10
  ctx.waitUntil(afterWrite(env, entry.id, now));
  return { status: 200, body };
}
