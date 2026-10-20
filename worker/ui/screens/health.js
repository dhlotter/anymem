// Health. The checks, the nightly runs step by step, size against the plan, what was captured and refused, the write limit,
// backups and counts. Built so a bad night shows as one broken cell, not a wall of numbers.
import { isMissingRoute } from "../lib/api.js";
import { chartTable, legend, stackedBars } from "../lib/chart.js";
import { mountChart } from "../lib/chart-dom.js";
import { emptyState, icon, missingRoute, shareBar, stateMark } from "../lib/components.js";
import { attempt, onAction, show } from "../lib/dom.js";
import { ago, count, daysLeftLabel, formatBytes, formatNumber, formatTime, shareLabel, shortDay } from "../lib/format.js";
import { html } from "../lib/html.js";

export const title = "Health";

const CAPTURE_SERIES = [
  { key: "saved", label: "Saved", cls: "s1" },
  { key: "refused", label: "Refused", cls: "s2" },
  { key: "limited", label: "Held back by the limit", cls: "s4" },
  { key: "duplicates", label: "Duplicates", cls: "sn" },
];

export const checksView = (checks) => html`<section class="panel" aria-labelledby="checks-h"><h2 class="h2" id="checks-h">Checks</h2><ul class="checks checks--wide">${checks.map((c) => html`<li>${stateMark(c.state)}<span class="checks__label">${c.label}</span><span class="checks__detail">${c.detail}</span></li>`)}</ul></section>`;

const CELL = { ok: ["ok", "Passed"], failed: ["fail", "Failed"], refused: ["fail", "Refused"], skipped: ["off", "Skipped"] };

/** The steps of the recent runs as a grid. One column per run, oldest on the left, one row per step. */
export function runsView(runs, now) {
  if (!runs.length) return html`<section class="panel" aria-labelledby="runs-h"><h2 class="h2" id="runs-h">Nightly job</h2>${emptyState("The nightly job has not run yet", "It runs at 01:00 UTC and records every step here.")}</section>`;
  const cols = [...runs].reverse();
  const steps = [];
  for (const r of cols) for (const s of r.steps) if (!steps.includes(s.name)) steps.push(s.name);
  const latest = runs[0];
  return html`<section class="panel" aria-labelledby="runs-h"><div class="panel__head"><h2 class="h2" id="runs-h">Nightly job</h2></div>
    <p class="muted panel__sum">${latest.ok === null ? "The latest run is still going or was cut off." : latest.ok ? "The latest run passed every step." : "The latest run had a failing step."} It started ${ago(latest.started_at, now)}${latest.job === "manual" ? ", and was run by hand" : ""}.</p>
    <div class="scroll" tabindex="0" role="region" aria-label="Nightly job steps over the last runs"><table class="grid-table"><caption class="sr">Nightly job steps over the last ${cols.length} runs</caption>
      <thead><tr><th scope="col">Step</th>${cols.map((r) => html`<th scope="col" class="grid-table__run" title="${formatTime(r.started_at)}">${shortDay(new Date(r.started_at).toISOString().slice(0, 10))}${r.job === "manual" ? html`<span class="grid-table__tag">hand</span>` : ""}</th>`)}</tr></thead>
      <tbody>${steps.map((name) => html`<tr><th scope="row">${name}</th>${cols.map((r) => {
        const s = r.steps.find((x) => x.name === name);
        if (!s) return html`<td class="cell cell--none"><span class="sr">Not run</span></td>`;
        const [kind, word] = CELL[s.state] ?? CELL.ok;
        return html`<td class="cell cell--${kind}" title="${word}${s.headline ? `, ${s.headline}` : ""}">${icon(kind)}<span class="sr">${word}${s.headline ? `, ${s.headline}` : ""}</span></td>`;
      })}</tr>`)}</tbody></table></div>
    <details class="fold" open><summary>What the latest run did</summary><dl class="steps">${latest.steps.map((s) => html`<div><dt>${s.name}</dt><dd>${(CELL[s.state] ?? CELL.ok)[1]}${s.headline ? `, ${s.headline}` : ""}${s.more ? ". More to do tomorrow" : ""}${s.ms ? html`<span class="muted"> Took ${formatNumber(s.ms)} ms.</span>` : ""}</dd></div>`)}</dl></details></section>`;
}

