// The screens and the drawer run against the fake DOM and a fake Worker: request counters, Load more, the column picks, the drawer as a
// modal dialog, and the routes the screens ask for. A stale answer is one the person has already moved past.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, Event, installDom } from "./helpers/dom.js";
import { ApiError } from "../ui/lib/api.js";
import { mount as auditMount } from "../ui/screens/audit.js";
import { mount as trashMount } from "../ui/screens/trash.js";
import { mount as searchMount } from "../ui/screens/search.js";
import { mount as memoriesMount } from "../ui/screens/memories.js";
import { mount as activityMount } from "../ui/screens/activity.js";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY = 86_400_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test settles by hand, so it can answer requests in any order. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

/** A page with a body and a main, the Worker answered by answers[prefix], and a screen root in the main. */
function world() {
  const doc = installDom(createDocument());
  doc.body.innerHTML = '<aside id="side"></aside><main id="main" tabindex="-1"></main><div id="toasts"></div>';
  const calls = [];
  const answers = {};
  const request = (path, opts = {}) => {
    calls.push({ path, method: opts.method ?? "GET", body: opts.body });
    const key = Object.keys(answers).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) return Promise.reject(new ApiError(404, "not_found", "No such route in this test."));
    return Promise.resolve().then(() => answers[key](path, opts));
  };
  const ctx = { request, now: () => NOW, shell: { refresh: async () => null, openRemember() {}, state: { counts: null } } };
  const root = doc.createElement("section");
  doc.getElementById("main").append(root);
  return { doc, calls, answers, ctx, root };
}

const auditRow = (over = {}) => ({ ts: NOW - 60_000, actor_kind: "device", actor_id: "d1", script: "", method: "GET", route: "/recall", status: 200, memory_ids: [], harness: "claude", harness_label: "Claude Code", ...over });
const facets = () => ({ ok: true, days: 14, harnesses: [], routes: [], per_day: [] });

test("Audit: an answer overtaken by a newer filter never replaces the newer list, and its error is not shown", async () => {
  const w = world();
  const queue = [deferred(), deferred()];
  let asked = 0;
  w.answers["/audit"] = () => queue[asked++].promise;
  w.answers["/ui/api/audit-facets"] = facets;
  const handle = auditMount(w.root, w.ctx, "", {});
  handle.update("", { result: "ok" }); // a newer request, answered first
  queue[1].resolve({ entries: [auditRow({ harness_label: "Newer tool" })], next_cursor: null });
  await flush();
  queue[0].reject(new ApiError(500, "boom", "The overtaken request failed."));
  await flush();
  const status = w.root.querySelector("[data-status]");
  assert.equal(status.textContent, "", "the overtaken failure is not shown");
  assert.equal(status.querySelector('[role="alert"]'), null);
  assert.match(w.root.textContent, /Newer tool/);
});

test("Audit: Load more asks for one page at a time", async () => {
  const w = world();
  const more = deferred();
  w.answers["/audit"] = (path) => (path.includes("cursor=") ? more.promise : { entries: [auditRow()], next_cursor: "c1" });
  w.answers["/ui/api/audit-facets"] = facets;
  auditMount(w.root, w.ctx, "", {});
  await flush();
  const button = w.root.querySelector('[data-action="more"]');
  button.click();
  button.click();
  assert.equal(w.calls.filter((c) => c.path.includes("cursor=c1")).length, 1, "a second click while the page is coming is ignored");
  more.resolve({ entries: [auditRow({ harness_label: "Second page" })], next_cursor: null });
  await flush();
  assert.match(w.root.textContent, /Second page/);
});

test("Trash: a list overtaken by a newer sort never draws over the newer one", async () => {
  const w = world();
  const queue = [deferred(), deferred()];
  let asked = 0;
  const reply = (title) => ({ ok: true, window_days: 14, entries: [{ id: title, title, origin: "capture", project: "", deleted_at: NOW - 2 * DAY, purge_at: NOW + 12 * DAY }], shown: 1, matching: 1, total: 1, soon: 0, older: 0, projects: [] });
  w.answers["/ui/api/trash"] = () => queue[asked++].promise;
  const handle = trashMount(w.root, w.ctx, "", {});
  handle.update("", { sort: "forgotten" });
  queue[1].resolve(reply("Newer note"));
  await flush();
  queue[0].resolve(reply("Stale note"));
  await flush();
  assert.match(w.root.textContent, /Newer note/);
  assert.doesNotMatch(w.root.textContent, /Stale note/);
  assert.match(w.calls.at(-1).path, /sort=forgotten/, "the sort is asked of the Worker");
});

