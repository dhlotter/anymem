// Hand written SVG charts. No library. Every chart returns markup built with html``, so labels from the store stay text.
// Colour comes from classes (s1 to s6 and sn) in charts.css, never from inline styles. A chart always has a table twin.
import { compact, formatNumber, shortDay } from "./format.js";
import { html } from "./html.js";

const MARGIN = { left: 40, right: 8, top: 10, bottom: 26 };
const MAX_BAR = 24; // a bar is never thicker than this
const GAP = 2; // the surface coloured gap between touching segments
const RADIUS = 4;

/** The next round number at or above n, from 2, 4, 6, 8 or 10 times a power of ten, so half of it is round too. */
export function niceMax(n) {
  if (!(n > 0)) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [2, 4, 6, 8, 10]) if (step * pow >= n) return step * pow;
  return 10 * pow;
}

/** Indexes for the labels along the bottom, a regular step counted back from the newest, so the last bar is always named. */
export function labelIndexes(count, room, each = 84) {
  if (count <= 1) return count ? [0] : [];
  const fit = Math.max(2, Math.floor(room / each));
  const step = Math.ceil((count - 1) / (fit - 1));
  const out = [];
  for (let i = count - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

/** A bar with only its top corners rounded, the end away from the baseline. */
function topRounded(x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h));
  return `M${x} ${y + h}V${y + k}Q${x} ${y} ${x + k} ${y}H${x + w - k}Q${x + w} ${y} ${x + w} ${y + k}V${y + h}Z`;
}

/**
 * Stacked columns. One column per bucket, one segment per series that has a value.
 * @param {{buckets: {label: string, values: Record<string, number>}[], series: {key: string, label: string, cls: string}[], width: number, height?: number, summary: string, axisLabel?: (b: any, i: number) => string}} o
 */
export function stackedBars({ buckets, series, width, height = 220, summary, axisLabel = (b) => b.label }) {
  const plotW = Math.max(60, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const totals = buckets.map((b) => series.reduce((n, s) => n + (b.values[s.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const slot = buckets.length ? plotW / buckets.length : plotW;
  const bar = Math.min(MAX_BAR, Math.max(2, slot - 2));
  const y = (v) => MARGIN.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labels = new Set(labelIndexes(buckets.length, plotW));
  const peak = totals.indexOf(Math.max(...totals));
  return html`<svg class="plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${summary}" focusable="false">
    ${ticks.map((t) => html`<line class="grid" x1="${MARGIN.left}" x2="${width - MARGIN.right}" y1="${y(t)}" y2="${y(t)}"></line><text class="tick" x="${MARGIN.left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`)}
    ${buckets.map((b, i) => {
      const x = MARGIN.left + i * slot + (slot - bar) / 2;
      let base = 0;
      const live = series.filter((s) => (b.values[s.key] ?? 0) > 0);
      const tip = [b.label, ...live.map((s) => `${s.label} ${formatNumber(b.values[s.key])}`), live.length > 1 ? `Total ${formatNumber(totals[i])}` : ""].filter(Boolean).join("\n");
      return html`<g class="col" data-tip="${tip}" data-i="${i}">
        <rect class="hit" x="${MARGIN.left + i * slot}" y="${MARGIN.top}" width="${slot}" height="${plotH}"></rect>
        ${live.map((s, k) => {
          const v = b.values[s.key];
          const h = (v / max) * plotH;
          const top = base + v;
          base = top;
          const gap = live.length > 1 && h > GAP * 2 ? GAP / 2 : 0;
          const last = k === live.length - 1;
          return last ? html`<path class="seg ${s.cls}" d="${topRounded(x, y(top) + gap, bar, Math.max(1, h - gap * (live.length > 1 ? 2 : 0)), RADIUS)}"></path>` : html`<rect class="seg ${s.cls}" x="${x}" y="${y(top) + gap}" width="${bar}" height="${Math.max(1, h - gap * 2)}"></rect>`;
        })}
      </g>${labels.has(i) ? html`<text class="tick" x="${Math.min(Math.max(MARGIN.left + i * slot + slot / 2, MARGIN.left + 22), width - MARGIN.right - 22)}" y="${height - 6}" text-anchor="middle">${axisLabel(b, i)}</text>` : ""}`;
    })}
    ${totals[peak] > 0 && buckets.length > 6 ? html`<text class="peak" x="${Math.min(Math.max(MARGIN.left + peak * slot + slot / 2, MARGIN.left + 14), width - MARGIN.right - 14)}" y="${Math.max(10, y(totals[peak]) - 6)}" text-anchor="middle">${formatNumber(totals[peak])}</text>` : ""}
  </svg>`;
}

/** The numbers behind a chart, as a table. */
export function chartTable({ caption, first, columns, rows }) {
  return html`<div class="scroll" tabindex="0" role="region" aria-label="${caption}"><table class="data"><caption>${caption}</caption><thead><tr><th scope="col">${first}</th>${columns.map((c) => html`<th scope="col" class="num">${c}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr><th scope="row">${r.label}</th>${r.cells.map((v) => html`<td class="num">${formatNumber(v)}</td>`)}</tr>`)}</tbody></table></div>`;
}

/** The colour keys under a chart. Always there for two or more series. */
export const legend = (items) => html`<ul class="legend">${items.map((i) => html`<li><span class="key ${i.cls}" aria-hidden="true"></span>${i.label}${i.note ? html` <span class="muted">${i.note}</span>` : ""}</li>`)}</ul>`;

/** Day buckets from the growth route in the shape stackedBars takes. */
export function growthBuckets(growth) {
  const day = growth.bucket === "day";
  return growth.buckets.map((b) => ({ label: day ? shortDay(b.start) : `Week of ${shortDay(b.start)}`, short: shortDay(b.start), values: b.counts }));
}
