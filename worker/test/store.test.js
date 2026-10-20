import { test } from "node:test";
import assert from "node:assert/strict";
import { START } from "./helpers/app.js";
import { newStore } from "./helpers/memories.js";
import { TRASH_WINDOW_MS } from "../memory/store.js";

const DAY = 24 * 60 * 60 * 1000;
const rejects = (p, status, code) => assert.rejects(p, (e) => e.status === status && (!code || e.code === code), `want ${status} ${code ?? ""}`);

test("create then get round trips every field", async () => {
  const { add, store, clock } = await newStore();
  const made = await add("---\nname: Tea order\ndescription: Office tea\nmetadata:\n  type: reference\n---\nBlack tea. #kitchen", ["Extra", "project:demo", "kind:semantic"], { harness: "claude", session: "s1" });
  assert.match(made.id, /^[0-9a-f-]{36}$/);
  const got = await store.get(made.id);
  assert.deepEqual(got, made);
  assert.deepEqual(
    { name: got.name, description: got.description, type: got.type, tags: got.tags, status: got.status, origin: got.origin, harness: got.harness, session: got.session, project: got.project, kind: got.kind, pinned: got.pinned },
    { name: "Tea order", description: "Office tea", type: "reference", tags: ["extra", "kitchen"], status: "active", origin: "explicit", harness: "claude", session: "s1", project: "demo", kind: "semantic", pinned: false },
  );
  assert.equal(got.valid_from, clock.t);
  assert.equal(got.created_at, clock.t);
  assert.equal(got.recall_count, 0);
  assert.equal(got.deleted_at, null);
  assert.equal(await store.get("missing"), null);
  assert.equal((await add("no frontmatter")).name, "");
});

test("create validates origin, status and kind", async () => {
  const { add } = await newStore();
  await rejects(add("x", [], { origin: "nope" }), 400);
  await rejects(add("x", [], { status: "draft" }), 400);
  await rejects(add("x", [], { kind: "weird" }), 400);
});

test("pinned comes from capsule tags and from profile and person origins", async () => {
  const { add, store } = await newStore();
  assert.equal((await add("a", ["capsule:core"])).pinned, true);
  assert.equal((await add("b", ["capsule-slot:identity"])).pinned, true);
  assert.equal((await add("c", [], { origin: "profile" })).pinned, true);
  assert.equal((await add("d", [], { origin: "person" })).pinned, true);
  assert.equal((await add("e")).pinned, false);
  const e = await add("f");
  assert.equal((await store.update({ id: e.id, tags: ["capsule:core"] })).pinned, true);
  assert.equal((await store.update({ id: e.id, tags: ["other"] })).pinned, false);
});

test("update writes a version and changes row, tags and hash", async () => {
  const { add, store, clock, db } = await newStore();
  const m = await add("first text", ["a", "b"]);
  clock.t += 1000;
  const u = await store.update({ id: m.id, content: "second text #c", tags: ["b", "status:canonical"] });
  assert.equal(u.content, "second text #c");
  assert.deepEqual(u.tags, ["b", "c"]);
  assert.equal(u.status, "canonical");
  assert.equal(u.updated_at, clock.t);
  const now = (await db.prepare("SELECT content_hash FROM memories WHERE id = ?").bind(m.id).first()).content_hash;
  const before = JSON.parse((await db.prepare("SELECT snapshot FROM memory_versions WHERE memory_id = ?").bind(m.id).first()).snapshot).content_hash;
  assert.match(now, /^[0-9a-f]{64}$/);
  assert.notEqual(now, before);
  const hist = await store.history(m.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].reason, "update");
  const old = await store.getVersion(m.id, 1);
  assert.equal(old.content, "first text");
  assert.deepEqual(old.tags, ["a", "b"]);
  assert.equal(old.version, 1);
  assert.equal(await store.getVersion(m.id, 2), null);
});

test("update with nothing different writes no version, tags left out are kept", async () => {
  const { add, store } = await newStore();
  const m = await add("same", ["keep"]);
  const same = await store.update({ id: m.id, content: "same" });
  assert.deepEqual(same, m);
  assert.deepEqual(await store.history(m.id), []);
  const c = await store.update({ id: m.id, content: "changed" });
  assert.deepEqual(c.tags, ["keep"]);
  await rejects(store.update({ id: "missing", content: "x" }), 404);
});

test("updated_at moves forward even inside one millisecond", async () => {
  const { add, store } = await newStore();
  const m = await add("a");
  const u1 = await store.update({ id: m.id, content: "b" });
  const u2 = await store.update({ id: m.id, content: "c" });
  assert.ok(u1.updated_at > m.updated_at && u2.updated_at > u1.updated_at);
});

