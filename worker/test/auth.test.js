import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { AUD, CERTS_URL, SERVICE_NAME, TEAM, browserClaims, certsFetch, createIssuer, serviceClaims } from "./helpers/jwt.js";
import { createKeyCache, readAuthConfig, sha256Hex, timingSafeEqual, verifyAccessJwt } from "../auth.js";

async function newDevice(app, label = "laptop") {
  const res = await app.call("/devices", { method: "POST", body: { label } });
  return res.json;
}

test("no token at all is a 401 and an Access JWT alone is not enough", async () => {
  const app = await createApp();
  const none = await app.call("/count", { token: null, jwt: null });
  assert.equal(none.status, 401);
  assert.equal(none.json.code, "access_required");
  const jwtOnly = await app.call("/count", { token: null });
  assert.equal(jwtOnly.status, 401);
  assert.equal(jwtOnly.json.code, "unauthorized");
});

test("a bad bearer is a 401", async () => {
  const app = await createApp();
  const res = await app.call("/count", { token: "not-the-token" });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "invalid_token");
  assert.equal((await app.call("/count", { headers: { authorization: "Basic abc" }, token: null })).status, 401);
});

test("admin bearer and device token both work on a plain route", async () => {
  const app = await createApp();
  const { token } = await newDevice(app);
  assert.equal((await app.call("/count")).status, 200);
  assert.equal((await app.call("/count", { token })).status, 200);
});

test("a device token on an admin route is a 403", async () => {
  const app = await createApp();
  const { token } = await newDevice(app);
  for (const [path, method] of [["/stats", "GET"], ["/devices", "GET"], ["/devices", "POST"], ["/audit", "GET"]]) {
    const res = await app.call(path, { token, method, body: method === "POST" ? { label: "x" } : undefined });
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, "forbidden");
  }
});

test("a revoked device token stops working at once", async () => {
  const app = await createApp();
  const { device, token } = await newDevice(app);
  assert.equal((await app.call("/count", { token })).status, 200);
  await app.call("/devices/revoke", { method: "POST", body: { id: device.id } });
  assert.equal((await app.call("/count", { token })).status, 401);
});

