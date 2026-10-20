// Entry point and router. Every reply is JSON, except the dashboard files and a backup download, which is gzip. An authenticated request writes one audit row.
import { createKeyCache, authenticate } from "./auth.js";
import { noteOutcomes } from "./outcomes.js";
import { capsuleRoute, onChange as capsuleChanged } from "./capsule.js";
import { memoryExtras, overview, people, profileSavesOnly, tokenExpiry } from "./dashboard-api.js";
import { harnesses, sourcesRoute } from "./dashboard-harnesses.js";
import { activity, auditFacets, growth, home, probation, recalls, runs, trash, usage } from "./dashboard-insights.js";
import { serveUi } from "./dashboard.js";
import { checkHost } from "./hosts.js";
import { cleanLabel, listAudit, recordAudit } from "./audit.js";
import { takeModelSlot, takeWriteSlot, writeRefused } from "./limits.js";
import { downloadBackupRoute, exportRoute, listBackupsRoute, runBackupRoute } from "./backup/backup.js";
import { runMaintenance, runMaintenanceRoute } from "./cron/maintenance.js";
import { createDevice, listDevices, revokeDevice, setDevicePrivate } from "./devices.js";
import { HttpError, errorResponse, json, notFound } from "./http.js";
import { append, forget, getEntry, getLinks, history, link, listEntries, restore, setStatus, undo, unlink, update } from "./memory/routes.js";
import { createSubject, getSubject, listSubjects, updateSubject } from "./subjects/routes.js";
import { harnessRoute, importRoute, questionsRoute, reindexRoute } from "./admin/routes.js";
import { extractRoute } from "./extract/extract.js";
import { readProbe, startProbe } from "./search/probe.js";
import { getRecall } from "./search/routes.js";
import { capture } from "./write/route.js";
import { count, health, stats } from "./system.js";

const MAX_BODY_BYTES = 1_000_000;

// admin means the admin token (or a browser login) is needed. browser means a browser login is accepted too.
// browserWrite means a browser login may write, but only from the dashboard itself (see checkSameOrigin in auth.js).
// browserOnly means only a browser login, no bearer.
// writes means the route changes memories. A caller who is not the admin token or a browser login takes a write slot first.
// model means the route runs Workers AI. A caller who is not the admin token or a browser login takes a model slot first.
// quiet means a successful reply writes no audit row (the dashboard files).
const ROUTES = [
  { method: "GET", path: "/health", browser: true, handler: health },
  { method: "GET", path: "/count", browser: true, handler: count },
  { method: "GET", path: "/stats", admin: true, browser: true, handler: stats },
  { method: "GET", path: "/devices", admin: true, browser: true, handler: listDevices },
  { method: "POST", path: "/devices", admin: true, handler: createDevice },
  { method: "POST", path: "/devices/revoke", admin: true, handler: revokeDevice },
  { method: "POST", path: "/devices/private", admin: true, handler: setDevicePrivate },
  { method: "GET", path: "/audit", admin: true, browser: true, handler: listAudit },
  { method: "GET", path: "/entry", browser: true, handler: getEntry },
  { method: "GET", path: "/list", browser: true, handler: listEntries },
  { method: "GET", path: "/history", browser: true, handler: history },
  { method: "POST", path: "/capture", browserWrite: true, handler: profileSavesOnly(capture) },
  { method: "POST", path: "/extract", model: true, handler: extractRoute },
  { method: "POST", path: "/update", browserWrite: true, writes: true, handler: update },
  { method: "POST", path: "/append", browserWrite: true, writes: true, handler: append },
  { method: "POST", path: "/status", browserWrite: true, writes: true, handler: setStatus },
  { method: "POST", path: "/forget", browserWrite: true, writes: true, handler: forget },
  { method: "POST", path: "/restore", browserWrite: true, writes: true, handler: restore },
  { method: "POST", path: "/undo", browserWrite: true, writes: true, handler: undo },
  { method: "POST", path: "/link", browserWrite: true, writes: true, handler: link },
  { method: "POST", path: "/unlink", browserWrite: true, writes: true, handler: unlink },
  { method: "GET", path: "/links", browser: true, handler: getLinks },
  { method: "POST", path: "/subject", admin: true, browserWrite: true, writes: true, handler: createSubject },
  { method: "POST", path: "/subject/update", admin: true, browserWrite: true, writes: true, handler: updateSubject },
  { method: "GET", path: "/subjects", browser: true, handler: listSubjects },
  { method: "GET", path: "/subject", browser: true, handler: getSubject },
  { method: "GET", path: "/recall", browser: true, model: true, handler: getRecall },
  { method: "POST", path: "/admin/reindex", admin: true, handler: reindexRoute },
  { method: "POST", path: "/admin/questions", admin: true, handler: questionsRoute },
  { method: "POST", path: "/admin/harness", admin: true, handler: harnessRoute },
  { method: "POST", path: "/import", admin: true, handler: importRoute },
  { method: "GET", path: "/export", admin: true, browser: true, handler: exportRoute },
  { method: "GET", path: "/backup", admin: true, browser: true, handler: listBackupsRoute },
  { method: "POST", path: "/backup/run", admin: true, handler: runBackupRoute },
  { method: "POST", path: "/admin/run-maintenance", admin: true, handler: runMaintenanceRoute },
  { method: "POST", path: "/vectorize-probe", handler: startProbe },
  { method: "GET", path: "/vectorize-probe", handler: readProbe },
  { method: "GET", path: "/prompt-capsules/core", browser: true, handler: capsuleRoute },
  { method: "GET", path: "/ui/api/overview", admin: true, browser: true, handler: overview },
  { method: "GET", path: "/ui/api/people", browser: true, handler: people },
  { method: "GET", path: "/ui/api/token-expiry", browser: true, handler: tokenExpiry },
  { method: "GET", path: "/ui/api/memory-extras", browser: true, handler: memoryExtras },
  { method: "GET", path: "/ui/api/home", admin: true, browser: true, handler: home },
  { method: "GET", path: "/ui/api/growth", admin: true, browser: true, handler: growth },
  { method: "GET", path: "/ui/api/recalls", admin: true, browser: true, handler: recalls },
  { method: "GET", path: "/ui/api/probation", admin: true, browser: true, handler: probation },
  { method: "GET", path: "/ui/api/trash", admin: true, browser: true, handler: trash },
  { method: "GET", path: "/ui/api/harnesses", admin: true, browser: true, handler: harnesses },
  { method: "GET", path: "/ui/api/sources", admin: true, browser: true, handler: sourcesRoute },
  { method: "GET", path: "/ui/api/activity", admin: true, browser: true, handler: activity },
  { method: "GET", path: "/ui/api/runs", admin: true, browser: true, handler: runs },
  { method: "GET", path: "/ui/api/usage", admin: true, browser: true, handler: usage },
  { method: "GET", path: "/ui/api/audit-facets", admin: true, browser: true, handler: auditFacets },
  // The dashboard. A browser login only. The prefix routes come last so the exact routes above win.
  { method: "GET", path: "/backup/", prefix: true, admin: true, browser: true, handler: downloadBackupRoute },
  { method: "GET", path: "/", browser: true, browserOnly: true, quiet: true, handler: serveUi },
  { method: "GET", path: "/ui/", prefix: true, browser: true, browserOnly: true, quiet: true, handler: serveUi },
];

