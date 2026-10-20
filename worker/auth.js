// Authentication. Two layers.
//
// 1. Cloudflare Access. Access strips the CF-Access-Client-Id and CF-Access-Client-Secret headers, then passes the
//    Cf-Access-Jwt-Assertion header. We verify that token ourselves with WebCrypto (RS256, team keys, aud, iss, exp, nbf).
//    A service token request has a common_name claim and no email. A browser login has an email claim.
// 2. A bearer for machines. The admin token (secret AUTH_TOKEN) or a device token from the devices table.
//
// With REQUIRE_ACCESS set to false only layer 2 runs. Any misconfiguration stops the request with a 500.
// Nothing about a token is cached beyond one request. Only the Access signing keys are cached, for at most an hour.

import { HttpError, forbidden, unauthorized } from "./http.js";

const KEY_REFRESH_MIN_MS = 60_000;
const KEY_MAX_AGE_MS = 60 * 60_000;
const LEEWAY_SECONDS = 30;
const MAX_JWT_CHARS = 8192;
const MIN_ADMIN_TOKEN_CHARS = 20;
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const encoder = new TextEncoder();

/** @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two strings without stopping at the first difference. Lengths are not secret here, both are hex digests.
 * @param {string} a
 * @param {string} b
 */
export function timingSafeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const list = (value) => String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * @typedef {object} AuthConfig
 * @property {boolean} requireAccess
 * @property {string} adminToken
 * @property {string} teamDomain
 * @property {string} aud
 * @property {Set<string>} serviceNames
 * @property {Set<string>} allowedEmails
 */

/**
 * Read and check the auth settings. Throws a 500 on anything unusable, so a bad deploy never runs open.
 * @param {Record<string, any>} env
 * @returns {AuthConfig}
 */
export function readAuthConfig(env) {
  const fail = (message) => new HttpError(500, "misconfigured", message);
  const raw = env.REQUIRE_ACCESS;
  if (raw !== undefined && raw !== "true" && raw !== "false") throw fail("REQUIRE_ACCESS must be the text true or false.");
  const requireAccess = raw !== "false";
  const adminToken = typeof env.AUTH_TOKEN === "string" ? env.AUTH_TOKEN : "";
  if (adminToken.length < MIN_ADMIN_TOKEN_CHARS) throw fail(`The AUTH_TOKEN secret is missing or shorter than ${MIN_ADMIN_TOKEN_CHARS} characters.`);
  const config = { requireAccess, adminToken, teamDomain: "", aud: "", serviceNames: new Set(), allowedEmails: new Set() };
  if (!requireAccess) return config;
  config.teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  if (!HOST_PATTERN.test(config.teamDomain)) throw fail("ACCESS_TEAM_DOMAIN must be the team host name, for example team.cloudflareaccess.com.");
  config.aud = String(env.ACCESS_AUD ?? "").trim();
  if (!config.aud) throw fail("ACCESS_AUD is not set.");
  config.serviceNames = new Set(list(env.ACCESS_SERVICE_COMMON_NAMES));
  config.allowedEmails = new Set(list(env.ACCESS_ALLOWED_EMAILS).map((e) => e.toLowerCase()));
  if (!config.serviceNames.size && !config.allowedEmails.size) throw fail("Set ACCESS_SERVICE_COMMON_NAMES or ACCESS_ALLOWED_EMAILS, otherwise nobody can get in.");
  return config;
}

/** The signing keys of one Access team, kept in memory only. */
export function createKeyCache() {
  return { team: "", keys: new Map(), fetchedAt: 0, attemptedAt: null, loading: null };
}

const defaultCache = createKeyCache();

/**
 * Fetch the signing keys. Every attempt is recorded, successful or not. A failed attempt keeps the keys there were and
 * returns false, so the token that asked is refused, never waved through.
 * @returns {Promise<boolean>}
 */
async function loadKeys(teamDomain, cache, deps) {
  cache.attemptedAt = deps.now();
  let body;
  try {
    const res = await deps.fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = await res.json();
  } catch {
    console.warn("access signing keys could not be fetched");
    return false;
  }
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    } catch {
      // a key we cannot import is skipped
    }
  }
  cache.team = teamDomain;
  cache.keys = keys;
  cache.fetchedAt = deps.now();
  return true;
}

async function signingKey(kid, teamDomain, cache, deps) {
  const usable = () => cache.team === teamDomain && deps.now() - cache.fetchedAt < KEY_MAX_AGE_MS;
  // Keys older than an hour are dropped, so a key that Cloudflare has retired stops being trusted.
  if (usable() && cache.keys.has(kid)) return cache.keys.get(kid);
  // Unknown key id, or no usable keys. Refresh, but never more than once a minute since the last attempt, whether it worked
  // or not, so bad tokens or a down certs endpoint cannot make us fetch on every request. A request that comes while an
  // attempt is in flight waits for that attempt instead of being refused.
  if (!cache.loading && deps.now() - (cache.attemptedAt ?? -Infinity) >= KEY_REFRESH_MIN_MS) {
    cache.loading = loadKeys(teamDomain, cache, deps).finally(() => {
      cache.loading = null;
    });
  }
  if (cache.loading) await cache.loading;
  return usable() ? cache.keys.get(kid) : undefined;
}

