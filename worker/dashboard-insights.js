// Read routes for the dashboard home, activity, health and audit screens. Everything here only reads. The numbers come from
// tables the Worker already keeps (memories, memory_versions, runs, audit, counters, write_counter, devices), so nothing new
// is recorded and no memory text beyond a title is sent. The one exception is the capsule cache, which home reads through
// getCapsule, and which rebuilds itself on a read after a capsule change, as GET /prompt-capsules/core does.
import { listBackups } from "./backup/backup.js";
import { CAP_CHARS, getCapsule } from "./capsule.js";
import { PENDING_PROPOSALS_SQL, tokenExpiryInfo } from "./dashboard-api.js";
import { deriveChecks, summarize } from "./dashboard-status.js";
import { badRequest, intParam, json } from "./http.js";
import { foldByHarness, harnessLabel } from "./harnesses.js";
import { LIVE, stats } from "./system.js";
import { PLAN_LIMITS } from "./plan-limits.js";
import { WINDOW_MS, WRITE_LIMIT } from "./limits.js";
import { TRASH_WINDOW_MS } from "./memory/store.js";
import { NEVER_RECALLED_MS } from "./cron/probation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const ORIGINS = ["explicit", "capture", "import", "profile", "person", "system"];
const SYSTEM_REASONS = ["supersede", "merge", "retire_never_recalled", "retire_idle_project"];
const KINDS = { replaced: ["supersede"], merged: ["merge"], retired: ["retire_never_recalled", "retire_idle_project"] };
const GROWTH_RANGES = [30, 90, 365];
// The state of an entry on Activity, as SQL. The same rules as the state line in activity(): an old version first, then trashed, closed, open.
const LATEST = "v.seq = (SELECT MAX(seq) FROM memory_versions WHERE memory_id = v.memory_id)";
const STATE_SQL = {
  changed_since: `NOT (${LATEST})`,
  trashed: `${LATEST} AND m.deleted_at IS NOT NULL`,
  closed: `${LATEST} AND m.deleted_at IS NULL AND m.valid_until IS NOT NULL`,
  open: `${LATEST} AND m.deleted_at IS NULL AND m.valid_until IS NULL`,
};
export const MACHINE_RECALL = "route = '/recall' AND method = 'GET' AND actor_kind <> 'browser' AND status < 400";
// Never recalled leaves out what reaches agents another way: profile and person notes, and the capsule (tagged capsule:core or capsule-slot:*).
const NEVER_RECALLED_SQL = `pinned = 0 AND origin NOT IN ('profile', 'person') AND recall_count = 0 AND last_recalled_at IS NULL AND created_at <= ?
  AND NOT EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = memories.id AND (t.tag LIKE 'capsule:%' OR t.tag LIKE 'capsule-slot:%'))`;
const marks = (list) => list.map(() => "?").join(", ");
const n0 = (v) => Number(v ?? 0);

/** The UTC day of a time as YYYY-MM-DD. */
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The UTC midnight at or before a time. */
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
/** The Monday, at UTC midnight, of the week a time falls in. */
const mondayOf = (ms) => {
  const d = dayStart(ms);
  const weekday = (new Date(d).getUTCDay() + 6) % 7; // Monday is 0
  return d - weekday * DAY_MS;
};

/** A title for a memory. Its name, else the first line of its text. */
export function titleFrom(name, head) {
  if (name) return name;
  const first = String(head ?? "").split("\n").find((l) => l.trim()) ?? "";
  const t = first.trim();
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t || "(empty)";
}

/** The first name in the profile memory, for the greeting. Null when there is none. */
export function ownerName(content) {
  const body = String(content ?? "").replace(/^---[\s\S]*?---\s*/, "");
  for (const label of ["Preferred name", "Full name"]) {
    const m = new RegExp(`^${label}:\\s*(.+?)(?:\\s+\\([^()]*\\))?\\s*$`, "m").exec(body);
    const first = m?.[1].trim().split(/\s+/)[0];
    if (first) return first.slice(0, 40);
  }
  return null;
}

