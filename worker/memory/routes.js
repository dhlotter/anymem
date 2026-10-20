// The memory routes. Each handler reads and checks input, calls the store, and notes the memory ids it touched for the audit row.
import { cleanLabel } from "../audit.js";
import { badRequest, flag, forbidden, HttpError, intParam, json, notFound, readJson } from "../http.js";
import { indexMemories } from "../search/indexer.js";
import { REASONS, screenExplicit } from "../write/screen.js";
import { adminHeld, adminOnlyMessage, adminOnlyTags, LINK_TYPES, normalizeTags, RESERVED_LINK_TYPES, STATUSES, TYPES } from "./parse.js";
import { createStore, ORIGINS, SORTS } from "./store.js";

const MAX_INT = Number.MAX_SAFE_INTEGER;

/** Bring the search keys and vectors up to date after the reply has gone. A failure leaves the memory marked for the nightly job. */
function indexLater({ env, ctx, now }, id) {
  ctx.waitUntil(indexMemories(env, [id], now).catch(() => console.error("indexing failed")));
}

/** The secret screen every explicit write gets, the same one POST /capture runs before it stores a memory. */
function refuseSecret(text) {
  const screened = screenExplicit(text);
  if (!screened.ok) throw new HttpError(422, "refused", REASONS[screened.reason]);
}

function idOf(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 64) throw badRequest("id is required.");
  return value.trim();
}

function oneOf(value, allowed, name) {
  if (value !== null && !allowed.includes(value)) throw badRequest(`${name} must be one of ${allowed.join(", ")}.`);
  return value ?? undefined;
}

/**
 * A device token may not change a memory that holds admin only tags or the canonical status, whatever the request says.
 * Sending the request's own tags is not enough: an update replaces the stored tags, and an undo restores an earlier state,
 * so removing or bringing back a capsule tag is a write too. For an undo the state it would restore is checked as well.
 */
async function guardDevice({ env, now, actor }, id, { undo = false } = {}) {
  if (actor.kind !== "device") return;
  const store = createStore(env.DB, now);
  let restricted = [];
  const cur = await store.get(id, { trash: true });
  if (cur) restricted = adminHeld(cur);
  if (cur && !restricted.length && undo) {
    const [last] = (await store.history(id)) ?? [];
    const prev = last && (await store.getVersion(id, last.seq, { trash: true }));
    if (prev) restricted = adminHeld(prev);
  }
  if (restricted.length) throw forbidden(adminOnlyMessage(restricted), "admin_only");
}

/** GET /entry?id=  with optional version=N and deleted=1. */
export async function getEntry({ env, url, now, memoryIds }) {
  const id = idOf(url.searchParams.get("id"));
  const version = intParam(url, "version", { min: 1, max: MAX_INT });
  const trash = flag(url, "deleted");
  const store = createStore(env.DB, now);
  const entry = version === undefined ? await store.get(id, { trash }) : await store.getVersion(id, version, { trash });
  if (!entry) throw notFound(version === undefined ? "No memory with that id." : "No such memory or version.");
  memoryIds.push(id);
  return json({ ok: true, entry });
}

/** The harness filter of GET /list. A short name, or none for the memories with no harness. */
function harnessFilter(value) {
  if (value === null || value === "") return undefined;
  if (value.length > 64 || cleanLabel(value) !== value) throw badRequest("harness must be a short name, or none.");
  return value;
}

/** GET /list. Filters are tag, status, origin, harness, type, project, after, before, min_recalls, max_recalls, deleted, sort, n and cursor. */
export async function listEntries({ env, url, now, memoryIds }) {
  const p = url.searchParams;
  const n = intParam(url, "n", { min: 1, max: 500, fallback: 50 });
  const result = await createStore(env.DB, now).list({
    tags: normalizeTags(p.getAll("tag")),
    status: oneOf(p.get("status"), STATUSES, "status"),
    origin: oneOf(p.get("origin"), ORIGINS, "origin"),
    harness: harnessFilter(p.get("harness")),
    type: oneOf(p.get("type"), TYPES, "type"),
    project: p.get("project") || undefined,
    after: intParam(url, "after", { min: 0, max: MAX_INT }),
    before: intParam(url, "before", { min: 0, max: MAX_INT }),
    minRecalls: intParam(url, "min_recalls", { min: 0, max: MAX_INT }),
    maxRecalls: intParam(url, "max_recalls", { min: 0, max: MAX_INT }),
    trash: flag(url, "deleted"),
    sort: oneOf(p.get("sort"), Object.keys(SORTS), "sort"),
    n,
    cursor: p.get("cursor") || undefined,
  });
  memoryIds.push(...result.entries.map((e) => e.id));
  return json({ ok: true, ...result });
}

