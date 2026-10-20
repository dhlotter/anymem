// Subjects made by hand: the routes, the card memory, the fields, the device flag and the trash purge. Every subject here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { DAY, row, rows, runNightly, seed } from "./helpers/maintenance.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";

const post = (app, path, body, opts = {}) => app.call(path, { method: "POST", body, ...opts });
const add = async (app, over = {}) => {
  const res = await post(app, "/subject", { slug: "pip", kind: "pet", name: "Pip", brief: "A small brown dog.", ...over });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.subject;
};
const note = async (app, text) => (await post(app, "/capture", { content: text })).json.id;
const about = (app, source, card) => post(app, "/link", { source_id: source, target_id: card, type: "about" });
const device = async (app, label = "laptop") => (await post(app, "/devices", { label })).json;

test("POST /subject makes the card memory and the row, and replies with the subject", async () => {
  const app = await createApp();
  const subject = await add(app, { aliases: ["Pipster", "pip "], fields: { species: "dog", breed: "terrier" } });
  assert.deepEqual(Object.keys(subject).sort(), ["aliases", "brief", "fields", "id", "kind", "member_count", "members", "name", "scope", "slug", "status", "updated_at"]);
  assert.deepEqual([subject.slug, subject.kind, subject.name, subject.status, subject.scope, subject.brief, subject.member_count, subject.members], ["pip", "pet", "Pip", "active", "shared", "A small brown dog.", 0, []]);
  assert.deepEqual(subject.aliases, ["pipster", "pip"], "lowercase and trimmed");
  assert.deepEqual(subject.fields.species, { value: "dog", confirmed_at: app.clock.t, source: "user" });
  const card = (await app.call(`/entry?id=${subject.id}`)).json.entry;
  assert.deepEqual([card.origin, card.type, card.status, card.name, card.description], ["system", "project", "active", "pip", "pet card for Pip"]);
  assert.deepEqual(card.tags, ["subject", "subject-kind:pet", "subject:pip"]);
  assert.equal(card.body, "A small brown dog.");
  assert.equal((await app.call("/list?tag=subject")).json.entries.length, 1, "an ordinary memory in the list");
  assert.ok((await app.call("/recall?query=small%20brown%20dog")).json.results.some((r) => r.id === subject.id), "searchable");
});

test("a subject needs a good slug, kind, name and fields, and a taken slug is a conflict", async () => {
  const app = await createApp();
  const bad = async (over, code, status = 400) => {
    const res = await post(app, "/subject", { slug: "dana", kind: "person", name: "Dana", ...over });
    assert.deepEqual([res.status, res.json.code], [status, code], JSON.stringify(over));
  };
  for (const slug of ["a", "x".repeat(41), "Dana", "dana-", "-dana", "da-" + "-na", "da na", "da_na", 5, undefined]) await bad({ slug }, "bad_slug");
  await bad({ kind: "cat" }, "bad_kind");
  await bad({ kind: undefined }, "bad_kind");
  for (const name of ["", "  ", "x".repeat(81), "two\nlines", 5]) await bad({ name }, "bad_name");
  await bad({ brief: 5 }, "bad_brief");
  await bad({ scope: "secret" }, "bad_scope");
  await bad({ aliases: "dani" }, "bad_alias");
  await bad({ aliases: ["x".repeat(81)] }, "bad_alias");
  await bad({ fields: [] }, "bad_field");
  await bad({ fields: { favourite_colour: "blue" } }, "bad_field");
  await bad({ fields: { health_note: "x" } }, "bad_field");
  await bad({ fields: { work: "" } }, "bad_field");
  await bad({ fields: { work: "x".repeat(201) } }, "bad_field");
  await bad({ fields: { work: 5 } }, "bad_field");
  assert.equal((await rows(app, "SELECT * FROM subjects")).length, 0);
  assert.equal((await app.call("/list")).json.entries.length, 0, "a refused subject leaves no card memory");
  assert.equal((await post(app, "/subject", { slug: "dana", kind: "person", name: "Dana", fields: { work: "x".repeat(200) } })).status, 200);
  await bad({ name: "Dana again" }, "subject_exists", 409);
  assert.equal((await rows(app, "SELECT * FROM subjects")).length, 1);
  assert.equal((await app.call("/list?tag=subject")).json.entries.length, 1, "the conflict made no second card");
});

