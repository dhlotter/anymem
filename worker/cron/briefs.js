// The nightly brief step. A subject whose newest members changed since its brief was built gets a new brief from the small
// model, and the brief is only saved when every check in subjects/brief.js passes. A failed check marks the subject stale and says
// which check failed. A model that does not answer is counted.
//
// Which subjects are rebuilt: active or stale, with at least one live member, whose members' hash is not the one stored, or
// that are stale. At most 8 a night, healthy ones first and then the oldest built_at first (never built counts as oldest), so a
// subject that keeps failing cannot hold up the healthy ones. A subject whose brief is pinned by hand is never touched. A brief a
// person wrote counts as pinned: saving one through the API sets brief_pinned.
//
// A brief that cites a memory that may no longer feed it (trashed, replaced, or now in a private subject) is blanked at the moment
// that happens, by subjects/clear.js, called from the routes that cause it. This step runs the same check for every card as a backup,
// before anything else and whatever the flags say, because text that must go is not a thing to leave for a switch. A memory that was
// only added to a subject, or edited, never blanks a brief: a good brief stays until it is rebuilt. A rebuild that fails, runs out of
// budget or never comes leaves a blanked subject blank and stale, and leaves a subject that was not blanked with its old brief and the
// reason it is stale.
//
// A model that does not answer is counted for each subject in stale_reason as model.fail.N. After 3 in a row the subject is
// stale with that reason, and a subject that failed is tried after the healthy ones.
//
// A project, area or topic with fewer than 3 live members that has not changed status for 60 days is retired, unless its brief
// is pinned.
//
// The prompt of a subject holds its own members only. A shared subject leaves out a member that also belongs to a private
// subject, so private text never reaches a card that every device can read. The step spends what is left of the shared subrequest
// budget when it starts minus what merge needs to examine one memory (MERGE_NEEDS), so merge always has some left, also on the Free budget of 40.
// Building briefs needs SUBJECTS_AUTO and SUBJECTS_BRIEFS both on: a brief is a model's reading of free text, which is less certain than
// a link, so it has its own switch.
import { auditStatement } from "../audit.js";
import { createStore } from "../memory/store.js";
import { buildBrief, checkBrief, MEMBER_LIMIT, memberHash, renderBrief, withBrief } from "../subjects/brief.js";
import { briefsOn } from "../subjects/auto.js";
import { auditRow, CLEAR_COST, CLEARED, clearIneligible } from "../subjects/clear.js";

export { CLEARED };

export const MAX_BUILDS = 8;
export const MAX_RETIRES = 8;
export const RETIRE_BELOW = 3;
export const RETIRE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
// A person, a pet or an asset has few memories by nature, so only a project, an area or a topic can fade away by itself.
const RETIRABLE_KINDS = new Set(["project", "area", "topic"]);
// What one build costs at most: the model, the fresh read of the members, and the card update with the links, the subject row and
// the audit row (two D1 calls, the read of the card and one batch). A failed build costs less.
const BUILD_COST = 4;
const READ_COST = 2; // the first batch of reads and the batch that reads the members' text
const RETIRE_COST = 1;
// What merge needs to examine one candidate (its fixed cost of 3 and one candidate at 10, see merge.js, plus the two reads it makes before
// its first check, which that check does not count). The briefs step leaves this much. Measured: with 13 left merge examined nothing.
export const MERGE_NEEDS = 15;
// After this many failed model calls in a row a subject is stale. The count lives in stale_reason as model.fail.N.
export const STALE_AFTER = 3;
// After this many failed model calls in a row, with every build of the group failing, the model is taken to be down and the step stops.
const OUTAGE_AFTER = 2;
const PARALLEL = 4;

const MEMBER_LIVE = "m.deleted_at IS NULL AND m.valid_until IS NULL AND m.status <> 'pending'";
// A memory that has an about link to a private subject.
const IN_PRIVATE = "EXISTS (SELECT 1 FROM links l2 JOIN subjects p ON p.id = l2.target_id WHERE l2.source_id = m.id AND l2.link_type = 'about' AND p.scope = 'private')";

