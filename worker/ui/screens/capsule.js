// Capsule. The exact text that opens every session, section by section, with the size against the cap and the memory each section comes from.
import { badge, emptyState, icon, shareBar } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { attempt, onAction, show } from "../lib/dom.js";
import { ago, formatNumber, formatTime, percent } from "../lib/format.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";

export const title = "Capsule";
const SLOT_ORDER = ["identity", "preferences", "constraints", "principles"];
const INTRO = "Always-on rules from the shared memory store. Recall anything else with the anymem skill's recall script.";

/** The sections in the order the session start hook prints them, grouped under one heading per slot. */
export function bySlot(sections) {
  const groups = new Map();
  for (const s of sections) if (String(s.content).trim()) groups.set(s.slot, [...(groups.get(s.slot) ?? []), s]);
  const slots = [...groups.keys()].sort((a, b) => {
    const x = SLOT_ORDER.indexOf(a);
    const y = SLOT_ORDER.indexOf(b);
    return x !== -1 || y !== -1 ? (x === -1 ? 99 : x) - (y === -1 ? 99 : y) : a < b ? -1 : 1;
  });
  return slots.map((slot) => ({ slot, items: groups.get(slot) }));
}

/** The text exactly as the hook joins it, for copying. */
export const capsuleText = (sections) => ["## Memory capsule (anymem Worker, live)", INTRO, ...bySlot(sections).map((g) => `### ${g.slot}\n${g.items.map((s) => s.content.trim()).join("\n\n")}`)].join("\n\n");

/** A ruler of the 9,500 character cap, one stretch per section. */
export function ruler(c) {
  const W = 1000;
  const scale = W / Math.max(c.cap, c.chars);
  let at = 0;
  const parts = c.sections.map((s, i) => {
    const w = Math.max(2, s.content.length * scale);
    const x = at;
    at += s.content.length * scale;
    return html`<rect class="ruler__seg ruler__seg--${i % 2 ? "b" : "a"}" x="${x}" y="6" width="${Math.max(1, w - 2)}" height="22" rx="3"></rect>`;
  });
  const capX = c.cap * scale;
  return html`<svg class="ruler" viewBox="0 0 ${W} 44" role="img" aria-label="${formatNumber(c.chars)} of ${formatNumber(c.cap)} characters used, ${percent(c.chars, c.cap)} percent, in ${c.sections.length} sections" focusable="false"><rect class="ruler__track" x="0" y="6" width="${capX}" height="22" rx="3"></rect>${parts}
    <line class="ruler__cap" x1="${capX}" x2="${capX}" y1="2" y2="32"></line><text class="ruler__label" x="${capX}" y="43" text-anchor="end">Cap ${formatNumber(c.cap)}</text><text class="ruler__label" x="0" y="43">0</text></svg>`;
}

/** How full the capsule is, in a word. The kind picks the badge colour, and the word carries the meaning without it. */
export function fullness(c) {
  const used = c.chars / c.cap;
  if (c.over_cap || used > 1) return { word: "Over the cap", kind: "fail" };
  if (used > 0.9) return { word: "Almost at the cap", kind: "warn" };
  if (used > 0.7) return { word: "Getting full", kind: "warn" };
  return { word: "Plenty of room", kind: "good" };
}

/** One section as a table row. The slot name jumps to its place in the text, the rest of the row opens the memory in a drawer on this page. */
const sectionRow = (s, total, now, activeId) => html`<tr class="${s.source_id === activeId ? "is-active" : ""}" data-id="${s.source_id}"><td><button type="button" class="capsule__jump" data-action="jump" data-target="sec-${s.source_id}">${s.slot}</button></td>
  <th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("capsule", { arg: s.source_id })}">${s.name || `memory ${s.source_id.slice(0, 8)}`}</a></th>
  <td class="num">${formatNumber(s.content.length)}</td><td class="left-days">${total ? html`<span class="days">${percent(s.content.length, total)} percent</span>${shareBar(s.content.length / total)}` : ""}</td><td class="num nowrap" title="${formatTime(s.updated_at)}">${ago(s.updated_at, now)}</td></tr>`;

