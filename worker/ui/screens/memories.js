// Memories. A table with its filters and sort in the column headers, and one memory in a drawer (lib/drawer.js). The address holds the filters and the open memory.
import { badge, emptyState, harnessChip, originChip } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { attempt, formValues, onAction, onPick, onSubmit, say, show } from "../lib/dom.js";
import { appendPage, listQuery, ORIGINS, STATUSES, TIME_RANGES, TYPES } from "../lib/filters.js";
import { ago, count, formatNumber, formatTime, titleOf, truncate } from "../lib/format.js";
import { ariaSort, appliedChips, choice, placeMenus, sorter, typed } from "../lib/grid.js";
import { harnessOptions } from "../lib/harness.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";

export const title = "Memories";

const FILTER_KEYS = ["origin", "harness", "status", "type", "project", "tag", "time", "sort"];

/** How many filters are set. The order counts when it is not the default. */
export const activeFilters = (f) => FILTER_KEYS.filter((k) => f[k] && !(k === "sort" && f[k] === "created") && !(k === "time" && f[k] === "all")).length;

export { detailView, diffView, editForm, factsView, historyView, linksView } from "../lib/drawer.js";
const STATUS_NOTE = { canonical: "good", pending: "warn", deprecated: "muted" };

const TIMES = Object.keys(TIME_RANGES).filter((k) => k !== "all").map((k) => [k, `last ${k}`]);
const ariaSortOf = (key, f) => ariaSort((f.sort || "created") === key ? "descending" : "");

/** The column headers. A column with a filter has a small funnel that opens it, and the three that can be sorted carry a sort button. The tool column shows when the Worker counted its sources. */
export const headRow = (f = {}, sources = []) => html`<tr>
  <th scope="col" class="th"><span class="th__row">Memory${typed("tag", "Tag", "tag", f.tag)}</span></th>
  <th scope="col" class="th"><span class="th__row">Status${choice("status", "Status", "status", STATUSES, f.status)}</span></th>
  <th scope="col" class="th"><span class="th__row">Origin${choice("origin", "Origin", "origin", ORIGINS, f.origin)}</span></th>
  ${sources.length || f.harness ? html`<th scope="col" class="th"><span class="th__row">Tool${choice("harness", "Tool", "harness", harnessOptions(sources, f.harness), f.harness)}</span></th>` : ""}
  <th scope="col" class="th"><span class="th__row">Type${choice("type", "Type", "type", TYPES, f.type)}</span></th>
  <th scope="col" class="th"><span class="th__row">Project${typed("project", "Project", "project", f.project)}</span></th>
  <th scope="col" class="th num" ${ariaSortOf("recalls", f)}>${sorter("recalls", "Recalled")}</th>
  <th scope="col" class="th num" ${ariaSortOf("updated", f)}>${sorter("updated", "Changed")}</th>
  <th scope="col" class="th num" ${ariaSortOf("created", f)}><span class="th__row th__row--end">${sorter("created", "Saved")}${choice("time", "Saved", "time", TIMES, f.time === "all" ? "" : f.time, "Any time")}</span></th></tr>`;

/** The filters that are set above the table. */
export function appliedView(f, sources, activeId = "") {
  const label = { origin: "Origin", harness: "Tool", status: "Status", type: "Type", project: "Project", tag: "Tag", time: "Saved" };
  const value = (k, v) => (k === "harness" ? (v === "none" ? "Not recorded" : (sources.find((r) => r.filter === v)?.label ?? v)) : k === "time" ? `last ${v}` : v);
  return appliedChips(Object.keys(label).filter((k) => f[k] && !(k === "time" && f[k] === "all")).map((k) => ({ label: label[k], value: value(k, f[k]), href: hashFor("memories", { arg: activeId, params: { ...f, [k]: "" } }) })));
}

/** One memory as a table row, one line high. The title is the link, a click anywhere on the row opens the drawer, and the open filters stay in the address. */
export const tableRow = (e, now, active, filters, tool = true) => html`<tr class="${active ? "is-active" : ""}" data-id="${e.id}">
  <th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("memories", { arg: e.id, params: filters })}" aria-current="${active ? "true" : "false"}">${titleOf(e)}</a>${e.description ? html`<span class="mem__desc">${truncate(e.description, 140)}</span>` : ""}</th>
  <td>${e.status && e.status !== "active" ? badge(e.status, STATUS_NOTE[e.status] ?? "") : html`<span class="muted">active</span>`}</td><td>${originChip(e.origin)}</td>${tool ? html`<td>${harnessChip(e)}</td>` : ""}
  <td>${e.type || ""}</td><td>${e.project || ""}</td>
  <td class="num">${e.recall_count ? formatNumber(e.recall_count) : ""}</td><td class="num nowrap" title="${formatTime(e.updated_at)}">${ago(e.updated_at, now)}</td><td class="num nowrap" title="${formatTime(e.created_at)}">${ago(e.created_at, now)}</td></tr>`;