function decodePart(part) {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const parsePart = (part) => JSON.parse(new TextDecoder().decode(decodePart(part)));

/**
 * Verify an Access JWT and return its claims.
 * @param {string} token
 * @param {AuthConfig} config
 * @param {{fetch: typeof fetch, now: () => number, cache?: ReturnType<typeof createKeyCache>}} deps
 * @returns {Promise<Record<string, any>>}
 */
export async function verifyAccessJwt(token, config, deps) {
  // The reply is the same for every reason, so an anonymous caller learns nothing about the check. The reason goes to the Worker log only.
  const bad = (why) => {
    console.warn("access token refused", why);
    return unauthorized("The Cloudflare Access token was refused.", "invalid_access_token");
  };
  if (token.length > MAX_JWT_CHARS) throw bad("too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw bad("malformed");
  let header;
  let claims;
  let signature;
  try {
    header = parsePart(parts[0]);
    claims = parsePart(parts[1]);
    signature = decodePart(parts[2]);
  } catch {
    throw bad("malformed");
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string") throw bad("unsupported algorithm");
  if (claims === null || typeof claims !== "object") throw bad("malformed");
  const key = await signingKey(header.kid, config.teamDomain, deps.cache ?? defaultCache, deps);
  if (!key) throw bad("unknown key");
  const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) throw bad("bad signature");
  const nowSeconds = deps.now() / 1000;
  if (claims.iss !== `https://${config.teamDomain}`) throw bad("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) throw bad("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < nowSeconds) throw bad("expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - LEEWAY_SECONDS > nowSeconds)) throw bad("not yet valid");
  return claims;
}

/**
 * Cross site request forgery guard for a write made with a browser login. The browser adds the login cookie to any
 * request, so the request must prove it came from our own page. Origin must be our own origin, Sec-Fetch-Site must be
 * same-origin when the browser sends it, and the dashboard's X-Anymem-UI header must be 1 (a cross site form cannot set it).
 * @param {Request} request
 */
export function checkSameOrigin(request) {
  const refuse = (why) => forbidden(`A browser write was refused (${why}).`, "csrf_rejected");
  if (request.headers.get("origin") !== new URL(request.url).origin) throw refuse("the Origin header is missing or is not this site");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw refuse("the request did not start on this site");
  if (request.headers.get("x-anymem-ui") !== "1") throw refuse("the X-Anymem-UI header is missing");
}

/**
 * @typedef {object} Identity
 * @property {{kind: string, id: string}} actor
 * @property {boolean} admin
 * @property {string} [deviceId]
 */

/**
 * Work out who is calling. Throws an HttpError when the caller is not allowed.
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{admin?: boolean, browser?: boolean, browserWrite?: boolean, browserOnly?: boolean}} route
 * @param {{fetch: typeof fetch, now: () => number, cache?: ReturnType<typeof createKeyCache>}} deps
 * @param {(actor: {kind: string, id: string}) => void} [noteActor] called as soon as the caller is known, before the route's own
 *   permission checks, so a refused request can still be audited against its caller
 * @returns {Promise<Identity>}
 */
export async function authenticate(request, env, route, deps, noteActor = () => {}) {
  const config = readAuthConfig(env);
  if (config.requireAccess) {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) throw unauthorized("The Cloudflare Access token is missing.", "access_required");
    const claims = await verifyAccessJwt(jwt, config, deps);
    if (typeof claims.common_name === "string") {
      if (!config.serviceNames.has(claims.common_name)) throw forbidden("This Access service token is not allowed.");
    } else if (typeof claims.email === "string") {
      const email = claims.email.toLowerCase();
      if (!config.allowedEmails.has(email)) throw forbidden("This login is not allowed.");
      noteActor({ kind: "browser", id: email });
      if (route.browser) {
        // a read, nothing more to check
      } else if (route.browserWrite) {
        checkSameOrigin(request);
      } else {
        throw forbidden("A browser login cannot use this route.", "browser_not_allowed");
      }
      return { actor: { kind: "browser", id: email }, admin: true };
    } else {
      throw forbidden("The Access token carries neither a service token name nor an email.");
    }
  }
  if (route.browserOnly) throw forbidden("This page needs a browser login through Cloudflare Access.", "browser_only");
  return bearerIdentity(request, env, config, route, noteActor);
}

async function bearerIdentity(request, env, config, route, noteActor) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (!match) throw unauthorized("A bearer token is required.");
  const presented = await sha256Hex(match[1]);
  /** @type {Identity | undefined} */
  let identity;
  if (timingSafeEqual(presented, await sha256Hex(config.adminToken))) {
    identity = { actor: { kind: "admin", id: "admin" }, admin: true };
  } else {
    const { results } = await env.DB.prepare("SELECT id, token_hash FROM devices WHERE revoked_at IS NULL").all();
    let found = null;
    for (const row of results) if (timingSafeEqual(presented, row.token_hash)) found = row;
    if (found) identity = { actor: { kind: "device", id: found.id }, admin: false, deviceId: found.id };
  }
  if (!identity) throw unauthorized("The token was not accepted.", "invalid_token");
  noteActor(identity.actor);
  if (route.admin && !identity.admin) throw forbidden("This route needs the admin token.");
  return identity;
}
