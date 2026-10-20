// Activity. Everything the system did on its own, newest first, each with an undo while undo still works.
// This answers "what did it change without me".
import { emptyState, harnessChip, icon, memoryLink } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { appliedChips, choice, placeMenus } from "../lib/grid.js";
import { attempt, formValues, notify, onAction, onPick, onSubmit, show } from "../lib/dom.js";
import { ago, count, DAY_MS, formatNumber, formatTime, longDate, truncate } from "../lib/format.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";

export const title = "Activity";

const KINDS = [["all", "Everything"], ["replaced", "Replaced"], ["merged", "Merged"], ["retired", "Retired"]];

/** The sentence under a title, saying what was done and why. */
export function whatHappened(e) {
  if (e.reason === "retire_never_recalled") return "Retired because it was never recalled in 60 days.";
  if (e.reason === "retire_idle_project") return "Retired because this project memory was not recalled for 90 days.";
  if (e.reason === "merge") return e.replaced_by ? html`Merged into <a href="${memoryLink(e.replaced_by.id)}">${truncate(e.replaced_by.title, 60)}</a>, which says the same thing.` : "Merged into a near copy.";
  return e.replaced_by ? html`Replaced by <a href="${memoryLink(e.replaced_by.id)}">${truncate(e.replaced_by.title, 60)}</a>, which contradicts it.` : "Replaced by a newer fact.";
}

/** Where the memory stands now. */
export function standing(e, now) {
  if (e.state === "trashed") return e.can_undo ? `In the trash. Gone for good ${ago(e.purge_at, now)}.` : "In the trash, and it can no longer be restored.";
  if (e.state === "closed") return "Closed history. It no longer reaches prompts.";
  if (e.state === "changed_since") return "Changed since, by an undo or an edit.";
  return "Open again.";
}

const STATE_WORD = { open: "Open again", closed: "Closed", trashed: "In the trash", changed_since: "Changed since" };
const STATES = Object.entries(STATE_WORD);
const KIND_OPTIONS = KINDS.filter(([k]) => k !== "all");
const KIND_WORD = { replaced: "Replaced", merged: "Merged", retired: "Retired" };

/** The filters in use above the table. */
const appliedView = (f, id = "") => appliedChips([["kind", "What", KIND_OPTIONS.find(([k]) => k === f.kind)?.[1] ?? f.kind], ["state", "Now", STATE_WORD[f.state] ?? f.state]].filter(([k]) => f[k]).map(([k, label, value]) => ({ label, value, href: hashFor("activity", { arg: id, params: { ...f, [k]: "" } }) })));

/** One thing the system did, as a table row one line high. The row opens the memory in a drawer here, and Undo stays on the row while it still works. */
export function entryView(e, now, f = {}) {
  return html`<tr class="act act--${e.kind}" data-id="${e.memory_id}" data-version="${e.version_id}"><td class="nowrap" title="${formatTime(e.at)}">${ago(e.at, now)}</td>
    <td class="nowrap"><span class="act__kind">${icon(e.kind === "retired" ? "trash" : e.kind === "merged" ? "memories" : "activity")}${KIND_WORD[e.kind]}</span></td>
    <th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("activity", { arg: e.memory_id, params: f })}">${e.title}</a></th>
    <td class="nowrap">${harnessChip(e)}</td><td class="mem__cell why">${whatHappened(e)}</td><td class="nowrap" title="${standing(e, now)}">${STATE_WORD[e.state] ?? "Open again"}</td>
    <td class="cell__act">${e.can_undo ? html`<button type="button" class="btn" data-action="undo-row" data-id="${e.memory_id}" data-version="${e.version_id}">${icon("undo")}Undo</button>` : ""}</td></tr>`;
}

/** The table, newest first. The headers stay when nothing matches, because they hold the filters that would loosen it. */
export function feedView(entries, now, f = {}, id = "") {
  const shown = [...entries].sort((a, b) => b.at - a.at || b.version_id - a.version_id); // the Worker has already filtered by kind and state
  const filtered = Boolean(f.kind || f.state);
  const empty = filtered ? emptyState("Nothing matches", "Loosen a filter, or clear them all to see everything the system did.", html`<a class="btn" href="${hashFor("activity")}">Clear the filters</a>`) : emptyState("The system has not changed anything yet", "Replaced, merged and retired memories are listed here, each with an undo.");
  if (!shown.length && !filtered) return empty;
  return html`${appliedView(f, id)}<form data-form="filter" aria-label="Filter what the system did"><div class="scroll" tabindex="0" role="region" aria-label="What the system did, newest first"><table class="data data--grid is-clickable data--act"><caption class="sr">What the system did on its own, newest first. The funnel in a column header filters it.</caption>
    <thead><tr><th scope="col" class="th" aria-sort="descending">Time</th><th scope="col" class="th"><span class="th__row">What${choice("kind", "What", "kind", KIND_OPTIONS, f.kind, "Everything")}</span></th><th scope="col" class="th">Memory</th><th scope="col" class="th">Tool</th><th scope="col" class="th">Why</th>
      <th scope="col" class="th"><span class="th__row">Now${choice("state", "Now", "state", STATES, f.state)}</span></th><th scope="col" class="th"><span class="sr">Actions</span></th></tr></thead>
    <tbody>${shown.length ? shown.map((e) => entryView(e, now, f)) : html`<tr><td colspan="7">${empty}</td></tr>`}</tbody></table></div><button type="submit" class="sr">Apply the filters</button></form>`;
}

