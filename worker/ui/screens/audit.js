// Audit. The Worker's record of every request, filtered by harness, route, result and time. It never holds memory text,
// a prompt or a token, only who asked, what, when and how it went.
import { chartTable, legend, stackedBars } from "../lib/chart.js";
import { mountChart } from "../lib/chart-dom.js";
import { emptyState, icon, memoryLink } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { appliedChips, choice, placeMenus, typedFields } from "../lib/grid.js";
import { attempt, formValues, onAction, onPick, onSubmit, say, show } from "../lib/dom.js";
import { appendPage, auditQuery } from "../lib/filters.js";
import { formatNumber, formatTime, shortDay } from "../lib/format.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";

export const title = "Audit";

export const RESULTS = [["ok", "Went through"], ["refused", "Refused by a screen"], ["limited", "Held back by the limit"], ["denied", "Not allowed"], ["failed", "Failed"]];
const FILTER_KEYS = ["harness", "route", "result", "since", "until"];
const SERIES = [{ key: "ok", label: "Went through", cls: "s1" }, { key: "bad", label: "Did not go through", cls: "s2" }];

/** The words for a caller in a row, from the Worker. A reply without them falls back to the raw name. */
export const harnessLabel = (r) => r.harness_label ?? (r.harness || "Unknown");

/** A status as a word, so the table never leans on colour. */
export function resultWord(status) {
  if (status < 400) return { word: "Went through", kind: "ok" };
  if (status === 422) return { word: "Refused", kind: "warn" };
  if (status === 429) return { word: "Held back", kind: "warn" };
  if (status === 401 || status === 403) return { word: "Not allowed", kind: "warn" };
  return { word: `Failed, ${status}`, kind: "fail" };
}

export const stripView = (facets, asTable) => html`<section class="panel panel--strip" aria-labelledby="strip-h"><div class="panel__head"><h2 class="h2" id="strip-h">Calls per day</h2><div class="panel__tools"><button type="button" class="btn btn--quiet" data-action="table" aria-pressed="${asTable ? "true" : "false"}">Show as table</button></div></div>
  <div class="chart"><div class="chart__plot" data-plot="strip" tabindex="0" role="group" aria-label="Calls per day. Use the left and right arrow keys to read each bar." ${asTable ? "hidden" : ""}></div><div ${asTable ? "" : "hidden"}>${chartTable({ caption: "Calls per day", first: "Day", columns: ["Went through", "Did not go through"], rows: [...facets.per_day].reverse().map((d) => ({ label: shortDay(d.day), cells: [d.ok, d.bad] })) })}</div></div>${legend(SERIES.map((s) => ({ cls: s.cls, label: s.label })))}</section>`;

export const stripChart = (facets, width) => stackedBars({ buckets: facets.per_day.map((d) => ({ label: shortDay(d.day), short: shortDay(d.day), values: d })), series: SERIES, width, height: 150, summary: `Calls per day for ${facets.days} days. The table has every number.`, axisLabel: (b) => b.short });

/** The filters in use above the table, each a link that takes it off. */
export function appliedView(f, facets) {
  const caller = (facets?.harnesses ?? []).find((h) => h.harness === f.harness)?.label ?? f.harness;
  const items = [["harness", "Caller", caller], ["result", "Result", RESULTS.find(([k]) => k === f.result)?.[1] ?? f.result], ["route", "Route", f.route], ["since", "From", f.since], ["until", "Until", f.until]];
  return appliedChips(items.filter(([k]) => f[k]).map(([k, label, value]) => ({ label, value, href: hashFor("audit", { params: { ...f, [k]: "" } }) })));
}

/** The column headers. Time, Caller, Route and Result each hold a filter. The Worker lists newest first and has no other order. The harnesses to pick are the ones seen lately, named by the Worker, and the one in use stays in the list. */
export function headRow(f = {}, facets) {
  const seen = (facets?.harnesses ?? []).filter((h) => h.harness).map((h) => [h.harness, h.label ?? h.harness]);
  const callers = f.harness && !seen.some(([id]) => id === f.harness) ? [...seen, [f.harness, f.harness]] : seen;
  const routes = (facets?.routes ?? []).map((r) => r.route);
  const span = [f.since && `from ${f.since}`, f.until && `until ${f.until}`].filter(Boolean).join(" ");
  return html`<tr><th scope="col" class="th" aria-sort="descending"><span class="th__row">Time${typedFields("time", "Time", [["since", "From", f.since, "datetime-local"], ["until", "Until", f.until, "datetime-local"]], span)}</span></th>
    <th scope="col" class="th"><span class="th__row">Caller${choice("harness", "Caller", "harness", callers, f.harness)}</span></th>
    <th scope="col" class="th"><span class="th__row">Route${typedFields("route", "Route", [["route", "Route", f.route]], f.route, "routes")}<datalist id="routes">${routes.map((r) => html`<option value="${r}"></option>`)}</datalist></span></th>
    <th scope="col" class="th"><span class="th__row">Result${choice("result", "Result", "result", RESULTS, f.result)}</span></th>
    <th scope="col" class="th">Memories</th></tr>`;
}