test("each kind takes its own field keys, and a person never gets a health or money key", async () => {
  const app = await createApp();
  const keys = {
    person: ["relationship", "known_as", "work", "contact", "birthday"],
    pet: ["name", "species", "breed", "born", "vet", "status", "health_note"],
    asset: ["type", "name", "identifier", "acquired", "status", "value_note"],
    project: ["what", "status", "owner", "repo"],
    area: ["what", "status"],
    topic: ["what"],
  };
  for (const [kind, allowed] of Object.entries(keys)) {
    const ok = await post(app, "/subject", { slug: `s-${kind}`, kind, name: kind, fields: Object.fromEntries(allowed.map((k) => [k, "v"])) });
    assert.equal(ok.status, 200, kind);
    assert.deepEqual(Object.keys(ok.json.subject.fields).sort(), [...allowed].sort());
    for (const other of ["health_note", "value_note", "what"].filter((k) => !allowed.includes(k))) {
      const res = await post(app, "/subject/update", { slug: `s-${kind}`, fields: { [other]: "v" } });
      assert.deepEqual([res.status, res.json.code], [400, "bad_field"], `${kind} ${other}`);
    }
  }
});

test("a brief or field with a secret is refused and stores nothing", async () => {
  const app = await createApp();
  const key = "sk-" + "a1B2c3D4".repeat(4);
  assert.equal((await post(app, "/subject", { slug: "alpha", kind: "project", name: "Alpha", brief: `key ${key}` })).status, 422);
  assert.equal((await post(app, "/subject", { slug: "alpha", kind: "project", name: "Alpha", fields: { what: key } })).status, 422);
  await add(app, { slug: "alpha", kind: "project", name: "Alpha" });
  assert.equal((await post(app, "/subject/update", { slug: "alpha", brief: key })).json.code, "refused");
  assert.equal((await rows(app, "SELECT * FROM subjects")).length, 1);
});

test("POST /subject/update merges fields, replaces aliases and moves status and scope", async () => {
  const app = await createApp();
  const { id } = await add(app, { fields: { species: "dog", vet: "Cottage Vets" }, aliases: ["pipster"] });
  app.clock.t += 1000;
  const res = await post(app, "/subject/update", { slug: "pip", fields: { vet: null, breed: "terrier", species: "dog" }, aliases: ["Pippin"], scope: "private", status: "retired" });
  assert.equal(res.status, 200);
  const s = res.json.subject;
  assert.deepEqual(Object.keys(s.fields).sort(), ["breed", "species"], "null removed vet");
  assert.equal(s.fields.species.confirmed_at, app.clock.t, "setting a key again confirms it again");
  assert.deepEqual([s.aliases, s.scope, s.status, s.updated_at], [["pippin"], "private", "retired", app.clock.t]);
  assert.equal((await post(app, "/subject/update", { id, status: "active" })).json.subject.status, "active", "found by id");
  for (const status of ["proposed", "stale", "gone", 5]) {
    const refused = await post(app, "/subject/update", { id, status });
    assert.deepEqual([refused.status, refused.json.code], [400, "bad_status"], String(status));
  }
  assert.equal((await post(app, "/subject/update", { id, scope: "open" })).json.code, "bad_scope");
  assert.equal((await post(app, "/subject/update", { id })).status, 400, "nothing to change");
  assert.equal((await post(app, "/subject/update", { slug: "nobody", status: "active" })).status, 404);
  assert.equal((await post(app, "/subject/update", { status: "active" })).status, 404);
});

