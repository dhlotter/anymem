// The write limit. More than 40 writes per token in a rolling 10 minutes is a 429 with a retry time.
// Each write is a row in write_counter keyed by its own millisecond, so the count over the window is exact.
// Nothing is held for review. The caller is told to wait, and the write is simply not made.
// The model routes (/extract and /recall, which run Workers AI) have their own count per token, in the same table under a
// key of their own, so a flood of recalls cannot use up a token's writes or the other way round.

export const WRITE_LIMIT = 40;
export const MODEL_LIMIT = 60;
export const WINDOW_MS = 10 * 60 * 1000;

/**
 * Count one attempt against a key. Call it once per attempt that gets past the screens.
 * @param {any} db the D1 binding
 * @param {string} key the token, or a key of its own
 * @param {number} at now in milliseconds
 * @param {number} limit attempts allowed in the window
 * @returns {Promise<{ok: true} | {ok: false, retryAfter: number}>} retryAfter is in whole seconds, at least 1
 */
async function takeSlot(db, key, at, limit) {
  const since = at - WINDOW_MS;
  const res = await db.batch([
    db.prepare("DELETE FROM write_counter WHERE token_id = ? AND window_start <= ?").bind(key, since),
    db.prepare("INSERT INTO write_counter (token_id, window_start, writes) VALUES (?, ?, 1) ON CONFLICT (token_id, window_start) DO UPDATE SET writes = writes + 1").bind(key, at),
    db.prepare("SELECT COALESCE(SUM(writes), 0) AS n, MIN(window_start) AS oldest FROM write_counter WHERE token_id = ? AND window_start > ?").bind(key, since),
  ]);
  const { n, oldest } = res[2].results[0];
  if (n <= limit) return { ok: true };
  // Over the limit: give this attempt's slot back so a refused write does not extend the wait.
  await db.batch([
    db.prepare("UPDATE write_counter SET writes = writes - 1 WHERE token_id = ? AND window_start = ?").bind(key, at),
    db.prepare("DELETE FROM write_counter WHERE token_id = ? AND writes <= 0").bind(key),
  ]);
  return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_MS - at) / 1000)) };
}

/**
 * Count this write against the token. Call it once per write attempt that gets past the screens.
 * @param {any} db the D1 binding
 * @param {string} tokenId the device id, or "admin" for the admin bearer
 * @param {number} at now in milliseconds
 * @returns {Promise<{ok: true} | {ok: false, retryAfter: number}>}
 */
export function takeWriteSlot(db, tokenId, at) {
  return takeSlot(db, tokenId, at, WRITE_LIMIT);
}

/**
 * Count one model call against the token. Only a device token is counted, the callers that are not limited skip this.
 * @param {any} db the D1 binding
 * @param {string} tokenId the device id
 * @param {number} at now in milliseconds
 * @returns {Promise<{ok: true} | {ok: false, retryAfter: number}>}
 */
export function takeModelSlot(db, tokenId, at) {
  return takeSlot(db, `model:${tokenId}`, at, MODEL_LIMIT);
}

/**
 * The reply for a refused write or model call, with the wait in the body and in Retry-After.
 * @param {{ok: false, retryAfter: number}} slot
 * @param {string} [what] the noun in the message
 * @returns {{status: number, body: object, headers: Record<string, string>}}
 */
export function writeRefused(slot, what = "writes") {
  return {
    status: 429,
    body: { error: `Too many ${what}. Try again in ${slot.retryAfter} seconds.`, code: "rate_limited", retry_after: slot.retryAfter },
    headers: { "retry-after": String(slot.retryAfter) },
  };
}
