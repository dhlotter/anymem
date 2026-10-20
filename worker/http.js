// Small helpers for JSON replies, errors and bounded request bodies.

/** An error that becomes a JSON reply with this status and code. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message, code = "unauthorized") => new HttpError(401, code, message);
export const forbidden = (message, code = "forbidden") => new HttpError(403, code, message);
export const notFound = (message, code = "not_found") => new HttpError(404, code, message);
export const conflict = (message, code = "conflict") => new HttpError(409, code, message);
export const tooLarge = (message, code = "payload_too_large") => new HttpError(413, code, message);
export const tooManyRequests = (message, code = "rate_limited") => new HttpError(429, code, message);

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

/** @param {HttpError} err */
export function errorResponse(err, headers = {}) {
  return json({ error: err.message, code: err.code }, err.status, headers);
}

/**
 * Read a JSON object body, refusing anything over maxBytes.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge(`Body is larger than ${maxBytes} bytes.`);
  if (!request.body) throw badRequest("A JSON body is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(`Body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw badRequest("The body is not valid JSON.", "bad_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("The body must be a JSON object.", "bad_json");
  return parsed;
}

/**
 * An integer query parameter, or the fallback when it is absent.
 * @param {URL} url
 * @param {string} name
 * @param {{min: number, max: number, fallback?: number}} range
 * @returns {number | undefined}
 */
export function intParam(url, name, { min, max, fallback }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,16}$/.test(raw)) throw badRequest(`${name} must be a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}.`);
  return n;
}

/** A yes or no query parameter, 1 or 0. Absent means no. */
export function flag(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw badRequest(`${name} must be 1 or 0.`);
}
