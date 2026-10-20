import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, createApp } from "./helpers/app.js";
import { raw } from "./helpers/ui.js";
import { compareSlots, etagOf, CAP_CHARS } from "../capsule.js";

const post = (app, path, body, opts = {}) => app.call(path, { method: "POST", body, ...opts });

/** A capsule memory through the capture route. */
async function addCapsule(app, slot, body, tags = []) {
  const content = `---\nname: ${slot}-note\ndescription: a ${slot} section\n---\n${body}`;
  const r = await post(app, "/capture", { content, tags: ["capsule:core", `capsule-slot:${slot}`, "status:canonical", ...tags] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  app.clock.t += 10;
  return r.json.id;
}

const capsule = (app, opts) => app.call("/prompt-capsules/core", opts);

test("slots come in the fixed order, then any other slot alphabetically", async () => {
  const app = await createApp();
  for (const slot of ["principles", "zeta", "identity", "alpha", "constraints", "preferences"]) await addCapsule(app, slot, `text for ${slot}`);
  const res = await capsule(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.sections.map((s) => s.slot), ["identity", "preferences", "constraints", "principles", "alpha", "zeta"]);
  assert.deepEqual([compareSlots("b", "a"), compareSlots("identity", "alpha"), compareSlots("alpha", "principles")].map(Math.sign), [1, -1, 1]);
});

test("a section is the body without frontmatter, trimmed, with its source id and update time", async () => {
  const app = await createApp();
  const id = await addCapsule(app, "identity", "\n\n  I am Alex.  \n\n");
  const { json } = await capsule(app);
  assert.deepEqual(json.sections, [{ slot: "identity", content: "I am Alex.", source_id: id, name: "identity-note", updated_at: json.sections[0].updated_at }]);
  const entry = (await app.call(`/entry?id=${id}`)).json.entry;
  assert.equal(json.sections[0].updated_at, entry.updated_at);
  assert.equal(json.ok, true);
  assert.equal(json.cap, CAP_CHARS);
  assert.equal(json.chars, "I am Alex.".length);
  assert.equal(json.over_cap, undefined);
  assert.match(json.etag, /^"[0-9a-f]{64}"$/);
});

test("only canonical, pinned, live memories with both tags are included", async () => {
  const app = await createApp();
  const ok = await addCapsule(app, "identity", "kept");
  const notCanonical = (await post(app, "/capture", { content: "active one", tags: ["capsule:core", "capsule-slot:identity"] })).json.id;
  await post(app, "/capture", { content: "no slot tag", tags: ["capsule:core", "status:canonical"] });
  await post(app, "/capture", { content: "no core tag", tags: ["capsule-slot:identity", "status:canonical"] });
  await post(app, "/capture", { content: "plain canonical", tags: ["status:canonical"] });
  const gone = await addCapsule(app, "preferences", "to be forgotten");
  await post(app, "/forget", { id: gone });
  const { json } = await capsule(app);
  assert.deepEqual(json.sections.map((s) => s.source_id), [ok]);
  assert.ok(notCanonical);
});

test("the etag is stable between reads and changes when content, slot or membership changes", async () => {
  const app = await createApp();
  const a = await addCapsule(app, "identity", "one");
  const e1 = (await capsule(app)).json.etag;
  assert.equal((await capsule(app)).json.etag, e1);
  assert.equal((await capsule(app)).headers.get("etag"), e1);
  await post(app, "/update", { id: a, content: "---\nname: identity-note\ndescription: x\n---\ntwo", tags: ["capsule:core", "capsule-slot:identity", "status:canonical"] });
  const e2 = (await capsule(app)).json.etag;
  assert.notEqual(e2, e1);
  await addCapsule(app, "principles", "more");
  assert.notEqual((await capsule(app)).json.etag, e2);
  assert.equal(await etagOf([{ slot: "a", source_id: "1", content: "x" }]), await etagOf([{ slot: "a", source_id: "1", content: "x" }]));
  assert.notEqual(await etagOf([{ slot: "a", source_id: "1", content: "x" }]), await etagOf([{ slot: "a", source_id: "2", content: "x" }]));
});

test("an etag does not change when only an unrelated memory changes", async () => {
  const app = await createApp();
  await addCapsule(app, "identity", "one");
  const e1 = (await capsule(app)).json.etag;
  const other = (await post(app, "/capture", { content: "unrelated" })).json.id;
  await post(app, "/append", { id: other, addition: "more" });
  assert.equal((await capsule(app)).json.etag, e1);
});

test("If-None-Match gives a 304 with no body, a different etag gives the capsule", async () => {
  const app = await createApp();
  await addCapsule(app, "identity", "one");
  const etag = (await capsule(app)).headers.get("etag");
  const conditional = (value) => raw(app, "/prompt-capsules/core", { token: ADMIN_TOKEN, jwt: app.serviceJwt(), headers: { "if-none-match": value } });
  for (const header of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
    const hit = await conditional(header);
    assert.equal(hit.status, 304, header);
    assert.equal(await hit.text(), "");
    assert.equal(hit.headers.get("etag"), etag);
  }
  const miss = await conditional('"something-else"');
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).sections.length, 1);
});

