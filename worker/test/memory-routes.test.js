import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";

const DAY = 24 * 60 * 60 * 1000;
const post = (app, path, body, opts = {}) => app.call(path, { method: "POST", body, ...opts });
const capture = async (app, content, extra = {}) => (await post(app, "/capture", { content, ...extra })).json;

const ROUTES = [
  ["GET", "/entry?id=x"], ["GET", "/list"], ["GET", "/history?id=x"],
  ["POST", "/capture"], ["POST", "/update"], ["POST", "/append"], ["POST", "/status"],
  ["POST", "/forget"], ["POST", "/restore"], ["POST", "/undo"], ["POST", "/link"],
];

test("every memory route needs a bearer token", async () => {
  const app = await createApp();
  for (const [method, path] of ROUTES) {
    const res = await app.call(path, { method, token: null, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await app.call(path, { method, token: "wrong", body: method === "POST" ? {} : undefined })).status, 401, `${method} ${path} bad token`);
  }
  assert.equal((await app.call("/list", { token: null, jwt: null })).status, 401);
});

test("a device token works on every memory route, a browser login only on the reads", async () => {
  const app = await createApp();
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  const created = await post(app, "/capture", { content: "device note" }, { token });
  assert.equal(created.status, 200);
  const id = created.json.id;
  for (const path of [`/entry?id=${id}`, "/list", `/history?id=${id}`]) assert.equal((await app.call(path, { token })).status, 200, path);
  for (const [path, body] of [["/update", { id, content: "x" }], ["/append", { id, addition: "y" }], ["/status", { id, status: "deprecated" }], ["/forget", { id }], ["/restore", { id }], ["/undo", { id }]]) {
    const r = await post(app, path, body, { token });
    assert.equal(r.status, 200, path + JSON.stringify(r.json));
  }
  const other = (await post(app, "/capture", { content: "second" }, { token })).json.id;
  const third = (await post(app, "/capture", { content: "third" }, { token })).json.id;
  assert.equal((await post(app, "/link", { source_id: third, target_id: other, type: "related" }, { token })).status, 200);

  const jwt = app.browserJwt("me@example.com");
  for (const path of [`/entry?id=${other}`, "/list", `/history?id=${other}`]) assert.equal((await app.call(path, { token: null, jwt })).status, 200, path);
  const denied = await post(app, "/capture", { content: "no" }, { token: null, jwt });
  assert.equal(denied.status, 403);
});

test("a device token cannot write admin only origins, capsule tags or canonical status, on /capture, /update or /status", async () => {
  const app = await createApp();
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  for (const origin of ["profile", "person", "system", "import"]) {
    const res = await post(app, "/capture", { content: `device ${origin} note`, origin }, { token });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.code, "admin_only");
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /cannot write origin/);
  }
  assert.equal((await post(app, "/capture", { content: "device person note", source: "person" }, { token })).status, 403, "source maps to the same origin");
  for (const tags of [["capsule:core"], ["capsule-slot:identity"], ["status:canonical"]]) {
    const res = await post(app, "/capture", { content: `device note tagged ${tags[0]}`, tags }, { token });
    assert.equal(res.status, 403, tags[0]);
    assert.equal(res.json.code, "admin_only");
  }
  assert.equal((await app.call("/list", { token })).json.entries.length, 0, "a refused write stores nothing");
  assert.equal((await post(app, "/capture", { content: "device plain note", origin: "explicit", tags: ["alpha"] }, { token })).status, 200);
  assert.equal((await post(app, "/capture", { content: "device session note", source: "session-capture" }, { token })).status, 200);

  const id = (await capture(app, "a plain memory")).id;
  for (const body of [{ id, tags: ["capsule:core"] }, { id, tags: ["status:canonical"] }]) {
    const res = await post(app, "/update", body, { token });
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.json.code, "admin_only");
  }
  const status = await post(app, "/status", { id, status: "canonical" }, { token });
  assert.equal(status.status, 403);
  assert.equal(status.json.code, "admin_only");
  assert.equal((await app.call(`/entry?id=${id}`)).json.entry.status, "active", "nothing changed");
  assert.equal((await post(app, "/update", { id, content: "device edit", tags: ["plain"] }, { token })).status, 200, "a device may still tag plainly");
  assert.equal((await post(app, "/status", { id, status: "deprecated" }, { token })).status, 200);

  const admin = await post(app, "/capture", { content: "admin identity note", origin: "system", tags: ["capsule:core", "capsule-slot:identity", "status:canonical"] });
  assert.equal(admin.status, 200);
  assert.equal(admin.json.status, "canonical");
  assert.equal((await post(app, "/capture", { content: "admin import note", origin: "import" })).status, 200);
  assert.equal((await post(app, "/update", { id, tags: ["capsule:core"] })).status, 200, "the admin token may set the capsule tag");
  assert.equal((await post(app, "/status", { id, status: "canonical" })).status, 200, "and canonical");
});