export function capacityView(u, token) {
  const db = u.db;
  const vec = u.vectors;
  return html`<section class="panel" aria-labelledby="cap-h"><h2 class="h2" id="cap-h">Size against the plan</h2>
    <dl class="gauges">
      <div class="gauge-row"><dt>Database</dt><dd>${db.size_bytes === null ? html`<span class="muted">Size not reported by this Worker.</span>` : html`<span class="gauge-row__fig"><strong class="fig">${formatBytes(db.size_bytes)}</strong> of ${formatBytes(db.limit_bytes)}, ${shareLabel(db.size_bytes, db.limit_bytes)}</span>${shareBar(db.size_bytes / db.limit_bytes, "", 0.8)}`}</dd></div>
      <div class="gauge-row"><dt>Vectors</dt><dd>${vec ? html`<span class="gauge-row__fig"><strong class="fig">${formatNumber(vec.count)}</strong> of ${formatNumber(vec.limit)} the index can hold, ${shareLabel(vec.count, vec.limit)}</span>${shareBar(vec.count / vec.limit, "", 0.8)}` : html`<span class="muted">The index did not answer.</span>`}</dd></div>
      <div class="gauge-row"><dt>Stored dimensions</dt><dd>${vec ? html`<span class="gauge-row__fig"><strong class="fig">${formatNumber(vec.stored_dimensions)}</strong> of ${formatNumber(vec.included_dimensions)} included in the plan, ${shareLabel(vec.stored_dimensions, vec.included_dimensions)}. Beyond that a small charge applies, nothing stops.</span>${shareBar(vec.stored_dimensions / vec.included_dimensions, "", 0.8)}` : html`<span class="muted">The index did not answer.</span>`}</dd></div>
      <div class="gauge-row"><dt>Access token</dt><dd>${token?.failed ? html`<span class="muted">The expiry date could not be read. ${token.failed}</span>` : token?.configured ? html`<span class="gauge-row__fig">Expires on <strong class="fig">${token.expires}</strong>, ${daysLeftLabel(token.days_left)}</span>` : html`<span class="muted">No expiry date is set. Add ACCESS_TOKEN_EXPIRES to the Worker settings to get a warning.</span>`}</dd></div>
    </dl>
    <p class="muted small">The limits are for ${u.plan.plan}, from the Cloudflare documentation on ${u.plan.checked}. They are not read from your account, so a plan change needs an edit in plan-limits.js.</p></section>`;
}

export function capturesView(u, stats, asTable) {
  const sum = (k) => u.days.reduce((n, d) => n + d[k], 0);
  const failures = Object.entries(stats?.model_failures?.last_7_days ?? {});
  return html`<section class="panel" aria-labelledby="cap2-h"><div class="panel__head"><h2 class="h2" id="cap2-h">Captures, last 14 days</h2><div class="panel__tools"><button type="button" class="btn btn--quiet" data-action="table" aria-pressed="${asTable ? "true" : "false"}">Show as table</button></div></div>
    <dl class="funnel"><div><dt>Proposed</dt><dd class="fig">${formatNumber(sum("proposed"))}</dd></div><div><dt>Screened out</dt><dd class="fig">${formatNumber(sum("screened"))}</dd></div><div><dt>Saved</dt><dd class="fig">${formatNumber(sum("saved"))}</dd></div><div><dt>Refused</dt><dd class="fig">${formatNumber(sum("refused"))}</dd></div><div><dt>Held back</dt><dd class="fig">${formatNumber(sum("limited"))}</dd></div><div><dt>Duplicates</dt><dd class="fig">${formatNumber(sum("duplicates"))}</dd></div></dl>
    <p class="muted small">Proposed is what the capture hook found in a session. Screened out never reached the store. Saved, refused, held back and duplicates are what happened to the rest.</p>
    <div class="chart"><div class="chart__plot" data-plot="captures" tabindex="0" role="group" aria-label="Captures per day by what happened to them. Use the left and right arrow keys to read each bar." ${asTable ? "hidden" : ""}></div>
    <div ${asTable ? "" : "hidden"}>${chartTable({ caption: "Captures per day", first: "Day", columns: ["Proposed", "Screened out", "Saved", "Refused", "Held back", "Duplicates", "Model failures"], rows: [...u.days].reverse().map((d) => ({ label: shortDay(d.day), cells: [d.proposed, d.screened, d.saved, d.refused, d.limited, d.duplicates, d.model_failures] })) })}</div></div>
    ${legend(CAPTURE_SERIES.map((s) => ({ cls: s.cls, label: s.label })))}
    <p class="${failures.length ? "" : "muted"}">${!stats ? "Whether a model call failed is not known right now." : failures.length ? html`${icon("warn")} ${count(failures.reduce((n, [, v]) => n + v, 0), "model call")} failed this week, ${failures.map(([k, v]) => `${k} ${v}`).join(", ")}.` : "No model call failed this week."}</p></section>`;
}

export const capturesChart = (u, width) =>
  stackedBars({ buckets: u.days.map((d) => ({ label: shortDay(d.day), short: shortDay(d.day), values: d })), series: CAPTURE_SERIES, width, height: 180, summary: "Captures per day for 14 days, by what happened to them. The table has every number.", axisLabel: (b) => b.short });

export function limitView(u) {
  const w = u.write_limit;
  return html`<section class="panel" aria-labelledby="wl-h"><h2 class="h2" id="wl-h">Write limit</h2><p class="muted panel__sum">Each token may write ${w.limit} times in a rolling ${w.window_minutes} minutes.</p>
    ${w.tokens.length ? html`<table class="data"><thead><tr><th scope="col">Token</th><th scope="col">Used now</th><th scope="col" class="num">Resets in</th></tr></thead><tbody>${w.tokens.map((t) => html`<tr><th scope="row">${t.label}</th><td class="left-days"><span class="days">${t.used} of ${w.limit}</span>${shareBar(t.used / w.limit, t.used >= w.limit ? "sbar--soon" : "")}</td><td class="num">${t.resets_in_seconds >= 60 ? `${Math.ceil(t.resets_in_seconds / 60)} min` : `${t.resets_in_seconds} s`}</td></tr>`)}</tbody></table>` : html`<p class="muted">${icon("ok")} Nothing has written in the last ${w.window_minutes} minutes.</p>`}</section>`;
}

