import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";

const ME = "me@example.com";

/** A browser login write. Defaults to a good same origin request, any header can be replaced or dropped with null. */
async function browserPost(app, path, body, { email = ME, headers = {} } = {}) {
  const merged = { ...UI_HEADERS, ...headers };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  const res = await raw(app, path, { method: "POST", jwt: app.browserJwt(email), headers: merged, body });
  return { status: res.status, json: await res.json() };
}

let seeded = 0;
async function seed(app) {
  // distinct text each time, the write path refuses an exact duplicate
  return (await app.call("/capture", { method: "POST", body: { content: `a note to change number ${++seeded}` } })).json.id;
}

const WRITES = (id) => [
  ["/update", { id, content: "changed" }],
  ["/append", { id, addition: "more" }],
  ["/status", { id, status: "canonical" }],
  ["/forget", { id }],
  ["/restore", { id }],
  ["/undo", { id }],
];

test("a good same origin browser write is accepted on every dashboard write route and audited as browser", async () => {
  const app = await createApp();
  const id = await seed(app);
  const other = await seed(app);
  assert.equal((await browserPost(app, "/link", { source_id: id, target_id: other, type: "related" })).status, 200);
  // in this order restore finds the memory in the trash and undo finds a version
  for (const [path, body] of WRITES(id)) {
    const res = await browserPost(app, path, body);
    assert.equal(res.status, 200, `${path} ${JSON.stringify(res.json)}`);
  }
  const rows = (await app.call("/audit?route=/update")).json.entries;
  assert.equal(rows[0].actor_kind, "browser");
  assert.equal(rows[0].actor_id, ME);
});

test("the Origin header must be present and equal the Worker's own origin", async () => {
  const app = await createApp();
  const id = await seed(app);
  const before = (await app.call(`/entry?id=${id}`)).json.entry.content;
  for (const origin of ["https://evil.example", "https://anymem-worker.test.evil.example", "http://anymem-worker.test", "null", "https://anymem-worker.test:8443"]) {
    const res = await browserPost(app, "/append", { id, addition: "x" }, { headers: { origin } });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.code, "csrf_rejected");
  }
  const none = await browserPost(app, "/append", { id, addition: "x" }, { headers: { origin: null } });
  assert.equal(none.status, 403);
  assert.equal((await app.call(`/entry?id=${id}`)).json.entry.content, before, "a refused write changes nothing");
});

test("Sec-Fetch-Site must be same-origin when the browser sends it", async () => {
  const app = await createApp();
  const id = await seed(app);
  for (const site of ["cross-site", "same-site", "none"]) {
    const res = await browserPost(app, "/append", { id, addition: "x" }, { headers: { "sec-fetch-site": site } });
    assert.equal(res.status, 403, site);
    assert.equal(res.json.code, "csrf_rejected");
  }
  // a client that does not send the header at all (older browsers) is still held to the other two rules
  assert.equal((await browserPost(app, "/append", { id, addition: "ok" }, { headers: { "sec-fetch-site": null } })).status, 200);
});

test("the X-Anymem-UI header must be 1", async () => {
  const app = await createApp();
  const id = await seed(app);
  for (const value of [null, "0", "true", ""]) {
    const res = await browserPost(app, "/append", { id, addition: "x" }, { headers: { "x-anymem-ui": value } });
    assert.equal(res.status, 403, String(value));
    assert.equal(res.json.code, "csrf_rejected");
  }
});

test("a stranger's login is refused even with every header right", async () => {
  const app = await createApp();
  const id = await seed(app);
  const res = await browserPost(app, "/append", { id, addition: "x" }, { email: "stranger@example.com" });
  assert.equal(res.status, 403);
  assert.notEqual(res.json.code, "csrf_rejected");
});

test("admin only routes stay bearer only for a browser login, even with every header right", async () => {
  const app = await createApp();
  for (const [path, body] of [["/devices", { label: "x" }], ["/devices/revoke", { id: "x" }], ["/import", { entries: [] }], ["/admin/reindex", {}]]) {
    const res = await browserPost(app, path, body);
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, "browser_not_allowed");
  }
});

test("a bearer request is not affected by the browser rules", async () => {
  const app = await createApp();
  const id = await seed(app);
  const res = await app.call("/append", { method: "POST", body: { id, addition: "x" } });
  assert.equal(res.status, 200);
});

test("a browser login may save profile and person notes through /capture, and nothing else", async () => {
  const app = await createApp();
  for (const body of [{ content: "Email: a@b.c", source: "profile" }, { content: "Note: x", source: "person" }, { content: "Note: y", origin: "person" }]) {
    assert.equal((await browserPost(app, "/capture", body)).status, 200, JSON.stringify(body));
  }
  for (const body of [{ content: "sneaky" }, { content: "sneaky", source: "claude" }, { content: "sneaky", source: "session-capture" }, { content: "sneaky", origin: "explicit" }, { content: "x", source: "profile", origin: "capture" }]) {
    const res = await browserPost(app, "/capture", body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.json.code, "browser_capture_scope");
  }
  const list = (await app.call("/list?origin=profile")).json.entries;
  assert.equal(list.length, 1);
  assert.equal((await app.call("/list?origin=explicit")).json.entries.length, 0);
  // bad JSON from the browser is still a plain 400
  const bad = await raw(app, "/capture", { method: "POST", jwt: app.browserJwt(ME), headers: UI_HEADERS, body: undefined });
  assert.equal(bad.status, 400);
});

test("a cross site form post cannot write even though the browser would attach the login", async () => {
  const app = await createApp();
  const id = await seed(app);
  const res = await raw(app, "/forget", { method: "POST", jwt: app.browserJwt(ME), headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: { id } });
  assert.equal(res.status, 403);
  assert.equal((await app.call(`/entry?id=${id}`)).status, 200);
});
