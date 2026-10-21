// Home. Quiet when all is well, specific when it is not. The status comes first, then the week in numbers, then what the store
// has been doing: what was saved, what was recalled, and what is still on probation.
import { isMissingRoute } from "../lib/api.js";
import { chartTable, growthBuckets, legend, stackedBars } from "../lib/chart.js";
import { mountChart } from "../lib/chart-dom.js";
import { emptyState, icon, memoryLink, originChip, segmented, shareBar, stateMark } from "../lib/components.js";
import { attempt, notify, onAction, onChange, onSubmit, formValues, show, unsay } from "../lib/dom.js";
import { against, ago, count, formatNumber, greeting, longDate, percent, shortDay, titleOf, truncate } from "../lib/format.js";
import { html } from "../lib/html.js";
import { quietSentence } from "../lib/harness.js";
import { mountDrawer } from "../lib/drawer.js";
import { ariaSort, sorter } from "../lib/grid.js";
import { hashFor } from "../lib/route.js";
import { subjectHref } from "../lib/subjects.js";

export const title = "Home";

const ORIGIN_SERIES = ["explicit", "capture", "import", "profile", "person", "system"].map((key, i) => ({ key, label: key[0].toUpperCase() + key.slice(1), cls: `s${i + 1}` }));
const RECALL_SERIES = [
  { key: "found", label: "Found memories", cls: "s1" },
  { key: "empty", label: "Found nothing", cls: "sn" },
];
const RANGES = [["30", "30 days"], ["90", "90 days"], ["365", "1 year"]];
/** The phrase with its first letter in lower case, so a label and a phrase read as one sentence. A word that starts with a capital and goes on in capitals keeps it. */
const lowerFirst = (text) => (/^[A-Z][a-z]/.test(text) ? `${text[0].toLowerCase()}${text.slice(1)}` : text);
const TABS = [["growth", "Growth"], ["recall", "Recall"], ["tools", "Tools"], ["probation", "Probation"]];
const SOON = 8; // rows of the probation list shown before the rest fold away

/** The checks that need a look, then the quiet ones. */
export function statusView(home) {
  const bad = home.checks.filter((c) => c.state === "warn" || c.state === "fail");
  const rest = home.checks.filter((c) => !bad.includes(c));
  const table = html`<details class="status__all"><summary>All ${home.checks.length} checks</summary><ul class="checks">${home.checks.map((c) => html`<li>${stateMark(c.state)}<span class="checks__label">${c.label}</span><span class="checks__detail">${c.detail}</span></li>`)}</ul></details>`;
  if (!bad.length) {
    const facts = ["nightly", "backup"].map((id) => home.checks.find((c) => c.id === id)).filter(Boolean);
    return html`<section class="status status--ok" aria-label="Status"><p class="status__line">${icon("ok")}<strong>All is well.</strong>${facts.map((c) => html`<span class="fact"><span class="fact__label">${c.label}</span> ${lowerFirst(c.detail)}</span>`)}</p>${table}</section>`;
  }
  return html`<section class="status status--attention" aria-labelledby="status-h">
    <h2 id="status-h" class="status__h">${icon(home.summary.worst === "fail" ? "fail" : "warn")}${count(bad.length, "thing needs", "things need")} attention</h2>
    <ul class="issues">${bad.map((c) => html`<li>${stateMark(c.state)}<span class="issues__label">${c.label}</span><span class="issues__detail">${c.detail}</span><a class="link" href="${c.href}">Open</a></li>`)}</ul>
    <p class="muted status__rest">${rest.length === 1 ? "The other check is fine." : `The other ${rest.length} checks are fine.`}</p>${table}</section>`;
}

/**
 * The subjects the system proposed, one line each: the name, the kind, how many memories back it, and what you can do. Accept puts it in
 * recall, Dismiss keeps it from coming back (there is no undo), Open shows it in the subject drawer. Nothing at all when none is waiting.
 */