/** The whole table. The headers stay when nothing matches, because they hold the filters that would let you loosen them. */
export function listView(entries, cursor, now, activeId, filters = {}, sources = []) {
  const tool = Boolean(sources.length || filters.harness);
  const columns = tool ? 9 : 8;
  return html`${appliedView(filters, sources, activeId)}<form data-form="filter" aria-label="Filter and sort the list"><input type="hidden" name="sort" value="${filters.sort ?? ""}"><div class="scroll" tabindex="0" role="region" aria-label="Memories"><table class="data data--grid is-clickable"><caption class="sr">Memories. The funnel in a column header filters it, and Recalled, Changed and Saved sort.</caption>
    <thead>${headRow(filters, sources)}</thead>
    <tbody>${entries.length ? entries.map((e) => tableRow(e, now, e.id === activeId, filters, tool)) : html`<tr><td colspan="${columns}">${emptyState("No memories match", "Loosen a filter, or clear them all to see everything.", html`<a class="btn" href="${hashFor("memories")}">Clear the filters</a>`)}</td></tr>`}</tbody></table></div><button type="submit" class="sr">Apply the filters</button></form>${cursor ? html`<p class="more"><button type="button" class="btn" data-action="more">Load more</button></p>` : ""}`;
}

export function mount(root, ctx, id, params) {
  const state = { filters: pick(params), items: [], cursor: null, sources: [] };
  show(root, html`<header class="head"><div><h1 id="mem-h" tabindex="-1">Memories</h1><p class="head__intro"><span data-count role="status">Newest first.</span> <a class="link" data-clear href="#/memories" hidden>Clear the filters</a></p></div></header>
    <div class="mem" data-layout><section class="mem__list" aria-label="Memory list"><div data-status></div><div data-rows></div></section></div>`);
  const status = root.querySelector("[data-status]");
  const rows = root.querySelector("[data-rows]");
  let refocus = "";
  let seq = 0; // the newest list request, so a slow older one cannot overwrite it
  const back = () => hashFor("memories", { params: state.filters });
  const drawer = mountDrawer(root, ctx, { back, changed: () => load(false), title, closed: () => drawRows() });

  const drawRows = () => {
    const keep = refocus.replace(/^pop-/, "") || null; // the funnel you used keeps focus through the redraws, load() lets go of it
    rows.innerHTML = String(listView(state.items, state.cursor, ctx.now(), drawer.id, state.filters, state.sources));
    if (keep) rows.querySelector(`[popovertarget="pop-${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    root.querySelector("[data-count]").textContent = state.items.length ? `${count(state.items.length, "memory", "memories")} shown${state.cursor ? ", more to load" : ""}.` : "Nothing matches.";
    root.querySelector("[data-clear]").hidden = !activeFilters(state.filters);
  };

  async function load(more) {
    const mine = ++seq;
    state.loading = true;
    const page = await attempt(status, () => ctx.request(`/list?${listQuery(state.filters, { cursor: more ? state.cursor : undefined, now: ctx.now() })}`), undefined, () => mine === seq);
    if (mine !== seq) return;
    state.loading = false;
    if (!page) return void (refocus = "");
    status.replaceChildren();
    ({ items: state.items, cursor: state.cursor } = appendPage(more ? state.items : [], page));
    drawRows();
    refocus = "";
  }

  const applyFilters = (form) => {
    const f = formValues(form);
    location.hash = hashFor("memories", { arg: drawer.id, params: Object.fromEntries(FILTER_KEYS.map((k) => [k, f[k] && f[k] !== "all" && !(k === "sort" && f[k] === "created") ? f[k].trim() : ""])) });
  };
  onPick(root, {
    filter(el) {
      const menu = el.closest("[popover]");
      refocus = menu ? menu.id : "";
      menu?.hidePopover?.();
      applyFilters(el.closest("form"));
    },
  });
  onSubmit(root, { filter: applyFilters });
  rows.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = hashFor("memories", { arg: tr.dataset.id, params: state.filters }); // the title link keeps its own click, so a new tab still works
  });
  placeMenus(root);
  onAction(root, {
    sort: (el) => (location.hash = hashFor("memories", { arg: drawer.id, params: { ...state.filters, sort: el.dataset.sort === "created" ? "" : el.dataset.sort } })),
    more: () => (state.loading ? undefined : (say(status, "Loading"), load(true))),
  });

  drawRows();
  load(false);
  ctx.request("/ui/api/sources").then((r) => ((state.sources = r.sources?.rows ?? []), drawRows())).catch(() => {}); // the harness filter appears when the Worker can count its sources
  if (id) (drawer.open(id), drawRows());

  return {
    update(nextId, nextParams) {
      const next = pick(nextParams);
      if (JSON.stringify(next) !== JSON.stringify(state.filters)) {
        state.filters = next;
        drawRows();
        load(false);
      }
      if (nextId !== drawer.id) (drawer.open(nextId), drawRows());
    },
  };
}

/** The filters out of the address. */
function pick(params) {
  return Object.fromEntries(FILTER_KEYS.filter((k) => params[k]).map((k) => [k, params[k]]));
}