/**
 * @param {{fetch?: typeof fetch, now?: () => number, cache?: ReturnType<typeof createKeyCache>}} [overrides] for tests
 */
export function createWorker({ fetch: fetchFn = (...a) => fetch(...a), now = Date.now, cache = createKeyCache() } = {}) {
  const deps = { fetch: fetchFn, now, cache };

  async function handle(request, env, ctx) {
    const started = now();
    const url = new URL(request.url);
    // A host name that is not allowed gets a bare 404, with no authentication and no audit row.
    try {
      checkHost(env, url);
    } catch (err) {
      return errorResponse(err);
    }
    const state = { actor: { kind: "none", id: "" }, memoryIds: [] };
    let response;
    let route;
    try {
      const samePath = ROUTES.filter((r) => r.path === url.pathname || (r.prefix && url.pathname.startsWith(r.path)));
      if (!samePath.length) throw notFound("No such route.");
      route = samePath.find((r) => r.method === request.method);
      if (!route) {
        const allow = samePath.map((r) => r.method).join(", ");
        throw Object.assign(new HttpError(405, "method_not_allowed", `Use ${allow} on this route.`), { allow });
      }
      // The actor is noted before the route's own checks, so a refused request is still audited.
      const identity = await authenticate(request, env, route, deps, (actor) => {
        state.actor = actor;
      });
      state.actor = identity.actor;
      noteOutcomes({ request, env, ctx, now, actor: identity.actor });
      if (identity.deviceId) ctx.waitUntil(env.DB.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").bind(now(), identity.deviceId).run().catch(() => {}));
      // Every write route shares one count per token with /capture. The admin token and a browser login are not counted here.
      let slot = { ok: true };
      if (!identity.admin && route.writes) slot = await takeWriteSlot(env.DB, identity.actor.id, now());
      if (!identity.admin && route.model) slot = await takeModelSlot(env.DB, identity.actor.id, now());
      if (!slot.ok) {
        const refused = writeRefused(slot, route.model ? "model calls" : "writes");
        response = json(refused.body, refused.status, refused.headers);
      } else {
        response = await route.handler({ request, url, env, ctx, now, maxBody: MAX_BODY_BYTES, actor: identity.actor, memoryIds: state.memoryIds });
        if (request.method !== "GET" && response.status < 300) await capsuleChanged(env.DB, state.memoryIds).catch(() => console.error("capsule cache update failed"));
      }
    } catch (err) {
      if (err instanceof HttpError) {
        response = errorResponse(err, err.allow ? { allow: err.allow } : {});
      } else {
        console.error("unhandled error", err?.name);
        response = json({ error: "Something went wrong on the server.", code: "internal" }, 500);
      }
    }
    // Anonymous traffic writes nothing, and neither does a successful dashboard file load. Authenticated API calls are audited.
    if (state.actor.kind === "none" || (route?.quiet && response.status < 400)) return response;
    // The audit write never delays the reply.
    ctx.waitUntil(
      recordAudit(env.DB, {
        ts: started,
        actor: state.actor,
        harness: cleanLabel(request.headers.get("x-anymem-harness")),
        script: cleanLabel(request.headers.get("x-anymem-script")),
        method: request.method,
        route: url.pathname,
        status: response.status,
        durationMs: now() - started,
        memoryIds: state.memoryIds,
      }).catch(() => console.error("audit write failed")),
    );
    return response;
  }

  return {
    fetch: handle,
    /** The nightly cron. */
    async scheduled(_event, env, ctx) {
      ctx.waitUntil(runMaintenance(env, now));
    },
  };
}

export default createWorker();