export const subjectsWaitingView = (subjects) =>
  subjects.length
    ? html`<section class="decide" aria-labelledby="subjects-wait-h"><h2 class="h2" id="subjects-wait-h">Subjects waiting for you</h2>
      <p class="muted panel__sum">${count(subjects.length, "subject")} anymem noticed ${subjects.length === 1 ? "has" : "have"} not been added yet. Accept one to let recall offer it. Dismiss keeps it from coming back.</p>
      <div class="scroll" tabindex="0" role="region" aria-label="Subjects waiting for you"><table class="data data--grid data--decide"><caption class="sr">Subjects waiting for you, with how many memories back each one</caption>
      <thead><tr><th scope="col" class="th">Subject</th><th scope="col" class="th">Kind</th><th scope="col" class="th num">Memories</th><th scope="col" class="th"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${subjects.map((s) => html`<tr data-slug="${s.slug}"><th scope="row" class="mem__cell">${s.name}<span class="mem__desc">${s.slug}</span></th><td>${s.kind}</td><td class="num">${formatNumber(s.member_count)}</td>
        <td class="cell__act"><button type="button" class="btn btn--primary" data-action="subject-accept" data-slug="${s.slug}">Accept<span class="sr"> ${s.name}</span></button> <button type="button" class="btn" data-action="subject-dismiss" data-slug="${s.slug}">Dismiss<span class="sr"> ${s.name}</span></button> <a class="btn btn--quiet" href="${subjectHref(s.slug)}">Open<span class="sr"> ${s.name}</span></a></td></tr>`)}</tbody></table></div></section>`
    : "";

/** The week: one big figure and a ledger of three rows. */
export function figuresView(h) {
  return html`<section class="figures" aria-label="This week">
    <p class="hero"><span class="hero__n">${formatNumber(h.live)}</span><span class="hero__l">live memories</span></p>
    <dl class="ledger">
      <div class="ledger__row"><dt>Saved this week</dt><dd class="ledger__n">${formatNumber(h.added_week)}</dd><dd class="ledger__note">${against(h.added_week, h.added_prev, "week")}.</dd></div>
      <div class="ledger__row"><dt>Recalled this week</dt><dd class="ledger__n">${formatNumber(h.recalled_week)}</dd><dd class="ledger__note">${count(h.recall_calls_week, "recall call")}. ${against(h.recall_calls_week, h.recall_calls_prev, "week")}.</dd></div>
      <div class="ledger__row"><dt>Closed by the system</dt><dd class="ledger__n">${formatNumber(h.closed_week)}</dd><dd class="ledger__note">Replaced, merged or retired by the system. <a class="link" href="${hashFor("activity")}">See what changed</a></dd></div>
    </dl>
  </section>`;
}

/** The newest memories, so a quick look says what is new. */
export function latestView(entries, now) {
  return html`<section class="latest" aria-labelledby="latest-h"><h2 id="latest-h" class="h2">Saved lately</h2>
    ${entries.length ? html`<ul class="plain">${entries.map((e) => html`<li><a href="${memoryLink(e.id)}" class="latest__title">${truncate(titleOf(e), 70)}</a><span class="latest__meta">${originChip(e.origin)} ${ago(e.created_at, now)}</span></li>`)}</ul>` : emptyState("Nothing saved yet", "Memories appear here as your agents save them.")}
  </section>`;
}

const total = (b) => Object.values(b.values).reduce((a, c) => a + c, 0);

/** Memories over time, stacked by origin. The chart, its legend with totals, and the table twin. */
export function growthView(growth, range, asTable) {
  const buckets = growthBuckets(growth);
  const sums = Object.fromEntries(ORIGIN_SERIES.map((s) => [s.key, buckets.reduce((n, b) => n + (b.values[s.key] ?? 0), 0)]));
  const used = ORIGIN_SERIES.filter((s, i) => i < 5 || sums[s.key] > 0);
  const lead = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
  const span = RANGES.find(([v]) => v === String(range))[1];
  const sentence = growth.total
    ? `${count(growth.total, "memory", "memories")} saved in ${growth.bucket === "week" ? "the last year, counted by week" : `the last ${span}`}. ${lead[0][0].toUpperCase()}${lead[0].slice(1)} made ${percent(lead[1], growth.total)} percent of them.`
    : `Nothing was saved in the last ${span}.`;
  return html`<div class="panel__head"><h2 class="h2" id="growth-h">Memories over time</h2>
      <div class="panel__tools">${segmented("range", "Range", RANGES, String(range), "range")}<button type="button" class="btn btn--quiet" data-action="table" data-target="growth" aria-pressed="${asTable ? "true" : "false"}">Show as table</button></div></div>
    <p class="muted panel__sum">${sentence}</p>
    <div class="chart"><div class="chart__plot" data-plot="growth" tabindex="0" role="group" aria-label="Memories saved per ${growth.bucket}, stacked by origin. Use the left and right arrow keys to read each bar." ${asTable ? "hidden" : ""}></div>
    <div data-table="growth" ${asTable ? "" : "hidden"}>${chartTable({ caption: `Memories saved per ${growth.bucket}, by origin`, first: growth.bucket === "week" ? "Week starting" : "Day", columns: used.map((s) => s.label).concat("Total"), rows: [...buckets].reverse().map((b) => ({ label: b.short, cells: used.map((s) => b.values[s.key] ?? 0).concat(total(b)) })) })}</div></div>
    ${legend(used.map((s) => ({ cls: s.cls, label: s.label, note: formatNumber(sums[s.key]) })))}`;
}

