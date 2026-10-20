// The column header kit for tables with filters and sort, shared by Memories, Audit and Trash. A filterable column gets a small
// funnel that opens its choices as a menu under the header, a sortable column gets a sort button, and the filters in use are
// listed above the table as chips that take them off. The screens decide what each column filters and how the list is read.
import { icon } from "./components.js";
import { html } from "./html.js";

export const norm = (o) => (Array.isArray(o) ? o : [o, o]);

/** The button in a column header that opens its filter. A set filter marks it, and the name carries the value for a screen reader. */
export const trigger = (id, title, shown) => html`<button type="button" class="th__filter ${shown ? "is-set" : ""}" popovertarget="pop-${id}" aria-label="${title}${shown ? `, now ${shown}` : ""}">${icon("filter")}</button>`;
export const menu = (id, title, body) => html`<div id="pop-${id}" popover class="menu" data-menu role="group" aria-label="${title}">${body}</div>`;

/** A column filter that is a choice from a list. It opens as a small menu under the header, and picking an option applies it. */
export function choice(id, label, name, options, value = "", any = "Any") {
  const all = [["", any], ...options.map(norm)];
  const shown = value && (all.find(([v]) => v === value)?.[1] ?? value);
  return html`${trigger(id, `Filter by ${label}`, shown)}${menu(id, `Filter by ${label}`, html`<fieldset class="menu__opts"><legend class="sr">${label}</legend>${all.map(([v, l]) => html`<label class="menu__opt"><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""} data-pick="filter"><span>${l}</span></label>`)}</fieldset>`)}`;
}

/** A column filter that is typed text, or several fields. Enter or Apply sets it. Each field is [name, label, value, type]. listId names a datalist on the page, such as routes. */
export const typedFields = (id, label, fields, shown, listId = "") => html`${trigger(id, `Filter by ${label}`, shown)}${menu(id, `Filter by ${label}`, html`${fields.map(([name, text, value = "", type = "text"]) => html`<label class="menu__text">${text}<input type="${type}" name="${name}" value="${value}" maxlength="200" autocomplete="off" ${listId ? html`list="${listId}"` : ""}></label>`)}<button type="submit" class="btn btn--primary">Apply</button>`)}`;
export const typed = (id, label, name, value = "") => typedFields(id, label, [[name, label, value]], value);

/** A column you can sort by. The active one is marked with aria-sort on its header, and a click moves the sort to it. */
export const sorter = (key, label) => html`<button type="button" class="th__sort" data-action="sort" data-sort="${key}">${label}</button>`;
export const ariaSort = (dir) => (dir ? html`aria-sort="${dir}"` : "");

/** The filters that are set, each one a link that takes it off. The name comes first so a value like capture is never a guess. */
export const appliedChips = (items) => (items.length ? html`<ul class="applied" aria-label="Filters in use">${items.map((i) => html`<li><a class="applied__chip" href="${i.href}">${i.label} <strong>${i.value}</strong>${icon("close")}<span class="sr"> Remove this filter</span></a></li>`)}</ul>` : "");

/**
 * Menus open under their funnel, in the top layer so a scrolling table cannot clip them. Call once per screen.
 * In a menu the arrow keys move the choice and do not apply it, and Enter picks the choice (a click, which applies it).
 */
export function placeMenus(root) {
  root.addEventListener("toggle", (e) => {
    const m = e.target;
    if (e.newState !== "open" || !m.matches?.("[data-menu]")) return;
    const r = root.querySelector(`[popovertarget="${m.id}"]`).getBoundingClientRect();
    m.style.top = `${Math.round(r.bottom + 4)}px`;
    m.style.left = `${Math.max(8, Math.min(Math.round(r.left), innerWidth - m.offsetWidth - 8))}px`;
    m.querySelector("input:checked, input")?.focus();
  }, true);
  root.addEventListener("keydown", (e) => {
    const radio = e.target.closest?.('[data-menu] input[type="radio"]');
    if (!radio) return;
    if (e.key === "Enter") return (e.preventDefault(), radio.click());
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault(); // the browser would check the next choice and fire its change, which applies it
    const all = [...radio.closest("[data-menu]").querySelectorAll('input[type="radio"]')];
    const next = all[(all.indexOf(radio) + step + all.length) % all.length];
    next.checked = true;
    next.focus();
  });
}