test("a device token cannot change, strip, undo or forget a memory that holds capsule tags or the canonical status", async () => {
  const app = await createApp();
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  const core = (await post(app, "/capture", { content: "core identity note", origin: "system", tags: ["capsule:core", "capsule-slot:identity", "status:canonical"] })).json.id;
  const refused = async (path, body) => {
    const res = await post(app, path, body, { token });
    assert.equal(res.status, 403, `${path} ${JSON.stringify(body)}`);
    assert.equal(res.json.code, "admin_only");
  };
  await refused("/update", { id: core, tags: ["plain"] });
  await refused("/update", { id: core, content: "device rewrite" });
  await refused("/append", { id: core, addition: "device addition" });
  await refused("/status", { id: core, status: "deprecated" });
  await refused("/forget", { id: core });
  const entry = (await app.call(`/entry?id=${core}`)).json.entry;
  assert.equal(entry.status, "canonical");
  assert.ok(entry.tags.includes("capsule:core"), "nothing changed");

  const plain = (await capture(app, "a plain memory")).id;
  assert.equal((await post(app, "/update", { id: plain, tags: ["capsule:core"] })).status, 200, "the admin sets the capsule tag");
  assert.equal((await post(app, "/update", { id: plain, tags: [] })).status, 200, "and removes it again");
  await refused("/undo", { id: plain });
  assert.equal((await app.call(`/entry?id=${plain}`)).json.entry.tags.length, 0, "the undo that would bring the tag back was refused");
  assert.equal((await post(app, "/undo", { id: plain })).status, 200, "the admin token may undo");
});

test("a device capture with the name of a protected capture memory is stored as a new memory, the protected one is not touched", async () => {
  const app = await createApp();
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  const text = (body) => `---\nname: same-name-note\ndescription: x\n---\n${body}`;
  const first = (await post(app, "/capture", { content: text("the original text of the note"), source: "session-capture" })).json.id;
  assert.equal((await post(app, "/update", { id: first, tags: ["capsule:core", "capsule-slot:identity"] })).status, 200);
  const second = await post(app, "/capture", { content: text("a completely different second text"), source: "session-capture" }, { token });
  assert.equal(second.status, 200);
  assert.notEqual(second.json.id, first, "a new memory, not an update in place");
  assert.equal(second.json.updated, undefined);
  const kept = (await app.call(`/entry?id=${first}`)).json.entry;
  assert.ok(kept.tags.includes("capsule:core"), "the capsule tags stay");
  assert.match(kept.content, /original text/);
});

test("a browser login may still save profile and person notes, and the capsule tags", async () => {
  const app = await createApp();
  const jwt = app.browserJwt("me@example.com");
  const write = (body) => raw(app, "/capture", { method: "POST", jwt, headers: UI_HEADERS, body });
  assert.equal((await write({ content: "browser profile note", origin: "profile" })).status, 200);
  assert.equal((await write({ content: "browser person note", source: "person" })).status, 200);
  assert.equal((await write({ content: "browser core note", origin: "profile", tags: ["capsule:core", "capsule-slot:identity", "status:canonical"] })).status, 200);
});