export const growthChart = (growth, width) =>
  stackedBars({ buckets: growthBuckets(growth), series: ORIGIN_SERIES, width, summary: `Memories saved per ${growth.bucket} for ${growth.days} days, ${formatNumber(growth.total)} in total, stacked by origin. The table has every number.`, axisLabel: (b) => b.short });

/** The share of prompts the hooks left quiet over 7 and over 30 days, or a plain line when no hook has reported yet. */
export function quietView(outcomes) {
  if (!outcomes) return "";
  if (!outcomes.since) return html`<p class="quiet__none muted">${icon("off")}<span>No hook has reported what it did yet. A hook notes whether it added memories to a prompt and sends that with its next request, so the quiet rate appears after a few prompts on an updated client.</span></p>`;
  const cell = (w) => html`<div><dt>Quiet over ${w.days} days</dt>${w.quiet_percent === null ? html`<dd class="is-none">No prompts reported</dd>` : html`<dd class="fig">${w.quiet_percent}%</dd><dd class="muted small">${count(w.prompts, "prompt")}</dd>`}</div>`;
  return html`<div class="quiet" role="group" aria-label="Quiet rate"><dl class="funnel funnel--quiet">${outcomes.windows.map(cell)}</dl>
    <p class="muted small">${quietSentence(outcomes)} Quiet means the search ran and nothing was good enough to add to the prompt.</p></div>`;
}

/** One row per tool, from the audit calls and from what the hooks reported. A tool whose client reports nothing says so. */
export function toolRows(h) {
  const rows = new Map();
  const row = (id, label) => rows.get(id || "unknown") ?? rows.set(id || "unknown", { label, calls: 0, empty: 0, prompts: null, quiet_percent: null }).get(id || "unknown");
  for (const c of h.recalls.by_harness) Object.assign(row(c.harness, c.label), { calls: c.calls, empty: c.empty });
  for (const o of h.outcomes.by_harness) Object.assign(row(o.harness, o.label), { prompts: o.injected + o.quiet, quiet_percent: o.quiet_percent });
  return [...rows.values()].sort((a, b) => b.calls - a.calls || (b.prompts ?? 0) - (a.prompts ?? 0) || (a.label < b.label ? -1 : 1));
}

