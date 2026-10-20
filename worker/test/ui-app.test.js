// The page script (ui/app.js) with the fake DOM and a fake Worker: an address mounts the screen it names, an unknown address is Home,
// an old address lands on Memories, and a memory address opens the drawer on it. One file, because app.js runs when it is imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, Event, installDom } from "./helpers/dom.js";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const EMPTY_HOME = {
  ok: true,
  now: NOW,
  owner: null,
  headline: { live: 0, added_week: 0, added_prev: 0, recalled_week: 0, recall_calls_week: 0, recall_calls_prev: 0, closed_week: 0, closed_prev: 0 },
  nav: { live: 0, trash: 0, pending: 0, activity_week: 0, capsule_chars: null, capsule_cap: 9500, attention: 0, unvectorized: 0 },
  checks: [],
  summary: { attention: 0, worst: "ok" },
};

/** Answers for every route a screen may ask for on its first draw. Anything else is a missing route. */
const ANSWERS = {
  "/ui/api/home": () => EMPTY_HOME,
  "/ui/api/growth": () => ({ ok: true, days: 30, bucket: "day", origins: [], buckets: [], total: 0 }),
  "/ui/api/recalls": () => ({ ok: true, days: [], total: 0, empty: 0, by_harness: [], most_recalled: [], never_recalled: { count: 0, sample: [] } }),
  "/ui/api/probation": () => ({ ok: true, total: 0, entries: [] }),
  "/ui/api/harnesses": () => ({ ok: true, sources: { total: 0, rows: [] }, recalls: { total: 0, empty: 0, by_harness: [] }, used: { since: null, total: 0, by_harness: [] }, outcomes: { since: null, windows: [], by_harness: [] } }),
  "/ui/api/sources": () => ({ ok: true, sources: { total: 0, rows: [] } }),
  "/ui/api/audit-facets": () => ({ ok: true, days: 14, harnesses: [], routes: [], per_day: [] }),
  "/ui/api/activity": () => ({ ok: true, entries: [], next_cursor: null, last_30_days: { replaced: 0, merged: 0, retired: 0 }, purge_soon: 0 }),
  "/ui/api/trash": () => ({ ok: true, window_days: 14, entries: [], shown: 0, matching: 0, total: 0, soon: 0, older: 0, projects: [] }),
  "/ui/api/people": () => ({ ok: true, profile: [], people: [], pending: [], pending_total: 0 }),
  "/ui/api/token-expiry": () => ({ ok: true, configured: false }),
  "/ui/api/usage": () => ({ ok: true, plan: { plan: "x", checked: "x" }, db: { size_bytes: null, limit_bytes: 1 }, vectors: null, write_limit: { limit: 40, window_minutes: 10, tokens: [] }, days: [] }),
  "/ui/api/runs": () => ({ ok: true, runs: [] }),
  "/ui/api/overview": () => ({ ok: true, count: 0, pending: 0, trash: 0, by_status: {}, by_origin: {}, by_kind: {}, by_project: {} }),
  "/prompt-capsules/core": () => ({ sections: [], chars: 0, cap: 9500, over_cap: false, etag: "x" }),
  "/backup": () => ({ ok: true, backups: [] }),
  "/list": () => ({ entries: [], next_cursor: null }),
  "/health": () => ({ version: "2.0.2" }),
  "/entry": (path) => ({ ok: true, entry: { id: new URL(`http://x${path}`).searchParams.get("id"), name: "a-note", content: "---\nname: a-note\n---\nText.", tags: [], origin: "explicit", harness: "", status: "active", project: "", type: "", kind: "semantic", pinned: 0, recall_count: 0, last_recalled_at: null, valid_from: NOW, valid_until: null, created_at: NOW, updated_at: NOW, deleted_at: null, superseded_by: null } }),
  "/subjects": () => ({ ok: true, subjects: [{ id: "c1", slug: "pip", kind: "pet", status: "active", scope: "shared", name: "Pip", aliases: [], fields: {}, member_count: 1, updated_at: NOW }] }),
  "/subject": () => ({ ok: true, subject: { id: "c1", slug: "pip", kind: "pet", status: "active", scope: "shared", name: "Pip", aliases: [], fields: {}, member_count: 1, updated_at: NOW, created_at: NOW, brief: "A small dog.", members: [{ id: "a1", name: "pip-vet", updated_at: NOW }] } }),
  "/links": () => ({ ok: true, links: [] }),
  "/history": () => ({ ok: true, versions: [] }),
  "/ui/api/memory-extras": () => ({ ok: true, probation_until: null, purge_at: null, links: [], recalled_by: [], recall_log_since: null }),
};