export function auditRows(rows, filters = {}, facets) {
  const body = rows.length ? rows.map((r) => {
    const res = resultWord(r.status);
    return html`<tr><td class="nowrap">${formatTime(r.ts)}</td><td>${r.actor_kind === "browser" ? "Dashboard" : harnessLabel(r)}<span class="cell__sub">${r.actor_kind} ${r.actor_id}${r.script ? ` ${r.script}` : ""}</span></td>
          <td class="mono">${r.method} ${r.route}</td><td><span class="state state--${res.kind === "ok" ? "ok" : res.kind}">${icon(res.kind === "ok" ? "ok" : res.kind === "warn" ? "warn" : "fail")}<span class="state__word">${res.word}</span></span></td>
          <td>${r.memory_ids.slice(0, 3).map((id) => html`<a class="mono" href="${memoryLink(id)}">${id.slice(0, 8)}</a> `)}${r.memory_ids.length > 3 ? `and ${r.memory_ids.length - 3} more` : ""}</td></tr>`;
  }) : html`<tr><td colspan="5">${emptyState("No requests match", "Loosen a filter, or clear them all to see everything the Worker handled.", html`<a class="btn" href="${hashFor("audit")}">Clear the filters</a>`)}</td></tr>`;
  return html`${appliedView(filters, facets)}<form data-form="filter" aria-label="Filter the audit"><div class="scroll" tabindex="0" role="region" aria-label="Requests, newest first"><table class="data data--grid data--audit"><caption class="sr">Requests, newest first. The funnel in a column header filters it.</caption><thead>${headRow(filters, facets)}</thead><tbody>${body}</tbody></table></div><button type="submit" class="sr">Apply the filters</button></form>`;
}

const pick = (params) => Object.fromEntries(FILTER_KEYS.filter((k) => params[k]).map((k) => [k, params[k]]));

export function mount(root, ctx, arg, params) {
  const state = { filters: pick(params), items: [], cursor: null, facets: null, table: false, loading: false };
  let seq = 0; // the newest list request, so a slow older one cannot overwrite it
  show(root, html`<header class="head"><div><h1 tabindex="-1">Audit</h1><p class="head__intro">Every request the Worker handled. Memory text and tokens are never recorded.</p></div></header>
    <div data-strip></div><div data-status></div><div data-list><p class="muted loading" role="status">Loading</p></div><div data-more></div>`);
  const status = root.querySelector("[data-status]");
  const strip = root.querySelector("[data-strip]");
  let refocus = "";
  const drawer = mountDrawer(root, ctx, { back: () => hashFor("audit", { params: state.filters }), changed: () => {}, title });

  function drawStrip() {
    strip.innerHTML = String(stripView(state.facets, state.table));
    mountChart(strip.querySelector('[data-plot="strip"]'), (w) => stripChart(state.facets, w));
  }
  const drawList = () => {
    root.querySelector("[data-list]").innerHTML = String(auditRows(state.items, state.filters, state.facets));
    if (refocus) root.querySelector(`[popovertarget="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
    root.querySelector("[data-more]").innerHTML = String(state.cursor ? html`<p class="more"><button type="button" class="btn" data-action="more">Load more</button></p>` : "");
  };
  async function load(more) {
    const mine = ++seq;
    state.loading = true;
    const page = await attempt(status, () => ctx.request(`/audit?${auditQuery(state.filters, { cursor: more ? state.cursor : undefined })}`), undefined, () => mine === seq);
    if (mine !== seq) return; // a newer request owns the list now
    state.loading = false;
    if (!page) return;
    status.replaceChildren();
    ({ items: state.items, cursor: state.cursor } = appendPage(more ? state.items : [], page));
    drawList();
    refocus = "";
  }
  const apply = (form) => {
    const f = formValues(form);
    location.hash = hashFor("audit", { params: Object.fromEntries(FILTER_KEYS.map((k) => [k, (f[k] ?? "").trim()])) });
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
  onAction(root, { more: () => (state.loading ? undefined : (say(status, "Loading"), load(true))), table: () => ((state.table = !state.table), drawStrip()) });

  load(false);
  if (arg) drawer.open(arg);
  attempt(status, () => ctx.request("/ui/api/audit-facets")).then((facets) => {
    if (!facets) return;
    state.facets = facets;
    drawStrip();
    drawList();
  });
  return {
    update(nextArg, next) {
      if (nextArg !== drawer.id) drawer.open(nextArg);
      const f = pick(next);
      if (JSON.stringify(f) === JSON.stringify(state.filters)) return;
      state.filters = f;
      drawList();
      load(false);
    },
  };
}