/** POST /update {id, content?, tags?, if_updated_at?} */
export async function update(c) {
  const { request, env, now, maxBody, memoryIds, actor } = c;
  const body = await readJson(request, maxBody);
  const id = idOf(body.id);
  if (body.content === undefined && body.tags === undefined) throw badRequest("Send content, tags or both.");
  if (body.content !== undefined && typeof body.content !== "string") throw badRequest("content must be a string.");
  if (body.if_updated_at !== undefined && !Number.isSafeInteger(body.if_updated_at)) throw badRequest("if_updated_at must be a whole number of milliseconds.");
  const restricted = actor.kind === "device" ? adminOnlyTags(normalizeTags(body.tags)) : [];
  if (restricted.length) throw forbidden(adminOnlyMessage(restricted), "admin_only");
  await guardDevice(c, id);
  if (typeof body.content === "string") refuseSecret(body.content);
  memoryIds.push(id);
  const entry = await createStore(env.DB, now).update({ id, content: body.content, tags: body.tags === undefined ? undefined : normalizeTags(body.tags), ifUpdatedAt: body.if_updated_at });
  indexLater(c, id);
  return json({ ok: true, entry });
}

/** POST /append {id, addition} */
export async function append(c) {
  const { request, env, now, maxBody, memoryIds } = c;
  const body = await readJson(request, maxBody);
  const id = idOf(body.id);
  await guardDevice(c, id);
  if (typeof body.addition === "string") refuseSecret(body.addition);
  memoryIds.push(id);
  const entry = await createStore(env.DB, now).append(id, body.addition);
  indexLater(c, id);
  return json({ ok: true, entry });
}

/** POST /status {id, status} */
export async function setStatus(c) {
  const { request, env, now, maxBody, memoryIds, actor } = c;
  const body = await readJson(request, maxBody);
  const id = idOf(body.id);
  if (actor.kind === "device" && body.status === "canonical") throw forbidden(adminOnlyMessage(["status:canonical"]), "admin_only");
  await guardDevice(c, id);
  memoryIds.push(id);
  const entry = await createStore(env.DB, now).setStatus(id, body.status);
  indexLater(c, id);
  return json({ ok: true, entry });
}

/** Builds a handler for the routes that only take an id. */
const byId = (method) =>
  async function (c) {
    const { request, env, now, maxBody, memoryIds } = c;
    const id = idOf((await readJson(request, maxBody)).id);
    await guardDevice(c, id, { undo: method === "undo" });
    memoryIds.push(id);
    const entry = await createStore(env.DB, now)[method](id);
    indexLater(c, id);
    return json({ ok: true, entry });
  };

/** POST /forget {id}, moves the memory to the trash. */
export const forget = byId("softDelete");
/** POST /restore {id} */
export const restore = byId("restore");
/** POST /undo {id} */
export const undo = byId("undo");

/** GET /history?id= */
export async function history({ env, url, now, memoryIds }) {
  const id = idOf(url.searchParams.get("id"));
  const versions = await createStore(env.DB, now).history(id);
  if (!versions) throw notFound("No memory with that id.");
  memoryIds.push(id);
  return json({ ok: true, id, versions });
}

/** POST /link {source_id, target_id, type}. The type is one of LINK_TYPES, and the two the system writes are refused. */
export async function link({ request, env, now, maxBody, memoryIds }) {
  const body = await readJson(request, maxBody);
  const source = idOf(body.source_id);
  const target = idOf(body.target_id);
  memoryIds.push(source, target);
  const type = typeof body.type === "string" ? body.type.trim().toLowerCase() : body.type;
  if (!LINK_TYPES.includes(type)) throw badRequest(`type must be one of ${LINK_TYPES.join(", ")}.`, "bad_link_type");
  if (RESERVED_LINK_TYPES.includes(type)) throw badRequest(`${type} is written by the system only. Use one of ${LINK_TYPES.filter((t) => !RESERVED_LINK_TYPES.includes(t)).join(", ")}.`, "reserved_link_type");
  const { created } = await createStore(env.DB, now).link(source, target, type);
  return json({ ok: true, created });
}

/**
 * POST /unlink {source_id, target_id, type}. A device token may not touch a link whose end holds capsule tags or the canonical
 * status, and may remove only links a user made. A link the system made is remembered as rejected, so the system never remakes it.
 */
export async function unlink(c) {
  const { request, env, now, maxBody, memoryIds, actor } = c;
  const body = await readJson(request, maxBody);
  const source = idOf(body.source_id);
  const target = idOf(body.target_id);
  memoryIds.push(source, target);
  await guardDevice(c, source);
  await guardDevice(c, target);
  const { removed } = await createStore(env.DB, now).unlink(source, target, body.type, { userOnly: actor.kind === "device" });
  return json({ ok: true, removed });
}

/** GET /links?id= */
export async function getLinks({ env, url, now, memoryIds }) {
  const id = idOf(url.searchParams.get("id"));
  const links = await createStore(env.DB, now).links(id);
  if (!links) throw notFound("No memory with that id.");
  memoryIds.push(id);
  return json({ ok: true, id, links });
}
