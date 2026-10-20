// GET /recall. Reads the query string, runs the recall, and adds the recall count and one recall_log row per returned memory only when asked (never for a browser login).
import { cleanLabel } from "../audit.js";
import { harnessId } from "../harnesses.js";
import { badRequest, flag, HttpError, intParam, json, notFound } from "../http.js";
import { KINDS, normalizeTags, TYPES } from "../memory/parse.js";
import { ORIGINS } from "../memory/store.js";
import { MAX_TOP_K, recall, recallSubject } from "./recall.js";

const MAX_INT = Number.MAX_SAFE_INTEGER;
const MAX_EXCLUDED = 200;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SUBJECT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function oneOf(value, allowed, name) {
  if (value !== null && !allowed.includes(value)) throw badRequest(`${name} must be one of ${allowed.join(", ")}.`);
  return value ?? undefined;
}

/** scope=all, or scope=project:<slug> for that project plus the global memories. @returns {string | null} the project */
function projectOf(scope) {
  if (scope === null || scope === "all") return null;
  const slug = scope.startsWith("project:") ? scope.slice("project:".length).toLowerCase() : "";
  if (!SLUG.test(slug)) throw badRequest("scope must be all or project:<slug>.", "bad_scope");
  return slug;
}

function idList(raw) {
  if (!raw) return [];
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length > MAX_EXCLUDED || ids.some((id) => id.length > 64)) throw badRequest(`exclude_ids takes at most ${MAX_EXCLUDED} ids of 64 characters.`);
  return ids;
}

/** GET /recall?subject=SLUG, the memories about one subject. A plain read: no ranking, no recall count. */
async function getSubjectRecall({ env, url, memoryIds, actor }, slug) {
  const found = SUBJECT_SLUG.test(slug) ? await recallSubject(env, { slug, topK: intParam(url, "topK", { min: 1, max: MAX_TOP_K }), actor }) : null;
  if (!found) throw notFound("No subject with that slug.");
  memoryIds.push(found.subject.id, ...found.results.map((r) => r.id));
  return json({ ok: true, query: null, subject: found.subject, results: found.results });
}

/** GET /recall?query=&topK=&scope=&exclude_ids=&tag=&kind=&type=&origin=&after=&before=&min_recalls=&as_of=&capsule=&explain=&checks=&count= */
export async function getRecall({ request, env, url, now, ctx, memoryIds, actor }) {
  const p = url.searchParams;
  if (p.has("subject")) return getSubjectRecall({ env, url, memoryIds, actor }, p.get("subject"));
  const query = p.get("query");
  if (query === null) throw badRequest("query is required.");
  // A browser login is a plain read. The cookie rides on any cross site request, so count=1 must not write for it.
  const count = flag(url, "count") && actor.kind !== "browser";
  const explain = flag(url, "explain");
  const started = now();
  let found;
  try {
    found = await recall(
      env,
      {
        query,
        topK: intParam(url, "topK", { min: 1, max: MAX_TOP_K }),
        project: projectOf(p.get("scope")),
        excludeIds: idList(p.get("exclude_ids")),
        tags: normalizeTags(p.getAll("tag")),
        kind: oneOf(p.get("kind"), KINDS, "kind"),
        type: oneOf(p.get("type"), TYPES, "type"),
        origin: oneOf(p.get("origin"), ORIGINS, "origin"),
        after: intParam(url, "after", { min: 0, max: MAX_INT }),
        before: intParam(url, "before", { min: 0, max: MAX_INT }),
        minRecalls: intParam(url, "min_recalls", { min: 0, max: MAX_INT }),
        asOf: intParam(url, "as_of", { min: 0, max: MAX_INT }),
        capsule: flag(url, "capsule"),
        explain,
        checks: explain && flag(url, "checks"),
        actor,
      },
      now,
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("recall failed", err?.name);
    throw new HttpError(502, "recall_failed", "The search could not run. Try again.");
  }
  const ids = found.results.map((r) => r.id);
  memoryIds.push(...ids, ...(found.subjects ?? []).map((c) => c.id));
  // The only write a recall makes, and only when the caller asks for it. Only relevant hits count, because the client drops the weak ones.
  const counted = found.results.filter((r) => r.relevant).map((r) => r.id);
  if (count && counted.length) {
    const at = now();
    const list = JSON.stringify(counted);
    ctx.waitUntil(
      env.DB.prepare("UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id IN (SELECT value FROM json_each(?))")
        .bind(at, list)
        .run()
        .catch(() => console.error("recall count failed")),
    );
    // Which tool was given which memory. Its own statement, so a failure here never undoes the count. No query text goes in.
    ctx.waitUntil(
      env.DB.prepare("INSERT INTO recall_log (ts, harness, memory_id) SELECT ?, ?, value FROM json_each(?)")
        .bind(at, harnessId(cleanLabel(request.headers.get("x-anymem-harness"))), list)
        .run()
        .catch(() => console.error("recall log failed")),
    );
  }
  return json({ ok: true, query: found.query, results: found.results, ...(found.subjects ? { subjects: found.subjects } : {}), ...(found.degraded ? { degraded: found.degraded } : {}), ...(explain ? { took_ms: now() - started, timings: found.timings } : {}) });
}
