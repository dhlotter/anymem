// The nightly brief step. A subject whose newest members changed since its brief was built gets a new brief from the small
// model, and the brief is only saved when every check in subjects/brief.js passes. A failed check leaves the old brief, marks
// the subject stale and says which check failed. A model that does not answer leaves everything as it is.
//
// Which subjects are rebuilt: active or stale, with at least one live member, whose members' hash is not the one stored, or
// that are stale. At most 8 a night, active ones first and then the oldest built_at first (never built counts as oldest), so a
// subject that keeps failing cannot hold up the healthy ones. A subject whose brief is pinned by hand is never touched.
//
// A subject with fewer than 3 live members that was made more than 60 days ago is retired, unless its brief is pinned.
//
// The prompt of a subject holds its own members only. A shared subject leaves out a member that also belongs to a private
// subject, so private text never reaches a card that every device can read.
import { auditStatement, recordAudit } from "../audit.js";
import { createStore } from "../memory/store.js";
import { buildBrief, checkBrief, MEMBER_LIMIT, memberHash, renderBrief, withBrief } from "../subjects/brief.js";
import { autoOn } from "../subjects/auto.js";

export const MAX_BUILDS = 8;
export const MAX_RETIRES = 8;
export const RETIRE_BELOW = 3;
export const RETIRE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
// What one build costs at most: the model, the fresh read of the members, and the card update with the links, the subject row and
// the audit row (two D1 calls, the read of the card and one batch). A failed build costs less.
const BUILD_COST = 4;
const READ_COST = 2; // the first batch of reads and the batch that reads the members' text
const RETIRE_COST = 1;
// After this many failed model calls in a row the model is taken to be down, and the step stops.
const OUTAGE_AFTER = 2;

const MEMBER_LIVE = "m.deleted_at IS NULL AND m.valid_until IS NULL AND m.status <> 'pending'";
// A memory that has an about link to a private subject.
const IN_PRIVATE = "EXISTS (SELECT 1 FROM links l2 JOIN subjects p ON p.id = l2.target_id WHERE l2.source_id = m.id AND l2.link_type = 'about' AND p.scope = 'private')";

const nameOf = (row) => (row.description.startsWith(`${row.kind} card for `) ? row.description.slice(`${row.kind} card for `.length) : row.slug);

