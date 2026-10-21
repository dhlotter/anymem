// The subject routes. Each handler reads and checks input, calls the subject store, and notes the card memory id for the audit row.
// A device token may read subjects but not write them (the route table says so), and never sees a private subject it is kept from.
import { cleanLabel } from "../audit.js";
import { harnessId } from "../harnesses.js";
import { badRequest, HttpError, json, notFound, readJson } from "../http.js";
import { indexMemories } from "../search/indexer.js";
import { REASONS, screenExplicit } from "../write/screen.js";
import { clearCiting, clearIneligible } from "./clear.js";
import { canSee, seesPrivate, SHED_MEMBERS_SQL, visibleOnly } from "./private.js";
import { createSubjectStore, KINDS, SCOPES, STATUSES } from "./store.js";

/** Bring the search keys and vectors of the card up to date after the reply has gone. A failure leaves it marked for the nightly job. */
function indexLater({ env, ctx, now }, id) {
  ctx.waitUntil(indexMemories(env, [id], now).catch(() => console.error("indexing failed")));
}

/** The secret screen every explicit write gets. It covers the brief and every field value, because both reach a prompt. */
function refuseSecret(body) {
  const values = body.fields && typeof body.fields === "object" ? Object.values(body.fields).filter((v) => typeof v === "string") : [];
  const names = [typeof body.name === "string" ? body.name : "", ...(Array.isArray(body.aliases) ? body.aliases.filter((a) => typeof a === "string") : [])];
  const screened = screenExplicit([typeof body.brief === "string" ? body.brief : "", ...names, ...values].join("\n"));
  if (!screened.ok) throw new HttpError(422, "refused", REASONS[screened.reason]);
}

function oneOf(url, name, allowed) {
  const value = url.searchParams.get(name);
  if (value && !allowed.includes(value)) throw badRequest(`${name} must be one of ${allowed.join(", ")}.`);
  return value || undefined;
}

/** POST /subject {slug, kind, name, brief?, fields?, aliases?, scope?} */
export async function createSubject(c) {
  const { request, env, now, maxBody, memoryIds } = c;
  const body = await readJson(request, maxBody);
  refuseSecret(body);
  const subject = await createSubjectStore(env.DB, now).create({ ...body, harness: harnessId(cleanLabel(request.headers.get("x-anymem-harness"))) });
  memoryIds.push(subject.id);
  indexLater(c, subject.id);
  return json({ ok: true, subject });
}

/** The members of a subject that has just become private stop being readable through anything shared. */
async function hideMembers({ env, ctx, now }, id) {
  await env.DB.prepare(SHED_MEMBERS_SQL).bind(id, id).run();
  const { results } = await env.DB.prepare("SELECT source_id FROM links WHERE target_id = ? AND link_type = 'about'").bind(id).all();
  await clearCiting(env, { ids: results.map((r) => r.source_id), now, ctx, sharedOnly: true, why: "member.private", strict: true });
}

/** POST /subject/update {id | slug, name?, brief?, fields?, aliases?, scope?, status?} */
export async function updateSubject(c) {
  const { request, env, now, maxBody, memoryIds } = c;
  const body = await readJson(request, maxBody);
  const store = createSubjectStore(env.DB, now);
  const id = await store.idOf(body);
  if (!id) throw notFound("No subject with that id or slug.");
  memoryIds.push(id);
  const changes = ["name", "brief", "fields", "aliases", "scope", "status"];
  if (!changes.some((k) => body[k] !== undefined)) throw badRequest(`Send at least one of ${changes.join(", ")}.`);
  refuseSecret(body);
  const was = body.scope === undefined ? null : (await env.DB.prepare("SELECT scope FROM subjects WHERE id = ?").bind(id).first())?.scope;
  const subject = await store.update(id, body);
  // A subject that turns private makes every member private, so the shared subjects the system linked those members to, and the shared briefs built from them, go now.
  if (body.scope === "private" && was !== "private") await hideMembers(c, id);
  // A private subject that turns shared may hold text of members that belong to another private subject, which a shared card must not.
  if (body.scope === "shared" && was === "private") await clearIneligible(env, { now, ctx: c.ctx, only: id, strict: true });
  if (body.name !== undefined || body.brief !== undefined || body.status === "active") indexLater(c, id);
  return json({ ok: true, subject });
}

/**
 * A closed device is not told when a brief was built or why it is stale. "members_changed" and a blank build time say that a member
 * of the subject has just gone private or been forgotten, which is the one thing a closed device must not learn.
 */
function withoutBriefState(subject) {
  delete subject.built_at;
  delete subject.stale_reason;
}

/** GET /subjects?kind=&status=&scope=&q= */
export async function listSubjects({ env, url, now, memoryIds, actor }) {
  const subjects = await createSubjectStore(env.DB, now).list({
    kind: oneOf(url, "kind", KINDS),
    status: oneOf(url, "status", STATUSES),
    scope: oneOf(url, "scope", SCOPES),
    q: url.searchParams.get("q") ?? undefined,
  });
  const seen = await visibleOnly(env.DB, subjects, actor);
  memoryIds.push(...seen.map((s) => s.id));
  if (seen.length && !(await seesPrivate(env.DB, actor))) seen.forEach(withoutBriefState);
  return json({ ok: true, subjects: seen });
}

/** GET /subject?slug= or ?id=. A subject the caller may not see is a 404, the same as one that does not exist. */
export async function getSubject({ env, url, now, memoryIds, actor }) {
  const slug = url.searchParams.get("slug");
  const id = url.searchParams.get("id");
  if (!slug && !id) throw badRequest("slug or id is required.");
  const store = createSubjectStore(env.DB, now);
  const found = await store.idOf({ id, slug });
  const subject = found && (await canSee(env.DB, found, actor)) ? await store.get(found) : null;
  if (!subject) throw notFound("No such subject.");
  memoryIds.push(subject.id);
  subject.members = await visibleOnly(env.DB, subject.members, actor);
  if (!(await seesPrivate(env.DB, actor))) withoutBriefState(subject);
  return json({ ok: true, subject });
}