/** Recall activity by tool, and what the table can and cannot answer. */
export function toolTable(h) {
  const rows = toolRows(h);
  if (!rows.length) return "";
  return html`<div class="scroll" tabindex="0" role="region" aria-label="Recall activity by tool"><table class="data data--tools"><caption class="sr">Recall activity by tool, last 30 days</caption>
    <thead><tr><th scope="col">Tool</th><th scope="col" class="num">Recall calls</th><th scope="col" class="num">Found nothing</th><th scope="col" class="num">Prompts reported</th><th scope="col" class="num">Left quiet</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr><th scope="row">${r.label}</th><td class="num">${formatNumber(r.calls)}</td><td class="num">${r.calls ? `${formatNumber(r.empty)}, ${percent(r.empty, r.calls)}%` : "none"}</td><td class="num">${r.prompts === null ? "not reported" : formatNumber(r.prompts)}</td><td class="num">${r.quiet_percent === null ? "none" : `${r.quiet_percent}%`}</td></tr>`)}</tbody></table></div>
    <p class="muted small">Calls come from the audit trail and include recall scripts as well as hooks. Prompts reported come from the hooks only, and a tool shows nothing there until its client is updated.</p>`;
}

/** Recall calls per day, split into those that found something and those that found nothing. */
export function recallsView(r, asTable, h = null) {
  const quiet = percent(r.empty, r.total);
  const sentence = r.total
    ? `Your agents asked for memories ${formatNumber(r.total)} times in 30 days. ${formatNumber(r.empty)} of those calls (${quiet} percent) found nothing at all.`
    : "No agent asked for memories in the last 30 days, or the audit trail holds no recall calls.";
  const rows = [...r.days].reverse();
  return html`<div class="panel__head"><h2 class="h2" id="recall-h">Recall activity</h2><div class="panel__tools"><button type="button" class="btn btn--quiet" data-action="table" data-target="recalls" aria-pressed="${asTable ? "true" : "false"}">Show as table</button></div></div>
    <p class="muted panel__sum">${sentence}</p>
    ${h ? quietView(h.outcomes) : ""}
    <div class="chart"><div class="chart__plot" data-plot="recalls" tabindex="0" role="group" aria-label="Recall calls per day. Use the left and right arrow keys to read each bar." ${asTable ? "hidden" : ""}></div>
    <div data-table="recalls" ${asTable ? "" : "hidden"}>${chartTable({ caption: "Recall calls per day", first: "Day", columns: ["Found memories", "Found nothing", "Total"], rows: rows.map((d) => ({ label: shortDay(d.day), cells: [d.calls - d.empty, d.empty, d.calls] })) })}</div></div>
    ${legend(RECALL_SERIES.map((s) => ({ cls: s.cls, label: s.label })))}
    ${h ? (toolRows(h).length ? html`<h3 class="h3">By tool</h3>${toolTable(h)}` : "") : html`<p class="muted small">The audit trail shows who asked and how many calls found nothing. What the hook did with the answer is decided on your machine.</p>`}`;
}

export const recallsChart = (r, width) =>
  stackedBars({ buckets: r.days.map((d) => ({ label: shortDay(d.day), short: shortDay(d.day), values: { found: d.calls - d.empty, empty: d.empty } })), series: RECALL_SERIES, width, height: 180, summary: `Recall calls per day for 30 days, ${formatNumber(r.total)} in total and ${formatNumber(r.empty)} that found nothing. The table has every number.`, axisLabel: (b) => b.short });

/** The most recalled memories and the ones nobody has recalled. */
export function usageView(r) {
  const max = Math.max(1, ...r.most_recalled.map((m) => m.recall_count));
  return html`<section class="usage" aria-labelledby="top-h"><h2 class="h2" id="top-h">Most recalled this month</h2>
    ${r.most_recalled.length ? html`<ol class="rank">${r.most_recalled.map((m) => html`<li><a href="${memoryLink(m.id)}" class="rank__title">${truncate(m.title, 64)}</a><span class="rank__n">${formatNumber(m.recall_count)}</span>${shareBar(m.recall_count / max)}</li>`)}</ol><p class="muted small">Counts are for all time, listed for memories used in the last 30 days.</p>` : emptyState("Nothing recalled this month", "A memory shows up here once an agent is given it.")}
    <h2 class="h2 h2--spaced" id="never-h">Never recalled</h2>
    ${r.never_recalled.count ? html`<p>${count(r.never_recalled.count, "memory", "memories")} older than a week ${r.never_recalled.count === 1 ? "has" : "have"} never been recalled. Capsule, profile and person notes are left out, they reach agents another way.</p>
      <details class="fold"><summary>Show the oldest ${r.never_recalled.sample.length}</summary><ul class="plain">${r.never_recalled.sample.map((m) => html`<li><a href="${memoryLink(m.id)}">${truncate(m.title, 64)}</a><span class="latest__meta">${originChip(m.origin)}</span></li>`)}</ul></details>` : html`<p class="muted">Every memory older than a week has been recalled at least once.</p>`}
  </section>`;
}

/** Where the live memories came from, one row per tool with its share. A blank harness is Imported or Unknown, named by the Worker. */
export function sourcesView(h) {
  const { total, rows } = h.sources;
  if (!total) return html`<section class="panel" aria-labelledby="src-h"><h2 class="h2" id="src-h">Where memories come from</h2>${emptyState("Nothing saved yet", "Each memory records the tool that saved it, and the share by tool appears here.")}</section>`;
  const lead = rows[0];
  const blank = rows.filter((r) => r.filter === "none").reduce((n, r) => n + r.memories, 0);
  return html`<section class="panel" aria-labelledby="src-h"><div class="panel__head"><h2 class="h2" id="src-h">Where memories come from</h2></div>
    <p class="muted panel__sum">${count(total, "live memory", "live memories")}. ${lead.label} is the biggest source, with ${percent(lead.memories, total)} percent.</p>
    <ol class="rank">${rows.map((r) => html`<li><span class="rank__title">${r.label}</span><span class="rank__n">${formatNumber(r.memories)}</span>${shareBar(r.memories / total)}</li>`)}</ol>
    ${blank ? html`<p class="muted small">${count(blank, "memory", "memories")} have no harness recorded. They are called Imported when they were imported and Unknown otherwise, because the tool did not name itself when they were saved. <a class="link" href="${hashFor("memories", { params: { harness: "none" } })}">See them</a></p>` : ""}</section>`;
}

/** Which memories each tool was given most, from the recall log. It says since when it has been recording. */
export function toolsView(h) {
  const { used } = h;
  const since = used.since ? shortDay(new Date(used.since).toISOString().slice(0, 10)) : null;
  if (!used.by_harness.length) {
    return html`<section class="usage" aria-labelledby="tool-h"><h2 class="h2" id="tool-h">Most used by tool</h2>${emptyState("No recall recorded in 30 days", since ? `Recording began on ${since} and keeps 90 days.` : "A counted recall stores which tool was given which memory. This fills in as your agents work, and keeps 90 days.")}</section>`;
  }
  return html`<section class="usage" aria-labelledby="tool-h"><h2 class="h2" id="tool-h">Most used by tool</h2>
    <p class="muted">${count(used.total, "counted recall")} gave memories to your tools in 30 days. Recording began on ${since} and keeps 90 days, so older use is not here.</p>
    ${used.by_harness.map((t) => html`<h3 class="h3">${t.label} <span class="muted">${count(t.recalls, "recall")} of ${count(t.memories, "memory", "memories")}</span></h3>
      <ol class="rank">${t.top.map((m) => html`<li><a href="${memoryLink(m.id)}" class="rank__title">${truncate(m.title, 64)}</a><span class="rank__n">${formatNumber(m.count)}</span></li>`)}</ol>`)}
  </section>`;
}

/** Captured memories on probation, with the days left and what happens at the end. Days left is the order unless Recalled is the sort, and a click on a row opens the memory. */
export function probationView(p, now, sort = "left") {
  if (!p.entries.length) return html`<section class="panel" aria-labelledby="prob-h"><h2 class="h2" id="prob-h">On probation</h2>${emptyState("No capture is on probation", "Captured memories get 60 days to be recalled before they stay for good.")}</section>`;
  const row = (e) => html`<tr data-id="${e.id}"><th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("home", { arg: e.id })}">${truncate(e.title, 60)}</a></th><td class="num">${formatNumber(e.recall_count)}</td><td class="left-days"><span class="days">${e.days_left} ${e.days_left === 1 ? "day" : "days"}</span>${shareBar(e.days_left / 60)}</td><td class="fate">${!e.retires ? "Stays, the nightly job never retires this one." : e.recall_count > 0 ? "Stays once the 60 days end." : e.retire_at ? `Goes to the trash on ${shortDay(new Date(e.retire_at).toISOString().slice(0, 10))} unless it is recalled.` : "Goes to the trash if it is never recalled."}</td></tr>`;
  const entries = sort === "recalled" ? [...p.entries].sort((a, b) => b.recall_count - a.recall_count || a.days_left - b.days_left) : p.entries;
  const head = html`<thead><tr><th scope="col" class="th">Memory</th><th scope="col" class="th num" ${ariaSort(sort === "recalled" ? "descending" : "")}>${sorter("recalled", "Recalled")}</th><th scope="col" class="th" ${ariaSort(sort === "left" ? "ascending" : "")}>${sorter("left", "Days left")}</th><th scope="col" class="th">What happens</th></tr></thead>`;
  const first = entries.slice(0, SOON);
  const more = entries.slice(SOON);
  return html`<section class="panel" aria-labelledby="prob-h"><div class="panel__head"><h2 class="h2" id="prob-h">On probation</h2></div>
    <p class="muted panel__sum">${count(p.total, "captured memory", "captured memories")} on probation. A capture that gets recalled stays. One nobody recalls goes to the trash 60 days after it was saved.</p>
    <div class="scroll" tabindex="0" role="region" aria-label="Captures on probation"><table class="data data--grid is-clickable data--prob">${head}<tbody>${first.map(row)}</tbody></table></div>
    ${more.length ? html`<details class="fold"><summary>Show ${more.length} more</summary><div class="scroll" tabindex="0" role="region" aria-label="More captures on probation"><table class="data data--grid is-clickable data--prob">${head}<tbody>${more.map(row)}</tbody></table></div></details>` : ""}${p.total > p.entries.length ? html`<p class="muted small">The list shows the first ${p.entries.length} of ${formatNumber(p.total)}.</p>` : ""}</section>`;
}

