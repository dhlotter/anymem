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
import { mount as subjectsMount } from "../ui/screens/subjects.js";

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

// Subjects: a dog called Pip, a car called the Corolla. The fake Worker keeps one card and applies /subject/update to it.
const CARD = "card-pip";
const subjectRow = (over = {}) => ({ id: CARD, slug: "pip", kind: "pet", status: "active", scope: "shared", name: "Pip", aliases: ["pippa"], fields: { vet: { value: "Dr Dana", confirmed_at: NOW - 2 * DAY, source: "user" }, species: { value: "dog", confirmed_at: NOW - DAY, source: "user" } }, member_count: 2, updated_at: NOW - DAY, ...over });
const corolla = () => subjectRow({ id: "card-corolla", slug: "corolla", kind: "asset", name: "The Corolla", aliases: [], fields: {}, member_count: 5, updated_at: NOW - 3 * DAY });
function subjectWorld({ list, card = {} } = {}) {
  const w = memoryWorld();
  const state = { card: { ...subjectRow(), brief: "Pip is a small dog.", members: [{ id: "m1", name: "pip-vet", updated_at: NOW - DAY }, { id: "m2", name: "pip-food", updated_at: NOW - 2 * DAY }], created_at: NOW - 9 * DAY, ...card }, links: [], refuse: null };
  w.state = state;
  w.answers["/subjects"] = () => ({ ok: true, subjects: list ?? [subjectRow(), corolla()] });
  w.answers["/subject"] = () => ({ ok: true, subject: state.card });
  w.answers["/links"] = () => ({ ok: true, id: CARD, links: state.links });
  w.answers["/subject/update"] = (path, opts) => {
    if (state.refuse) return Promise.reject(state.refuse);
    const { id, fields, ...rest } = opts.body;
    assert.equal(id, CARD);
    Object.assign(state.card, rest);
    for (const [k, v] of Object.entries(fields ?? {})) v === null ? delete state.card.fields[k] : (state.card.fields[k] = { value: v, confirmed_at: NOW, source: "user" });
    return { ok: true, subject: state.card };
  };
  return w;
}
const panelOf = (w) => w.root.querySelector('.mem__panel[aria-label="Subject"]');
const openCard = async (w, params = { subject: "pip" }) => {
  const handle = subjectsMount(w.root, w.ctx, "", params);
  await flush();
  return handle;
};

test("Subjects: the list asks the Worker for what is filtered, sorts here, and a row opens the subject", async () => {
  const w = subjectWorld();
  const handle = subjectsMount(w.root, w.ctx, "", {});
  await flush();
  assert.equal(w.calls.at(-1).path, "/subjects?", "no filter, no query");
  const names = () => [...w.root.querySelectorAll("tbody .mem__title")].map((a) => a.textContent);
  assert.deepEqual(names(), ["Pip", "The Corolla"], "newest changed first");
  handle.update("", { kind: "asset", q: "corolla" });
  await flush();
  assert.match(w.calls.at(-1).path, /^\/subjects\?kind=asset&q=corolla$/);
  handle.update("", { sort: "members" });
  await flush();
  assert.deepEqual(names(), ["The Corolla", "Pip"], "most members first");
  w.root.querySelector('tr[data-slug="pip"]').click();
  assert.equal(globalThis.location.hash, "#/subjects?sort=members&subject=pip", "a click on the row opens the drawer and keeps the filters");
});

test("Subjects: a Worker without the route gets a plain notice, and a failure is shown", async () => {
  const w = subjectWorld();
  w.answers["/subjects"] = () => Promise.reject(new ApiError(404, "not_found", "No such route in this test."));
  subjectsMount(w.root, w.ctx, "", {});
  await flush();
  assert.match(w.root.textContent, /Subjects is not available on this Worker yet, because GET \/subjects does not exist here/);
  const failing = subjectWorld();
  failing.answers["/subjects"] = () => Promise.reject(new ApiError(500, "boom", "The list failed."));
  subjectsMount(failing.root, failing.ctx, "", {});
  await flush();
  assert.match(failing.root.querySelector("[data-status]").textContent, /The list failed\./);
});

test("Subjects: a list overtaken by a newer filter never draws over the newer one", async () => {
  const w = subjectWorld();
  const queue = [deferred(), deferred()];
  let asked = 0;
  w.answers["/subjects"] = () => queue[asked++].promise;
  const handle = subjectsMount(w.root, w.ctx, "", {});
  handle.update("", { kind: "asset" });
  queue[1].resolve({ ok: true, subjects: [corolla()] });
  await flush();
  queue[0].resolve({ ok: true, subjects: [subjectRow()] });
  await flush();
  assert.match(w.root.textContent, /The Corolla/);
  assert.doesNotMatch(w.root.querySelector("tbody").textContent, /Pip/);
});