export function summaryView(reply) {
  const c = reply.last_30_days;
  return html`<p class="muted head__intro">In the last 30 days the system replaced ${formatNumber(c.replaced)}, merged ${formatNumber(c.merged)} and retired ${formatNumber(c.retired)}.</p>
    ${reply.purge_soon ? html`<p class="notice" role="status">${icon("warn")}<span>${count(reply.purge_soon, "memory", "memories")} in the trash will be gone for good within 3 days.</span><a class="btn" href="${hashFor("trash")}">Open the trash</a></p>` : ""}`;
}

export function mount(root, ctx, arg, params = {}) {
  const pick = (p) => Object.fromEntries(["kind", "state"].filter((k) => p[k]).map((k) => [k, p[k]]));
  const state = { filters: pick(params), items: [], cursor: null, reply: null, loading: false };
  let seq = 0; // the newest request, so a slow older one cannot overwrite it
  let refocus = "";
  show(root, html`<header class="head"><div><h1 tabindex="-1">Activity</h1><div data-summary></div></div></header>
    <div data-status></div><div data-feed><p class="muted loading" role="status">Loading</p></div><div data-more></div>`);
  const status = root.querySelector("[data-status]");
  const feed = root.querySelector("[data-feed]");
  const back = () => hashFor("activity", { params: state.filters });
  const drawer = mountDrawer(root, ctx, { back, changed: () => load(false), title });

  const draw = () => {
    feed.innerHTML = String(feedView(state.items, ctx.now(), state.filters, drawer.id));
    if (refocus) feed.querySelector(`[popovertarget="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
    root.querySelector("[data-more]").innerHTML = String(state.cursor ? html`<p class="more"><button type="button" class="btn" data-action="more">Load more</button></p>` : "");
  };
  async function load(more) {
    const q = new URLSearchParams({ n: "40" });
    if (state.filters.kind) q.set("kind", state.filters.kind);
    if (state.filters.state) q.set("state", state.filters.state);
    if (more) q.set("cursor", String(state.cursor));
    const mine = ++seq;
    state.loading = true;
    const reply = await attempt(status, () => ctx.request(`/ui/api/activity?${q}`), undefined, () => mine === seq);
    if (mine !== seq) return;
    state.loading = false;
    if (!reply) return void (refocus = "");
    status.replaceChildren();
    state.reply = reply;
    state.items = more ? [...state.items, ...reply.entries] : reply.entries;
    state.cursor = reply.next_cursor;
    root.querySelector("[data-summary]").innerHTML = String(summaryView(reply));
    draw();
    refocus = "";
  }

  async function undo(id) {
    return attempt(status, () => ctx.request("/undo", { method: "POST", body: { id } }));
  }
  const apply = (form) => {
    const f = formValues(form);
    location.hash = hashFor("activity", { arg: drawer.id, params: { kind: (f.kind ?? "").trim(), state: (f.state ?? "").trim() } });
  };
  placeMenus(root);
  onPick(root, {
    filter(el) {
      const menu = el.closest("[popover]");
      refocus = menu ? menu.id : "";
      menu?.hidePopover?.();
      apply(el.closest("form"));
    },
  });
  onSubmit(root, { filter: apply });
  feed.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a, button")) location.hash = hashFor("activity", { arg: tr.dataset.id, params: state.filters }); // the row opens the memory in a drawer, here on Activity
  });
  onAction(root, {
    more: () => (state.loading ? undefined : load(true)),
    async "undo-row"(el) {
      const id = el.dataset.id;
      const item = state.items.find((e) => String(e.version_id) === el.dataset.version);
      el.disabled = true;
      if (await undo(id)) {
        dispatchEvent(new Event("anymem:changed"));
        notify(`Undone. ${truncate(item?.title ?? "The memory", 50)} is back.`, { action: { label: "Undo the undo", run: () => undo(id).then((done) => done && (dispatchEvent(new Event("anymem:changed")), load(false))) } });
        load(false);
      } else el.disabled = false;
    },
  });
  load(false);
  if (arg) drawer.open(arg);
  return {
    update(nextArg, next) {
      const f = pick(next);
      const filtersChanged = f.kind !== state.filters.kind || f.state !== state.filters.state;
      state.filters = f;
      if (nextArg !== drawer.id) drawer.open(nextArg);
      if (filtersChanged) load(false);
      else draw();
    },
  };
}
