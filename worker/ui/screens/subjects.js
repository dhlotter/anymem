// Subjects. A table with its filters and sort in the column headers, and one subject in a drawer (lib/subject-drawer.js). A subject is a
// thing memories are about, such as a pet, a car or a project, and its card holds a brief. A member opens in the memory drawer on top.
// The address holds the filters and the open subject (?subject=slug), and a memory id after the screen name opens that memory.
import { isMissingRoute } from "../lib/api.js";
import { badge, emptyState, missingRoute } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { attempt, formValues, onAction, onPick, onSubmit, say, show } from "../lib/dom.js";
import { ago, count, formatTime, truncate } from "../lib/format.js";
import { ariaSort, appliedChips, choice, placeMenus, sorter, typed } from "../lib/grid.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";
import { mountSubjectDrawer, statusMark } from "../lib/subject-drawer.js";
import { FILTER_KEYS, KINDS, sortSubjects, STATUSES, subjectHref, subjectQuery, validSlug } from "../lib/subjects.js";

export const title = "Subjects";

/** How many filters are set. The order counts when it is not the default. */
export const activeFilters = (f) => FILTER_KEYS.filter((k) => f[k] && !(k === "sort" && f[k] === "updated")).length;

const ariaSortOf = (key, f) => ariaSort((f.sort || "updated") === key ? (key === "name" ? "ascending" : "descending") : "");

/** The column headers. A column with a filter has a small funnel that opens it, and Subject, Members and Changed sort. */
export const headRow = (f = {}) => html`<tr>
  <th scope="col" class="th" ${ariaSortOf("name", f)}><span class="th__row">${sorter("name", "Subject")}${typed("q", "Name or alias", "q", f.q)}</span></th>
  <th scope="col" class="th"><span class="th__row">Kind${choice("kind", "Kind", "kind", KINDS, f.kind)}</span></th>
  <th scope="col" class="th"><span class="th__row">Status${choice("status", "Status", "status", STATUSES, f.status)}</span></th>
  <th scope="col" class="th"><span class="th__row">Scope${choice("scope", "Scope", "scope", ["shared", "private"], f.scope)}</span></th>
  <th scope="col" class="th num" ${ariaSortOf("members", f)}>${sorter("members", "Members")}</th>
  <th scope="col" class="th num" ${ariaSortOf("updated", f)}>${sorter("updated", "Changed")}</th></tr>`;

/** The filters that are set above the table. */
export function appliedView(f, activeSlug = "") {
  const label = { kind: "Kind", status: "Status", scope: "Scope", q: "Name or alias" };
  return appliedChips(Object.keys(label).filter((k) => f[k]).map((k) => ({ label: label[k], value: f[k], href: hashFor("subjects", { params: { ...f, [k]: "", subject: activeSlug } }) })));
}

/** One subject as a table row, one line high. The name is the link, a click anywhere on the row opens the drawer, and the open filters stay in the address. */
export const tableRow = (s, now, active, filters) => html`<tr class="${active ? "is-active" : ""}" data-slug="${s.slug}">
  <th scope="row" class="mem__cell"><a class="mem__title" href="${subjectHref(s.slug, filters)}" aria-current="${active ? "true" : "false"}">${s.name}</a><span class="mem__desc">${truncate(`${s.slug}${s.aliases?.length ? `, also called ${s.aliases.join(", ")}` : ""}`, 140)}</span></th>
  <td>${s.kind}</td><td>${statusMark(s.status)}</td><td>${s.scope === "private" ? badge("private", "warn") : html`<span class="muted">shared</span>`}</td>
  <td class="num">${s.member_count}</td><td class="num nowrap" title="${formatTime(s.updated_at)}">${ago(s.updated_at, now)}</td></tr>`;

/** The whole table. The headers stay when nothing matches, because they hold the filters that would let you loosen them. */
export function listView(subjects, now, activeSlug, filters = {}) {
  const filtered = activeFilters({ ...filters, sort: "" }) > 0;
  return html`${appliedView(filters, activeSlug)}<form data-form="filter" aria-label="Filter and sort the list"><input type="hidden" name="sort" value="${filters.sort ?? ""}"><div class="scroll" tabindex="0" role="region" aria-label="Subjects"><table class="data data--grid is-clickable"><caption class="sr">Subjects. The funnel in a column header filters it, and Subject, Members and Changed sort.</caption>
    <thead>${headRow(filters)}</thead>
    <tbody>${subjects.length ? subjects.map((s) => tableRow(s, now, s.slug === activeSlug, filters)) : html`<tr><td colspan="6">${filtered
      ? emptyState("No subjects match", "Loosen a filter, or clear them all to see everything.", html`<a class="btn" href="${hashFor("subjects")}">Clear the filters</a>`)
      : emptyState("No subjects yet", "A subject is a thing memories are about, such as a pet, a car or a project. It has a short brief you write.", html`<button type="button" class="btn btn--primary" data-action="subject-new">New subject</button>`)}</td></tr>`}</tbody></table></div><button type="submit" class="sr">Apply the filters</button></form>`;
}

/** The form for a new subject. The Worker checks the slug and makes the card. */
export const newForm = () => html`<form class="stack" data-form="subject-new" aria-label="New subject"><div data-new-msg></div><label class="field">Kind<select name="kind">${KINDS.map((k) => html`<option value="${k}">${k}</option>`)}</select></label>
  <label class="field">Name<input name="name" required maxlength="80" autocomplete="off"></label>
  <label class="field">Slug<input name="slug" required minlength="2" maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off"></label>
  <p class="muted small">The slug is its short name in addresses and commands. Use 2 to 40 lowercase letters and numbers, with single dashes between them.</p>
  <label class="field">Brief<textarea name="brief" rows="6" placeholder="What this is, in a few plain sentences"></textarea></label>
  <p class="actions"><button type="submit" class="btn btn--primary">Create subject</button><button type="button" class="btn" data-action="subject-new-cancel">Cancel</button></p></form>`;

