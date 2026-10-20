// Small view pieces shared by the screens. Every one returns an html`` result, so store text is always escaped.
import { html } from "./html.js";
import { harnessText } from "./harness.js";
import { memoryLink } from "./route.js";

export { memoryLink };

/** An icon from the sprite in index.html. It is decoration, the words next to it carry the meaning. */
export const icon = (name, cls = "") => html`<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

/** The word and the shape for a check state, so colour is never the only signal. */
export const STATE = {
  ok: { word: "Fine", icon: "ok" },
  warn: { word: "Needs a look", icon: "warn" },
  fail: { word: "Failing", icon: "fail" },
  off: { word: "Not set up", icon: "off" },
};

export const stateMark = (state) => html`<span class="state state--${state}">${icon(STATE[state]?.icon ?? "off")}<span class="state__word">${STATE[state]?.word ?? ""}</span></span>`;

export const badge = (label, kind = "") => html`<span class="badge ${kind}">${label}</span>`;

/** The origin colours are the chart series, so a memory's chip matches its bar in the growth chart. */
export const ORIGIN_CLASS = { explicit: "s1", capture: "s2", import: "s3", profile: "s4", person: "s5", system: "s6" };

/** A short colour key and the origin name beside it, so the name carries the meaning. */
export const originChip = (origin) => html`<span class="origin"><span class="key ${ORIGIN_CLASS[origin] ?? ""}" aria-hidden="true"></span>${origin}</span>`;

export const tagList = (tags) => (tags?.length ? html`<ul class="tags" aria-label="Tags">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : "");

/** The tool a memory came from, in the Worker's words. The hidden word tells a screen reader what the name is. */
export const harnessChip = (e) => html`<span class="tool">${icon("tool")}<span class="sr">Source </span>${harnessText(e)}</span>`;

const STATUS_NOTE = { canonical: "good", pending: "warn", deprecated: "muted" };

/** The short facts about a memory, as chips. */
export const provenance = (e) => html`${originChip(e.origin)}${harnessChip(e)}${e.status && e.status !== "active" ? badge(e.status, STATUS_NOTE[e.status] ?? "") : ""}${e.project ? badge(`project ${e.project}`) : ""}${e.type ? badge(e.type) : ""}`;

/** Name what is empty, say why it matters, and offer the one next step. */
export const emptyState = (title, why = "", action = "") => html`<div class="empty"><p class="empty__title">${title}</p>${why ? html`<p class="muted">${why}</p>` : ""}${action}</div>`;

/** A notice for a route this Worker does not have yet. */
export const missingRoute = (what, route) => html`<p class="notice" role="status">${icon("info")}<span>${what} is not available on this Worker yet, because ${route} does not exist here. The rest of the dashboard still works.</span></p>`;

/** A fixed-width bar for a share, drawn as SVG so no inline style is needed. The words beside it carry the value. */
export function shareBar(share, cls = "", least = 4) {
  const w = Math.max(0, Math.min(100, share * 100));
  return html`<svg class="sbar ${cls}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="sbar__track" width="100" height="8" rx="4"></rect>${w > 0 ? html`<rect class="sbar__fill" width="${Math.max(Math.round(w * 10) / 10, least)}" height="8" rx="4"></rect>` : ""}</svg>`;
}

/** A group of radio buttons that reads as a segmented control. */
export const segmented = (name, legend, options, value, change = "") => html`<fieldset class="seg"><legend class="sr">${legend}</legend>${options.map(([v, label]) => html`<label class="seg__opt"><input type="radio" name="${name}" value="${v}" data-change="${change}" ${String(v) === String(value) ? "checked" : ""}><span>${label}</span></label>`)}</fieldset>`;

