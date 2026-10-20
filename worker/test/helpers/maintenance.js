// Helpers for the nightly job, backup and import tests. All sample text is invented.
import { createStore, FTS_INSERT } from "../../memory/store.js";
import { parseMemory } from "../../memory/parse.js";
import { reindex } from "../../search/indexer.js";
import { note } from "./search.js";
import { SMALL_MODEL } from "../../ai.js";

export const DAY = 24 * 60 * 60 * 1000;

/**
 * Add a memory straight to the store, so tests do not depend on the write pipeline.
 * ageDays sets created_at back from the app clock. The other options are columns.
 * @param {{env: any, clock: {t: number}}} app
 * @param {{name: string, text?: string, description?: string, tags?: string[], origin?: string, ageDays?: number, probationInDays?: number, recalls?: number, lastRecalledDaysAgo?: number | null, [k: string]: any}} spec
 * @returns {Promise<string>} the id
 */
export async function seed(app, { name, text = `Text of ${name}`, description = "A sample.", tags = [], origin = "capture", ageDays = 0, probationInDays, recalls = 0, lastRecalledDaysAgo = null, ...extra }) {
  const store = createStore(app.env.DB, () => app.clock.t);
  const created = extra.created_at ?? app.clock.t - Math.round(ageDays * DAY);
  const parsed = await parseMemory(note(name, description, text), tags);
  const entry = await store.create({
    ...parsed,
    origin,
    created_at: created,
    updated_at: created,
    recall_count: recalls,
    probation_until: probationInDays === undefined ? null : app.clock.t + Math.round(probationInDays * DAY),
    kind: "semantic",
    ...extra,
  });
  if (lastRecalledDaysAgo !== null) await app.env.DB.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?").bind(app.clock.t - Math.round(lastRecalledDaysAgo * DAY), entry.id).run();
  return entry.id;
}

/** Build the search keys and vectors of everything that needs them. */
export async function indexAll(app) {
  for (let i = 0; i < 50; i++) if ((await reindex(app.env, 200, () => app.clock.t)).remaining === 0) return;
  throw new Error("indexing did not finish");
}

export const row = (app, id) => app.env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first();
export const rows = async (app, sql, ...args) => (await app.env.DB.prepare(sql).bind(...args).all()).results;
/** A store on the test app clock, for the tests that write memories directly. */
export const storeOf = (app) => createStore(app.env.DB, () => app.clock.t);
export const live = (r) => r.deleted_at === null && r.valid_until === null;

/** The small model answers kind with the given value, or fails when it is null. */
export function modelKind(app, kind) {
  app.env.AI.reply(SMALL_MODEL, () => {
    if (kind === null) throw new Error("the model is down");
    return { response: { kind } };
  });
}