export function mount(root, ctx, memoryId, params) {
  const state = { filters: pick(params), subject: params.subject ?? "", items: [] };
  show(root, html`<header class="head"><div><h1 id="subjects-h" tabindex="-1">Subjects</h1><p class="head__intro"><span data-count role="status">Newest first.</span> <a class="link" data-clear href="#/subjects" hidden>Clear the filters</a></p></div><button type="button" class="btn btn--primary" data-action="subject-new">New subject</button></header>
    <div data-new></div><section aria-label="Subject list"><div data-status></div><div data-rows></div></section>`);
  const status = root.querySelector("[data-status]");
  const rows = root.querySelector("[data-rows]");
  const slot = root.querySelector("[data-new]");
  let refocus = "";
  let seq = 0; // the newest list request, so a slow older one cannot overwrite it
  const withSubject = (f = state.filters) => ({ ...f, subject: state.subject });
  // The subject drawer opens first and the memory drawer after it, so the memory sits on top and Escape closes it first.
  const subject = mountSubjectDrawer(root, ctx, { back: () => hashFor("subjects", { params: state.filters }), changed: () => load(), title, above: () => Boolean(memory.id), member: (id) => (location.hash = hashFor("subjects", { arg: id, params: withSubject() })), closed: () => drawRows() });
  const memory = mountDrawer(root, ctx, { back: () => hashFor("subjects", { params: withSubject() }), changed: () => load(), title });

  const drawRows = () => {
    const keep = refocus.replace(/^pop-/, "") || null; // the funnel you used keeps focus through the redraws, load() lets go of it
    rows.innerHTML = String(listView(state.items, ctx.now(), state.subject, state.filters));
    if (keep) rows.querySelector(`[popovertarget="pop-${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    root.querySelector("[data-count]").textContent = state.items.length ? `${count(state.items.length, "subject")} shown.` : "Nothing to show.";
    root.querySelector("[data-clear]").hidden = !activeFilters({ ...state.filters, sort: "" });
  };

  async function load() {
    const mine = ++seq;
    const reply = await attempt(status, () => ctx.request(`/subjects?${subjectQuery(state.filters)}`).catch((err) => (isMissingRoute(err) ? null : Promise.reject(err))), undefined, () => mine === seq);
    if (mine !== seq || reply === undefined) return void (refocus = "");
    status.replaceChildren();
    if (reply === null) rows.innerHTML = String(missingRoute("Subjects", "GET /subjects"));
    else ((state.items = sortSubjects(reply.subjects ?? [], state.filters.sort)), drawRows());
    refocus = "";
  }

  const applyFilters = (form) => {
    const f = formValues(form);
    location.hash = hashFor("subjects", { arg: memory.id, params: withSubject(Object.fromEntries(FILTER_KEYS.map((k) => [k, f[k] && !(k === "sort" && f[k] === "updated") ? f[k].trim() : ""]))) });
  };
  onPick(root, {
    filter(el) {
      const menu = el.closest("[popover]");
      refocus = menu ? menu.id : "";
      menu?.hidePopover?.();
      applyFilters(el.closest("form"));
    },
  });
  onSubmit(root, {
    filter: applyFilters,
    async "subject-new"(form) {
      const v = formValues(form);
      const slug = v.slug.trim();
      const msg = form.querySelector("[data-new-msg]");
      if (!validSlug(slug)) return say(msg, "The slug needs 2 to 40 lowercase letters and numbers, with single dashes between them.", true);
      const body = { slug, kind: v.kind, name: v.name.trim() };
      if (v.brief.trim()) body.brief = v.brief.trim();
      if (!(await attempt(msg, () => ctx.request("/subject", { method: "POST", body })))) return;
      slot.replaceChildren();
      dispatchEvent(new Event("anymem:changed"));
      location.hash = hashFor("subjects", { params: { ...state.filters, subject: slug } }); // the new subject opens in its drawer
      load();
    },
  });
  rows.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-slug]");
    if (tr && !e.target.closest("a")) location.hash = subjectHref(tr.dataset.slug, state.filters); // the name link keeps its own click, so a new tab still works
  });
  placeMenus(root);
  onAction(root, {
    sort: (el) => (location.hash = hashFor("subjects", { arg: memory.id, params: withSubject({ ...state.filters, sort: el.dataset.sort === "updated" ? "" : el.dataset.sort }) })),
    "subject-new"() {
      slot.innerHTML = String(newForm());
      slot.querySelector("select")?.focus();
    },
    "subject-new-cancel": () => slot.replaceChildren(),
  });

  drawRows();
  load();
  if (state.subject) (subject.open(state.subject), drawRows());
  if (memoryId) memory.open(memoryId);

  return {
    update(nextId, nextParams) {
      const next = pick(nextParams);
      const nextSubject = nextParams.subject ?? "";
      const filtersChanged = JSON.stringify(next) !== JSON.stringify(state.filters);
      const subjectChanged = nextSubject !== state.subject;
      state.filters = next;
      state.subject = nextSubject;
      if (memory.id && (!nextId || subjectChanged)) memory.open(""); // the top drawer closes before the one under it changes
      if (subjectChanged) subject.open(nextSubject);
      if (nextId && nextId !== memory.id) memory.open(nextId);
      if (filtersChanged) load();
      else drawRows();
    },
  };
}

/** The filters out of the address. */
function pick(params) {
  return Object.fromEntries(FILTER_KEYS.filter((k) => params[k]).map((k) => [k, params[k]]));
}