/** A list of the last n days, oldest first, as YYYY-MM-DD. */
function lastDays(n, now) {
  return Array.from({ length: n }, (_, i) => dayKey(dayStart(now) - (n - 1 - i) * DAY_MS));
}

/** GET /ui/api/home. The facts and checks behind the status line, the headline numbers and the live counts in the sidebar. */
export async function home(c) {
  const { env, now } = c;
  const at = now();
  const w0 = at - WEEK_MS;
  const w1 = at - 2 * WEEK_MS;
  const base = await (await stats(c)).json();
  const [live, added, recalled, calls, closed, trash, pending, profile, nightly, keys, activity] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${LIVE}`),
    env.DB.prepare("SELECT COALESCE(SUM(created_at >= ?), 0) AS week, COALESCE(SUM(created_at < ?), 0) AS prev FROM memories WHERE deleted_at IS NULL AND created_at >= ?").bind(w0, w0, w1),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND last_recalled_at >= ?").bind(w0),
    env.DB.prepare(`SELECT COALESCE(SUM(ts >= ?), 0) AS week, COALESCE(SUM(ts < ?), 0) AS prev FROM audit WHERE ${MACHINE_RECALL} AND ts >= ?`).bind(w0, w0, w1),
    env.DB.prepare(`SELECT COALESCE(SUM(created_at >= ?), 0) AS week, COALESCE(SUM(created_at < ?), 0) AS prev FROM memory_versions WHERE reason IN (${marks(SYSTEM_REASONS)}) AND created_at >= ?`).bind(w0, w0, ...SYSTEM_REASONS, w1),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL AND deleted_at >= ?").bind(at - TRASH_WINDOW_MS),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${PENDING_PROPOSALS_SQL}`),
    env.DB.prepare("SELECT content FROM memories WHERE origin = 'profile' AND name = 'profile' AND deleted_at IS NULL AND valid_until IS NULL ORDER BY created_at LIMIT 1"),
    env.DB.prepare("SELECT started_at, finished_at, ok, summary FROM runs WHERE job = 'nightly' ORDER BY id DESC LIMIT 1"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memory_keys WHERE vector_id IS NOT NULL"),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_versions WHERE reason IN (${marks(SYSTEM_REASONS)}) AND created_at >= ?`).bind(...SYSTEM_REASONS, w0),
  ]);
  let vectorCount = null;
  try {
    const info = await env.VECTORIZE.describe();
    if (Number.isFinite(info.vectorCount)) vectorCount = info.vectorCount;
  } catch {
    // the index figures are optional
  }
  let backup = { configured: Boolean(env.BACKUP_BUCKET) };
  if (env.BACKUP_BUCKET) {
    try {
      const [latest] = await listBackups(env.BACKUP_BUCKET);
      backup = { configured: true, latest: latest ? { day: latest.day, created_at: latest.created_at, entries: latest.entries } : null };
    } catch {
      backup = { configured: true, error: true };
    }
  }
  const run = nightly.results[0];
  // ok stays null while a run is going, so a run still open is not read as a failure.
  const nightlyRun = run ? { ok: run.ok === null ? null : run.ok === 1, started_at: run.started_at, finished_at: run.finished_at, summary: safeJson(run.summary) } : null;
  const capsule = await getCapsule(env.DB, now).catch(() => null);
  const token = tokenExpiryInfo(env, now);
  const checks = deriveChecks(
    { nightly: nightlyRun, backup, unvectorized: base.unvectorized, vectorCount, keysWithVectors: keys.results[0].n, token, stats: base, pending: pending.results[0].n },
    at,
  );
  return json({
    ok: true,
    now: at,
    owner: profile.results[0] ? ownerName(profile.results[0].content) : null,
    headline: {
      live: live.results[0].n,
      added_week: n0(added.results[0].week),
      added_prev: n0(added.results[0].prev),
      recalled_week: recalled.results[0].n,
      recall_calls_week: n0(calls.results[0].week),
      recall_calls_prev: n0(calls.results[0].prev),
      closed_week: n0(closed.results[0].week),
      closed_prev: n0(closed.results[0].prev),
    },
    nav: {
      live: live.results[0].n,
      trash: trash.results[0].n,
      pending: pending.results[0].n,
      activity_week: activity.results[0].n,
      capsule_chars: capsule?.chars ?? null,
      capsule_cap: CAP_CHARS,
      attention: summarize(checks).attention,
      unvectorized: base.unvectorized,
    },
    checks,
    summary: summarize(checks),
  });
}

function safeJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** GET /ui/api/growth?days=30|90|365. Memories saved per day (a week for a year), counted by origin. */
export async function growth({ env, url, now }) {
  const days = intParam(url, "days", { min: 1, max: 365, fallback: 30 });
  if (!GROWTH_RANGES.includes(days)) throw badRequest("days must be 30, 90 or 365.");
  const at = now();
  const weekly = days > 90;
  const first = weekly ? mondayOf(at - (days - 1) * DAY_MS) : dayStart(at) - (days - 1) * DAY_MS;
  const keyExpr = weekly ? "date(created_at / 1000, 'unixepoch', 'weekday 0', '-6 days')" : "date(created_at / 1000, 'unixepoch')";
  const { results } = await env.DB.prepare(`SELECT ${keyExpr} AS k, origin, COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND created_at >= ? GROUP BY k, origin`).bind(first).all();
  const starts = [];
  for (let t = first; t <= at; t += (weekly ? 7 : 1) * DAY_MS) starts.push(dayKey(t));
  const buckets = starts.map((start) => ({ start, counts: Object.fromEntries(ORIGINS.map((o) => [o, 0])) }));
  const byStart = new Map(buckets.map((b) => [b.start, b]));
  let total = 0;
  for (const r of results) {
    const b = byStart.get(r.k);
    if (!b || !(r.origin in b.counts)) continue;
    b.counts[r.origin] += r.n;
    total += r.n;
  }
  return json({ ok: true, days, bucket: weekly ? "week" : "day", origins: ORIGINS, buckets, total });
}

