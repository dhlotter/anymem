// Proposed subjects. The system never makes an active subject on its own. It makes a proposal: a subject row with status `proposed`
// and a card memory with status `pending`, which recall and search never return. The person accepts it (it becomes active and
// the evidence is already linked) or dismisses it (it is retired and the slug stays taken, so the same proposal never comes back).
import { recordAudit } from "../audit.js";
import { parseMemory } from "../memory/parse.js";
import { createStore } from "../memory/store.js";
import { readsAsInstruction, screenExplicit } from "../write/screen.js";
import { autoOn } from "./auto.js";
import { cleanHint, HINT_ORIGINS, isGeneric, mentions, plainName } from "./hint.js";
import { checkName, KINDS, PROPOSED_BRIEF } from "./store.js";

export { PROPOSED_BRIEF };

/** Proposals waiting for a click at one time. More than this and a proposal is refused, so a flood of captures cannot bury the person. The insert itself checks it. */
export const MAX_PROPOSED = 25;
const MAX_EVIDENCE = 50;
const SLUG_MIN = 2;
const SLUG_MAX = 40;

/** What the audit row says for each step that proposes. */
const STEPS = { propose: { route: "propose.subject", how: "hint" }, cluster: { route: "cluster.propose", how: "cluster" } };

// The same card text as createSubjectStore, written here so this module does not reach into the store's private helpers. A test keeps the two equal.
const cardContent = ({ slug, kind, name, brief }) => `---\nname: ${slug}\ndescription: ${kind} card for ${name}\nmetadata:\n  type: project\n---\n\n${brief}`;

/** A slug from a display name: lowercase letters and digits with single dashes, a leading "the" dropped. Null when nothing valid is left. */
export function slugOf(name) {
  const plain = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const bare = plain.startsWith("the-") ? plain.slice(4) : plain;
  const slug = (bare || plain).slice(0, SLUG_MAX).replace(/-+$/, "");
  return slug.length >= SLUG_MIN ? slug : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const asClock = (now) => (typeof now === "function" ? now : () => (Number.isFinite(now) ? now : Date.now()));

/** The evidence that can be used: a memory id and a confidence from 0 to 1, each memory once. */
function cleanEvidence(evidence) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(evidence) ? evidence : []) {
    if (!e || typeof e.id !== "string" || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, confidence: round2(Math.min(1, Math.max(0, Number.isFinite(e.confidence) ? e.confidence : 1))) });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

const decimal = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

async function audit(db, { step, conf, now, status, ids }) {
  // The script column keeps letters, digits and ._:- only, so the decision is written as how:hint.conf:1.0
  const script = `how:${STEPS[step].how}.conf:${decimal(conf)}`;
  await recordAudit(db, { ts: now(), actor: { kind: "system", id: step }, harness: "system", script, method: "SYSTEM", route: STEPS[step].route, status, durationMs: 0, memoryIds: ids }).catch(() => console.error("audit write failed"));
}

/**
 * Make a proposed subject with its evidence. Returns {ok: true, slug, id}, or {ok: false, reason} where reason is bad_name, bad_kind,
 * generic, secret, instruction, no_evidence, exists or failed. Nothing is made for a refusal. The unique slug is the guard against two
 * callers at once: the loser's card goes to the trash and it gets "exists".
 * step says who is proposing, "propose" for a hint or "cluster" for the nightly clustering, and picks the audit route.
 * Never throws.
 * @param {{DB: any}} env
 * @param {{name: string, kind: string, evidence: {id: string, confidence: number}[], now: (() => number) | number, madeBy?: string, step?: "propose" | "cluster"}} f
 * @returns {Promise<{ok: true, slug: string, id: string} | {ok: false, reason: string}>}
 */
