// Device tokens. Only the SHA-256 hash is stored. The token itself is shown once, at creation.
import { sha256Hex } from "./auth.js";
import { badRequest, json, notFound, readJson } from "./http.js";

const MAX_LABEL_CHARS = 64;
const MAX_ID_CHARS = 64;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "amd_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const shape = (r) => ({ id: r.id, label: r.label, created_at: r.created_at, last_used_at: r.last_used_at });

/** GET /devices, every device that is not revoked. */
export async function listDevices({ env }) {
  const { results } = await env.DB.prepare("SELECT id, label, created_at, last_used_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id").all();
  return json({ devices: results.map(shape) });
}

/** POST /devices {label} */
export async function createDevice({ env, request, now, maxBody }) {
  const body = await readJson(request, maxBody);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL_CHARS || /\p{Cc}/u.test(label)) throw badRequest(`label must be 1 to ${MAX_LABEL_CHARS} characters without control characters.`);
  const token = newToken();
  const device = { id: crypto.randomUUID(), label, created_at: now(), last_used_at: null };
  await env.DB.prepare("INSERT INTO devices (id, label, token_hash, created_at) VALUES (?, ?, ?, ?)").bind(device.id, label, await sha256Hex(token), device.created_at).run();
  return json({ device, token }, 201);
}

/** POST /devices/revoke {id} */
export async function revokeDevice({ env, request, now, maxBody }) {
  const body = await readJson(request, maxBody);
  if (typeof body.id !== "string" || !body.id || body.id.length > MAX_ID_CHARS) throw badRequest("id is required.");
  const res = await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), body.id).run();
  if (res.meta.changes === 0) throw notFound("No active device has that id.");
  return json({ ok: true, id: body.id });
}