/** GET /ui/api/recalls. Recall calls from machines per day, the most recalled memories, and the ones never recalled. */
export async function recalls({ env, now, memoryIds }) {
  const at = now();
  const days = 30;
  const since = dayStart(at) - (days - 1) * DAY_MS;
  const [perDay, byHarness, top, never, neverSample] = await env.DB.batch([
    env.DB.prepare(`SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(memory_ids = '[]'), 0) AS empty FROM audit WHERE ${MACHINE_RECALL} AND ts >= ? GROUP BY day`).bind(since),
    env.DB.prepare(`SELECT harness, COUNT(*) AS calls, COALESCE(SUM(memory_ids = '[]'), 0) AS empty FROM audit WHERE ${MACHINE_RECALL} AND ts >= ? GROUP BY harness`).bind(since),
    env.DB.prepare(
      `SELECT id, name, substr(content, 1, 200) AS head, origin, project, recall_count, last_recalled_at FROM memories
       WHERE deleted_at IS NULL AND valid_until IS NULL AND recall_count > 0 AND last_recalled_at >= ? ORDER BY recall_count DESC, last_recalled_at DESC, id LIMIT 8`,
    ).bind(at - 30 * DAY_MS),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${LIVE} AND ${NEVER_RECALLED_SQL}`).bind(at - WEEK_MS),
    env.DB.prepare(
      `SELECT id, name, substr(content, 1, 200) AS head, origin, project, created_at FROM memories
       WHERE ${LIVE} AND ${NEVER_RECALLED_SQL} ORDER BY created_at, id LIMIT 8`,
    ).bind(at - WEEK_MS),
  ]);
  const found = new Map(perDay.results.map((r) => [r.day, r]));
  const series = lastDays(days, at).map((day) => ({ day, calls: found.get(day)?.n ?? 0, empty: n0(found.get(day)?.empty) }));
  const mostRecalled = top.results.map((r) => ({ id: r.id, title: titleFrom(r.name, r.head), origin: r.origin, project: r.project, recall_count: r.recall_count, last_recalled_at: r.last_recalled_at }));
  const sample = neverSample.results.map((r) => ({ id: r.id, title: titleFrom(r.name, r.head), origin: r.origin, project: r.project, created_at: r.created_at }));
  memoryIds.push(...mostRecalled.map((m) => m.id), ...sample.map((m) => m.id));
  return json({
    ok: true,
    days: series,
    total: series.reduce((a, d) => a + d.calls, 0),
    empty: series.reduce((a, d) => a + d.empty, 0),
    by_harness: foldByHarness(byHarness.results, ["calls", "empty"]),
    most_recalled: mostRecalled,
    never_recalled: { count: never.results[0].n, sample },
  });
}

/** True for a memory the nightly job can retire, the same rule as ELIGIBLE in cron/probation.js. */
const retires = (r) => r.origin === "capture" && r.pinned === 0 && r.status !== "canonical";

/** GET /ui/api/probation. Captured memories still on probation, soonest first, with the days left. */
export async function probation({ env, now, memoryIds }) {
  const at = now();
  const [total, rows] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL AND probation_until IS NOT NULL"),
    env.DB.prepare(
      `SELECT id, name, substr(content, 1, 200) AS head, origin, project, pinned, status, probation_until, recall_count, last_recalled_at, created_at FROM memories
       WHERE deleted_at IS NULL AND valid_until IS NULL AND probation_until IS NOT NULL ORDER BY probation_until, id LIMIT 100`,
    ),
  ]);
  const entries = rows.results.map((r) => ({
    id: r.id,
    title: titleFrom(r.name, r.head),
    origin: r.origin,
    project: r.project,
    created_at: r.created_at,
    probation_until: r.probation_until,
    days_left: Math.max(0, Math.ceil((r.probation_until - at) / DAY_MS)),
    recall_count: r.recall_count,
    // A capture nobody recalls goes to the trash 60 days after it was saved, unless the nightly job would never touch it (pinned or canonical).
    retires: retires(r),
    retire_at: retires(r) && r.recall_count === 0 && r.last_recalled_at === null ? r.created_at + NEVER_RECALLED_MS : null,
  }));
  memoryIds.push(...entries.map((e) => e.id));
  return json({ ok: true, total: total.results[0].n, entries });
}

/** GET /ui/api/activity?kind=&n=&cursor=. What the system changed on its own, newest first. */
export async function activity({ env, url, now, memoryIds }) {
  const at = now();
  const n = intParam(url, "n", { min: 1, max: 100, fallback: 40 });
  const cursor = intParam(url, "cursor", { min: 1, max: Number.MAX_SAFE_INTEGER });
  const kind = url.searchParams.get("kind") ?? "all";
  if (kind !== "all" && !Object.hasOwn(KINDS, kind)) throw badRequest("kind must be all, replaced, merged or retired.");
  const state = url.searchParams.get("state") || "all";
  if (state !== "all" && !Object.hasOwn(STATE_SQL, state)) throw badRequest("state must be all, open, closed, trashed or changed_since.");
  const reasons = kind === "all" ? SYSTEM_REASONS : KINDS[kind];
  const where = [`v.reason IN (${marks(reasons)})`];
  const args = [...reasons];
  if (state !== "all") where.push(STATE_SQL[state]);
  if (cursor !== undefined) (where.push("v.id < ?"), args.push(cursor));
  const [rows, counts, soon] = await env.DB.batch([
    env.DB.prepare(
      `SELECT v.id AS version_id, v.memory_id, v.seq, v.reason, v.created_at AS at,
              m.name, substr(m.content, 1, 200) AS head, m.origin, m.harness, m.project, m.valid_until, m.superseded_by, m.deleted_at,
              (SELECT MAX(seq) FROM memory_versions WHERE memory_id = v.memory_id) AS top_seq,
              s.id AS by_id, s.name AS by_name, substr(s.content, 1, 200) AS by_head
       FROM memory_versions v JOIN memories m ON m.id = v.memory_id LEFT JOIN memories s ON s.id = m.superseded_by
       WHERE ${where.join(" AND ")} ORDER BY v.id DESC LIMIT ?`,
    ).bind(...args, n + 1),
    env.DB.prepare(`SELECT reason, COUNT(*) AS n FROM memory_versions WHERE reason IN (${marks(SYSTEM_REASONS)}) AND created_at >= ? GROUP BY reason`).bind(...SYSTEM_REASONS, at - 30 * DAY_MS),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL AND deleted_at >= ? AND deleted_at < ?").bind(at - TRASH_WINDOW_MS, at - TRASH_WINDOW_MS + 3 * DAY_MS),
  ]);
  const page = rows.results.slice(0, n);
  const entries = page.map((r) => {
    const latest = r.seq === r.top_seq;
    const trashed = r.deleted_at !== null;
    const closed = r.valid_until !== null;
    const state = !latest ? "changed_since" : trashed ? "trashed" : closed ? "closed" : "open";
    const restorable = !trashed || at - r.deleted_at <= TRASH_WINDOW_MS;
    const kindOf = r.reason === "supersede" ? "replaced" : r.reason === "merge" ? "merged" : "retired";
    return {
      version_id: r.version_id,
      memory_id: r.memory_id,
      title: titleFrom(r.name, r.head),
      origin: r.origin,
      harness: r.harness,
      harness_label: harnessLabel(r.harness, r.origin),
      project: r.project,
      kind: kindOf,
      reason: r.reason,
      at: r.at,
      state,
      can_undo: latest && (trashed || closed) && restorable,
      purge_at: state === "trashed" ? r.deleted_at + TRASH_WINDOW_MS : null,
      replaced_by: state === "closed" && r.by_id ? { id: r.by_id, title: titleFrom(r.by_name, r.by_head) } : null,
    };
  });
  memoryIds.push(...entries.map((e) => e.memory_id));
  const byReason = Object.fromEntries(counts.results.map((r) => [r.reason, r.n]));
  return json({
    ok: true,
    entries,
    next_cursor: rows.results.length > n ? page.at(-1).version_id : null,
    last_30_days: {
      replaced: n0(byReason.supersede),
      merged: n0(byReason.merge),
      retired: n0(byReason.retire_never_recalled) + n0(byReason.retire_idle_project),
    },
    purge_soon: soon.results[0].n,
  });
}

const TRASH_LIST = 500;

/**
 * GET /ui/api/trash?sort=&origin=&project=. What can still be restored, closest to the end first (or newest forgotten first with sort=forgotten),
 * filtered and sorted here, so the page never loads the whole trash. The count of the older ones and the projects are for the filters.
 */
export async function trash({ env, url, now, memoryIds }) {
  const at = now();
  const since = at - TRASH_WINDOW_MS;
  const newest = url.searchParams.get("sort") === "forgotten";
  const origin = (url.searchParams.get("origin") ?? "").trim();
  const project = (url.searchParams.get("project") ?? "").trim();
  if (origin.length > 40 || project.length > 200) throw badRequest("origin or project is too long.");
  const filter = ["deleted_at >= ?"];
  const args = [since];
  if (origin) (filter.push("origin = ?"), args.push(origin));
  if (project) (filter.push("project = ?"), args.push(project));
  const where = filter.join(" AND ");
  const [rows, matching, summary, older, projects] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, substr(content, 1, 200) AS head, origin, project, deleted_at FROM memories WHERE ${where} ORDER BY deleted_at ${newest ? "DESC" : "ASC"}, id LIMIT ?`).bind(...args, TRASH_LIST),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).bind(...args),
    env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(deleted_at < ?), 0) AS soon FROM memories WHERE deleted_at >= ?").bind(since + 3 * DAY_MS, since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(since),
    env.DB.prepare("SELECT DISTINCT project AS p FROM memories WHERE deleted_at >= ? AND COALESCE(project, '') <> '' ORDER BY project").bind(since),
  ]);
  const entries = rows.results.map((r) => ({
    id: r.id,
    title: titleFrom(r.name, r.head),
    origin: r.origin,
    project: r.project,
    deleted_at: r.deleted_at,
    purge_at: r.deleted_at + TRASH_WINDOW_MS,
  }));
  memoryIds.push(...entries.map((e) => e.id));
  return json({
    ok: true,
    window_days: TRASH_WINDOW_MS / DAY_MS,
    entries,
    shown: entries.length,
    matching: matching.results[0].n,
    total: summary.results[0].total,
    soon: summary.results[0].soon,
    older: older.results[0].n,
    projects: projects.results.map((r) => r.p),
  });
}