test("a new brief or name writes a new version of the card memory with the reason update", async () => {
  const app = await createApp();
  const { id } = await add(app);
  app.clock.t += 1000;
  const res = await post(app, "/subject/update", { id, brief: "A small brown dog. Afraid of thunder.", name: "Pip the dog" });
  assert.deepEqual([res.json.subject.brief, res.json.subject.name], ["A small brown dog. Afraid of thunder.", "Pip the dog"]);
  const card = (await app.call(`/entry?id=${id}`)).json.entry;
  assert.deepEqual([card.description, card.name, card.origin, card.tags], ["pet card for Pip the dog", "pip", "system", ["subject", "subject-kind:pet", "subject:pip"]]);
  const versions = (await rows(app, "SELECT seq, reason FROM memory_versions WHERE memory_id = ?", id)).map((r) => ({ ...r }));
  assert.deepEqual(versions, [{ seq: 1, reason: "update" }]);
  assert.equal((await app.call(`/history?id=${id}`)).json.versions.length, 1);
  await post(app, "/subject/update", { id, brief: "" });
  assert.equal((await app.call(`/subject?id=${id}`)).json.subject.brief, "", "an empty brief clears it");
  await post(app, "/subject/update", { id, aliases: ["a"] });
  assert.equal((await rows(app, "SELECT seq FROM memory_versions WHERE memory_id = ?", id)).length, 2, "alias and field changes do not touch the card");
});

test("GET /subjects lists newest updated first with filters, and q matches slug, name and alias", async () => {
  const app = await createApp();
  await add(app, { aliases: ["pipster"] });
  app.clock.t += 1000;
  await add(app, { slug: "corolla", kind: "asset", name: "The Corolla" });
  app.clock.t += 1000;
  await add(app, { slug: "cottage", kind: "asset", name: "The Cottage", scope: "private" });
  app.clock.t += 1000;
  const alpha = await add(app, { slug: "alpha", kind: "project", name: "Alpha" });
  app.clock.t += 1000;
  await post(app, "/subject/update", { id: alpha.id, status: "retired" });
  const list = async (query = "") => (await app.call(`/subjects${query}`)).json.subjects;
  const slugs = async (query) => (await list(query)).map((s) => s.slug);
  assert.deepEqual(await slugs(""), ["alpha", "cottage", "corolla", "pip"]);
  assert.deepEqual(Object.keys((await list())[0]).sort(), ["aliases", "fields", "id", "kind", "member_count", "name", "scope", "slug", "status", "updated_at"]);
  assert.deepEqual(await slugs("?kind=asset"), ["cottage", "corolla"]);
  assert.deepEqual(await slugs("?status=retired"), ["alpha"]);
  assert.deepEqual(await slugs("?scope=private"), ["cottage"]);
  assert.deepEqual(await slugs("?kind=asset&scope=shared"), ["corolla"]);
  assert.deepEqual(await slugs("?q=PIPS"), ["pip"], "alias, case blind");
  assert.deepEqual(await slugs("?q=the%20cor"), ["corolla"], "name");
  assert.deepEqual(await slugs("?q=cott"), ["cottage"], "slug");
  assert.deepEqual(await slugs("?q=nothing"), []);
  for (const q of ["?kind=cat", "?status=old", "?scope=hidden"]) assert.equal((await app.call(`/subjects${q}`)).status, 400, q);
});

test("GET /subject returns the brief and the members newest first, and counts members that are live", async () => {
  const app = await createApp();
  const card = await add(app);
  const first = await note(app, "Pip chewed a shoe");
  app.clock.t += 1000;
  const second = await note(app, "Pip learned to sit");
  app.clock.t += 1000;
  const gone = await note(app, "Pip broke a vase");
  const unrelated = await note(app, "The Corolla needs a service");
  for (const id of [first, second, gone]) assert.equal((await about(app, id, card.id)).status, 200);
  await post(app, "/link", { source_id: unrelated, target_id: card.id, type: "related" });
  await post(app, "/forget", { id: gone });
  app.clock.t += 1000;
  await post(app, "/append", { id: first, addition: "and a sock" });
  const byId = (await app.call(`/subject?id=${card.id}`)).json;
  const bySlug = (await app.call("/subject?slug=pip")).json;
  assert.deepEqual(byId, bySlug);
  assert.equal(byId.ok, true);
  assert.deepEqual(byId.subject.members.map((m) => m.id), [first, second], "newest change first, no trash, no other link type");
  assert.deepEqual(Object.keys(byId.subject.members[0]).sort(), ["id", "name", "updated_at"]);
  assert.equal(byId.subject.member_count, 2);
  assert.equal((await app.call("/subjects")).json.subjects[0].member_count, 2);
  assert.equal((await app.call("/subject")).status, 400);
  assert.equal((await app.call("/subject?slug=nobody")).status, 404);
  assert.equal((await app.call("/subject?id=nobody")).status, 404);
});