/** The ask or remember box and a few things worth asking about. */
export function askView(chips) {
  return html`<form class="ask" data-form="ask"><label class="field ask__label">Ask or remember<input name="text" type="text" maxlength="240" autocomplete="off" placeholder="What would a prompt about this find?"></label>
    <div class="ask__buttons"><button type="submit" class="btn btn--primary">Search</button><button type="button" class="btn" data-action="remember-box">Remember</button></div>
    ${chips.length ? html`<p class="ask__chips"><span class="muted">Try asking about</span>${chips.map((c) => html`<button type="button" class="chip" data-action="chip" data-q="${c}">${truncate(c, 26)}</button>`)}</p>` : ""}</form>`;
}

export const headView = (home, chips, now) => html`<header class="home-head"><div><h1 tabindex="-1">${greeting(new Date(now).getHours())}${home?.owner ? `, ${home.owner}` : ""}.</h1><p class="muted">${longDate(now)}</p></div>${askView(chips)}</header>`;

export function mount(root, ctx, arg) {
  let range = "30";
  let tab = "growth";
  let probSort = "left";
  let seq = 0; // the newest range request, so a slow older one cannot draw the wrong range
  const view = { growth: null, recalls: null, harnesses: null, probation: null, proposed: [] };
  const tables = { growth: false, recalls: false };
  show(root, html`<div data-status></div><div data-page><p class="muted loading" role="status">Loading</p></div>`);
  const status = root.querySelector("[data-status]");
  const page = root.querySelector("[data-page]");
  const charts = {};

  const hostOf = (name) => page.querySelector(`[data-panel="${name}"]`);
  function drawGrowth() {
    hostOf("growth").innerHTML = String(growthView(view.growth, range, tables.growth));
    charts.growth = mountChart(hostOf("growth").querySelector('[data-plot="growth"]'), (w) => growthChart(view.growth, w));
  }
  function drawRecalls() {
    hostOf("recalls").innerHTML = String(recallsView(view.recalls, tables.recalls, view.harnesses));
    charts.recalls = mountChart(hostOf("recalls").querySelector('[data-plot="recalls"]'), (w) => recallsChart(view.recalls, w));
  }

  /** The proposed subjects. A Worker without subjects has none to show, and the status is checked here too in case a Worker ignores the filter. */
  const askedFor = () => ctx.request("/subjects?status=proposed").then((r) => (r.subjects ?? []).filter((s) => s.status === "proposed")).catch((err) => (isMissingRoute(err) ? [] : Promise.reject(err)));

  async function load() {
    const got = await attempt(status, async () => {
      const [home, growth, recalls, probation, latest, harnesses, proposed] = await Promise.all([
        ctx.shell.refresh(), // null when the first read failed, the rest of the page still shows
        ctx.request(`/ui/api/growth?days=${range}`),
        ctx.request("/ui/api/recalls"),
        ctx.request("/ui/api/probation"),
        ctx.request("/list?n=6").catch((err) => (isMissingRoute(err) ? { entries: [] } : Promise.reject(err))),
        ctx.request("/ui/api/harnesses").catch((err) => (isMissingRoute(err) ? null : Promise.reject(err))), // a Worker without it simply has no harness panels
        askedFor().catch(() => []), // a failed list leaves the section out, it never takes the page down
      ]);
      return { home, growth, recalls, probation, latest, harnesses, proposed };
    });
    if (!got) return;
    const now = ctx.now();
    view.growth = got.growth;
    view.recalls = got.recalls;
    view.harnesses = got.harnesses;
    view.probation = got.probation;
    view.proposed = got.proposed;
    const chips = got.recalls.most_recalled.slice(0, 2).map((m) => m.title);
    show(page, html`${headView(got.home, chips, now)}${got.home ? statusView(got.home) : html`<p class="notice notice--error" role="alert">${icon("fail")}<span>The status line and the week in numbers could not be read. Reload to try again.</span></p>`}
      <div data-waiting>${subjectsWaitingView(view.proposed)}</div>
      <div class="week">${got.home ? figuresView(got.home.headline) : ""}${latestView(got.latest.entries, now)}</div>
      <nav class="tabs" aria-label="More about your memories">${segmented("tab", "Section", TABS.map(([v, l]) => [v, v === "probation" && got.probation.total ? `${l} ${formatNumber(got.probation.total)}` : l]), tab, "tab")}</nav>
      <div class="tabbody" data-tabbody></div>`);
    drawTab();
  }

  /** One panel group at a time, so the page keeps its numbers and the rest waits a click away. */
  function drawTab() {
    const body = page.querySelector("[data-tabbody]");
    const h = view.harnesses;
    const parts = {
      growth: () => html`<section class="panel" aria-labelledby="growth-h" data-panel="growth"></section>`,
      recall: () => html`<div class="pair"><section class="panel" aria-labelledby="recall-h" data-panel="recalls"></section>${usageView(view.recalls)}</div>`,
      tools: () => (h ? html`<div class="pair pair--even">${sourcesView(h)}${toolsView(h)}</div>` : emptyState("No tool data", "This Worker does not report which tool saved a memory.")),
      probation: () => probationView(view.probation, ctx.now(), probSort),
    };
    show(body, parts[tab]());
    if (tab === "growth") drawGrowth();
    if (tab === "recall") drawRecalls();
  }

  /** Accept or dismiss one proposal, then read the list again. The sidebar count follows from the changed event. Both buttons of the row stay off while the request is on its way. */
  const answering = new Set();
  async function decide(el, path, message) {
    const slug = el.dataset.slug;
    if (answering.has(slug)) return; // a double click, or Dismiss after Accept on the same row
    answering.add(slug);
    const buttons = [...(el.closest("tr")?.querySelectorAll("button") ?? [el])];
    for (const b of buttons) b.disabled = true;
    try {
      if (!(await attempt(status, () => ctx.request(path, { method: "POST", body: { slug } })))) {
        for (const b of buttons) b.disabled = false;
        return;
      }
      unsay(status); // an earlier failure is not true any more
      dispatchEvent(new Event("anymem:changed"));
      notify(message);
      const next = await attempt(status, askedFor);
      if (next) {
        view.proposed = next;
        show(page.querySelector("[data-waiting]"), subjectsWaitingView(next));
      }
    } finally {
      answering.delete(slug);
    }
  }

  onChange(root, {
    tab() {
      tab = root.querySelector('input[name="tab"]:checked')?.value ?? "growth";
      drawTab();
    },
    async range() {
      range = root.querySelector('input[name="range"]:checked')?.value ?? "30";
      const mine = ++seq;
      const next = await attempt(status, () => ctx.request(`/ui/api/growth?days=${range}`));
      if (next && mine === seq) ((view.growth = next), drawGrowth());
    },
  });
  root.addEventListener("click", (e) => {
    const tr = e.target.closest(".data--prob tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = hashFor("home", { arg: tr.dataset.id }); // a row opens its memory in a drawer, here on Home
  });
  onSubmit(root, { ask: (form) => (location.hash = hashFor("search", { params: { q: formValues(form).text.trim() } })) });
  onAction(root, {
    table(el) {
      const name = el.dataset.target;
      tables[name] = !tables[name];
      (name === "growth" ? drawGrowth : drawRecalls)();
    },
    sort(el) {
      probSort = el.dataset.sort;
      drawTab();
    },
    async "subject-accept"(el) {
      await decide(el, "/subject/accept", "Accepted. Recall can offer it now.");
    },
    async "subject-dismiss"(el) {
      await decide(el, "/subject/dismiss", "Dismissed. anymem will not propose it again."); // there is no undo, the slug stays taken
    },
    chip: (el) => (location.hash = hashFor("search", { params: { q: el.dataset.q } })),
    "remember-box": () => ctx.shell.openRemember(root.querySelector('input[name="text"]').value.trim()),
  });
  load();
  const drawer = mountDrawer(root, ctx, { back: () => hashFor("home"), changed: () => load(), title });
  if (arg) drawer.open(arg);
  return { update: (next) => next !== drawer.id && drawer.open(next) };
}