/** A hand written brief. The field is set by hand, so it may be a plain value or a field with a value. */
export function isPinned(fields) {
  const f = fields?.brief_pinned;
  if (f === undefined || f === null) return false;
  const v = typeof f === "object" ? f.value : f;
  return v !== undefined && v !== null && v !== false && !["", "0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
}

const parse = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

/** The audit row of one system action on a subject. The script column keeps letters, digits and . : - only, so the check names use dots. */
function auditRow(now, { route, ok, how, ids, started }) {
  return {
    ts: now(),
    actor: { kind: "system", id: "brief" },
    harness: "",
    script: `how:${how}`.replace(/_/g, "."),
    method: "SYSTEM",
    route,
    status: ok ? 200 : 500,
    durationMs: now() - started,
    memoryIds: ids,
  };
}

/** The newest members a subject is built from, as one statement. A shared subject leaves out members that are also in a private one. */
const membersSql = (scope) =>
  `SELECT m.id, m.name, m.description, m.body, m.created_at, m.updated_at FROM links l JOIN memories m ON m.id = l.source_id
   WHERE l.target_id = ? AND l.link_type = 'about' AND ${MEMBER_LIVE}${scope === "private" ? "" : ` AND NOT ${IN_PRIVATE}`}
   ORDER BY m.updated_at DESC, m.id DESC LIMIT ${MEMBER_LIMIT}`;

const textOf = (m) => [m.name, m.description, m.body].filter(Boolean).join("\n");

/**
 * Build one subject's brief and save it, or mark it stale. The card, its links, the subject row and the audit row are saved in one
 * batch, so a brief is saved whole or not at all. Returns what happened.
 * @returns {Promise<"built" | "stale" | "outage" | "conflict">}
 */
async function buildOne(env, { now, store }, subject, shown) {
  const started = now();
  const card = subject.id;
  const members = shown.map((m) => ({ id: m.id, text: textOf(m), created_at: m.created_at }));
  const answer = await buildBrief(env, { name: subject.name, kind: subject.kind, fields: subject.fields }, members);
  if (!answer) {
    await recordAudit(env.DB, auditRow(now, { route: "brief.build", ok: false, how: "model.fail", ids: [card], started }));
    return "outage";
  }
  // The members may have changed while the model worked, so they are read again. A member that was trashed or replaced is refused.
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, body, created_at, updated_at, deleted_at, valid_until, superseded_by, status FROM memories m
       WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM links WHERE source_id = m.id AND target_id = ? AND link_type = 'about')`,
    )
    .bind(JSON.stringify(shown.map((m) => m.id)), card)
    .all();
  const fresh = results.map((m) => ({ ...m, text: textOf(m) }));
  const checked = checkBrief(answer.lines, fresh);
  const cited = [...new Set(answer.lines.flatMap((l) => l.ids))].slice(0, 20);
  // A card that was edited by hand may have lost its frontmatter, and then there is nowhere to put a brief.
  const content = checked.ok ? withBrief(subject.content, renderBrief(answer.lines)) : null;
  const failure = checked.ok ? (content === null ? "bad_card" : null) : checked.check;
  if (failure) {
    await env.DB.batch([
      env.DB.prepare("UPDATE subjects SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'stale')").bind(failure, now(), card),
      auditStatement(env.DB, auditRow(now, { route: "brief.build", ok: false, how: `check.${failure}`, ids: [card, ...cited], started })),
    ]);
    return "stale";
  }
  const hash = await memberHash(shown);
  const at = now();
  try {
    await store.update({
      id: card,
      content,
      ifUpdatedAt: subject.card_updated_at,
      reason: "brief",
      quiet: true,
      extra: [
        env.DB.prepare("DELETE FROM links WHERE source_id = ? AND link_type = 'derived_from'").bind(card),
        env.DB
          .prepare("INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence) SELECT ?, id, 'derived_from', ?, 'system', NULL FROM memories WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
          .bind(card, at, JSON.stringify(cited)),
        env.DB.prepare("UPDATE subjects SET status = 'active', stale_reason = '', built_at = ?, member_hash = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'stale')").bind(at, hash, at, card),
        auditStatement(env.DB, auditRow(now, { route: "brief.build", ok: true, how: `model.lines:${answer.lines.length}`, ids: [card, ...cited], started })),
      ],
    });
  } catch (err) {
    // The card was edited since it was read, or another writer won. Nothing was saved, and the subject is looked at again tomorrow.
    if (err?.status === 409) return "conflict";
    throw err;
  }
  return "built";
}

/**
 * @returns {Promise<{skipped?: string, refused?: string, candidates: number, built: number, stale: number, failed: number, conflicts: number, retired: number, pinned: number, remaining: number}>}
 */
export async function briefsStep(env, { now, budget }) {
  const out = { candidates: 0, built: 0, stale: 0, failed: 0, conflicts: 0, retired: 0, pinned: 0, remaining: 0 };
  if (!autoOn(env)) return { skipped: "off" };
  if (!budget.has(READ_COST + BUILD_COST)) return { ...out, skipped: "budget" };
  // One batch reads the subjects, how many live members each has, and the newest members of each with their change times.
  const [subjectRows, countRows, memberRows] = (
    await env.DB.batch([
      env.DB.prepare(
        `SELECT s.id, s.slug, s.kind, s.status, s.scope, s.fields, s.created_at, s.member_hash, s.built_at, c.description, c.content, c.updated_at AS card_updated_at
         FROM subjects s JOIN memories c ON c.id = s.id WHERE s.status IN ('active', 'stale') AND c.deleted_at IS NULL
         ORDER BY s.built_at IS NOT NULL, s.built_at, s.id LIMIT 1000`,
      ),
      env.DB.prepare(
        `SELECT l.target_id AS sid, COUNT(*) AS n FROM links l JOIN memories m ON m.id = l.source_id
         WHERE l.link_type = 'about' AND l.target_id IN (SELECT id FROM subjects WHERE status IN ('active', 'stale')) AND ${MEMBER_LIVE} GROUP BY l.target_id`,
      ),
      env.DB.prepare(
        `SELECT sid, id, updated_at FROM (
           SELECT l.target_id AS sid, m.id AS id, m.updated_at AS updated_at, ROW_NUMBER() OVER (PARTITION BY l.target_id ORDER BY m.updated_at DESC, m.id DESC) AS rn
           FROM links l JOIN subjects s ON s.id = l.target_id AND s.status IN ('active', 'stale') JOIN memories m ON m.id = l.source_id
           WHERE l.link_type = 'about' AND ${MEMBER_LIVE} AND (s.scope = 'private' OR NOT ${IN_PRIVATE})
         ) WHERE rn <= ${MEMBER_LIMIT}`,
      ),
    ])
  ).map((r) => r.results);
  const live = new Map(countRows.map((r) => [r.sid, r.n]));
  const newest = new Map();
  for (const r of memberRows) (newest.get(r.sid) ?? newest.set(r.sid, []).get(r.sid)).push({ id: r.id, updated_at: r.updated_at });

  const store = createStore(env.DB, now);
  const candidates = [];
  for (const row of subjectRows) {
    const subject = { ...row, name: nameOf(row), fields: parse(row.fields, {}) };
    if (isPinned(subject.fields)) {
      out.pinned++;
      continue;
    }
    if ((live.get(row.id) ?? 0) < RETIRE_BELOW && now() - row.created_at > RETIRE_AFTER_MS) {
      if (out.retired < MAX_RETIRES && budget.has(RETIRE_COST + BUILD_COST)) {
        const started = now();
        await env.DB.batch([
          env.DB.prepare("UPDATE subjects SET status = 'retired', stale_reason = '', updated_at = ? WHERE id = ? AND status IN ('active', 'stale')").bind(now(), row.id),
          auditStatement(env.DB, auditRow(now, { route: "brief.retire", ok: true, how: `members:${live.get(row.id) ?? 0}`, ids: [row.id], started })),
        ]);
        out.retired++;
      }
      continue;
    }
    const members = newest.get(row.id) ?? [];
    if (!members.length) continue;
    if (row.status === "stale" || (await memberHash(members)) !== row.member_hash) candidates.push(subject);
  }
  // Healthy subjects first, and the ones that failed last. Within each the oldest brief first, a subject never built before all.
  candidates.sort((a, b) => (a.status === "stale") - (b.status === "stale") || (a.built_at ?? -1) - (b.built_at ?? -1) || (a.id < b.id ? -1 : 1));
  out.candidates = candidates.length;
  const chosen = candidates.slice(0, Math.min(MAX_BUILDS, Math.max(0, Math.floor((budget.left() - 1) / BUILD_COST))));
  if (!chosen.length || !budget.has(READ_COST)) {
    out.remaining = candidates.length;
    return out;
  }
  const texts = await env.DB.batch(chosen.map((s) => env.DB.prepare(membersSql(s.scope)).bind(s.id)));
  let down = 0;
  let attempted = 0;
  for (let i = 0; i < chosen.length; i++) {
    if (!budget.has(BUILD_COST)) break;
    const shown = texts[i].results;
    if (!shown.length) continue;
    attempted++;
    try {
      const result = await buildOne(env, { now, store }, chosen[i], shown);
      if (result === "built") out.built++;
      else if (result === "stale") out.stale++;
      else if (result === "conflict") out.conflicts++;
      else out.failed++;
      down = result === "outage" ? down + 1 : 0;
    } catch (err) {
      // A write that failed is counted and the next subject still gets its turn.
      out.failed++;
      console.error("brief build failed", err?.name);
    }
    if (down >= OUTAGE_AFTER) break;
  }
  out.remaining = candidates.length - out.built;
  // The run is not ok when every build failed (the model did not answer, or a write failed), the same as a backup that was refused.
  if (attempted && out.failed === attempted) out.refused = down > 0 ? "the model did not answer" : "no brief could be saved";
  return out;
}
