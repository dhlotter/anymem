// Read routes the dashboard needs, and the guard for what a browser login may save through /capture.
import { foldByHarness } from "./harnesses.js";
import { badRequest, forbidden, json, notFound, readJson } from "./http.js";
import { createStore, TRASH_WINDOW_MS } from "./memory/store.js";
import { hiddenIds } from "./subjects/private.js";
import { LIVE, stats } from "./system.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 30;
const PEOPLE_PAGE = 500;
const tally = (rows, key) => Object.fromEntries(rows.map((r) => [r[key] ?? "", r.n]));
/** A pending memory the People screen shows: a profile or person note, or one tagged profile-proposal. The list and the home count both use it. */
export const isProposal = (e) => e.origin === "profile" || e.origin === "person" || e.tags.includes("profile-proposal");
const PROPOSAL_SQL = "(origin IN ('profile', 'person') OR id IN (SELECT memory_id FROM memory_tags WHERE tag = 'profile-proposal'))";
/** Every change waiting for a decision. The Home badge and the People count both read this, so they always agree. */
export const PENDING_PROPOSALS_SQL = `deleted_at IS NULL AND valid_until IS NULL AND status = 'pending' AND ${PROPOSAL_SQL}`;

/** GET /ui/api/overview. Everything /stats reports (so later additions show up), plus the breakdowns the Health screen needs. */
export async function overview(c) {
  const { env, now } = c;
  const base = await (await stats(c)).json();
  const [project, kind, type, pending, trash] = await env.DB.batch([
    env.DB.prepare(`SELECT project AS k, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY project`),
    env.DB.prepare(`SELECT kind AS k, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY kind`),
    env.DB.prepare(`SELECT type AS k, COUNT(*) AS n FROM memories WHERE ${LIVE} GROUP BY type`),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL AND status = 'pending'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL AND deleted_at >= ?").bind(now() - 14 * DAY_MS),
  ]);
  let vectors = null;
  try {
    const info = await env.VECTORIZE.describe();
    if (Number.isFinite(info.vectorCount)) vectors = { count: info.vectorCount, dimensions: info.dimensions ?? info.config?.dimensions ?? null };
  } catch {
    // vector figures are optional
  }
  return json({
    ...base,
    now: now(),
    by_project: tally(project.results, "k"),
    by_kind: tally(kind.results, "k"),
    by_type: tally(type.results, "k"),
    pending: pending.results[0].n,
    trash: trash.results[0].n,
    vectors,
    capture: base.capture ?? null,
  });
}

/**
 * GET /ui/api/people. The profile memory, the person notes, and the pending changes (status pending). pending_total is the same count
 * as the Home badge, so the page can say when it shows only the first PEOPLE_PAGE of them.
 */