/** What a step of the nightly job did, in one short phrase and a state. */
export function stepView(name, v) {
  const label = name.replace(/_/g, " ");
  if (!v || typeof v !== "object") return { name: label, state: "ok", headline: "" };
  if (v.error) return { name: label, state: "failed", headline: String(v.error).slice(0, 160) };
  if (v.refused) return { name: label, state: "refused", headline: "Refused, it had far fewer entries than the last backup." };
  if (v.skipped) return { name: label, state: "skipped", headline: String(v.skipped).slice(0, 120) };
  const skip = new Set(["subrequests", "ms"]);
  const parts = Object.entries(v)
    .filter(([k, x]) => !skip.has(k) && typeof x === "number")
    .map(([k, x]) => `${k.replace(/_/g, " ")} ${x}`);
  return { name: label, state: "ok", headline: parts.join(", "), more: v.more === true, ms: n0(v.ms), subrequests: n0(v.subrequests) };
}

/** GET /ui/api/runs?n=. The latest runs of the nightly job, and any run started by hand, with the result of each step. */
export async function runs({ env, url }) {
  const n = intParam(url, "n", { min: 1, max: 30, fallback: 14 });
  const { results } = await env.DB.prepare("SELECT id, job, started_at, finished_at, ok, summary FROM runs ORDER BY id DESC LIMIT ?").bind(n).all();
  return json({
    ok: true,
    runs: results.map((r) => ({
      id: r.id,
      job: r.job,
      started_at: r.started_at,
      finished_at: r.finished_at,
      ok: r.ok === null ? null : r.ok === 1,
      steps: Object.entries(safeJson(r.summary)).map(([name, v]) => stepView(name, v)),
    })),
  });
}