test("a device token shares 40 writes in 10 minutes across every write route, and the admin token is not counted", async () => {
  const app = await createApp();
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  const id = (await capture(app, "seed memory")).id;
  const other = (await capture(app, "another seed")).id;
  for (let i = 0; i < 40; i++) {
    const res = await post(app, "/update", { id, content: `edit number ${i}` }, { token });
    assert.equal(res.status, 200, `update ${i}`);
  }
  const refused = await post(app, "/update", { id, content: "one more edit" }, { token });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, "rate_limited");
  assert.match(refused.headers.get("retry-after"), /^\d+$/);
  assert.equal(refused.json.retry_after, Number(refused.headers.get("retry-after")));
  for (const [path, body] of [["/append", { id, addition: "x" }], ["/status", { id, status: "deprecated" }], ["/forget", { id }], ["/restore", { id }], ["/undo", { id }], ["/link", { source_id: id, target_id: other, type: "related" }]]) {
    assert.equal((await post(app, path, body, { token })).status, 429, path);
  }
  assert.equal((await app.call(`/entry?id=${id}`, { token })).status, 200, "reads are not counted");
  assert.equal((await post(app, "/update", { id, content: "the admin token still writes" })).status, 200, "the admin token is not limited");

  app.clock.t += 10 * 60 * 1000 + 1000;
  assert.equal((await post(app, "/update", { id, content: "after the window" }, { token })).status, 200, "the window has rolled");
});

test("/update and /append screen their text for secrets, as /capture does, and store nothing when it holds one", async () => {
  const app = await createApp();
  const id = (await capture(app, "a plain memory")).id;
  const key = "sk-" + "a1b2c3d4".repeat(4);
  const update = await post(app, "/update", { id, content: `the key is ${key}` });
  assert.equal(update.status, 422);
  assert.equal(update.json.code, "refused");
  assert.match(update.json.error, /looks like a secret/);
  const append = await post(app, "/append", { id, addition: `token: ${key}` });
  assert.equal(append.status, 422);
  assert.equal(append.json.code, "refused");
  assert.equal((await app.call(`/entry?id=${id}`)).json.entry.content, "a plain memory", "a refused write changes nothing");
  assert.equal((await post(app, "/update", { id, content: "a clean edit" })).status, 200);
  assert.equal((await post(app, "/append", { id, addition: "a clean addition" })).status, 200);
  assert.equal((await post(app, "/update", { id, tags: ["plain"] })).status, 200, "a tags only update has no text to screen");
  const kept = (await app.call(`/entry?id=${id}`)).json.entry;
  assert.match(kept.content, /clean addition/);
  assert.doesNotMatch(kept.content, /sk-/);
});

test("POST /capture stores and maps source to origin", async () => {
  const app = await createApp();
  const cases = [["session-capture", "capture"], ["claude", "explicit"], ["profile", "profile"], ["person", "person"], ["anything-else", "explicit"], [undefined, "explicit"]];
  for (const [source, origin] of cases) {
    const r = await capture(app, `note from ${source}`, { source });
    assert.equal(r.ok, true);
    const entry = (await app.call(`/entry?id=${r.id}`)).json.entry;
    assert.equal(entry.origin, origin, String(source));
  }
  const r = await capture(app, "tagged #hashy", { tags: ["Alpha", "status:canonical", "kind:episodic", "capsule:core"], project: "demo" });
  assert.deepEqual(r, { ok: true, id: r.id, status: "canonical", tags: ["alpha", "capsule:core", "hashy"] });
  const e = (await app.call(`/entry?id=${r.id}`)).json.entry;
  assert.deepEqual([e.kind, e.project, e.pinned, e.status], ["episodic", "demo", true, "canonical"]);
});

