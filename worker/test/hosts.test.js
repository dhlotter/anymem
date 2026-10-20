import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { checkHost } from "../hosts.js";
import { raw } from "./helpers/ui.js";

const auditCount = async (app) => (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first()).n;
const url = (host) => new URL(`https://${host}/count`);

test("with ALLOWED_HOSTS unset any host is served", async () => {
  const app = await createApp();
  assert.equal((await app.call("/count")).status, 200);
});

test("a host in the list is served, whatever the case or spacing of the list", async () => {
  const app = await createApp({ env: { ALLOWED_HOSTS: " Other.example.com , ANYMEM-WORKER.test " } });
  assert.equal((await app.call("/count")).status, 200);
});

test("a host that is not in the list gets a 404 even with perfect credentials", async () => {
  const app = await createApp({ env: { ALLOWED_HOSTS: "memory.example.com" } });
  const res = await app.call("/count");
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "not_found");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the host check runs before authentication, so a caller with no credentials sees a 404 and not a 401", async () => {
  const app = await createApp({ env: { ALLOWED_HOSTS: "memory.example.com" } });
  for (const path of ["/count", "/stats", "/nonexistent", "/", "/ui/app.js"]) {
    const res = await app.call(path, { token: null, jwt: null });
    assert.equal(res.status, 404, path);
    assert.equal(res.json.code, "not_found", path);
  }
});

test("a refused host writes no audit row and does not touch the database", async () => {
  const app = await createApp({ env: { ALLOWED_HOSTS: "memory.example.com" } });
  const touched = [];
  const prepare = app.env.DB.prepare.bind(app.env.DB);
  app.env.DB.prepare = (sql) => (touched.push(sql), prepare(sql));
  await app.call("/count");
  await app.call("/devices", { method: "POST", body: { label: "x" } });
  await app.call("/count", { token: "wrong", jwt: "junk" });
  assert.deepEqual(touched, []);
  assert.equal(await auditCount(app), 0);
});

test("an allowed host is still audited and still needs its credentials", async () => {
  const app = await createApp({ env: { ALLOWED_HOSTS: "anymem-worker.test" } });
  assert.equal((await app.call("/count", { token: "wrong" })).status, 401);
  assert.equal((await app.call("/count")).status, 200);
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor_kind = 'admin' AND route = '/count'").first()).n, 1);
});

test("an unusable ALLOWED_HOSTS is a 500 that names the setting, never open access", async () => {
  for (const value of ["", " , ", "bad host", "https://memory.example.com", "memory.example.com:8443"]) {
    const app = await createApp({ env: { ALLOWED_HOSTS: value } });
    const res = await raw(app, "/count", { token: ADMIN_TOKEN });
    assert.equal(res.status, 500, JSON.stringify(value));
    assert.equal((await res.json()).code, "misconfigured");
    assert.equal(await auditCount(app), 0);
  }
});

test("checkHost compares the host name only, ignores case and a trailing dot", () => {
  const env = { ALLOWED_HOSTS: "memory.example.com" };
  assert.doesNotThrow(() => checkHost(env, url("memory.example.com")));
  assert.doesNotThrow(() => checkHost(env, url("MEMORY.example.com:8443")));
  assert.doesNotThrow(() => checkHost(env, url("memory.example.com.")));
  for (const host of ["evil.example.com", "memory.example.com.evil.net", "xmemory.example.com", "anymem-v2.example.workers.dev"]) {
    assert.throws(() => checkHost(env, url(host)), { status: 404 }, host);
  }
  assert.doesNotThrow(() => checkHost({}, url("anything.test")));
});