const COUNTER_DAYS = 14;

/** GET /ui/api/usage. Database and vector size against the plan, the write limit, and the capture counters per day. */
export async function usage({ env, now }) {
  const at = now();
  let size = null;
  try {
    const res = await env.DB.prepare("SELECT 1 AS one").run();
    size = Number.isFinite(res.meta?.size_after) ? res.meta.size_after : null;
  } catch {
    // the size is optional
  }
  let vectors = null;
  try {
    const info = await env.VECTORIZE.describe();
    if (Number.isFinite(info.vectorCount)) vectors = { count: info.vectorCount, dimensions: info.dimensions ?? info.config?.dimensions ?? null };
  } catch {
    // the index figures are optional
  }
  const since = dayKey(at - (COUNTER_DAYS - 1) * DAY_MS);
  const [counterRows, slots, devices] = await env.DB.batch([
    env.DB.prepare("SELECT name, day, count FROM counters WHERE day >= ?").bind(since),
    env.DB.prepare("SELECT token_id, SUM(writes) AS used, MIN(window_start) AS oldest FROM write_counter WHERE window_start > ? AND token_id NOT LIKE 'model:%' GROUP BY token_id ORDER BY used DESC").bind(at - WINDOW_MS),
    env.DB.prepare("SELECT id, label FROM devices"),
  ]);
  const byDay = new Map(lastDays(COUNTER_DAYS, at).map((day) => [day, { day, proposed: 0, screened: 0, saved: 0, refused: 0, limited: 0, duplicates: 0, model_failures: 0 }]));
  for (const r of counterRows.results) {
    const d = byDay.get(r.day);
    if (!d) continue;
    if (r.name === "extract.proposed") d.proposed += r.count;
    else if (r.name.startsWith("extract.screened.")) d.screened += r.count;
    else if (r.name === "capture.accepted") d.saved += r.count;
    else if (r.name === "capture.rejected.rate_limited") d.limited += r.count;
    else if (r.name === "capture.rejected.duplicate" || r.name === "capture.rejected.near_duplicate") d.duplicates += r.count;
    else if (r.name.startsWith("capture.rejected.")) d.refused += r.count;
    else if (r.name.startsWith("model.failure.")) d.model_failures += r.count;
  }
  const labels = new Map(devices.results.map((r) => [r.id, r.label]));
  return json({
    ok: true,
    plan: PLAN_LIMITS,
    db: { size_bytes: size, limit_bytes: PLAN_LIMITS.d1_bytes },
    vectors: vectors ? { ...vectors, limit: PLAN_LIMITS.vectors_per_index, stored_dimensions: vectors.count * (vectors.dimensions ?? 0), included_dimensions: PLAN_LIMITS.vector_dimensions_included } : null,
    write_limit: {
      limit: WRITE_LIMIT,
      window_minutes: WINDOW_MS / 60_000,
      tokens: slots.results.map((r) => ({
        id: r.token_id,
        // A browser login writes under its email (see write/pipeline.js), so that row is the dashboard, not an unknown device.
        label: r.token_id === "admin" ? "Admin token" : r.token_id.includes("@") ? "Dashboard" : (labels.get(r.token_id) ?? "Unknown device"),
        used: r.used,
        resets_in_seconds: Math.max(1, Math.ceil((r.oldest + WINDOW_MS - at) / 1000)),
      })),
    },
    days: [...byDay.values()],
  });
}

