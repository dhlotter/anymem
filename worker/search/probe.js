// The probe behind the skill's `doctor.py --probe`. It writes one reserved vector and reports whether a query finds it, once
// with a metadata filter and once without. Found without the filter but not with it means the metadata index is missing.
// Found by neither is only slow indexing. It checks the metadata index only: recall sends no filter, so it never runs the
// filtered query. The vector id is nonce:probe:0, so it never matches a memory, and its metadata origin is "probe". Each new
// probe deletes the one before it, and the nightly job deletes the last one. The vector is a fixed unit vector that no real
// text embeds near.
import { badRequest, json } from "../http.js";
import { DIMENSIONS } from "./embed.js";

const META_KEY = "vectorize_probe";
const NONCE = /^[0-9a-f]{8,32}$/;
const VALUES = Array.from({ length: DIMENSIONS }, (_, i) => (i % 2 === 0 ? 1 : -1) / Math.sqrt(DIMENSIONS));

const idOf = (nonce) => `${nonce}:probe:0`;

/** Delete the vector of the last probe, if there is one. Returns whether there was one. */
export async function clearProbe(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(META_KEY).first();
  if (!row) return false;
  await env.VECTORIZE.deleteByIds([idOf(row.value)]);
  await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(META_KEY).run();
  return true;
}

/** POST /vectorize-probe. Starts a probe and returns its nonce. */
export async function startProbe({ env }) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(META_KEY).first();
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  await env.VECTORIZE.upsert([{ id: idOf(nonce), values: VALUES, metadata: { memory_id: nonce, project: "", origin: "probe" } }]);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(META_KEY, nonce).run();
  if (row) await env.VECTORIZE.deleteByIds([idOf(row.value)]);
  return json({ ok: true, probe: nonce });
}

/** GET /vectorize-probe?probe=<nonce>. */
export async function readProbe({ env, url }) {
  const nonce = url.searchParams.get("probe") ?? "";
  if (!NONCE.test(nonce)) throw badRequest("probe must be the value POST /vectorize-probe returned.");
  const found = (res) => res.matches.some((m) => m.id === idOf(nonce));
  const [filtered, unfiltered] = await Promise.all([
    env.VECTORIZE.query(VALUES, { topK: 5, filter: { origin: "probe" }, returnMetadata: "none" }),
    env.VECTORIZE.query(VALUES, { topK: 5, returnMetadata: "none" }),
  ]);
  return json({ ok: true, probe: nonce, filtered: found(filtered), unfiltered: found(unfiltered) });
}