test("a service token request with no email is accepted", async () => {
  const app = await createApp();
  const jwt = app.serviceJwt();
  assert.ok(!("email" in JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"))));
  assert.equal((await app.call("/count", { jwt })).status, 200);
});

test("a service token with a name that is not on the list is a 403", async () => {
  const app = await createApp();
  const res = await app.call("/count", { jwt: app.serviceJwt({ common_name: "stranger.access" }) });
  assert.equal(res.status, 403);
});

test("the second configured service name is accepted too", async () => {
  const app = await createApp();
  assert.equal((await app.call("/count", { jwt: app.serviceJwt({ common_name: "other-client.access" }) })).status, 200);
});

test("wrong audience, wrong issuer, expired and not yet valid are 401", async () => {
  const app = await createApp();
  const cases = {
    "wrong aud": app.serviceJwt({ aud: ["someone-else"] }),
    "string wrong aud": app.serviceJwt({ aud: "someone-else" }),
    "wrong iss": app.serviceJwt({ iss: "https://evil.cloudflareaccess.com" }),
    expired: app.serviceJwt({ exp: Math.floor(app.clock.t / 1000) - 3600 }),
    "not yet": app.serviceJwt({ nbf: Math.floor(app.clock.t / 1000) + 3600 }),
    "no exp": app.serviceJwt({ exp: undefined }),
  };
  for (const [name, jwt] of Object.entries(cases)) {
    const res = await app.call("/count", { jwt });
    assert.equal(res.status, 401, name);
    assert.equal(res.json.code, "invalid_access_token", name);
  }
});

test("a string audience that matches is accepted", async () => {
  const app = await createApp();
  assert.equal((await app.call("/count", { jwt: app.serviceJwt({ aud: AUD }) })).status, 200);
});

test("an unknown key id is refused, and the keys are refetched at most once a minute", async () => {
  const app = await createApp();
  assert.equal((await app.call("/count")).status, 200);
  assert.equal(app.fetchFn.calls.length, 1);
  const stranger = createIssuer("kid-unknown");
  const forged = stranger.sign(serviceClaims(app.clock.t));
  assert.equal((await app.call("/count", { jwt: forged })).status, 401);
  assert.equal(app.fetchFn.calls.length, 1, "a refetch inside a minute of the last one is skipped");
  app.clock.t += 61_000;
  assert.equal((await app.call("/count", { jwt: forged })).status, 401);
  assert.equal(app.fetchFn.calls.length, 2);
});

test("a rotated key is picked up when its id first appears", async () => {
  const old = createIssuer("kid-old");
  const fresh = createIssuer("kid-new");
  let t = 1_790_000_000_000;
  const served = [old];
  const fetchFn = async () => Response.json({ keys: served.map((i) => i.jwk) });
  const deps = { fetch: fetchFn, now: () => t, cache: createKeyCache() };
  const config = { teamDomain: TEAM, aud: AUD };
  await verifyAccessJwt(old.sign(serviceClaims(t)), config, deps);
  served.push(fresh);
  t += 61_000;
  const claims = await verifyAccessJwt(fresh.sign(serviceClaims(t)), config, deps);
  assert.equal(claims.common_name, SERVICE_NAME);
});

test("a token signed by the wrong key with a known key id is refused", async () => {
  const app = await createApp();
  const other = createIssuer("kid-1");
  const forged = other.sign(serviceClaims(app.clock.t));
  const res = await app.call("/count", { jwt: forged });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "invalid_access_token");
});

test("every refused Access token gets the same reply, and the reason goes to the log only", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const app = await createApp();
  const stranger = createIssuer("kid-unknown");
  const claims = Buffer.from(JSON.stringify(serviceClaims(app.clock.t))).toString("base64url");
  const cases = {
    malformed: "not.a.jwt",
    "unsupported algorithm": `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "kid-1" })).toString("base64url")}.${claims}.AAAA`,
    "unknown key": stranger.sign(serviceClaims(app.clock.t)),
    "bad signature": createIssuer("kid-1").sign(serviceClaims(app.clock.t)),
    "wrong audience": app.serviceJwt({ aud: ["someone-else"] }),
    "wrong issuer": app.serviceJwt({ iss: "https://evil.cloudflareaccess.com" }),
    expired: app.serviceJwt({ exp: Math.floor(app.clock.t / 1000) - 3600 }),
    "not yet valid": app.serviceJwt({ nbf: Math.floor(app.clock.t / 1000) + 3600 }),
    "too long": "A".repeat(9000),
  };
  const replies = new Set();
  for (const [why, jwt] of Object.entries(cases)) {
    const res = await app.call("/count", { jwt });
    assert.equal(res.status, 401, why);
    replies.add(JSON.stringify(res.json));
  }
  assert.equal(replies.size, 1, [...replies].join(" | "));
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments[1]),
    Object.keys(cases),
    "each reason is logged, never a token",
  );
  assert.ok(!JSON.stringify(warn.mock.calls.map((c) => c.arguments)).includes("kid-"));
});

test("the signing keys expire after an hour, so a key Cloudflare has retired stops working", async () => {
  const old = createIssuer("kid-old");
  const fresh = createIssuer("kid-new");
  let t = 1_790_000_000_000;
  const served = [old];
  const fetchFn = async () => Response.json({ keys: served.map((i) => i.jwk) });
  const deps = { fetch: fetchFn, now: () => t, cache: createKeyCache() };
  const config = { teamDomain: TEAM, aud: AUD };
  const token = old.sign(serviceClaims(t, { exp: Math.floor(t / 1000) + 86_400 }));
  await verifyAccessJwt(token, config, deps);
  t += 59 * 60_000;
  await verifyAccessJwt(token, config, deps);
  served.splice(0, served.length, fresh);
  t += 2 * 60_000;
  await assert.rejects(verifyAccessJwt(token, config, deps), { status: 401, code: "invalid_access_token" });
  assert.equal((await verifyAccessJwt(fresh.sign(serviceClaims(t)), config, deps)).common_name, SERVICE_NAME);
});