/** How many model calls in a row failed for a subject, read from its stale_reason. */
export const failuresOf = (reason) => Number(/^model\.fail\.(\d+)$/.exec(reason ?? "")?.[1] ?? 0);

// updated_at is read as the last change of status, which the 60 days before a retirement run from. A build or a failure that leaves the
// status as it is does not move it (an update reads the old row, so the test of the old status holds whatever the order of the columns).
const CHANGED = "CASE WHEN status <> 'stale' THEN ? ELSE updated_at END";

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
    // Counted for this subject, so a subject the model keeps failing on becomes stale and goes to the back of the queue.
    const fails = failuresOf(subject.stale_reason) + 1;
    const goStale = fails >= STALE_AFTER && subject.status !== "stale";
    await env.DB.batch([
      goStale
        ? env.DB.prepare(`UPDATE subjects SET stale_reason = ?, updated_at = ${CHANGED}, status = 'stale' WHERE id = ? AND status IN ('active', 'stale')`).bind(`model.fail.${fails}`, now(), card)
        : env.DB.prepare("UPDATE subjects SET stale_reason = ? WHERE id = ? AND status IN ('active', 'stale')").bind(`model.fail.${fails}`, card),
      auditStatement(env.DB, auditRow(now, { route: "brief.build", ok: false, how: "model.fail", ids: [card], started })),
    ]);
    return "outage";
  }
  // The members may have changed while the model worked, so they are read again. A member that was trashed or replaced is refused, and
  // for a shared subject so is one that joined a private subject meanwhile (it is left out here, so a line that cites it fails the check).
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, body, created_at, updated_at, deleted_at, valid_until, superseded_by, status FROM memories m
       WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM links WHERE source_id = m.id AND target_id = ? AND link_type = 'about')${subject.scope === "private" ? "" : ` AND NOT ${IN_PRIVATE}`}`,
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
      env.DB.prepare(`UPDATE subjects SET stale_reason = ?, updated_at = ${CHANGED}, status = 'stale' WHERE id = ? AND status IN ('active', 'stale')`).bind(failure, now(), card),
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
        env.DB.prepare("UPDATE subjects SET stale_reason = '', built_at = ?, member_hash = ?, updated_at = CASE WHEN status <> 'active' THEN ? ELSE updated_at END, status = 'active' WHERE id = ? AND status IN ('active', 'stale')").bind(at, hash, at, card),
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
 * Healthy subjects first, then the ones that failed, the ones the model failed on least first. Within each the oldest brief first, a
 * subject never built before all. A subject whose brief was only cleared because its members changed has not failed.
 */
const byTurn = (a, b) => {
  const failed = (s) => (s.stale_reason !== CLEARED && (s.stale_reason !== "" || s.status === "stale") ? 1 : 0);
  return failed(a) - failed(b) || failuresOf(a.stale_reason) - failuresOf(b.stale_reason) || (a.built_before ?? -1) - (b.built_before ?? -1) || (a.id < b.id ? -1 : 1);
};

/**
 * @returns {Promise<{skipped?: string, refused?: string, candidates: number, built: number, stale: number, failed: number, conflicts: number, retired: number, cleared: number, pinned: number, remaining: number}>}
 */
export async function briefsStep(env, { now, budget }) {
  const out = { candidates: 0, built: 0, stale: 0, failed: 0, conflicts: 0, retired: 0, cleared: 0, pinned: 0, remaining: 0 };
  // The nightly clear step ("clear", the first step of the run) has done this already, so here it is one read that finds nothing. It stays
  // for a run that picks only this step, and for a card that lost its brief's right to stay during the run. It does not depend on a switch:
  // the routes blank a brief the moment its text must go, and this catches what they could not. Pinned and retired subjects are cleared too.
  let cleared = 0;
  if (budget.has(1)) {
    try {
      cleared = (await clearIneligible(env, { now, room: () => budget.has(CLEAR_COST + 1) })).length;
    } catch (err) {
      console.error("brief clear failed", err?.name);
    }
  }
  if (!briefsOn(env)) return cleared ? { skipped: "off", cleared } : { skipped: "off" };
  out.cleared = cleared;
  // Merge runs after this step and works until the shared budget is gone, so this step leaves it what it needs to run at all.
  const startedAt = budget.spent;
  const share = Math.max(0, budget.left() - MERGE_NEEDS);
  const has = (n) => budget.has(n) && budget.spent - startedAt + n <= share;
  if (!has(READ_COST + BUILD_COST)) return { ...out, skipped: "budget" };
  // One batch reads the subjects, how many live members each has, and the newest members of each with their change times.
  const [subjectRows, countRows, memberRows] = (
    await env.DB.batch([
      env.DB.prepare(
        `SELECT s.id, s.slug, s.kind, s.status, s.scope, s.fields, s.created_at, s.updated_at, s.member_hash, s.built_at, s.stale_reason, c.description, c.content, c.updated_at AS card_updated_at
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
    const subject = { ...row, name: nameOf(row), fields: parse(row.fields, {}), built_before: row.built_at };
    if (isPinned(subject.fields)) {
      out.pinned++;
      continue;
    }
    const members = newest.get(row.id) ?? [];
    const hash = await memberHash(members);
    // The 60 days run from the last status change (accepting a proposal sets updated_at), not from when the subject was first made.
    if (RETIRABLE_KINDS.has(row.kind) && (live.get(row.id) ?? 0) < RETIRE_BELOW && now() - Math.max(row.created_at, row.updated_at) > RETIRE_AFTER_MS) {
      if (out.retired < MAX_RETIRES && has(RETIRE_COST + BUILD_COST)) {
        const started = now();
        await env.DB.batch([
          env.DB.prepare("UPDATE subjects SET status = 'retired', stale_reason = '', updated_at = ? WHERE id = ? AND status IN ('active', 'stale')").bind(now(), row.id),
          auditStatement(env.DB, auditRow(now, { route: "brief.retire", ok: true, how: `members:${live.get(row.id) ?? 0}`, ids: [row.id], started })),
        ]);
        out.retired++;
      }
      continue;
    }
    if (!members.length) continue;
    if (subject.status === "stale" || hash !== row.member_hash) candidates.push(subject);
  }
  candidates.sort(byTurn);
  out.candidates = candidates.length;
  const chosen = candidates.slice(0, MAX_BUILDS);
  if (!chosen.length || !has(1 + BUILD_COST)) {
    out.remaining = candidates.length;
    return out;
  }
  const texts = await env.DB.batch(chosen.map((s) => env.DB.prepare(membersSql(s.scope)).bind(s.id)));
  let down = 0;
  let attempted = 0;
  // A few builds run at once, because the model is the slow part and the whole step has a time limit. The budget is reserved for the whole group first.
  for (let at = 0; at < chosen.length && down < OUTAGE_AFTER; ) {
    let size = Math.min(PARALLEL, chosen.length - at);
    while (size > 0 && !has(BUILD_COST * size)) size--;
    if (!size) break;
    const group = chosen.slice(at, at + size).map((subject, j) => ({ subject, shown: texts[at + j].results }));
    at += size;
    const results = await Promise.all(
      group.map(async ({ subject, shown }) => {
        if (!shown.length) return "skipped";
        try {
          return await buildOne(env, { now, store }, subject, shown);
        } catch (err) {
          // A write that failed is counted, and the other subjects still get their turn.
          console.error("brief build failed", err?.name);
          return "error";
        }
      }),
    );
    for (const result of results) {
      if (result === "skipped") continue;
      attempted++;
      if (result === "built") out.built++;
      else if (result === "stale") out.stale++;
      else if (result === "conflict") out.conflicts++;
      else out.failed++;
    }
    const tried = results.filter((r) => r !== "skipped");
    down = tried.length && tried.every((r) => r === "outage") ? down + tried.length : 0;
  }
  out.remaining = candidates.length - out.built;
  // The run is not ok when every build failed (the model did not answer, or a write failed), the same as a backup that was refused.
  if (attempted && out.failed === attempted) out.refused = down > 0 ? "the model did not answer" : "no brief could be saved";
  return out;
}