test("the cache is used, and each kind of change rebuilds it", async () => {
  const app = await createApp();
  const id = await addCapsule(app, "identity", "one");
  assert.equal((await capsule(app)).json.sections[0].content, "one");
  const cached = await app.env.DB.prepare("SELECT built_at FROM capsule_cache WHERE id = 1").first();
  assert.ok(cached);
  // a change made behind the Worker's back is not seen, which proves the read came from the cache
  await app.env.DB.prepare("UPDATE memories SET body = 'sneaky' WHERE id = ?").bind(id).run();
  assert.equal((await capsule(app)).json.sections[0].content, "one");

  const content = (t) => `---\nname: identity-note\ndescription: x\n---\n${t}`;
  const tags = ["capsule:core", "capsule-slot:identity", "status:canonical"];
  const steps = [
    ["update", () => post(app, "/update", { id, content: content("two"), tags }), "two"],
    ["append", () => post(app, "/append", { id, addition: "three" }), "two\n\nthree"],
    ["undo", () => post(app, "/undo", { id }), "two"],
    ["status away", () => post(app, "/status", { id, status: "active" }), null],
    ["status back", () => post(app, "/status", { id, status: "canonical" }), "two"],
    ["forget", () => post(app, "/forget", { id }), null],
    ["restore", () => post(app, "/restore", { id }), "two"],
    ["tag removed", () => post(app, "/update", { id, content: content("two"), tags: ["capsule-slot:identity", "status:canonical"] }), null],
    ["tag added back", () => post(app, "/update", { id, content: content("four"), tags }), "four"],
  ];
  for (const [name, run, expected] of steps) {
    const r = await run();
    assert.equal(r.status, 200, `${name} ${JSON.stringify(r.json)}`);
    const sections = (await capsule(app)).json.sections;
    assert.equal(sections[0]?.content ?? null, expected, name);
  }
  // creating a new capsule memory rebuilds too
  await addCapsule(app, "preferences", "new");
  assert.deepEqual((await capsule(app)).json.sections.map((s) => s.slot), ["identity", "preferences"]);
});

test("a write to another memory leaves the cache alone", async () => {
  const app = await createApp();
  await addCapsule(app, "identity", "one");
  await capsule(app);
  const other = (await post(app, "/capture", { content: "other" })).json.id;
  await post(app, "/update", { id: other, content: "other changed" });
  assert.ok(await app.env.DB.prepare("SELECT 1 AS x FROM capsule_cache WHERE id = 1").first());
});

test("a rebuild that raced with a capsule write is not stored", async () => {
  const app = await createApp();
  const id = await addCapsule(app, "identity", "one");
  const { getCapsule, onChange } = await import("../capsule.js");
  const db = app.env.DB;
  // a capsule write lands right after the build has read the memories and before it stores the cache
  const racing = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM memories m")) return statement;
      return { all: async () => { const rows = await statement.all(); await onChange(db, [id]); return rows; } };
    },
  };
  await getCapsule(racing, () => app.clock.t);
  assert.equal(await db.prepare("SELECT 1 AS x FROM capsule_cache WHERE id = 1").first(), null);
  assert.equal((await getCapsule(db, () => app.clock.t)).sections.length, 1);
  assert.ok(await db.prepare("SELECT 1 AS x FROM capsule_cache WHERE id = 1").first());
});

test("a rebuild that raced with the removal of capsule:core is not stored, and the next read has no such section", async () => {
  const app = await createApp();
  const id = await addCapsule(app, "identity", "one");
  const { getCapsule, onChange } = await import("../capsule.js");
  const db = app.env.DB;
  // the tag goes after the build has read the memories and before it stores the cache, so the build still holds the section
  const racing = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM memories m")) return statement;
      return {
        all: async () => {
          const rows = await statement.all();
          await db.prepare("DELETE FROM memory_tags WHERE memory_id = ? AND tag = 'capsule:core'").bind(id).run();
          await onChange(db, [id]);
          return rows;
        },
      };
    },
  };
  assert.equal((await getCapsule(racing, () => app.clock.t)).sections.length, 1, "the racing build still has the section");
  assert.equal(await db.prepare("SELECT 1 AS x FROM capsule_cache WHERE id = 1").first(), null, "and it is not stored");
  assert.deepEqual((await getCapsule(db, () => app.clock.t)).sections, [], "the next read does not have it");
});

test("over 9,500 characters the reply still works and carries a warning", async () => {
  const app = await createApp();
  await addCapsule(app, "identity", "a".repeat(7000));
  const ok = await capsule(app);
  assert.equal(ok.json.over_cap, undefined);
  await addCapsule(app, "principles", "b".repeat(2501));
  const over = await capsule(app);
  assert.equal(over.status, 200);
  assert.equal(over.json.over_cap, true);
  assert.equal(over.json.chars, 9501);
  assert.match(over.json.warning, /9501 characters, over the 9500 limit/);
  assert.equal(over.json.sections.length, 2);
});

test("an empty store gives an empty capsule", async () => {
  const app = await createApp();
  const { status, json } = await capsule(app);
  assert.equal(status, 200);
  assert.deepEqual([json.sections, json.chars], [[], 0]);
});

test("auth: no token is a 401, a device token and an allowed browser login can read it, a stranger cannot", async () => {
  const app = await createApp();
  await addCapsule(app, "identity", "one");
  assert.equal((await capsule(app, { token: null })).status, 401);
  const { token } = (await post(app, "/devices", { label: "laptop" })).json;
  assert.equal((await capsule(app, { token })).status, 200);
  assert.equal((await capsule(app, { token: null, jwt: app.browserJwt("me@example.com") })).status, 200);
  assert.equal((await capsule(app, { token: null, jwt: app.browserJwt("stranger@example.com") })).status, 403);
  assert.equal((await post(app, "/prompt-capsules/core", {})).status, 405);
});

test("reading the capsule is audited with the source ids", async () => {
  const app = await createApp();
  const id = await addCapsule(app, "identity", "one");
  await capsule(app);
  const rows = (await app.call("/audit?route=/prompt-capsules/core")).json.entries;
  assert.deepEqual(rows[0].memory_ids, [id]);
});