test("the member list stops at 200 and member_count stays the real count", async () => {
  const app = await createApp();
  const card = await add(app);
  const ids = [];
  for (let i = 0; i < 205; i++) ids.push(await seed(app, { name: `m${i}`, text: `Pip note number ${i}`, created_at: app.clock.t - i }));
  await app.env.DB.batch(ids.map((id) => app.env.DB.prepare("INSERT INTO links (source_id, target_id, link_type, created_at) VALUES (?, ?, 'about', 1)").bind(id, card.id)));
  const { subject } = (await app.call("/subject?slug=pip")).json;
  assert.equal(subject.members.length, 200);
  assert.equal(subject.member_count, 205);
});

test("a subject whose card is in the trash is not found until the card is restored", async () => {
  const app = await createApp();
  const { id } = await add(app);
  await post(app, "/forget", { id });
  assert.equal((await app.call("/subject?slug=pip")).status, 404);
  assert.deepEqual((await app.call("/subjects")).json.subjects, []);
  assert.equal((await post(app, "/subject/update", { slug: "pip", status: "retired" })).status, 404);
  assert.equal((await post(app, "/subject", { slug: "pip", kind: "pet", name: "Pip" })).json.code, "subject_exists", "the slug stays taken");
  await post(app, "/restore", { id });
  assert.equal((await app.call("/subject?slug=pip")).status, 200);
});

test("the trash purge removes the subject row of a purged card, and the links to it", async () => {
  const app = await createApp();
  const { id } = await add(app);
  const kept = await add(app, { slug: "alpha", kind: "project", name: "Alpha" });
  const m = await note(app, "Pip chewed a shoe");
  await about(app, m, id);
  await app.env.DB.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").bind(app.clock.t - 15 * DAY, id).run();
  const out = (await runNightly(app, { steps: ["purge_trash"] })).summary.purge_trash;
  assert.equal(out.purged, 1);
  assert.equal(await row(app, id), null);
  assert.deepEqual((await rows(app, "SELECT slug FROM subjects")).map((r) => r.slug), ["alpha"]);
  assert.equal((await rows(app, "SELECT * FROM links")).length, 0);
  assert.equal((await app.call(`/subject?id=${kept.id}`)).status, 200);
  assert.ok(await row(app, m), "the member memory stays");
});

test("subject writes need the admin token or a browser login from the dashboard, a device token may read", async () => {
  const app = await createApp();
  const { token } = await device(app);
  const { id } = await add(app);
  for (const [path, body] of [["/subject", { slug: "dana", kind: "person", name: "Dana" }], ["/subject/update", { id, status: "retired" }]]) {
    const res = await post(app, path, body, { token });
    assert.deepEqual([res.status, res.json.error], [403, "This route needs the admin token."], path);
  }
  assert.equal((await rows(app, "SELECT * FROM subjects")).length, 1);
  assert.equal((await app.call("/subjects", { token })).json.subjects.length, 1);
  assert.equal((await app.call("/subject?slug=pip", { token })).status, 200);
  for (const path of ["/subjects", "/subject?slug=pip"]) assert.equal((await app.call(path, { token: null })).status, 401, path);

  const jwt = app.browserJwt("me@example.com");
  const browser = async (path, body, headers = UI_HEADERS) => {
    const res = await raw(app, path, { method: "POST", jwt, headers, body });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await browser("/subject", { slug: "dana", kind: "person", name: "Dana" })).status, 200);
  assert.equal((await browser("/subject/update", { slug: "dana", status: "retired" })).status, 200);
  const noHeaders = await browser("/subject", { slug: "eli", kind: "person", name: "Eli" }, {});
  assert.deepEqual([noHeaders.status, noHeaders.json.code], [403, "csrf_rejected"]);
  assert.equal((await rows(app, "SELECT * FROM subjects WHERE slug = 'eli'")).length, 0);
  assert.equal((await app.call("/subjects", { token: null, jwt })).status, 200, "a browser login reads");
  assert.equal((await app.call("/subject?slug=dana", { token: null, jwt })).status, 200);
});