test("Trash: a restore takes the row out and asks again", async () => {
  const w = world();
  const once = [{ ok: true, window_days: 14, entries: [{ id: "a", title: "Back soon", origin: "capture", project: "", deleted_at: NOW - DAY, purge_at: NOW + 13 * DAY }], shown: 1, matching: 1, total: 1, soon: 0, older: 0, projects: [] }];
  w.answers["/ui/api/trash"] = () => (once.length ? once.shift() : { ok: true, window_days: 14, entries: [], shown: 0, matching: 0, total: 0, soon: 0, older: 0, projects: [] });
  w.answers["/restore"] = () => ({ ok: true });
  trashMount(w.root, w.ctx, "", {});
  await flush();
  w.root.querySelector('[data-action="restore-row"]').click();
  await flush();
  assert.ok(w.calls.some((c) => c.path === "/restore" && c.method === "POST" && c.body.id === "a"));
  assert.match(w.root.textContent, /The trash is empty/);
});

test("Search: a search overtaken by a newer prompt does not show its failure", async () => {
  const w = world();
  const queue = [deferred(), deferred()];
  let asked = 0;
  w.answers["/recall"] = () => queue[asked++].promise;
  const handle = searchMount(w.root, w.ctx, "", { q: "an old prompt that is long enough" });
  handle.update("", { q: "a newer prompt that is long enough" });
  queue[1].resolve({ results: [], took_ms: 2, degraded: "" });
  await flush();
  queue[0].reject(new ApiError(500, "boom", "The old search failed."));
  await flush();
  assert.doesNotMatch(w.root.textContent, /The old search failed/);
  assert.match(w.root.textContent, /No hits/);
});

const entry = (over = {}) => ({ id: "m1", name: "otter-facts", description: "", content: "---\nname: otter-facts\n---\nOtters swim.", tags: [], origin: "explicit", harness: "claude", harness_label: "Claude Code", session: "", status: "active", project: "", type: "", kind: "semantic", pinned: 0, recall_count: 0, last_recalled_at: null, valid_from: NOW - DAY, valid_until: null, created_at: NOW - DAY, updated_at: NOW - DAY, deleted_at: null, superseded_by: null, ...over });
const extras = (over = {}) => ({ ok: true, probation_until: null, purge_at: null, links: [], recalled_by: [], recall_log_since: null, ...over });
function memoryWorld(answers = {}) {
  const w = world();
  w.answers["/entry"] = () => ({ ok: true, entry: entry() });
  w.answers["/history"] = () => ({ ok: true, versions: [] });
  w.answers["/ui/api/memory-extras"] = () => extras();
  w.answers["/links"] = () => ({ ok: true, id: "m1", links: [] });
  w.answers["/list"] = () => ({ entries: [], next_cursor: null });
  w.answers["/ui/api/sources"] = () => ({ ok: true, sources: { total: 0, rows: [] } });
  Object.assign(w.answers, answers);
  return w;
}

test("the memory drawer is a modal dialog: the page behind it is inert, Tab stays in it, and closing gives the page back", async () => {
  const w = memoryWorld();
  const handle = memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  const panel = w.root.querySelector(".mem__panel");
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  const side = w.doc.getElementById("side");
  const toasts = w.doc.getElementById("toasts");
  const behind = w.root.querySelector(".mem");
  assert.equal(side.inert, true, "the sidebar is inert while a memory is open");
  assert.equal(behind.inert, true, "the list behind the drawer is inert");
  assert.equal(toasts.inert, false, "the toasts stay live, so Undo can be pressed");
  assert.equal(panel.inert, false, "the drawer itself is not inert");
  const controls = panel.querySelectorAll("a[href], button, input, select, textarea");
  const last = controls.at(-1);
  last.focus();
  const tab = new Event("keydown", { key: "Tab" });
  last.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, "Tab from the last control is held in the drawer");
  assert.equal(w.doc.activeElement, controls[0], "and goes to the first");
  const back = new Event("keydown", { key: "Tab", shiftKey: true });
  controls[0].dispatchEvent(back);
  assert.equal(w.doc.activeElement, last, "Shift Tab from the first goes to the last");
  handle.update("", {});
  assert.equal(side.inert, false, "closing gives the sidebar back");
  assert.equal(behind.inert, false);
});