test("the subject drawer reads GET /subject and the card's links, shows the brief as text, and is a modal dialog", async () => {
  const w = subjectWorld({ card: { brief: "<b>Pip</b> is a small dog.\n**not bold**", name: "<i>Pip</i>" } });
  w.state.links = [linkRow({ direction: "in", other_id: "m1", other_name: "pip-vet" })];
  await openCard(w);
  assert.ok(w.calls.some((c) => c.path === "/subject?slug=pip" && c.method === "GET"));
  assert.ok(w.calls.some((c) => c.path === `/links?id=${CARD}`));
  const panel = panelOf(w);
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(w.doc.getElementById("side").inert, true, "the page behind is inert");
  assert.equal(panel.querySelector("b"), null, "the brief is text, not markup");
  assert.equal(panel.querySelector("i"), null, "so is the name");
  assert.match(panel.querySelector("pre").textContent, /^<b>Pip<\/b> is a small dog\.\n\*\*not bold\*\*$/);
  assert.match(panel.textContent, /Dr Dana/);
  assert.match(panel.textContent, /confirmed 2 days ago/);
  assert.match(panel.textContent, /pip-food/, "the members are listed");
  assert.match(panel.textContent, /Linked from pip-vet/, "the links are the memory drawer's section");
  assert.equal(panel.querySelector('[data-action="unlink"]'), null);
  assert.equal(panel.querySelector('input[name="subject-scope"][value="shared"]').checked, true);
});

test("Edit brief saves through POST /subject/update and the drawer shows the new brief", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-form"][data-form-name="brief"]').click();
  const form = panelOf(w).querySelector('form[data-form="subject-brief"]');
  assert.equal(form.querySelector("textarea").value, "Pip is a small dog.", "the form starts with the brief");
  form.querySelector("textarea").value = "Pip is a small dog who hates the vet.";
  form.dispatchEvent(new Event("submit"));
  await flush();
  const call = w.calls.find((c) => c.path === "/subject/update");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { id: CARD, brief: "Pip is a small dog who hates the vet." });
  assert.match(panelOf(w).querySelector("pre").textContent, /hates the vet/);
  assert.equal(panelOf(w).querySelector("form"), null, "the form closes");
  assert.ok(w.calls.filter((c) => c.path.startsWith("/subjects?")).length >= 2, "the list is read again");
});

test("Edit fields sends only what changed, and an emptied box removes the field", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-form"][data-form-name="fields"]').click();
  const form = panelOf(w).querySelector('form[data-form="subject-fields"]');
  assert.deepEqual([...form.querySelectorAll("input")].map((i) => i.name), ["name", "species", "breed", "born", "vet", "status", "health_note"], "the keys of a pet");
  assert.equal(form.querySelector('input[name="vet"]').value, "Dr Dana");
  form.querySelector('input[name="breed"]').value = " terrier ";
  form.querySelector('input[name="vet"]').value = "";
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/subject/update").body, { id: CARD, fields: { breed: "terrier", vet: null } }, "species was not touched");
  assert.match(panelOf(w).textContent, /Breed/);
  assert.doesNotMatch(panelOf(w).textContent, /Dr Dana/);
});

test("Edit fields with nothing changed sends nothing", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-form"][data-form-name="fields"]').click();
  panelOf(w).querySelector('form[data-form="subject-fields"]').dispatchEvent(new Event("submit"));
  await flush();
  assert.equal(w.calls.some((c) => c.path === "/subject/update"), false);
  assert.equal(panelOf(w).querySelector("form"), null);
});

test("Add alias sends the whole list in lowercase, and Remove sends it without the alias", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-form"][data-form-name="alias"]').click();
  const form = panelOf(w).querySelector('form[data-form="subject-alias"]');
  form.querySelector('input[name="alias"]').value = "  Pip The Dog ";
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/subject/update").body, { id: CARD, aliases: ["pippa", "pip the dog"] });
  assert.match(panelOf(w).textContent, /pip the dog/);
  panelOf(w).querySelector('[data-action="subject-unalias"][data-alias="pippa"]').click();
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.path === "/subject/update").at(-1).body, { id: CARD, aliases: ["pip the dog"] });
});

test("Adding an alias the subject already has sends nothing", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-form"][data-form-name="alias"]').click();
  const form = panelOf(w).querySelector('form[data-form="subject-alias"]');
  form.querySelector('input[name="alias"]').value = "Pippa";
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.equal(w.calls.some((c) => c.path === "/subject/update"), false);
});

