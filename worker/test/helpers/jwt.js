// Mints Access style JWTs signed with a test RSA key, and serves the matching certs document.
import { generateKeyPairSync, createSign } from "node:crypto";

export const TEAM = "team.cloudflareaccess.com";
export const AUD = "test-audience-tag";
export const SERVICE_NAME = "client-id-1234.access";
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** A signing key with its own key id. */
export function createIssuer(kid = "kid-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return {
    kid,
    jwk,
    /** @param {Record<string, any>} claims @param {{kid?: string, alg?: string, signWith?: any}} [opts] */
    sign(claims, { kid: headerKid = kid, alg = "RS256", signWith = privateKey } = {}) {
      const head = b64url(JSON.stringify({ alg, kid: headerKid, typ: "JWT" }));
      const body = b64url(JSON.stringify(claims));
      const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(signWith);
      return `${head}.${body}.${b64url(sig)}`;
    },
    privateKey,
  };
}

/** Claims for a service token request, relative to a clock in milliseconds. */
export function serviceClaims(nowMs, over = {}) {
  const s = Math.floor(nowMs / 1000);
  return { type: "app", iss: `https://${TEAM}`, aud: [AUD], common_name: SERVICE_NAME, iat: s, nbf: s, exp: s + 3600, ...over };
}

/** Claims for a browser login. */
export function browserClaims(nowMs, email, over = {}) {
  const s = Math.floor(nowMs / 1000);
  return { iss: `https://${TEAM}`, aud: [AUD], email, iat: s, nbf: s, exp: s + 3600, ...over };
}

/** A fetch that answers the certs URL with the given issuers' keys, and counts calls. */
export function certsFetch(issuers) {
  const fake = async (url) => {
    fake.calls.push(String(url));
    if (String(url) !== CERTS_URL) return new Response("not found", { status: 404 });
    if (fake.down) return new Response("down", { status: 500 });
    return Response.json({ keys: issuers.map((i) => i.jwk), public_cert: {}, public_certs: [] });
  };
  fake.calls = [];
  fake.down = false;
  return fake;
}