test("a dialog on the page, such as the palette, is not made inert, because it opens on top of the drawer", async () => {
  const w = memoryWorld();
  const palette = w.doc.createElement("dialog");
  palette.id = "palette";
  w.doc.body.append(palette);
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  assert.equal(w.doc.getElementById("side").inert, true, "the sidebar is inert");
  assert.equal(palette.inert, false, "the palette dialog stays live");
});

test("a route change that replaces the screen under an open drawer gives the page back", async () => {
  const w = memoryWorld();
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  const side = w.doc.getElementById("side");
  assert.equal(side.inert, true);
  w.root.remove();
  dispatchEvent(new Event("hashchange"));
  assert.equal(side.inert, false, "the sidebar is live again once the drawer's screen is gone");
});

test("the drawer shows only the failure of the memory that is open", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  let asked = 0;
  const w = memoryWorld({ "/entry": () => queue[asked++].promise });
  const handle = memoriesMount(w.root, w.ctx, "m1", {});
  handle.update("m2", {});
  second.resolve({ ok: true, entry: entry({ id: "m2", name: "second-note" }) });
  await flush();
  first.reject(new ApiError(500, "boom", "The memory before failed."));
  await flush();
  const msg = w.root.querySelector(".mem__panel [data-msg]");
  assert.equal(msg.textContent, "", "the failure of the memory before is not shown on the one open now");
  assert.match(w.root.querySelector(".mem__panel").textContent, /second-note/);
});

const linkRow = (over = {}) => ({ type: "about", direction: "out", other_id: "m2", other_name: "pip-vet", made_by: "user", confidence: null, created_at: NOW - DAY, ...over });