test("POST /capture origin, harness and session come from the body or the header", async () => {
  const app = await createApp();
  const a = await capture(app, "one", { origin: "import", harness: "codex", session: "sess-1" });
  const b = await post(app, "/capture", { content: "two" }, { headers: { "x-anymem-harness": "claude-code" } });
  const get = async (id) => (await app.call(`/entry?id=${id}`)).json.entry;
  assert.deepEqual([(await get(a.id)).origin, (await get(a.id)).harness, (await get(a.id)).session], ["import", "codex", "sess-1"]);
  assert.equal((await get(b.json.id)).harness, "claude", "a known alias is stored as its id");
  const c = await post(app, "/capture", { content: "three" }, { headers: { "x-anymem-harness": "some-new-tool" } });
  assert.equal((await get(c.json.id)).harness, "some-new-tool", "a name nobody knows is kept as written");
  assert.equal((await get(c.json.id)).harness_label, "some-new-tool");
  assert.equal((await get(a.id)).harness_label, "Codex");
  assert.equal((await post(app, "/capture", { content: "x", origin: "bogus" })).status, 400);
});

test("POST /capture bad input", async () => {
  const app = await createApp();
  const bad = [{}, { content: "" }, { content: 5 }, { content: "x", tags: "a" }, { content: "x", tags: [1] }, { content: "x", tags: ["status:draft"] }, { content: "x", project: 3 }, { content: "x", project: "Bad Slug" }, { content: "x", tags: ["project:a"], project: "b" }];
  for (const body of bad) assert.equal((await post(app, "/capture", body)).status, 400, JSON.stringify(body));
  assert.equal((await app.call("/capture", { method: "POST", rawBody: "{not json" })).status, 400);
  const big = await post(app, "/capture", { content: "a".repeat(30_001) });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /30000/);
  assert.equal((await app.call("/capture", { method: "GET" })).status, 405);
});

test("GET /entry returns the full shape, 404 for missing, and reads old versions", async () => {
  const app = await createApp();
  const { id } = await capture(app, "---\nname: Shape\ndescription: d\nmetadata:\n  type: user\n---\nthe body", { tags: ["t"] });
  const res = await app.call(`/entry?id=${id}`);
  assert.equal(res.json.ok, true);
  assert.deepEqual(Object.keys(res.json.entry).sort(), [
    "body", "content", "created_at", "deleted_at", "description", "harness", "harness_label", "id", "kind", "last_recalled_at", "name", "origin", "pinned", "project", "recall_count", "session", "status", "superseded_by", "tags", "type", "updated_at", "valid_from", "valid_until",
  ]);
  assert.deepEqual([res.json.entry.name, res.json.entry.type, res.json.entry.body, res.json.entry.tags], ["Shape", "user", "the body", ["t"]]);
  assert.equal((await app.call("/entry?id=nope")).status, 404);
  assert.equal((await app.call("/entry")).status, 400);
  await post(app, "/update", { id, content: "changed" });
  const v1 = await app.call(`/entry?id=${id}&version=1`);
  assert.equal(v1.json.entry.name, "Shape");
  assert.equal(v1.json.entry.version, 1);
  assert.equal((await app.call(`/entry?id=${id}&version=9`)).status, 404);
  assert.equal((await app.call(`/entry?id=${id}&version=0`)).status, 400);
  assert.equal((await app.call(`/entry?id=${id}&version=x`)).status, 400);
});