test("each subject route lists the card memory id in its audit row", async () => {
  const app = await createApp();
  const { id } = await add(app);
  await post(app, "/subject/update", { slug: "pip", status: "retired" });
  await app.call("/subject?slug=pip");
  await app.call("/subjects");
  const seen = {};
  for (const e of (await app.call("/audit")).json.entries) seen[`${e.method} ${e.route}`] = e.memory_ids;
  for (const key of ["POST /subject", "POST /subject/update", "GET /subject", "GET /subjects"]) assert.deepEqual(seen[key], [id], key);
});

test("a refused update still audits the card it was aimed at", async () => {
  const app = await createApp();
  const { id } = await add(app);
  assert.equal((await post(app, "/subject/update", { id, fields: { colour: "x" } })).status, 400);
  assert.deepEqual((await app.call("/audit?route=/subject/update")).json.entries[0].memory_ids, [id]);
});

test("POST /devices/private sets the flag, GET /devices shows it, and only the admin token may call it", async () => {
  const app = await createApp();
  const { device: made, token } = await device(app);
  const listed = async () => (await app.call("/devices")).json.devices.map((d) => d.allow_private);
  assert.deepEqual(await listed(), [true], "a new device may see private subjects");
  assert.deepEqual((await post(app, "/devices/private", { id: made.id, allow_private: false })).json, { ok: true, id: made.id, allow_private: false });
  assert.deepEqual(await listed(), [false]);
  assert.equal((await app.env.DB.prepare("SELECT allow_private FROM devices WHERE id = ?").bind(made.id).first()).allow_private, 0);
  assert.equal((await post(app, "/devices/private", { id: made.id, allow_private: true })).status, 200);
  assert.deepEqual(await listed(), [true]);

  const deviceCall = await post(app, "/devices/private", { id: made.id, allow_private: false }, { token });
  assert.equal(deviceCall.status, 403, "a device cannot change its own flag");
  const browser = await post(app, "/devices/private", { id: made.id, allow_private: false }, { token: null, jwt: app.browserJwt("me@example.com"), headers: UI_HEADERS });
  assert.deepEqual([browser.status, browser.json.code], [403, "browser_not_allowed"]);
  assert.deepEqual(await listed(), [true]);

  for (const body of [{}, { id: made.id }, { id: made.id, allow_private: "no" }, { id: made.id, allow_private: 0 }, { id: 5, allow_private: true }]) {
    assert.equal((await post(app, "/devices/private", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(app, "/devices/private", { id: "nobody", allow_private: false })).status, 404);
  await post(app, "/devices/revoke", { id: made.id });
  assert.equal((await post(app, "/devices/private", { id: made.id, allow_private: false })).status, 404, "a revoked device is not found");
});

// The stub in subjects/private.js hides nothing, so this one cannot pass until the real rule replaces it. The integrator removes `todo`.
test("needs the real private.js: a device kept from private subjects gets 404 for a private subject and no row in the list", { todo: "needs the real private.js" }, async () => {
  const app = await createApp();
  const { device: kept, token } = await device(app);
  await add(app);
  const hidden = await add(app, { slug: "cottage", kind: "asset", name: "The Cottage", scope: "private" });
  await post(app, "/devices/private", { id: kept.id, allow_private: false });
  assert.deepEqual((await app.call("/subjects", { token })).json.subjects.map((s) => s.slug), ["pip"]);
  assert.equal((await app.call("/subject?slug=cottage", { token })).status, 404);
  assert.equal((await app.call(`/subject?id=${hidden.id}`, { token })).status, 404);
  assert.equal((await app.call("/subject?slug=pip", { token })).status, 200);
  assert.equal((await app.call("/subject?slug=cottage")).status, 200, "the admin token sees it");
});