test("the scope toggle posts the new scope, and a refusal puts the toggle back and says why", async () => {
  const w = subjectWorld();
  await openCard(w);
  const priv = () => panelOf(w).querySelector('input[name="subject-scope"][value="private"]');
  priv().click();
  priv().dispatchEvent(new Event("change"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/subject/update").body, { id: CARD, scope: "private" });
  assert.equal(priv().checked, true, "the drawer shows private after the reload");
  assert.match(panelOf(w).textContent, /never sees this subject/);
  w.state.refuse = new ApiError(403, "admin_only", "Only the admin can change the scope.");
  const shared = () => panelOf(w).querySelector('input[name="subject-scope"][value="shared"]');
  shared().click();
  shared().dispatchEvent(new Event("change"));
  await flush();
  assert.match(panelOf(w).textContent, /Only the admin can change the scope\./);
  assert.equal(priv().checked, true, "the toggle is back on private, which is what is stored");
  assert.equal(shared().checked, false);
});

test("Retire posts status retired, shows the card as retired, and the toast Undo makes it active again", async () => {
  const w = subjectWorld();
  await openCard(w);
  w.root.querySelector('[data-action="subject-status"][data-status="retired"]').click();
  await flush();
  assert.deepEqual(w.calls.find((c) => c.path === "/subject/update").body, { id: CARD, status: "retired" });
  assert.match(panelOf(w).textContent, /This subject is retired/);
  assert.equal(panelOf(w).querySelector('[data-status="retired"]'), null, "Retire is gone");
  const undo = w.doc.querySelector("#toasts button");
  assert.ok(undo, "the toast offers Undo");
  undo.click();
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.path === "/subject/update").at(-1).body, { id: CARD, status: "active" });
  assert.doesNotMatch(panelOf(w).textContent, /This subject is retired/);
});

test("a subject the Worker does not know shows the Worker's words and an empty drawer", async () => {
  const w = subjectWorld();
  w.answers["/subject"] = () => Promise.reject(new ApiError(404, "not_found", "No such subject."));
  const handle = await openCard(w, { subject: "ghost" });
  assert.match(panelOf(w).querySelector("[data-msg]").textContent, /No such subject\./);
  assert.equal(panelOf(w).querySelector("[data-body]").textContent, "");
  w.answers["/subject"] = () => ({ ok: true, subject: w.state.card });
  handle.update("", { subject: "pip" });
  await flush();
  const msg = panelOf(w).querySelector("[data-msg]");
  assert.deepEqual([msg.textContent, msg.className, msg.getAttribute("role")], ["", "", null], "the next subject opens clean, with no empty error box left over");
  assert.match(panelOf(w).textContent, /Pip is a small dog\./);
});

test("New subject: the form checks the slug, posts kind, slug, name and brief, then opens the new subject", async () => {
  const w = subjectWorld();
  w.answers["/subject"] = (path, opts) => (opts.method === "POST" ? { ok: true, subject: { ...w.state.card, slug: opts.body.slug } } : { ok: true, subject: w.state.card });
  subjectsMount(w.root, w.ctx, "", {});
  await flush();
  w.root.querySelector('[data-action="subject-new"]').click();
  const form = w.root.querySelector('form[data-form="subject-new"]');
  const fill = (kind, name, slug, brief) => {
    form.querySelector('select[name="kind"]').value = kind;
    form.querySelector('input[name="name"]').value = name;
    form.querySelector('input[name="slug"]').value = slug;
    form.querySelector('textarea[name="brief"]').value = brief;
  };
  fill("pet", "Pip", "Pip Dog", "");
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.equal(w.calls.some((c) => c.method === "POST"), false, "a bad slug is not sent");
  assert.match(form.querySelector("[data-new-msg]").textContent, /The slug needs 2 to 40 lowercase letters/);
  fill("pet", " Pip ", "pip-dog", "  A small dog.  ");
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.method === "POST").body, { slug: "pip-dog", kind: "pet", name: "Pip", brief: "A small dog." });
  assert.equal(globalThis.location.hash, "#/subjects?subject=pip-dog");
  assert.equal(w.root.querySelector('form[data-form="subject-new"]'), null, "the form closes");
});

