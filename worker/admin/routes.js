// Admin routes that load data and keep the index healthy. Admin token only.
import { HARNESSES, knownHarness } from "../harnesses.js";
import { badRequest, HttpError, json, notFound, readJson } from "../http.js";
import { createStore } from "../memory/store.js";
import { reindex } from "../search/indexer.js";
import { likelyQuestions } from "../search/questions.js";
import { memoryText } from "../search/chunk.js";
import { importV2 } from "../backup/import.js";
import { mapLegacy } from "./legacy.js";

const MAX_REINDEX = 200;
const DEFAULT_REINDEX = 50;
const MAX_IMPORT_PAGE = 200;
const DEFAULT_IMPORT_PAGE = 50;
const MAX_IMPORT_BYTES = 10_000_000;
const PARALLEL = 10;
const MAX_ERRORS = 20;
const DEFAULT_QUESTIONS = 20;
const MAX_QUESTIONS = 100;
const PARALLEL_MODEL_CALLS = 5;

function pageSize(value, fallback, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw badRequest(`${name} must be a whole number from 1 to ${max}.`);
  return value;
}

/** POST /admin/reindex {limit?}. Indexes memories that lack current vectors, oldest first. Call it until remaining is 0. */
export async function reindexRoute({ request, env, now, maxBody }) {
  const body = request.body ? await readJson(request, maxBody) : {};
  const limit = pageSize(body.limit, DEFAULT_REINDEX, MAX_REINDEX, "limit");
  try {
    return json({ ok: true, ...(await reindex(env, limit, now)) });
  } catch (err) {
    console.error("reindex failed", err?.name);
    throw new HttpError(502, "index_failed", "Indexing failed part way. Call it again, finished work is kept.");
  }
}

/**
 * POST /import {entries, offset?, limit?}. The entries of the old Worker's export. A body with format 2 is an export or backup
 * of this Worker and goes to backup/import.js. Entries offset up to offset + limit
 * are imported, an id that already exists is skipped, so a page can be sent twice. The search index is not built here,
 * call /admin/reindex after.
 */
export async function importRoute({ request, env, now, memoryIds, ctx }) {
  const body = await readJson(request, MAX_IMPORT_BYTES);
  if (!Array.isArray(body.entries)) throw badRequest("entries must be a list.");
  const offset = body.offset === undefined ? 0 : body.offset;
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest("offset must be a whole number of 0 or more.");
  const limit = pageSize(body.limit, DEFAULT_IMPORT_PAGE, MAX_IMPORT_PAGE, "limit");
  if (body.format === 2) return json(await importV2(env, body, { offset, limit }, memoryIds, { now, ctx }));
  const page = body.entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  const ids = page.map((e) => (typeof e?.id === "string" ? e.id.trim() : "")).filter(Boolean);
  const { results } = await env.DB.prepare("SELECT id FROM memories WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
  const seen = new Set(results.map((r) => r.id));

  const store = createStore(env.DB, now);
  const importedAt = now();
  const errors = [];
  let imported = 0;
  let skipped = 0;
  const one = async (entry) => {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (id && seen.has(id)) return void skipped++;
    seen.add(id);
    try {
      const created = await store.create(await mapLegacy(entry, importedAt));
      memoryIds.push(created.id);
      imported++;
    } catch (err) {
      skipped++;
      const reason = err instanceof HttpError ? err.message : "The entry could not be stored.";
      if (errors.length < MAX_ERRORS) errors.push({ id: typeof entry?.id === "string" ? entry.id.slice(0, 64) : null, error: reason });
    }
  };
  for (let i = 0; i < page.length; i += PARALLEL) await Promise.all(page.slice(i, i + PARALLEL).map(one));
  return json({ ok: true, imported, skipped, next_offset: nextOffset, remaining: Math.max(0, body.entries.length - nextOffset), ...(errors.length ? { errors } : {}) });
}

/**
 * POST /admin/questions {limit?}. Writes likely questions for memories that have none, as search keys waiting for the next
 * reindex. A memory the model answered without a usable question is marked in meta so it is not tried again on every call.
 * A memory whose model call failed is not marked, and it is counted in failed so the next call tries it again.
 */
export async function questionsRoute({ request, env, now, maxBody }) {
  const body = request.body ? await readJson(request, maxBody) : {};
  const limit = pageSize(body.limit, DEFAULT_QUESTIONS, MAX_QUESTIONS, "limit");
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.description, m.body FROM memories m
     WHERE m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM memory_keys k WHERE k.memory_id = m.id AND k.key_type = 'question')
     AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'no_questions:' || m.id) LIMIT ?`,
  ).bind(limit).all();
  let written = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i += PARALLEL_MODEL_CALLS) {
    await Promise.all(
      results.slice(i, i + PARALLEL_MODEL_CALLS).map(async (m) => {
        let questions;
        try {
          questions = await likelyQuestions(env.AI, memoryText(m));
        } catch (err) {
          // Not an answer, so nothing is marked and the next call asks again.
          failed++;
          console.error("questions failed", err?.name);
          return;
        }
        const statements = questions.length
          ? questions.map((q, n) => env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) VALUES (?, 'question', ?, ?, NULL, ?)").bind(m.id, n, q, now()))
          : [env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('no_questions:' || ?, '1')").bind(m.id)];
        await env.DB.batch(statements);
        written += questions.length;
      }),
    );
  }
  return json({ ok: true, memories: results.length, questions: written, failed });
}

/**
 * POST /admin/harness {id, harness}. Fills in the harness of a memory that has none, for the backfill script. It never replaces a
 * harness that is already there and never touches updated_at or the history, like ending probation. A name must be a known id or alias.
 * Admin only, so a device token and a browser login are both refused.
 */
export async function harnessRoute({ request, env, maxBody, memoryIds }) {
  const body = await readJson(request, maxBody);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || id.length > 64) throw badRequest("id is required.");
  const known = knownHarness(body.harness);
  if (!known) throw badRequest(`harness must be one of ${HARNESSES.map((h) => h.id).join(", ")}.`, "unknown_harness");
  const row = await env.DB.prepare("SELECT harness FROM memories WHERE id = ?").bind(id).first();
  if (!row) throw notFound("No memory with that id.");
  memoryIds.push(id);
  if (row.harness) return json({ ok: true, id, harness: row.harness, changed: false });
  const res = await env.DB.prepare("UPDATE memories SET harness = ? WHERE id = ? AND harness = ''").bind(known.id, id).run();
  if (res.meta.changes > 0) return json({ ok: true, id, harness: known.id, changed: true });
  // A racing call filled it in first, so say what is stored now.
  const now = await env.DB.prepare("SELECT harness FROM memories WHERE id = ?").bind(id).first();
  return json({ ok: true, id, harness: now?.harness ?? "", changed: false });
}