/** The sections in the order the hook prints them, with the standard slots that nothing fills yet shown as empty. */
export function sectionsTable(c, now, activeId = "") {
  const groups = bySlot(c.sections);
  const total = c.sections.reduce((n, s) => n + s.content.length, 0);
  const empty = SLOT_ORDER.filter((slot) => !groups.some((g) => g.slot === slot));
  return html`<div class="scroll" tabindex="0" role="region" aria-label="Capsule sections"><table class="data data--grid is-clickable data--cap"><caption class="sr">Capsule sections in the order a session receives them. A row opens its memory.</caption>
    <thead><tr><th scope="col" class="th">Slot</th><th scope="col" class="th">Memory</th><th scope="col" class="th num">Characters</th><th scope="col" class="th">Share of the capsule</th><th scope="col" class="th num">Changed</th></tr></thead>
    <tbody>${groups.flatMap((g) => g.items).map((s) => sectionRow(s, total, now, activeId))}${empty.map((slot) => html`<tr class="is-empty"><td>${slot}</td><td colspan="4" class="muted">Empty. No canonical memory fills this slot yet.</td></tr>`)}</tbody></table></div>`;
}

export function capsuleView(c, now, activeId = "") {
  const text = capsuleText(c.sections);
  const left = c.cap - c.chars;
  const groups = bySlot(c.sections);
  const full = fullness(c);
  return html`<section class="gauge" aria-label="Size"><div class="gauge__top"><p class="gauge__line"><strong class="fig">${formatNumber(c.chars)}</strong> of ${formatNumber(c.cap)} characters, ${percent(c.chars, c.cap)} percent. ${left >= 0 ? `${formatNumber(left)} left.` : `${formatNumber(-left)} over.`}</p>${badge(full.word, full.kind)}</div>${ruler(c)}</section>
    ${c.over_cap ? html`<p class="notice notice--error" role="alert">${icon("fail")}<span>${c.warning}</span></p>` : ""}
    ${c.sections.length ? html`<div class="capsule"><div class="capsule__index">${sectionsTable(c, now, activeId)}</div>
      <div class="capsule__text">${text.length > c.cap ? html`<p class="notice" role="status">${icon("warn")}<span>This text is ${formatNumber(text.length)} characters. The session start hook cuts it at ${formatNumber(c.cap)}, so the end would not reach a session.</span></p>` : ""}<div class="capsule__bar"><p class="muted">The text the hook builds from the capsule, before any cut.</p><button type="button" class="btn" data-action="copy">${icon("copy")}Copy</button></div>
      <div class="code code--block capsule__doc" tabindex="0" role="region" aria-label="Capsule text"><p class="doc__head">## Memory capsule (anymem Worker, live)</p><p class="doc__intro">${INTRO}</p>${groups.map((g) => html`<div class="doc__slot"><p class="doc__h">### ${g.slot}</p>${g.items.map((s) => html`<div class="doc__sec" id="sec-${s.source_id}"><pre>${s.content.trim()}</pre></div>`)}</div>`)}</div></div></div>`
      : emptyState("The capsule is empty", "A canonical memory tagged capsule:core and capsule-slot:identity becomes a section.")}`;
}

export function mount(root, ctx, arg) {
  let text = "";
  show(root, html`<header class="head"><div><h1 tabindex="-1">Capsule</h1><p class="head__intro">The notes every session starts with, in the order they arrive.</p></div></header><div data-status></div><div data-out><p class="muted loading" role="status">Loading</p></div>`);
  const status = root.querySelector("[data-status]");
  const drawer = mountDrawer(root, ctx, { back: () => hashFor("capsule"), changed: () => load(), title });
  async function load() {
    // The names come with the sections, so one read is the whole screen.
    await attempt(status, async () => {
      const c = await ctx.request("/prompt-capsules/core");
      text = capsuleText(c.sections);
      show(root.querySelector("[data-out]"), capsuleView(c, ctx.now(), drawer.id));
    });
  }
  load();
  if (arg) drawer.open(arg);
  root.addEventListener("click", (e) => {
    const tr = e.target.closest(".data--cap tr[data-id]");
    if (tr && !e.target.closest("a, button")) location.hash = hashFor("capsule", { arg: tr.dataset.id }); // the row opens its memory in a drawer, here on the capsule
  });
  onAction(root, {
    jump: (el) => document.getElementById(el.dataset.target)?.scrollIntoView({ block: "nearest" }),
    async copy(el) {
      try {
        await navigator.clipboard.writeText(text);
        el.lastChild.textContent = "Copied";
      } catch {
        el.lastChild.textContent = "Select the text and copy it by hand";
      }
    },
  });
  return { update: (next) => (next !== drawer.id ? drawer.open(next) : undefined) };
}