/** The backups the Worker lists (GET /backup), newest first. */
export function backupItems(reply) {
  return (reply?.backups ?? [])
    .map((b) => ({ day: String(b.day ?? ""), size: b.size, entries: b.entries ?? null }))
    .filter((b) => b.day)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

export const backupsView = (items) =>
  items.length
    ? html`<div class="scroll" tabindex="0" role="region" aria-label="Backups"><table class="data"><thead><tr><th scope="col">Day</th><th scope="col" class="num">Memories</th><th scope="col" class="num">Size</th><th scope="col"><span class="sr">Download</span></th></tr></thead><tbody>${items.map((b) => html`<tr><th scope="row">${b.day}</th><td class="num">${b.entries === null ? "" : formatNumber(b.entries)}</td><td class="num">${b.size === undefined ? "" : formatBytes(b.size)}</td><td class="cell__act"><a class="btn btn--quiet" href="/backup/${encodeURIComponent(b.day)}" download>Download</a></td></tr>`)}</tbody></table></div>`
    : emptyState("No backup yet", "The nightly job writes one a day into the backup bucket.");

const countList = (title, counts) => {
  const rows = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return html`<div class="counts__col"><h3 class="h3">${title}</h3>${rows.length ? html`<dl class="counts">${rows.map(([k, n]) => html`<div><dt>${k || "none"}</dt><dd class="num">${formatNumber(n)}</dd></div>`)}</dl>` : html`<p class="muted">Nothing yet.</p>`}</div>`;
};

export const countsView = (o) => html`<section class="panel" aria-labelledby="counts-h"><h2 class="h2" id="counts-h">What is stored</h2><p class="muted panel__sum"><strong>${formatNumber(o.count)}</strong> live memories${o.pending ? `, ${formatNumber(o.pending)} pending` : ""}, ${formatNumber(o.trash)} in the trash${o.unclassified ? `, ${formatNumber(o.unclassified)} without a kind` : ""}.</p>
  <div class="counts__grid">${countList("By status", o.by_status)}${countList("By origin", o.by_origin)}${countList("By kind", o.by_kind)}${countList("By project", o.by_project)}</div></section>`;

export function mount(root, ctx) {
  let asTable = false;
  let data = null;
  show(root, html`<header class="head"><div><h1 tabindex="-1">Health</h1><p class="head__intro">How the system is working, and what it did last night.</p></div></header><div data-status></div><div data-out><p class="muted loading" role="status">Loading</p></div>`);
  const status = root.querySelector("[data-status]");
  const out = root.querySelector("[data-out]");

  function drawCaptures() {
    const host = out.querySelector("[data-panel=captures]");
    host.innerHTML = String(capturesView(data.usage, data.overview, asTable));
    mountChart(host.querySelector('[data-plot="captures"]'), (w) => capturesChart(data.usage, w));
  }

  // One panel failing leaves the others standing. Each read that can fail on its own says so in its own place.
  const soft = (request) => request.catch((err) => ({ failed: err.message }));
  const section = (what, reply, view) => (reply.failed ? html`<p class="notice notice--error" role="alert">${icon("fail")}<span>${what} could not be read. ${reply.failed}</span></p>` : view(reply));

  attempt(status, async () => {
    const [home, overview, usage, runs, token, backups] = await Promise.all([
      ctx.shell.refresh().then((h) => h ?? { checks: [] }),
      soft(ctx.request("/ui/api/overview")),
      soft(ctx.request("/ui/api/usage")),
      soft(ctx.request("/ui/api/runs")),
      ctx.request("/ui/api/token-expiry").catch((err) => ({ failed: err.message })),
      ctx.request("/backup").catch((err) => (isMissingRoute(err) ? null : { error: err.message })),
    ]);
    data = { overview: overview.failed ? null : overview, usage };
    show(out, html`${home.checks.length ? checksView(home.checks) : ""}${section("The nightly job", runs, (r) => runsView(r.runs, ctx.now()))}
      ${section("The size and limit figures", usage, (u) => html`<div class="pair pair--even">${capacityView(u, token)}${limitView(u)}</div><div data-panel="captures"></div>`)}
      <section class="panel" aria-labelledby="bak-h"><h2 class="h2" id="bak-h">Backups</h2>${backups === null ? missingRoute("The backup list", "GET /backup") : backups.error ? html`<p class="notice notice--error" role="alert">${backups.error}</p>` : backupsView(backupItems(backups))}</section>
      ${section("The counts", overview, countsView)}`);
    if (!usage.failed) drawCaptures();
  });
  onAction(root, { table: () => ((asTable = !asTable), drawCaptures()) });
}