export async function createProposed(env, { name, kind, evidence, now, madeBy = "system", step = "propose" }) {
  const clock = asClock(now);
  const db = env.DB;
  let text;
  try {
    text = checkName(name);
  } catch {
    return { ok: false, reason: "bad_name" };
  }
  // The same plain text rule as a hint, so a name from any caller cannot carry a link, an address, a sentence or hidden characters.
  text = plainName(text);
  if (!text) return { ok: false, reason: "bad_name" };
  if (!KINDS.includes(kind)) return { ok: false, reason: "bad_kind" };
  const slug = slugOf(text);
  if (!slug) return { ok: false, reason: "bad_name" };
  if (isGeneric(text) || isGeneric(slug.replace(/-/g, " "))) return { ok: false, reason: "generic" };
  if (!screenExplicit(text).ok) return { ok: false, reason: "secret" };
  if (readsAsInstruction(text)) return { ok: false, reason: "instruction" };
  const proof = cleanEvidence(evidence);
  if (!proof.length) return { ok: false, reason: "no_evidence" };

  const folded = text.toLowerCase().split(/\s+/).join(" ");
  const who = STEPS[step] ? step : "propose";
  let cardId = null;
  let rowMade = false;
  let evidenced = false;
  const memories = createStore(db, clock);
  /** Undo a proposal that did not get its evidence: no subject row, the card in the trash, so the slug is free for a retry. Never throws. */
  const undo = async () => {
    if (rowMade) await db.prepare("DELETE FROM subjects WHERE id = ? AND status = 'proposed'").bind(cardId).run().catch(() => {});
    if (cardId) await memories.softDelete(cardId).catch(() => {});
  };
  try {
    // A slug in any status is taken, and so is a name an existing subject already answers to.
    const taken = await db.prepare("SELECT 1 AS n FROM subjects s WHERE s.slug = ? OR EXISTS (SELECT 1 FROM json_each(s.aliases) j WHERE j.value IN (?, ?)) LIMIT 1").bind(slug, folded, slug).first();
    if (taken) return { ok: false, reason: "exists" };

    const at = clock();
    const parsed = await parseMemory(cardContent({ slug, kind, name: text, brief: PROPOSED_BRIEF }), ["subject", `subject:${slug}`, `subject-kind:${kind}`]);
    const card = await memories.create({ ...parsed, origin: "system", status: "pending", harness: "" });
    cardId = card.id;
    try {
      // The cap is part of the insert, so many proposals at once cannot all pass a check that each made before any of them wrote.
      const made = await db
        .prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) SELECT ?, ?, ?, 'proposed', 'shared', '{}', '[]', ?, ? WHERE (SELECT COUNT(*) FROM subjects WHERE status = 'proposed') < ?")
        .bind(card.id, slug, kind, at, at, MAX_PROPOSED)
        .run();
      if (made.meta.changes === 0) {
        await undo();
        return { ok: false, reason: "too_many" };
      }
      rowMade = true;
    } catch (err) {
      // Two proposals for one slug: the loser's card goes to the trash, and the nightly purge removes it.
      await undo();
      cardId = null;
      if (/UNIQUE constraint failed: subjects/.test(String(err?.message))) return { ok: false, reason: "exists" };
      throw err;
    }
    // One batch for every link, each only when the memory is live, is not itself a card and does not belong to a private subject,
    // because a link to a proposal (always shared) must never change who may see a memory that a person kept private.
    const linked = await db.batch(
      proof.map((e) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence) SELECT ?, ?, 'about', ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM subjects WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM links l JOIN subjects s ON s.id = l.target_id WHERE l.source_id = ? AND l.link_type = 'about' AND s.scope = 'private')",
          )
          .bind(e.id, card.id, at, madeBy, e.confidence, e.id, e.id, e.id),
      ),
    );
    if (!linked.some((r) => r.meta.changes > 0)) {
      // A proposal with no evidence is a card nobody can judge, and its slug would stay taken, so it is not kept.
      await undo();
      return { ok: false, reason: "no_evidence" };
    }
    evidenced = true;
    const conf = round2(proof.reduce((sum, e) => sum + e.confidence, 0) / proof.length);
    await audit(db, { step: who, conf, now: clock, status: 200, ids: [card.id, ...proof.map((e) => e.id)] });
    return { ok: true, slug, id: card.id };
  } catch {
    console.error("proposing a subject failed");
    // Anything that went wrong before the evidence was written leaves no card and no row behind, so a retry is not told "exists" for ever.
    if (!evidenced) await undo();
    await audit(db, { step: who, conf: 0, now: clock, status: 500, ids: [cardId, ...proof.map((e) => e.id)].filter(Boolean) });
    return { ok: false, reason: "failed" };
  }
}

/**
 * Propose a subject from the extractor's hint about one memory. The hint must be well formed, the memory must be a live capture or
 * explicit write, and the name must stand in the memory's own text, so a hint cannot invent a subject the memory is not about.
 * Does nothing unless both subject flags are on. Never throws.
 * @param {{DB: any}} env
 * @param {{memoryId: string, hint: {name: string, kind: string}, now: (() => number) | number}} f
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function proposeFromHint(env, { memoryId, hint, now }) {
  if (!autoOn(env)) return { ok: false, reason: "off" };
  const clean = cleanHint(hint);
  if (!clean) return { ok: false, reason: "bad_hint" };
  try {
    // Only the description and the body count, as in the write path: the front matter holds a label and a type, not what the memory says.
    // A memory that already belongs to a subject is left alone. It may belong to a private one, and a link to a new shared card would un-hide it.
    const memory = await env.DB.prepare(
      "SELECT description, body, origin, (SELECT COUNT(*) FROM subjects WHERE status = 'proposed') AS waiting, EXISTS (SELECT 1 FROM links WHERE source_id = memories.id AND link_type = 'about') AS linked FROM memories WHERE id = ? AND deleted_at IS NULL AND valid_until IS NULL AND status <> 'pending'",
    )
      .bind(memoryId)
      .first();
    if (!memory || !HINT_ORIGINS.includes(memory.origin)) return { ok: false, reason: "bad_memory" };
    if (memory.linked) return { ok: false, reason: "already_linked" };
    if (!mentions([memory.description, memory.body].filter(Boolean).join("\n"), clean.name)) return { ok: false, reason: "not_in_memory" };
    if (memory.waiting >= MAX_PROPOSED) return { ok: false, reason: "too_many" };
  } catch {
    return { ok: false, reason: "failed" };
  }
  const made = await createProposed(env, { name: clean.name, kind: clean.kind, evidence: [{ id: memoryId, confidence: 1 }], now });
  return made.ok ? { ok: true } : { ok: false, reason: made.reason };
}
