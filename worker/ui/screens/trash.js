// Trash. Memories forgotten recently, the ones closest to the end first, each with restore and the days left.
// The Worker filters and sorts the list (GET /ui/api/trash), so the page asks for what it shows and nothing more.
import { emptyState, originChip, shareBar } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { ariaSort, appliedChips, choice, placeMenus, sorter } from "../lib/grid.js";
import { ORIGINS, trashQuery } from "../lib/filters.js";
import { hashFor } from "../lib/route.js";
import { attempt, formValues, notify, onAction, onPick, onSubmit, say, show } from "../lib/dom.js";
import { ago, count, DAY_MS, formatTime, titleOf, truncate } from "../lib/format.js";
import { html } from "../lib/html.js";

export const title = "Trash";
const SOON_DAYS = 3;

/** Whole days left before the purge, never below zero. The Worker sends the purge time (purge_at). */
export const daysLeft = (e, now) => Math.max(0, Math.ceil((e.purge_at - now) / DAY_MS));

const FILTERS = ["origin", "project", "sort"];

/** The filters in use above the table. */
const appliedView = (f) => appliedChips([["origin", "Origin", f.origin], ["project", "Project", f.project]].filter(([k]) => f[k]).map(([k, label, value]) => ({ label, value, href: hashFor("trash", { params: { ...f, [k]: "" } }) })));

/**
 * The trash as a table, from the Worker's reply. The rows come in the order the Worker sent them: closest to the end first, or newest
 * forgotten first when Forgotten is the sort. Origin and Project filter it on the Worker.
 */
export function trashView(reply, now, f = {}) {
  const { entries, total, matching, shown, soon, older, projects, window_days: windowDays } = reply;
  const newest = f.sort === "forgotten";
  const body = entries.length ? entries.map((e) => {
    const left = daysLeft(e, now);
    return html`<tr class="${left <= SOON_DAYS ? "is-soon" : ""}" data-id="${e.id}"><th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("trash", { arg: e.id, params: f })}">${truncate(titleOf(e), 70)}</a></th>
          <td>${originChip(e.origin)}</td><td>${e.project || ""}</td>
          <td class="nowrap"><span title="${formatTime(e.deleted_at)}">${ago(e.deleted_at, now)}</span></td>
          <td class="left-days"><span class="days">${left} ${left === 1 ? "day" : "days"}</span>${shareBar(left / windowDays, left <= SOON_DAYS ? "sbar--soon" : "")}</td>
          <td class="cell__act"><button type="button" class="btn" data-action="restore-row" data-id="${e.id}">Restore</button></td></tr>`;
  }) : html`<tr><td colspan="6">${emptyState("No memories match", "Loosen a filter, or clear them all to see everything in the trash.", html`<a class="btn" href="${hashFor("trash")}">Clear the filters</a>`)}</td></tr>`;
  const projectChoice = projects.length || f.project ? choice("project", "Project", "project", [...new Set([...projects, ...(f.project ? [f.project] : [])])], f.project) : "";
  return html`${total ? html`<p class="muted head__intro">${count(total, "memory", "memories")} in the trash${soon ? `, ${soon} gone for good within ${SOON_DAYS} days` : ""}. ${newest ? "The newest are first." : "The closest to the end are first."}${matching > shown ? ` The list shows the first ${shown} of ${matching}.` : ""}</p>
      ${appliedView(f)}<form data-form="filter" aria-label="Filter the trash"><input type="hidden" name="sort" value="${f.sort ?? ""}"><div class="scroll" tabindex="0" role="region" aria-label="Memories in the trash"><table class="data data--grid is-clickable data--trash"><caption class="sr">Memories in the trash. The funnel in a column header filters it, and Forgotten and Time left sort.</caption><thead><tr><th scope="col" class="th">Memory</th>
        <th scope="col" class="th"><span class="th__row">Origin${choice("origin", "Origin", "origin", ORIGINS, f.origin)}</span></th>
        <th scope="col" class="th"><span class="th__row">Project${projectChoice}</span></th>
        <th scope="col" class="th" ${ariaSort(newest ? "descending" : "")}>${sorter("forgotten", "Forgotten")}</th><th scope="col" class="th" ${ariaSort(newest ? "" : "ascending")}>${sorter("left", "Time left")}</th><th scope="col" class="th"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${body}</tbody></table></div></form>` : emptyState("The trash is empty", `A memory you forget, or one the nightly job retires, waits here for ${count(windowDays, "day")} before it is gone for good.`)}
    ${older ? html`<p class="muted">${count(older, "older memory", "older memories")} ${older === 1 ? "is" : "are"} past ${count(windowDays, "day")} and cannot be restored. The nightly job removes ${older === 1 ? "it" : "them"} for good.</p>` : ""}`;
}

export function mount(root, ctx, arg, params = {}) {
  let filters = Object.fromEntries(FILTERS.filter((k) => params[k]).map((k) => [k, params[k]]));
  let loaded = null;
  let refocus = "";
  let seq = 0; // the newest list request, so a slow older one cannot overwrite it
  const back = () => hashFor("trash", { params: filters });
  show(root, html`<header class="head"><div><h1 tabindex="-1">Trash</h1><p class="head__intro" data-intro>Everything forgotten recently. Restore brings it back as it was.</p></div></header><div data-status></div><div data-list><p class="muted loading" role="status">Loading</p></div>`);
  const status = root.querySelector("[data-status]");
  const list = root.querySelector("[data-list]");
  const drawer = mountDrawer(root, ctx, { back, changed: () => load(), title });

  async function load() {
    const mine = ++seq;
    const reply = await attempt(status, () => ctx.request(`/ui/api/trash?${trashQuery(filters)}`), undefined, () => mine === seq);
    if (mine !== seq || !reply) return;
    status.replaceChildren();
    root.querySelector("[data-intro]").hidden = true;
    loaded = reply;
    draw();
  }
  function draw() {
    if (!loaded) return;
    list.innerHTML = String(trashView(loaded, ctx.now(), filters));
    if (refocus) list.querySelector(`[popovertarget="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
    refocus = "";
  }
  const apply = (form) => {
    const f = formValues(form);
    location.hash = hashFor("trash", { params: Object.fromEntries(FILTERS.map((k) => [k, (f[k] ?? "").trim()])) });
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
  list.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a, button")) location.hash = hashFor("trash", { arg: tr.dataset.id, params: filters }); // the row opens the memory in a drawer, here on the trash
  });
  onAction(root, {
    sort: (el) => (location.hash = hashFor("trash", { params: { ...filters, sort: el.dataset.sort === "left" ? "" : el.dataset.sort } })),
    async "restore-row"(el) {
      el.disabled = true;
      const row = el.closest("tr");
      const name = row.querySelector("th a").textContent;
      if (await attempt(status, () => ctx.request("/restore", { method: "POST", body: { id: el.dataset.id } }))) {
        dispatchEvent(new Event("anymem:changed"));
        notify(`Restored ${truncate(name, 50)}.`, { action: { label: "Move it back", run: () => ctx.request("/forget", { method: "POST", body: { id: el.dataset.id } }).then(() => (dispatchEvent(new Event("anymem:changed")), load())).catch((err) => say(status, err.message, true)) } });
        load();
      } else el.disabled = false;
    },
  });
  load();
  if (arg) drawer.open(arg);
  return {
    update(nextArg, next) {
      if (nextArg !== drawer.id) drawer.open(nextArg);
      const f = Object.fromEntries(FILTERS.filter((k) => next[k]).map((k) => [k, next[k]]));
      if (JSON.stringify(f) === JSON.stringify(filters)) return;
      filters = f;
      load();
    },
  };
}