test("a known key is served from the cache inside the hour without a fetch", async () => {
  const app = await createApp();
  await app.call("/count");
  app.clock.t += 30 * 60_000;
  await app.call("/count", { jwt: app.serviceJwt() });
  assert.equal(app.fetchFn.calls.length, 1);
  app.clock.t += 31 * 60_000;
  assert.equal((await app.call("/count", { jwt: app.serviceJwt() })).status, 200);
  assert.equal(app.fetchFn.calls.length, 2, "the keys were fetched again once they were an hour old");
});

test("an expired key cache with the certs endpoint down fails closed", async () => {
  const app = await createApp();
  await app.call("/count");
  app.clock.t += 61 * 60_000;
  app.fetchFn.down = true;
  const res = await app.call("/count", { jwt: app.serviceJwt() });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "invalid_access_token");
});

test("every JSON reply, success or error, carries nosniff and no-store", async () => {
  const app = await createApp();
  const replies = [
    await app.call("/count"),
    await app.call("/count", { token: "bad" }),
    await app.call("/nope"),
    await app.call("/count", { method: "POST", body: {} }),
    await app.call("/count", { token: null, jwt: null }),
  ];
  for (const r of replies) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", String(r.status));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-type"), /^application\/json/);
  }
});

test("alg none, HS256, junk and oversized tokens are refused", async () => {
  const app = await createApp();
  const claims = Buffer.from(JSON.stringify(serviceClaims(app.clock.t))).toString("base64url");
  const header = (h) => Buffer.from(JSON.stringify(h)).toString("base64url");
  const bad = [
    `${header({ alg: "none", kid: "kid-1" })}.${claims}.`,
    `${header({ alg: "HS256", kid: "kid-1" })}.${claims}.AAAA`,
    "not.a.jwt",
    "onlyonepart",
    `${header({ alg: "RS256", kid: "kid-1" })}.${claims}.${"A".repeat(9000)}`,
  ];
  for (const jwt of bad) assert.equal((await app.call("/count", { jwt })).status, 401);
});

test("requests that arrive together on a cold key cache wait for one fetch, and none is refused", async () => {
  const app = await createApp();
  const replies = await Promise.all([app.call("/count"), app.call("/count"), app.call("/count")]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 200]);
  assert.equal(app.fetchFn.calls.length, 1);
});

test("a broken certs endpoint refuses the token with a 401, and is asked again at most once a minute", async () => {
  const app = await createApp();
  app.fetchFn.down = true;
  const res = await app.call("/count");
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "invalid_access_token");
  const asked = app.fetchFn.calls.length;
  for (let i = 0; i < 5; i++) assert.equal((await app.call("/count")).status, 401);
  assert.equal(app.fetchFn.calls.length, asked, "the failed attempt is recorded, so no refetch inside a minute");
  app.clock.t += 61_000;
  assert.equal((await app.call("/count")).status, 401);
  assert.equal(app.fetchFn.calls.length, asked + 1, "one more attempt after a minute");
  app.fetchFn.down = false;
  assert.equal((await app.call("/count")).status, 401, "the attempt a minute ago is still recent, so the keys are not reloaded yet");
  app.clock.t += 61_000;
  assert.equal((await app.call("/count")).status, 200, "a working endpoint is believed again");
});

test("a browser login with an allowed email can use a browser route and is audited by email", async () => {
  const app = await createApp();
  const jwt = app.browserJwt("ME@example.com");
  const res = await app.call("/stats", { jwt, token: null });
  assert.equal(res.status, 200);
  const audit = await app.call("/audit?route=/stats");
  assert.equal(audit.json.entries[0].actor_kind, "browser");
  assert.equal(audit.json.entries[0].actor_id, "me@example.com");
});