/** Run the maintenance route and return the summary of one step, or of everything. */
export async function runNightly(app, body = {}) {
  const res = await app.call("/admin/run-maintenance", { method: "POST", body });
  if (res.status !== 200) throw new Error(`run-maintenance ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Every table that a backup carries, as plain rows in a fixed order, for comparing two stores. */
export async function dump(app) {
  const q = (sql) => rows(app, sql);
  return {
    memories: await q("SELECT * FROM memories ORDER BY id"),
    tags: await q("SELECT memory_id, tag FROM memory_tags ORDER BY memory_id, tag"),
    versions: await q("SELECT memory_id, seq, snapshot, reason, created_at FROM memory_versions ORDER BY memory_id, seq"),
    questions: await q("SELECT memory_id, position, text, created_at FROM memory_keys WHERE key_type = 'question' ORDER BY memory_id, position"),
    links: await q("SELECT * FROM links ORDER BY source_id, target_id, link_type"),
    link_rejections: await q("SELECT * FROM link_rejections ORDER BY source_id, target_id, link_type"),
    subjects: await q("SELECT * FROM subjects ORDER BY id"),
    devices: await q("SELECT * FROM devices ORDER BY id"),
    fts: await q("SELECT memory_id, name, description, body, keys FROM memory_fts ORDER BY memory_id"),
  };
}

const TRICKY = "Line one  with  double spaces\tand a tab.\r\nSecond line, emoji 🎯, accents café, quote \" and 'single'.\n\n\n  Indented third paragraph.";

/**
 * A store with one of everything a backup carries: memories of several origins, tags, history, a closed and a trashed
 * memory, links (one made by the system, one rejected), question keys, usage counts, probation, a project, two subjects (one private),
 * and two devices (one revoked, one barred from private subjects).
 * @returns {Promise<{ids: Record<string, string>, token: string}>}
 */
export async function populate(app) {
  const store = createStore(app.env.DB, () => app.clock.t);
  const ids = {};
  ids.explicit = await seed(app, { name: "explicit-note", origin: "explicit", text: TRICKY, tags: ["blue", "red"], ageDays: 30, project: "alpha", status: "canonical" });
  ids.capture = await seed(app, { name: "captured-note", origin: "capture", ageDays: 20, probationInDays: 40, recalls: 2, lastRecalledDaysAgo: 3, kind: "episodic", project: "alpha", harness: "codex", session: "s-1" });
  ids.profile = await seed(app, { name: "profile-note", origin: "profile", ageDays: 90, tags: ["capsule:core", "capsule-slot:identity"], status: "canonical" });
  ids.imported = await seed(app, { name: "imported-note", origin: "import", ageDays: 400, kind: null, recalls: 7 });
  ids.updated = await seed(app, { name: "edited-note", origin: "explicit", text: "First wording of the note.", ageDays: 10 });
  ids.trashed = await seed(app, { name: "trashed-note", origin: "capture", ageDays: 12 });
  ids.older = await seed(app, { name: "older-twin", origin: "capture", ageDays: 9 });
  ids.newer = await seed(app, { name: "newer-twin", origin: "capture", ageDays: 8 });
  app.clock.t += 1000;
  await store.update({ id: ids.updated, content: note("edited-note", "A sample.", "Second wording of the note."), tags: ["edited"] });
  app.clock.t += 1000;
  await store.append(ids.updated, "An addition.");
  app.clock.t += 1000;
  await store.softDelete(ids.trashed);
  app.clock.t += 1000;
  await store.supersede(ids.newer, ids.older, app.clock.t, "merge");
  await store.link(ids.explicit, ids.capture, "related_to");
  await store.link(ids.profile, ids.explicit, "about_person");
  await store.link(ids.imported, ids.explicit, "affects", { madeBy: "system", confidence: 0.85 });
  await app.env.DB.prepare("INSERT INTO link_rejections (source_id, target_id, link_type, created_at) VALUES (?, ?, 'about', ?)").bind(ids.capture, ids.explicit, app.clock.t).run();
  await app.env.DB.batch([
    app.env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) VALUES (?, 'question', 0, 'What is the first question?', 'x:question:0', ?)").bind(ids.explicit, app.clock.t),
    app.env.DB.prepare("INSERT INTO memory_keys (memory_id, key_type, position, text, vector_id, created_at) VALUES (?, 'question', 1, 'What is the second question?', NULL, ?)").bind(ids.explicit, app.clock.t),
    app.env.DB.prepare("DELETE FROM memory_fts WHERE memory_id = ?").bind(ids.explicit),
    app.env.DB.prepare(FTS_INSERT).bind(ids.explicit),
  ]);
  // a pet that is private and a project that is shared, with their cards among the memories above
  const fields = JSON.stringify({ species: { value: "dog", confirmed_at: app.clock.t, source: "user" } });
  await app.env.DB.batch([
    app.env.DB.prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES (?, 'pip', 'pet', 'active', 'private', ?, '[\"pippin\"]', ?, ?)").bind(ids.explicit, fields, app.clock.t, app.clock.t + 5),
    app.env.DB.prepare("INSERT INTO subjects (id, slug, kind, status, scope, created_at, updated_at) VALUES (?, 'alpha', 'project', 'retired', 'shared', ?, ?)").bind(ids.updated, app.clock.t, app.clock.t),
  ]);
  const laptop = await app.call("/devices", { method: "POST", body: { label: "laptop" } });
  const phone = await app.call("/devices", { method: "POST", body: { label: "phone" } });
  app.clock.t += 1000;
  await app.call("/devices/revoke", { method: "POST", body: { id: phone.json.device.id } });
  await app.env.DB.prepare("UPDATE devices SET last_used_at = ?, allow_private = 0 WHERE id = ?").bind(app.clock.t, laptop.json.device.id).run();
  return { ids, token: laptop.json.token };
}

/** Send a document to POST /import page by page until nothing remains. Returns the replies. */
export async function restore(app, doc, limit = 50) {
  const replies = [];
  let offset = 0;
  for (;;) {
    const res = await app.call("/import", { method: "POST", body: { ...doc, offset, limit } });
    if (res.status !== 200) throw new Error(`import ${res.status} ${JSON.stringify(res.json)}`);
    replies.push(res.json);
    if (res.json.remaining === 0) return replies;
    offset = res.json.next_offset;
  }
}
