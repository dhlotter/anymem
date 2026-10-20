// Subjects for tests, made straight in the database so the private rule and recall do not depend on the subject routes.
// All sample names are invented.
import { createStore } from "../../memory/store.js";
import { parseMemory } from "../../memory/parse.js";
import { note } from "./search.js";
import { ADMIN_TOKEN } from "./app.js";

/** A subject: its card memory (origin system, the way the subject routes write it) and its row. @returns {Promise<string>} the card id */
export async function addSubject(app, { slug, kind = "project", name = slug, scope = "shared", status = "active", brief = `Brief of ${name}.`, fields = {} }) {
  const store = createStore(app.env.DB, () => app.clock.t);
  const parsed = await parseMemory(note(slug, `${kind} card for ${name}`, brief), ["subject", `subject:${slug}`, `subject-kind:${kind}`]);
  const card = await store.create({ ...parsed, type: "project", origin: "system" });
  await app.env.DB.prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)")
    .bind(card.id, slug, kind, status, scope, JSON.stringify(fields), app.clock.t, app.clock.t)
    .run();
  return card.id;
}

/** An about link from a memory to a card. */
export const about = (app, memoryId, cardId) => createStore(app.env.DB, () => app.clock.t).link(memoryId, cardId, "about");

/** A device token, with allow_private set the way the person would with POST /devices/private. @returns {Promise<{id: string, token: string}>} */
export async function device(app, { allowPrivate, label = "laptop" }) {
  const made = (await app.call("/devices", { method: "POST", body: { label }, token: ADMIN_TOKEN })).json;
  await app.env.DB.prepare("UPDATE devices SET allow_private = ? WHERE id = ?").bind(allowPrivate ? 1 : 0, made.device.id).run();
  return { id: made.device.id, token: made.token };
}

/**
 * The same small world for every test: a private card (Pip) and a shared card (the Cottage), and these memories.
 * hidden is about Pip only, mixed is about Pip and the Cottage, shared is about the Cottage, plain has no about link.
 * @param {any[]} ids memory ids in the order hidden, mixed, shared, plain (made by appWith, so they are indexed)
 */
export async function wire(app, ids) {
  const [hidden, mixed, shared, plain] = ids;
  const pip = await addSubject(app, { slug: "pip", kind: "pet", name: "Pip", scope: "private" });
  const cottage = await addSubject(app, { slug: "cottage", kind: "asset", name: "the Cottage" });
  await about(app, hidden, pip);
  await about(app, mixed, pip);
  await about(app, mixed, cottage);
  await about(app, shared, cottage);
  return { pip, cottage, hidden, mixed, shared, plain };
}