test("a browser login with an email that is not allowed is a 403", async () => {
  const app = await createApp();
  const res = await app.call("/stats", { jwt: app.browserJwt("intruder@example.com"), token: null });
  assert.equal(res.status, 403);
});

test("a browser login cannot use a route that is not for browsers", async () => {
  const app = await createApp();
  const res = await app.call("/devices", { method: "POST", body: { label: "x" }, jwt: app.browserJwt("me@example.com"), token: null });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, "browser_not_allowed");
});

test("a JWT with neither common_name nor email is a 403", async () => {
  const app = await createApp();
  const res = await app.call("/count", { jwt: app.serviceJwt({ common_name: undefined }) });
  assert.equal(res.status, 403);
});

test("REQUIRE_ACCESS false runs on the bearer alone", async () => {
  const app = await createApp({ withAccess: false });
  assert.equal((await app.call("/count")).status, 200);
  assert.equal((await app.call("/count", { token: null })).status, 401);
  assert.equal((await app.call("/count", { token: "wrong" })).status, 401);
  assert.equal(app.fetchFn.calls.length, 0, "no Access keys were fetched");
});

test("misconfiguration fails closed with a 500 and a clear message", async () => {
  const cases = [
    [{ AUTH_TOKEN: undefined }, /AUTH_TOKEN/],
    [{ AUTH_TOKEN: "short" }, /AUTH_TOKEN/],
    [{ REQUIRE_ACCESS: "maybe" }, /REQUIRE_ACCESS/],
    [{ ACCESS_AUD: "" }, /ACCESS_AUD/],
    [{ ACCESS_TEAM_DOMAIN: "https://team.example.com/x" }, /ACCESS_TEAM_DOMAIN/],
    [{ ACCESS_TEAM_DOMAIN: undefined }, /ACCESS_TEAM_DOMAIN/],
    [{ ACCESS_SERVICE_COMMON_NAMES: "", ACCESS_ALLOWED_EMAILS: "" }, /nobody can get in/],
  ];
  for (const [over, pattern] of cases) {
    const app = await createApp({ env: over });
    const res = await app.call("/count");
    assert.equal(res.status, 500, JSON.stringify(over));
    assert.equal(res.json.code, "misconfigured");
    assert.match(res.json.error, pattern);
  }
});

test("a missing REQUIRE_ACCESS defaults to requiring Access", async () => {
  const app = await createApp({ env: { REQUIRE_ACCESS: undefined } });
  assert.equal((await app.call("/count", { jwt: null })).status, 401);
});

test("timingSafeEqual and sha256Hex", async () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("readAuthConfig lowercases emails and splits lists", () => {
  const c = readAuthConfig({ AUTH_TOKEN: ADMIN_TOKEN, ACCESS_TEAM_DOMAIN: "T.example.com", ACCESS_AUD: "a", ACCESS_SERVICE_COMMON_NAMES: " a.access , b.access ", ACCESS_ALLOWED_EMAILS: "X@Y.com" });
  assert.deepEqual([...c.serviceNames], ["a.access", "b.access"]);
  assert.deepEqual([...c.allowedEmails], ["x@y.com"]);
  assert.equal(c.teamDomain, "t.example.com");
});

test("the certs url is fetched from the configured team", async () => {
  const app = await createApp();
  await app.call("/count");
  assert.deepEqual(app.fetchFn.calls, [CERTS_URL]);
});

test("a device token is only stored as a hash", async () => {
  const app = await createApp();
  const { token } = await newDevice(app);
  const row = await app.env.DB.prepare("SELECT token_hash FROM devices").first();
  assert.equal(row.token_hash, await sha256Hex(token));
  assert.ok(!JSON.stringify(row).includes(token));
});

test("browserClaims and certsFetch helpers behave", async () => {
  const issuer = createIssuer();
  assert.equal(browserClaims(0, "a@b.c").email, "a@b.c");
  assert.equal((await certsFetch([issuer])(CERTS_URL).then((r) => r.json())).keys.length, 1);
});