test("update, compare and set, append, status over HTTP", async () => {
  const app = await createApp();
  const { id } = await capture(app, "start");
  const e0 = (await app.call(`/entry?id=${id}`)).json.entry;
  app.clock.t += 50;
  const u = await post(app, "/update", { id, content: "next", tags: ["x"], if_updated_at: e0.updated_at });
  assert.equal(u.status, 200);
  assert.equal(u.json.entry.content, "next");
  const stale = await post(app, "/update", { id, content: "late", if_updated_at: e0.updated_at });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale_update");
  assert.equal((await post(app, "/append", { id, addition: "more" })).json.entry.content, "next\n\nmore");
  assert.equal((await post(app, "/status", { id, status: "deprecated" })).json.entry.status, "deprecated");
  const bad = [
    ["/update", {}], ["/update", { id }], ["/update", { id, content: 3 }], ["/update", { id, tags: "x" }], ["/update", { id, content: "x", if_updated_at: "1" }], ["/update", { id, content: "x", if_updated_at: 1.5 }],
    ["/append", { id }], ["/append", { id, addition: " " }], ["/append", { addition: "x" }],
    ["/status", { id }], ["/status", { id, status: "draft" }], ["/status", { status: "active" }],
    ["/forget", {}], ["/forget", { id: 5 }], ["/restore", {}], ["/undo", {}], ["/link", {}], ["/link", { source_id: id }],
  ];
  for (const [path, body] of bad) assert.equal((await post(app, path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
  for (const [path, body] of [["/update", { content: "x" }], ["/append", { addition: "x" }], ["/status", { status: "active" }], ["/forget", {}], ["/restore", {}], ["/undo", {}]]) {
    assert.equal((await post(app, path, { id: "missing", ...body })).status, 404, path);
  }
});

test("two racing updates over HTTP, one 200 and one 409", async () => {
  const app = await createApp();
  const { id } = await capture(app, "race");
  const { updated_at } = (await app.call(`/entry?id=${id}`)).json.entry;
  const res = await Promise.all([post(app, "/update", { id, content: "A", if_updated_at: updated_at }), post(app, "/update", { id, content: "B", if_updated_at: updated_at })]);
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
});

test("forget, list the trash, restore, and the restore window", async () => {
  const app = await createApp();
  const a = (await capture(app, "keep me")).id;
  const b = (await capture(app, "trash me")).id;
  app.clock.t += 10;
  const f = await post(app, "/forget", { id: b });
  assert.equal(f.json.entry.deleted_at, app.clock.t);
  assert.equal((await app.call(`/entry?id=${b}`)).status, 404);
  assert.equal((await app.call(`/entry?id=${b}&deleted=1`)).status, 200);
  assert.deepEqual((await app.call("/list")).json.entries.map((e) => e.id), [a]);
  assert.deepEqual((await app.call("/list?deleted=1")).json.entries.map((e) => e.id), [b]);
  assert.equal((await post(app, "/restore", { id: b })).json.entry.deleted_at, null);
  assert.equal((await app.call("/list")).json.entries.length, 2);
  assert.equal((await post(app, "/restore", { id: b })).status, 409);
  await post(app, "/forget", { id: b });
  app.clock.t += 15 * DAY;
  const late = await post(app, "/restore", { id: b });
  assert.equal(late.status, 410);
  assert.equal(late.json.code, "restore_window_passed");
});

test("undo over HTTP flips, history lists versions with summaries", async () => {
  const app = await createApp();
  const { id } = await capture(app, "one");
  await post(app, "/update", { id, content: "one two" });
  const h = (await app.call(`/history?id=${id}`)).json;
  assert.equal(h.ok, true);
  assert.deepEqual(h.versions.map((v) => [v.seq, v.reason, v.summary]), [[1, "update", "content +4 chars"]]);
  assert.equal(typeof h.versions[0].at, "number");
  assert.equal((await post(app, "/undo", { id })).json.entry.content, "one");
  assert.equal((await post(app, "/undo", { id })).json.entry.content, "one two");
  assert.equal((await app.call(`/history?id=${id}`)).json.versions.length, 3);
  assert.equal((await app.call("/history?id=nope")).status, 404);
  assert.equal((await app.call("/history")).status, 400);
  const fresh = (await capture(app, "untouched")).id;
  assert.equal((await post(app, "/undo", { id: fresh })).status, 409);
});

test("POST /link creates, dedupes and checks both ends", async () => {
  const app = await createApp();
  const a = (await capture(app, "a")).id;
  const b = (await capture(app, "b")).id;
  assert.deepEqual((await post(app, "/link", { source_id: a, target_id: b, type: "about_person" })).json, { ok: true, created: true });
  assert.deepEqual((await post(app, "/link", { source_id: a, target_id: b, type: "about_person" })).json, { ok: true, created: false });
  assert.equal((await post(app, "/link", { source_id: a, target_id: "missing", type: "x" })).status, 404);
  assert.equal((await post(app, "/link", { source_id: a, target_id: a, type: "x" })).status, 400);
  assert.equal((await post(app, "/link", { source_id: a, target_id: b })).status, 400);
  assert.equal((await app.env.DB.prepare("SELECT COUNT(*) AS n FROM links").first()).n, 1);
});

test("GET /list filters, paging and bad parameters over HTTP", async () => {
  const app = await createApp();
  const ids = [];
  for (let i = 0; i < 7; i++) {
    app.clock.t += 10;
    ids.push((await capture(app, `row ${i}`, { tags: i % 2 ? ["odd", "all"] : ["even", "all"], source: i < 3 ? "session-capture" : "claude" })).id);
  }
  assert.deepEqual((await app.call("/list")).json.entries.map((e) => e.id), [...ids].reverse());
  assert.equal((await app.call("/list?tag=odd")).json.entries.length, 3);
  assert.equal((await app.call("/list?tag=odd&tag=all")).json.entries.length, 3);
  assert.equal((await app.call("/list?tag=odd&tag=even")).json.entries.length, 0);
  assert.equal((await app.call("/list?origin=capture")).json.entries.length, 3);
  assert.equal((await app.call("/list?status=pending")).json.entries.length, 0);
  assert.equal((await app.call("/list?min_recalls=1")).json.entries.length, 0);
  assert.equal((await app.call("/list?max_recalls=0")).json.entries.length, 7);
  const t = (await app.call(`/entry?id=${ids[3]}`)).json.entry.created_at;
  assert.equal((await app.call(`/list?after=${t}`)).json.entries.length, 4);
  assert.equal((await app.call(`/list?before=${t}`)).json.entries.length, 3);
  const seen = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const page = (await app.call(`/list?n=3${cursor}`)).json;
    seen.push(...page.entries.map((e) => e.id));
    if (!page.next_cursor) break;
    cursor = `&cursor=${page.next_cursor}`;
  }
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal((await app.call("/list?n=3")).json.entries[0].content, "row 6");
  for (const q of ["n=0", "n=501", "n=x", "status=draft", "origin=x", "type=x", "after=x", "before=-1", "min_recalls=x", "deleted=2", "cursor=%21%21", "tag=has%20space"]) {
    assert.equal((await app.call(`/list?${q}`)).status, 400, q);
  }
});

test("long content comes back in full from list and entry", async () => {
  const app = await createApp();
  const text = "x".repeat(29_000);
  const { id } = await capture(app, text);
  assert.equal((await app.call("/list")).json.entries[0].content.length, 29_000);
  assert.equal((await app.call(`/entry?id=${id}`)).json.entry.content.length, 29_000);
});

test("audit rows list the memory ids each call touched", async () => {
  const app = await createApp();
  const a = (await capture(app, "a")).id;
  const b = (await capture(app, "b")).id;
  await post(app, "/link", { source_id: a, target_id: b, type: "x" });
  await post(app, "/update", { id: a, content: "never-logged-marker-zq" });
  await app.call(`/entry?id=${a}`);
  await app.call("/list");
  await post(app, "/forget", { id: b });
  await post(app, "/update", { id: "missing", content: "x" });
  const rows = (await app.call("/audit?limit=500")).json.entries.reverse();
  const at = (route, n = 0) => rows.filter((r) => r.route === route)[n];
  assert.deepEqual(at("/capture", 0).memory_ids, [a]);
  assert.deepEqual(at("/capture", 1).memory_ids, [b]);
  assert.deepEqual(at("/link").memory_ids, [a, b]);
  assert.deepEqual(at("/update", 0).memory_ids, [a]);
  assert.deepEqual(at("/entry").memory_ids, [a]);
  assert.deepEqual(at("/list").memory_ids.sort(), [a, b].sort());
  assert.deepEqual(at("/forget").memory_ids, [b]);
  assert.deepEqual([at("/update", 1).status, at("/update", 1).memory_ids], [404, ["missing"]]);
  assert.ok(rows.every((r) => !JSON.stringify(r).includes("never-logged-marker-zq")));
});