export async function people({ env, now, memoryIds }) {
  const store = createStore(env.DB, now);
  // A pending change is found three ways, each its own list, so a pending memory of another kind cannot push one out of the page.
  const [profile, persons, pendingProfile, pendingPerson, pendingTagged, total] = await Promise.all([
    store.list({ origin: "profile", n: PEOPLE_PAGE }),
    store.list({ origin: "person", n: PEOPLE_PAGE }),
    store.list({ status: "pending", origin: "profile", n: PEOPLE_PAGE }),
    store.list({ status: "pending", origin: "person", n: PEOPLE_PAGE }),
    store.list({ status: "pending", tags: ["profile-proposal"], n: PEOPLE_PAGE }),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${PENDING_PROPOSALS_SQL}`).first(),
  ]);
  const found = new Map();
  for (const list of [pendingProfile, pendingPerson, pendingTagged]) for (const e of list.entries) if (isProposal(e)) found.set(e.id, e);
  const proposals = [...found.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1)).slice(0, PEOPLE_PAGE);
  const settled = (list) => list.entries.filter((e) => e.status !== "pending"); // a pending change is shown under pending only
  const out = { profile: settled(profile), people: settled(persons), pending: proposals };
  memoryIds.push(...[...out.profile, ...out.people, ...out.pending].map((e) => e.id));
  return json({ ok: true, ...out, pending_total: total.n });
}

/** The Access token expiry from ACCESS_TOKEN_EXPIRES (a date such as 2027-10-07). Shared with the nightly job. */
export function tokenExpiryInfo(env, now) {
  const raw = String(env.ACCESS_TOKEN_EXPIRES ?? "").trim();
  const at = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(raw) ? Date.parse(/T/.test(raw) ? raw : `${raw}T00:00:00Z`) : NaN;
  if (!Number.isFinite(at)) return { configured: false };
  const daysLeft = Math.floor((at - now()) / DAY_MS);
  return { configured: true, expires: raw, days_left: daysLeft, warn: daysLeft <= WARN_DAYS };
}

/** GET /ui/api/token-expiry */
export async function tokenExpiry({ env, now }) {
  return json({ ok: true, ...tokenExpiryInfo(env, now) });
}

/**
 * Wraps the /capture handler. A browser login may only save profile and person notes through it, nothing else.
 * Any other caller goes straight through.
 */
export const profileSavesOnly = (handler) => async (c) => {
  if (c.actor.kind === "browser") {
    const body = await readJson(c.request.clone(), c.maxBody);
    const origin = body.origin ?? body.source;
    if (origin !== "profile" && origin !== "person") throw forbidden("A browser login can only save profile and person notes.", "browser_capture_scope");
  }
  return handler(c);
};

// The save of a memory is found in the audit trail by its time, so a later save of the same memory is never taken for it.
// The audit time is the start of the request and the memory is stored after the screens and model calls, which take up to 25 seconds.
const SAVE_EARLY_MS = 120_000;
const SAVE_LATE_MS = 5_000;

/**
 * GET /ui/api/memory-extras?id=. What the entry does not carry, which is the probation end, the links in both directions, who saved it and
 * which tools were given it. Who saved it comes from the audit trail, which keeps 90 days, so an older memory has none. A device
 * token is not told which other device saved a memory.
 */
export async function memoryExtras({ env, url, actor, memoryIds }) {
  const id = url.searchParams.get("id");
  if (!id || id.length > 64) throw badRequest("id is required.");
  const [row, out, into, saved, used, log] = await env.DB.batch([
    env.DB.prepare("SELECT probation_until, deleted_at FROM memories WHERE id = ?").bind(id),
    env.DB.prepare("SELECT l.target_id AS id, l.link_type AS type, l.created_at, m.name FROM links l JOIN memories m ON m.id = l.target_id WHERE l.source_id = ? AND m.deleted_at IS NULL ORDER BY l.created_at DESC").bind(id),
    env.DB.prepare("SELECT l.source_id AS id, l.link_type AS type, l.created_at, m.name FROM links l JOIN memories m ON m.id = l.source_id WHERE l.target_id = ? AND m.deleted_at IS NULL ORDER BY l.created_at DESC").bind(id),
    env.DB.prepare(
      `SELECT a.ts, a.actor_kind, a.script, d.label FROM audit a JOIN memories m ON m.id = ? LEFT JOIN devices d ON d.id = a.actor_id
       WHERE a.route = '/capture' AND a.method = 'POST' AND a.status < 400 AND a.ts BETWEEN m.created_at - ${SAVE_EARLY_MS} AND m.created_at + ${SAVE_LATE_MS}
       AND EXISTS (SELECT 1 FROM json_each(a.memory_ids) j WHERE j.value = ?) ORDER BY a.ts LIMIT 1`,
    ).bind(id, id),
    env.DB.prepare("SELECT harness, COUNT(*) AS n FROM recall_log WHERE memory_id = ? GROUP BY harness").bind(id),
    env.DB.prepare("SELECT MIN(ts) AS first FROM recall_log"),
  ]);
  if (!row.results.length) throw notFound("No memory with that id.");
  // The links carry the names of their other ends, so a device without private access gets the same cut as GET /links.
  const linked = [...out.results.map((l) => ({ ...l, direction: "out" })), ...into.results.map((l) => ({ ...l, direction: "in" }))];
  const hidden = await hiddenIds(env.DB, [id, ...linked.map((l) => l.id)], actor);
  if (hidden.has(id)) throw notFound("No memory with that id.");
  memoryIds.push(id);
  const found = saved.results[0];
  const who = !found ? null : found.actor_kind === "device" ? found.label || "A device that was removed" : found.actor_kind === "admin" ? "The admin token" : "The dashboard";
  const trashedAt = row.results[0].deleted_at;
  return json({
    ok: true,
    probation_until: row.results[0].probation_until,
    purge_at: trashedAt === null ? null : trashedAt + TRASH_WINDOW_MS, // when a trashed memory goes for good, from the Worker's own window
    links: hidden.size ? linked.filter((l) => !hidden.has(l.id)) : linked,
    ...(actor.kind === "device" ? {} : { saved_by: found ? { at: found.ts, by: who, kind: found.actor_kind, script: found.script } : null }),
    recalled_by: foldByHarness(used.results.map((r) => ({ harness: r.harness, times: r.n })), ["times"]),
    recall_log_since: log.results[0].first,
  });
}