const reply = (data) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => data });
const missing = () => ({ ok: false, status: 404, headers: { get: () => "application/json" }, json: async () => ({ code: "not_found", error: "No such route in this test." }) });

test("the page script mounts the screen each address names, and an unknown address is Home", async () => {
  const doc = installDom(createDocument());
  doc.body.innerHTML = [
    '<aside id="side"><ul id="nav"></ul><button id="close-nav"></button></aside>',
    '<div id="scrim" hidden></div><button id="open-nav" aria-expanded="false"></button>',
    '<main id="main" tabindex="-1"></main><span id="kbd-hint"></span><div id="theme"></div><div id="colophon"></div>',
    '<dialog id="palette"><input id="palette-input"><ul id="palette-list"></ul></dialog>',
    '<dialog id="remember"><div id="remember-body"></div></dialog><span id="bar-title"></span><div id="toasts"></div>',
  ].join("");
  globalThis.fetch = async (path) => {
    const key = Object.keys(ANSWERS).filter((k) => String(path).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return key ? reply(ANSWERS[key](String(path))) : missing();
  };
  globalThis.history = { replaceState: (_state, _title, url) => (globalThis.location.hash = url) };
  await import("../ui/app.js");
  await flush();
  const main = doc.getElementById("main");
  const screen = () => main.querySelector("section")?.getAttribute("class");
  const go = async (hash) => {
    globalThis.location.hash = hash;
    dispatchEvent(new Event("hashchange"));
    await flush();
  };

  assert.equal(screen(), "screen screen--home", "the empty address is Home");
  assert.equal(doc.title, "Home, anymem");
  await go("#/trash");
  assert.equal(screen(), "screen screen--trash");
  assert.equal(doc.title, "Trash, anymem");
  await go("#/nope");
  assert.equal(screen(), "screen screen--home", "an unknown address is Home");
  await go("#/browse/a1");
  assert.equal(screen(), "screen screen--memories", "an old address lands on Memories");
  assert.equal(globalThis.location.hash, "#/memories/a1", "and its address is brought up to date");
  assert.ok(main.querySelector(".mem__panel")?.getAttribute("role") === "dialog", "the memory in it opens in the drawer");
  await go("#/memories/a2");
  assert.equal(screen(), "screen screen--memories", "a memory address on the same screen keeps the screen");
  assert.match(main.querySelector(".mem__panel").textContent, /a-note/);
  await go("#/subjects");
  assert.equal(screen(), "screen screen--subjects", "Subjects is a screen");
  assert.equal(doc.title, "Subjects, anymem");
  assert.match(main.textContent, /Pip/, "the subject is in the table");
  assert.equal(doc.getElementById("nav").querySelector('a[data-screen="subjects"]').textContent, "Subjects", "and in the sidebar");
  await go("#/subjects?subject=pip");
  assert.equal(screen(), "screen screen--subjects", "a subject address keeps the screen");
  assert.match(main.querySelector('.mem__panel[aria-label="Subject"]').textContent, /A small dog\./, "and opens the subject in its drawer");
  const member = main.querySelector('.mem__panel a[href="#/memories/a1"]');
  assert.ok(member, "a member links to its memory");
  member.dispatchEvent(new Event("click"));
  assert.equal(globalThis.location.hash, "#/subjects/a1?subject=pip", "a memory link on Subjects opens the memory drawer there, with the subject kept");
});