test("New subject: an empty brief is left out, and a refusal shows the reason and keeps what was typed", async () => {
  const w = subjectWorld();
  w.answers["/subject"] = () => Promise.reject(new ApiError(409, "subject_exists", "A subject with that slug exists."));
  subjectsMount(w.root, w.ctx, "", {});
  await flush();
  w.root.querySelector('[data-action="subject-new"]').click();
  const form = w.root.querySelector('form[data-form="subject-new"]');
  form.querySelector('select[name="kind"]').value = "person";
  form.querySelector('input[name="name"]').value = "Pip";
  form.querySelector('input[name="slug"]').value = "pip";
  form.dispatchEvent(new Event("submit"));
  await flush();
  assert.deepEqual(w.calls.find((c) => c.method === "POST").body, { slug: "pip", kind: "person", name: "Pip" }, "no brief key when the box is empty");
  assert.match(w.root.querySelector("[data-new-msg]").textContent, /A subject with that slug exists\./);
  assert.equal(w.root.querySelector('input[name="name"]').value, "Pip", "the form stays");
  w.root.querySelector('[data-action="subject-new-cancel"]').click();
  assert.equal(w.root.querySelector('form[data-form="subject-new"]'), null);
});

test("a member row opens the memory drawer on top of the subject, Escape closes the memory first, and the page is given back in order", async () => {
  const w = subjectWorld();
  w.answers["/entry"] = (path) => ({ ok: true, entry: entry({ id: "m1", name: "pip-vet" }) });
  w.answers["/links"] = (path) => ({ ok: true, links: path.includes(CARD) ? [] : [linkRow({ other_id: CARD, other_name: "pip" })] });
  const handle = await openCard(w);
  const side = w.doc.getElementById("side");
  w.root.querySelector('tr[data-id="m1"]').click();
  assert.equal(globalThis.location.hash, "#/subjects/m1?subject=pip", "the memory is in the address next to the subject");
  handle.update("m1", { subject: "pip" });
  await flush();
  const subject = panelOf(w);
  const memory = w.root.querySelector('.mem__panel[aria-label="Memory"]');
  assert.equal(memory.hidden, false);
  assert.match(memory.textContent, /pip-vet/);
  assert.equal(subject.hidden, false, "the subject stays open under it");
  assert.equal(subject.inert, true, "and is inert while the memory is on top");
  assert.equal(memory.inert, false);
  assert.match(memory.textContent, /Subjects\s*Pip/, "the memory says it is about Pip");
  assert.equal(memory.querySelector('ul[aria-label="Subjects"] a').textContent, "Pip");
  const writes = [];
  let hash = globalThis.location.hash;
  Object.defineProperty(globalThis.location, "hash", { configurable: true, get: () => hash, set: (v) => (writes.push(v), (hash = v)) });
  dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.deepEqual(writes, ["#/subjects?subject=pip"], "Escape closes the memory, and the subject drawer under it does not also ask to close");
  handle.update("", { subject: "pip" });
  assert.equal(memory.hidden, true);
  assert.equal(subject.inert, false, "the subject is live again");
  assert.equal(side.inert, true, "the page is still behind the subject");
  dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.equal(globalThis.location.hash, "#/subjects", "the next Escape closes the subject");
  handle.update("", {});
  assert.equal(subject.hidden, true);
  assert.equal(side.inert, false);
});

test("the scrim of each drawer closes only that drawer", async () => {
  const w = subjectWorld();
  const handle = await openCard(w);
  w.root.querySelector('.mem__scrim[data-action="subject-close"]').click();
  assert.equal(globalThis.location.hash, "#/subjects", "the subject scrim goes back to the list");
  handle.update("m1", { subject: "pip" });
  await flush();
  w.root.querySelector('.mem__scrim[data-action="close"]').click();
  assert.equal(globalThis.location.hash, "#/subjects?subject=pip", "the memory scrim goes back to the subject");
});

test("a memory in the memory drawer shows Subjects only for the cards it is about, and nothing when the Worker has no subjects", async () => {
  const w = memoryWorld({ "/subjects": () => ({ ok: true, subjects: [subjectRow(), corolla()] }), "/links": () => ({ ok: true, id: "m1", links: [linkRow({ other_id: CARD, other_name: "pip" }), linkRow({ other_id: "m2", other_name: "pip-vet" }), linkRow({ type: "related", other_id: "card-corolla", other_name: "corolla" })] }) });
  memoriesMount(w.root, w.ctx, "m1", {});
  await flush();
  assert.ok(w.calls.some((c) => c.path === "/subjects"));
  const chips = [...w.root.querySelectorAll('.mem__panel ul[aria-label="Subjects"] a')];
  assert.deepEqual(chips.map((a) => [a.textContent, a.getAttribute("href")]), [["Pip", "#/subjects?subject=pip"]], "the about link to a card, not the one to an ordinary memory or the related link");
  const none = memoryWorld();
  memoriesMount(none.root, none.ctx, "m1", {});
  await flush();
  assert.doesNotMatch(none.root.querySelector(".mem__panel").textContent, /Subjects/, "a Worker that answers 404 to GET /subjects leaves the row out");
});