test("compare and set refuses a stale if_updated_at with a 409", async () => {
  const { add, store, clock } = await newStore();
  const m = await add("v1");
  clock.t += 10;
  const u = await store.update({ id: m.id, content: "v2", ifUpdatedAt: m.updated_at });
  await rejects(store.update({ id: m.id, content: "v3", ifUpdatedAt: m.updated_at }), 409, "stale_update");
  assert.equal((await store.get(m.id)).content, "v2");
  assert.equal((await store.update({ id: m.id, content: "v3", ifUpdatedAt: u.updated_at })).content, "v3");
});

test("two racing updates with the same if_updated_at, exactly one wins", async () => {
  const { add, store, db } = await newStore();
  const m = await add("base");
  const results = await Promise.allSettled([
    store.update({ id: m.id, content: "from A", ifUpdatedAt: m.updated_at }),
    store.update({ id: m.id, content: "from B", ifUpdatedAt: m.updated_at }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const loser = results.find((r) => r.status === "rejected");
  assert.equal(loser.reason.status, 409);
  const winner = results.find((r) => r.status === "fulfilled").value;
  assert.equal((await store.get(m.id)).content, winner.content);
  assert.equal((await store.history(m.id)).length, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id = ?").bind(m.id).first()).n, 1);
});

test("a race without if_updated_at is caught by the version number and rolls back whole", async () => {
  const { add, store, db } = await newStore();
  const m = await add("base", ["t"]);
  const results = await Promise.allSettled([store.append(m.id, "one"), store.append(m.id, "two")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "lost_race");
  const row = await store.get(m.id);
  assert.match(row.content, /^base\n\n(one|two)$/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?").bind(m.id).first()).n, 1);
});

test("append adds text after a blank line, keeps the old content in a version", async () => {
  const { add, store } = await newStore();
  const m = await add("line one", ["a"]);
  const a = await store.append(m.id, "  line two #newtag  ");
  assert.equal(a.content, "line one\n\nline two #newtag");
  assert.deepEqual(a.tags, ["a", "newtag"]);
  assert.equal((await store.history(m.id))[0].reason, "append");
  assert.equal((await store.getVersion(m.id, 1)).content, "line one");
  await rejects(store.append(m.id, "   "), 400);
  await rejects(store.append(m.id, undefined), 400);
  await rejects(store.append("missing", "x"), 404);
  const big = await add("b".repeat(29_990));
  await rejects(store.append(big.id, "c".repeat(50)), 413);
});

test("status changes write a version and a repeat changes nothing", async () => {
  const { add, store } = await newStore();
  const m = await add("x");
  const d = await store.setStatus(m.id, "deprecated");
  assert.equal(d.status, "deprecated");
  assert.equal((await store.setStatus(m.id, "deprecated")).updated_at, d.updated_at);
  const hist = await store.history(m.id);
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].reason, hist[0].summary], ["status", "status active to deprecated"]);
  await rejects(store.setStatus(m.id, "draft"), 400);
  await rejects(store.setStatus("missing", "active"), 404);
  assert.equal((await store.setStatus(m.id, "pending")).status, "pending");
});

test("soft delete hides the memory from get and list, keeps the rows, and the trash shows it", async () => {
  const { add, store, db, clock, ftsHits } = await newStore();
  const m = await add("quiet gardens", ["t1"]);
  await add("other memory");
  clock.t += 5;
  const gone = await store.softDelete(m.id);
  assert.equal(gone.deleted_at, clock.t);
  assert.equal(await store.get(m.id), null);
  assert.equal((await store.get(m.id, { trash: true })).id, m.id);
  assert.equal((await store.list()).entries.length, 1);
  assert.deepEqual((await store.list({ trash: true })).entries.map((e) => e.id), [m.id]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").bind(m.id).first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_tags WHERE memory_id = ?").bind(m.id).first()).n, 1);
  assert.deepEqual(await ftsHits("quiet gardens"), []);
  assert.equal((await store.softDelete(m.id)).deleted_at, gone.deleted_at);
  assert.equal((await store.history(m.id)).length, 1);
  await rejects(store.softDelete("missing"), 404);
});

test("restore works inside 14 days and is refused after", async () => {
  const { add, store, clock, ftsHits } = await newStore();
  const a = await add("restorable thing");
  const b = await add("late thing");
  await store.softDelete(a.id);
  await store.softDelete(b.id);
  clock.t += TRASH_WINDOW_MS - 1000;
  const back = await store.restore(a.id);
  assert.equal(back.deleted_at, null);
  assert.equal((await store.get(a.id)).id, a.id);
  assert.deepEqual(await ftsHits("restorable thing"), [a.id]);
  clock.t += 2000;
  await rejects(store.restore(b.id), 410, "restore_window_passed");
  assert.equal(await store.get(b.id), null);
  await rejects(store.restore(a.id), 409, "not_in_trash");
  await rejects(store.restore("missing"), 404);
});

test("history is newest first with a short diff summary", async () => {
  const { add, store, clock } = await newStore();
  const m = await add("abcd", ["a"]);
  clock.t += 10;
  await store.update({ id: m.id, content: "abcdefgh", tags: ["b"] });
  clock.t += 10;
  await store.setStatus(m.id, "canonical");
  clock.t += 10;
  await store.softDelete(m.id);
  const h = await store.history(m.id);
  assert.deepEqual(h.map((v) => [v.seq, v.reason]), [[3, "forget"], [2, "status"], [1, "update"]]);
  assert.deepEqual(h.map((v) => v.summary), ["moved to trash", "status active to canonical", "content +4 chars, tags +b, tags -a"]);
  assert.ok(h[0].at > h[2].at);
  assert.equal(await store.history("missing"), null);
});

test("undo goes back one step and a second undo flips forward again", async () => {
  const { add, store } = await newStore();
  const m = await add("original", ["one"]);
  await store.update({ id: m.id, content: "edited", tags: ["two"] });
  const u1 = await store.undo(m.id);
  assert.equal(u1.content, "original");
  assert.deepEqual(u1.tags, ["one"]);
  assert.equal((await store.history(m.id))[0].reason, "undo");
  const u2 = await store.undo(m.id);
  assert.equal(u2.content, "edited");
  assert.deepEqual(u2.tags, ["two"]);
  assert.equal((await store.undo(m.id)).content, "original");
  assert.equal((await store.history(m.id)).length, 4);
});

test("undo keeps counters and provenance, and tells the truth when there is nothing to undo", async () => {
  const { add, store, db } = await newStore();
  const m = await add("a", [], { harness: "codex" });
  await rejects(store.undo(m.id), 409, "nothing_to_undo");
  await rejects(store.undo("missing"), 404);
  await store.update({ id: m.id, content: "b" });
  await db.prepare("UPDATE memories SET recall_count = 7 WHERE id = ?").bind(m.id).run();
  const u = await store.undo(m.id);
  assert.deepEqual([u.recall_count, u.harness, u.created_at], [7, "codex", m.created_at]);
});

test("undo of a forget brings the memory back, unless the trash window has passed", async () => {
  const { add, store, clock } = await newStore();
  const a = await add("alpha");
  const b = await add("beta");
  await store.softDelete(a.id);
  await store.softDelete(b.id);
  assert.equal((await store.undo(a.id)).deleted_at, null);
  clock.t += 15 * DAY;
  await rejects(store.undo(b.id), 410);
});

test("supersede closes the old memory and writes a version, undo reopens it", async () => {
  const { add, store, clock, db } = await newStore();
  const old = await add("old fact", ["t"]);
  const next = await add("new fact");
  clock.t += 100;
  const closed = await store.supersede(old.id, next.id, clock.t);
  assert.equal(closed.valid_until, clock.t);
  assert.equal(closed.superseded_by, next.id);
  assert.deepEqual((await store.history(old.id)).map((v) => [v.reason, v.summary]), [["supersede", "closed"]]);
  assert.deepEqual((await store.list()).entries.map((e) => e.id), [next.id]);
  await rejects(store.supersede(old.id, next.id, clock.t), 409, "already_closed");
  await rejects(store.supersede(old.id, old.id, clock.t), 400);
  await rejects(store.supersede(next.id, "missing", clock.t), 404);
  const reopened = await store.undo(old.id);
  assert.equal(reopened.valid_until, null);
  assert.equal(reopened.superseded_by, null);
  assert.equal((await store.list()).entries.length, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?").bind(old.id).first()).n, 2);
  assert.equal((await store.history(old.id))[0].summary, "reopened");
});

test("link creates once and dedupes, and checks both ends", async () => {
  const { add, store } = await newStore();
  const a = await add("a");
  const b = await add("b");
  assert.deepEqual(await store.link(a.id, b.id, "About_Person"), { created: true });
  assert.deepEqual(await store.link(a.id, b.id, "about_person"), { created: false });
  assert.deepEqual(await store.link(b.id, a.id, "about_person"), { created: true });
  assert.deepEqual(await store.link(a.id, b.id, "other"), { created: true });
  await rejects(store.link(a.id, "missing", "x"), 404);
  await rejects(store.link(a.id, a.id, "x"), 400);
  await rejects(store.link(a.id, b.id, "bad type"), 400);
  await rejects(store.link(a.id, b.id, undefined), 400);
  await store.softDelete(b.id);
  await rejects(store.link(a.id, b.id, "late"), 404);
});

test("list filters", async () => {
  const { add, store, clock, db } = await newStore();
  const ids = {};
  const make = async (key, content, tags, extra) => {
    clock.t += 1000;
    ids[key] = (await add(content, tags, extra)).id;
  };
  await make("a", "---\nname: A\nmetadata:\n  type: user\n---\nalpha", ["red", "blue", "project:p1"], { origin: "capture" });
  await make("b", "beta", ["red", "status:canonical"]);
  await make("c", "gamma", ["blue", "status:pending"], { origin: "profile" });
  await make("d", "delta", ["red", "blue"]);
  await store.setStatus(ids.d, "deprecated");
  for (const [k, n] of Object.entries({ a: 5, b: 3, c: 0, d: 1 })) await db.prepare("UPDATE memories SET recall_count = ? WHERE id = ?").bind(n, ids[k]).run();
  const q = async (f) => (await store.list(f)).entries.map((e) => Object.keys(ids).find((k) => ids[k] === e.id)).join("");
  assert.equal(await q({}), "dcba");
  assert.equal(await q({ tags: ["red"] }), "dba");
  assert.equal(await q({ tags: ["red", "blue"] }), "da");
  assert.equal(await q({ tags: ["red", "blue", "none"] }), "");
  assert.equal(await q({ status: "pending" }), "c");
  assert.equal(await q({ status: "canonical" }), "b");
  assert.equal(await q({ origin: "capture" }), "a");
  assert.equal(await q({ type: "user" }), "a");
  assert.equal(await q({ project: "p1" }), "a");
  assert.equal(await q({ after: START + (2000) }), "dcb");
  assert.equal(await q({ before: START + (3000) }), "ba");
  assert.equal(await q({ after: START + (2000), before: START + (4000) }), "cb");
  assert.equal(await q({ minRecalls: 3 }), "ba");
  assert.equal(await q({ maxRecalls: 1 }), "dc");
  assert.equal(await q({ n: 2 }), "dc");
  const withTags = (await store.list({ tags: ["red", "blue"] })).entries;
  assert.deepEqual(withTags[0].tags, ["blue", "red"]);
  assert.equal(withTags[0].content, "delta");
});

test("cursor paging gives every memory once with no gaps, including equal timestamps", async () => {
  const { add, store, clock } = await newStore();
  const made = [];
  for (let i = 0; i < 23; i++) {
    if (i % 4 === 0) clock.t += 1; // groups of four share a created_at
    made.push((await add(`memory number ${i}`)).id);
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.list({ n: 5, cursor });
    seen.push(...page.entries.map((e) => e.id));
    cursor = page.next_cursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(pages, 5);
  assert.equal(seen.length, 23);
  assert.deepEqual([...seen].sort(), [...made].sort());
  assert.equal(new Set(seen).size, 23);
  const exact = await store.list({ n: 23 });
  assert.equal(exact.next_cursor, null);
  await rejects(store.list({ cursor: "!!!" }), 400, "bad_cursor");
  await rejects(store.list({ cursor: btoa("[1]") }), 400, "bad_cursor");
});

test("the keyword index follows create, update, forget and restore", async () => {
  const { add, store, ftsHits, db } = await newStore();
  const m = await add("---\nname: Pelican notes\ndescription: coastal birds\n---\nThe pelican dives for fish.");
  assert.deepEqual(await ftsHits("pelican dives"), [m.id]);
  assert.deepEqual(await ftsHits("Pelican notes"), [m.id]);
  assert.deepEqual(await ftsHits("coastal birds"), [m.id]);
  await store.update({ id: m.id, content: "The heron wades in shallows." });
  assert.deepEqual(await ftsHits("pelican dives"), []);
  assert.deepEqual(await ftsHits("heron wades"), [m.id]);
  await store.append(m.id, "Also a kingfisher.");
  assert.deepEqual(await ftsHits("kingfisher"), [m.id]);
  await store.undo(m.id);
  assert.deepEqual(await ftsHits("kingfisher"), []);
  await store.softDelete(m.id);
  assert.deepEqual(await ftsHits("heron wades"), []);
  await store.restore(m.id);
  assert.deepEqual(await ftsHits("heron wades"), [m.id]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id = ?").bind(m.id).first()).n, 1);
});

test("the keyword index includes search keys when they exist", async () => {
  const { add, store, db, ftsHits } = await newStore();
  const m = await add("plain body text");
  await db.prepare("INSERT INTO memory_keys (memory_id, key_type, text, created_at) VALUES (?, 'question', 'what about zebras', 1)").bind(m.id).run();
  await store.setStatus(m.id, "deprecated");
  assert.deepEqual(await ftsHits("zebras"), [m.id]);
});