/** GET /ui/api/audit-facets?days=. The harnesses and routes seen lately and the calls per day, for the audit filters. */
export async function auditFacets({ env, url, now }) {
  const days = intParam(url, "days", { min: 1, max: 90, fallback: 14 });
  const at = now();
  const since = dayStart(at) - (days - 1) * DAY_MS;
  const [harnesses, routes, perDay] = await env.DB.batch([
    env.DB.prepare("SELECT harness, COUNT(*) AS n FROM audit WHERE ts >= ? GROUP BY harness ORDER BY n DESC").bind(since),
    env.DB.prepare("SELECT route, COUNT(*) AS n FROM audit WHERE ts >= ? GROUP BY route ORDER BY n DESC, route LIMIT 30").bind(since),
    env.DB.prepare("SELECT date(ts / 1000, 'unixepoch') AS day, COALESCE(SUM(status < 400), 0) AS ok, COALESCE(SUM(status >= 400), 0) AS bad FROM audit WHERE ts >= ? GROUP BY day").bind(since),
  ]);
  const found = new Map(perDay.results.map((r) => [r.day, r]));
  return json({
    ok: true,
    days,
    harnesses: foldByHarness(harnesses.results.map((r) => ({ harness: r.harness, calls: r.n })), ["calls"]),
    routes: routes.results.map((r) => ({ route: r.route, calls: r.n })),
    per_day: lastDays(days, at).map((day) => ({ day, ok: n0(found.get(day)?.ok), bad: n0(found.get(day)?.bad) })),
  });
}
