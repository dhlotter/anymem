// The two clicks on a proposal: accept and dismiss. Both are for the person (admin token or browser login), never a device.
// Only a subject with status `proposed` can be decided, and the status change is one guarded UPDATE, so a double click or two
// browsers cannot both win.
import { badRequest, conflict, json, notFound, readJson } from "../http.js";
import { createStore } from "../memory/store.js";
import { indexMemories } from "../search/indexer.js";
import { PROPOSED_BRIEF } from "./propose.js";
import { createSubjectStore } from "./store.js";

const notProposed = () => conflict("That subject is not waiting for a click.", "not_proposed");

/** @param {"accept" | "dismiss"} action */
async function decide({ request, env, ctx, now, maxBody, memoryIds }, action) {
  const body = await readJson(request, maxBody);
  if (typeof body.slug !== "string" || !body.slug) throw badRequest("slug is required.", "bad_slug");
  const subjects = createSubjectStore(env.DB, now);
  const id = await subjects.idOf({ slug: body.slug });
  if (!id) throw notFound("No subject with that slug.");
  memoryIds.push(id);
  const before = await subjects.get(id);
  if (before.status !== "proposed") throw notProposed();
  const claim = await env.DB.prepare("UPDATE subjects SET status = ?, updated_at = ? WHERE id = ? AND status = 'proposed'").bind(action === "accept" ? "active" : "retired", now(), id).run();
  if (claim.meta.changes === 0) throw notProposed();
  // A dismissed subject keeps its card (still pending, never shown) and its evidence links, and the slug stays taken so it is not proposed again.
  if (action === "accept") {
    try {
      await createStore(env.DB, now).setStatus(id, "active");
      // The one line the system wrote is not a brief, so it goes. A brief the person already edited stays.
      if (before.brief.trim() === PROPOSED_BRIEF) {
        await subjects.update(id, { brief: "" });
        ctx.waitUntil(indexMemories(env, [id], now).catch(() => console.error("indexing failed")));
      }
    } catch (err) {
      await env.DB.prepare("UPDATE subjects SET status = 'proposed' WHERE id = ? AND status = 'active'").bind(id).run().catch(() => {});
      await createStore(env.DB, now).setStatus(id, "pending").catch(() => {});
      throw err;
    }
  }
  return json({ ok: true, subject: await subjects.get(id) });
}

/** POST /subject/accept {slug}. The subject becomes active and its card memory active, so recall can return both. The evidence links stay. */
export const acceptSubject = (c) => decide(c, "accept");

/** POST /subject/dismiss {slug}. The subject is retired and nothing is deleted. */
export const dismissSubject = (c) => decide(c, "dismiss");