test("the drawer lists the links from GET /links, grouped by type with the other memory named", async () => {
  const w = memoryWorld({ "/links": () => ({ ok: true, id: "m1", links: [linkRow(), linkRow({ type: "part_of", direction: "in", other_id: "m3", other_name: "alpha-plan", made_by: "system", confidence: 0.7 })] }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  assert.ok(w.calls.some((c) => c.path === "/links?id=m1" && c.method === "GET"));
  const text = w.root.querySelector(".mem__panel").textContent;
  assert.match(text, /Links to pip-vet/);
  assert.match(text, /Linked from alpha-plan/);
  assert.match(text, /70% sure/);
  assert.equal(w.root.querySelectorAll('[data-action="unlink"]').length, 2);
});

test("Not this on a system link posts /unlink with the right ends, then reloads the links", async () => {
  let links = [linkRow({ type: "part_of", direction: "in", other_id: "m3", other_name: "alpha-plan", made_by: "system", confidence: 0.7 })];
  const w = memoryWorld({ "/links": () => ({ ok: true, id: "m1", links }), "/unlink": () => ((links = []), { ok: true, removed: true }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  w.root.querySelector('[data-action="unlink"]').click();
  await flush();
  const call = w.calls.find((c) => c.path === "/unlink");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { source_id: "m3", target_id: "m1", type: "part_of" }, "an incoming link has the other memory as its source");
  const panel = w.root.querySelector(".mem__panel");
  assert.match(panel.textContent, /No links yet/);
  assert.match(panel.textContent, /will not make that link again/);
  assert.equal(w.doc.querySelector("#toasts").childElementCount, 0, "there is no undo for a refusal");
});

test("Remove on a user link posts /unlink and the toast Undo puts the link back", async () => {
  let links = [linkRow()];
  const w = memoryWorld({ "/links": () => ({ ok: true, id: "m1", links }), "/unlink": () => ((links = []), { ok: true, removed: true }), "/link": () => ({ ok: true, created: true }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  w.root.querySelector('[data-action="unlink"]').click();
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/unlink").body, { source_id: "m1", target_id: "m2", type: "about" });
  const undo = w.doc.querySelector("#toasts button");
  assert.ok(undo, "the toast offers Undo");
  undo.click();
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/link").body, { source_id: "m1", target_id: "m2", type: "about" });
});

test("removing a link of an older free text type sends its stored type and offers no undo", async () => {
  const w = memoryWorld({ "/links": () => ({ ok: true, id: "m1", links: [linkRow({ type: "likes-a-lot" })] }), "/unlink": () => ({ ok: true, removed: true }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  assert.match(w.root.querySelector(".mem__panel").textContent, /related/);
  w.root.querySelector('[data-action="unlink"]').click();
  await flush();
  assert.equal(w.calls.find((c) => c.path === "/unlink").body.type, "likes-a-lot");
  assert.equal(w.doc.querySelector("#toasts").childElementCount, 0, "that type cannot be added again, so there is nothing to undo");
});

test("a refused unlink shows the reason and leaves the links as they were", async () => {
  const w = memoryWorld({ "/links": () => ({ ok: true, id: "m1", links: [linkRow()] }), "/unlink": () => Promise.reject(new ApiError(403, "admin_only", "Only the admin can remove that link.")) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  w.root.querySelector('[data-action="unlink"]').click();
  await flush();
  assert.match(w.root.querySelector(".mem__panel").textContent, /Only the admin can remove that link\./);
  assert.match(w.root.querySelector(".mem__panel").textContent, /Links to pip-vet/);
});

test("the Link form sends the chosen type from the closed list", async () => {
  const w = memoryWorld({ "/link": () => ({ ok: true, created: true }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  w.root.querySelector('[data-form-name="link"]').click();
  const form = w.root.querySelector('form[data-form="link"]');
  assert.ok(form.querySelector('select[name="type"]'), "the type is a select");
  form.querySelector('input[name="target"]').value = "m2";
  form.querySelector('select[name="type"]').value = "affects";
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/link").body, { source_id: "m1", target_id: "m2", type: "affects" });
});

test("the column picks: an arrow key only moves the choice, Enter or a click applies it, and a change alone applies nothing", async () => {
  const w = world();
  w.answers["/audit"] = () => ({ entries: [auditRow()], next_cursor: null });
  w.answers["/ui/api/audit-facets"] = facets;
  auditMount(w.root, w.ctx, "", {});
  await flush();
  const radios = w.root.querySelectorAll('input[name="result"]');
  assert.ok(radios.length >= 3, "the result choices are on the page");
  const hashBefore = globalThis.location.hash;
  radios[0].dispatchEvent(new Event("keydown", { key: "ArrowDown" }));
  assert.equal(globalThis.location.hash, hashBefore, "an arrow key does not apply the choice");
  assert.equal(radios[1].checked, true, "it moves the choice");
  assert.equal(w.doc.activeElement, radios[1]);
  radios[1].dispatchEvent(new Event("keydown", { key: "Enter" }));
  assert.notEqual(globalThis.location.hash, hashBefore, "Enter applies it");
  assert.match(globalThis.location.hash, /result=/);
  const applied = globalThis.location.hash;
  radios[2].dispatchEvent(new Event("change"));
  assert.equal(globalThis.location.hash, applied, "a change event alone applies nothing");
  radios[2].click();
  assert.notEqual(globalThis.location.hash, applied, "a click applies it");
});

test("Activity: the Now filter is asked of the Worker, so every page answers it", async () => {
  const w = world();
  w.answers["/ui/api/activity"] = () => ({ ok: true, entries: [], next_cursor: null, last_30_days: { replaced: 0, merged: 0, retired: 0 }, purge_soon: 0 });
  const handle = activityMount(w.root, w.ctx, "", {});
  await flush();
  assert.doesNotMatch(w.calls.at(-1).path, /state=/);
  handle.update("", { state: "trashed" });
  await flush();
  assert.match(w.calls.at(-1).path, /state=trashed/, "the filter goes to the Worker");
  assert.match(w.root.textContent, /Nothing matches/, "an empty answer under the filter says so");
});

test("Memories reads the filter options from the light sources route, not the full harness report", async () => {
  const w = memoryWorld();
  memoriesMount(w.root, w.ctx, "", {});
  await flush();
  assert.ok(w.calls.some((c) => c.path === "/ui/api/sources"));
  assert.equal(w.calls.some((c) => c.path === "/ui/api/harnesses"), false, "the seven harness queries are not run for a filter list");
});
