// Holes an independent review found in the private rule, each pinned by a test. All sample text is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appWith, note } from "./helpers/search.js";
import { device, wire, addSubject, about } from "./helpers/subjects.js";
import { runNightly } from "./helpers/maintenance.js";
import { recallSubject } from "../search/recall.js";

const SAMPLE = [
  note("vet-visit", "The vet visit", "Pip saw the vet about a limp"),
  note("garden-plan", "The garden plan", "Pip digs up the Cottage garden"),
  note("roof-repair", "The roof repair", "The Cottage roof needs new tiles"),
  note("tax-note", "A tax note", "Nothing about any subject"),
];

async function world() {
  const { app, ids } = await appWith(SAMPLE);
  const w = await wire(app, ids);
  return { app, w, closed: await device(app, { allowPrivate: false }) };
}
const call = (app, path, d, body) => app.call(path, { method: body ? "POST" : "GET", token: d.token, body });

test("paging a device's list one row at a time never names a hidden memory in a cursor", async () => {
  const { app, w, closed } = await world();
  const seen = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const res = (await call(app, `/list?n=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, closed)).json;
    seen.push(...res.entries.map((e) => e.id));
    if (res.next_cursor) {
      const named = Buffer.from(res.next_cursor, "base64").toString();
      assert.ok(!named.includes(w.hidden) && !named.includes(w.pip), "the cursor names a hidden memory");
    }
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  assert.ok(!seen.includes(w.hidden) && !seen.includes(w.pip));
  assert.deepEqual([...seen].sort(), [w.cottage, w.mixed, w.shared, w.plain].sort(), "every visible memory is reached");
});

test("a device cannot link, unlink or change a hidden memory, and gets the 404 of a missing id", async () => {
  const { app, w, closed } = await world();
  const missing = await call(app, "/link", closed, { source_id: "no-such-id", target_id: w.cottage, type: "related" });
  for (const [path, body] of [
    ["/link", { source_id: w.hidden, target_id: w.plain, type: "related" }],
    ["/unlink", { source_id: w.hidden, target_id: w.plain, type: "related" }],
    ["/update", { id: w.hidden, content: "rewritten" }],
    ["/append", { id: w.hidden, addition: "more" }],
    ["/forget", { id: w.hidden }],
  ]) {
    const res = await call(app, path, closed, body);
    assert.equal(res.status, 404, path);
  }
  assert.notEqual(missing.status, 200);
  const bypass = await call(app, "/link", closed, { source_id: w.hidden, target_id: w.cottage, type: "about" });
  assert.equal(bypass.status, 404, "a hidden memory cannot be moved under a shared subject");
  assert.equal((await call(app, `/entry?id=${w.hidden}`, closed)).status, 404, "so it stays hidden");
});

test("a device cannot change a subject card or link to one", async () => {
  const { app, w, closed } = await world();
  for (const [path, body] of [
    ["/update", { id: w.cottage, content: "a new brief" }],
    ["/forget", { id: w.cottage }],
    ["/status", { id: w.cottage, status: "deprecated" }],
    ["/link", { source_id: w.plain, target_id: w.cottage, type: "about" }],
    ["/unlink", { source_id: w.shared, target_id: w.cottage, type: "about" }],
  ]) {
    const res = await call(app, path, closed, body);
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, "admin_only", path);
  }
});

test("a capture from a device does not reveal, match or overwrite a hidden memory", async () => {
  const { app, w, closed } = await world();
  const exact = await call(app, "/capture", closed, { content: note("vet-visit", "The vet visit", "Pip saw the vet about a limp"), origin: "explicit" });
  assert.equal(exact.json.duplicate, undefined, "an exact copy of a hidden memory is not a duplicate for the device, so nothing tells it the text exists");
  assert.equal(exact.json.matchId, undefined, "no id of the hidden memory");
  assert.ok(exact.json.id && exact.json.id !== w.hidden, "it is stored as the device's own memory");
  const same = await call(app, "/capture", closed, { content: note("vet-visit", "The vet visit", "A different text altogether about nothing"), source: "session-capture" });
  assert.equal(same.json.updated, undefined, "the hidden memory is not updated in place");
  assert.ok(same.json.id && same.json.id !== w.hidden);
  const hiddenText = (await app.call(`/entry?id=${w.hidden}`)).json.entry.content;
  assert.match(hiddenText, /limp/, "the hidden memory is as it was");
});

test("the count a device gets leaves out what it cannot see", async () => {
  const { app, closed } = await world();
  const all = (await app.call("/count")).json.count;
  const mine = (await call(app, "/count", closed)).json.count;
  assert.equal(all - mine, 2, "the private card and the memory that is only about it");
});

test("a device cannot read the people list", async () => {
  const { app, closed } = await world();
  const res = await app.call("/ui/api/people", { token: closed.token });
  assert.equal(res.status, 403);
});

test("the card of a private subject that still has members is not purged from the trash", async () => {
  const { app, w } = await world();
  await app.call("/forget", { method: "POST", body: { id: w.pip } });
  app.clock.t += 20 * 24 * 60 * 60 * 1000;
  const out = await runNightly(app, { steps: ["purge_trash"] });
  assert.equal(out.summary.purge_trash.purged, 0);
  const row = await app.env.DB.prepare("SELECT id FROM memories WHERE id = ?").bind(w.pip).first();
  assert.ok(row, "the card is still there, so its members stay private");
  await app.env.DB.prepare("DELETE FROM links WHERE target_id = ?").bind(w.pip).run();
  const again = await runNightly(app, { steps: ["purge_trash"] });
  assert.equal(again.summary.purge_trash.purged, 1, "once the members are unlinked it goes");
});

test("a subject's members are filtered by the rule when read as a list", async () => {
  const { app, w } = await world();
  const closed = await device(app, { allowPrivate: false, label: "phone" });
  // a private-only memory linked to a shared subject by an admin through a card that is itself linked to the shared one
  const nested = await addSubject(app, { slug: "kennel", kind: "asset", name: "the Kennel", scope: "private" });
  await about(app, nested, w.cottage);
  const out = await recallSubject(app.env, { slug: "cottage", topK: 20, actor: { kind: "device", id: closed.id } });
  assert.ok(!out.results.some((r) => r.id === nested), "a private card is not listed as a member of a shared subject");
});

test("an old memory that a hidden memory replaced does not name it", async () => {
  const { app, w, closed } = await world();
  await app.env.DB.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").bind(w.hidden, w.plain).run();
  const entry = (await call(app, `/entry?id=${w.plain}`, closed)).json.entry;
  assert.equal(entry.superseded_by, null);
  const admin = (await app.call(`/entry?id=${w.plain}`)).json.entry;
  assert.equal(admin.superseded_by, w.hidden, "the admin still sees it");
});

test("a secret in a subject's name or an alias is refused like one in the brief", async () => {
  const { app } = await world();
  const key = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const named = await app.call("/subject", { method: "POST", body: { slug: "leaky", kind: "topic", name: `Leaky ${key}` } });
  assert.equal(named.status, 422);
  const aliased = await app.call("/subject", { method: "POST", body: { slug: "leaky2", kind: "topic", name: "Leaky two", aliases: [key] } });
  assert.equal(aliased.status, 422);
});

test("a hidden id and a missing id look the same on every device write", async () => {
  const { app, w, closed } = await world();
  const shape = async (path, body) => {
    const res = await call(app, path, closed, body);
    return [res.status, res.json.error ?? res.json.code ?? null];
  };
  for (const [path, mk] of [
    ["/link", (id) => ({ source_id: id, target_id: w.plain, type: "related" })],
    ["/unlink", (id) => ({ source_id: id, target_id: w.plain, type: "related" })],
    ["/update", (id) => ({ id, content: "a plain edit" })],
    ["/append", (id) => ({ id, addition: "a plain addition" })],
    ["/forget", (id) => ({ id })],
  ]) assert.deepEqual(await shape(path, mk(w.hidden)), await shape(path, mk("no-such-id")), path);
  const secret = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  assert.deepEqual(await shape("/update", { id: w.hidden, content: secret }), await shape("/update", { id: "no-such-id", content: secret }), "the secret screen answers the same for both");
});

test("a trashed memory that a hidden memory replaced does not name it in the trash list", async () => {
  const { app, w, closed } = await world();
  await app.call("/forget", { method: "POST", body: { id: w.plain } });
  await app.env.DB.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").bind(w.hidden, w.plain).run();
  const entry = (await call(app, "/list?deleted=1", closed)).json.entries.find((e) => e.id === w.plain);
  assert.ok(entry);
  assert.equal(entry.superseded_by, null);
});
