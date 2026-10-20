// What the sidebar says, worked out from the home reply. Pure.
import { icon } from "./components.js";
import { count, formatNumber, percent } from "./format.js";
import { html } from "./html.js";

export const VERSION_UNKNOWN = "";

/**
 * The count beside a nav item, or null when the item has none or the number is quiet (zero).
 * @param {string} name a screen name
 * @param {{nav?: Record<string, number | null>} | null} home the reply of /ui/api/home
 * @returns {{text: string, label: string, alert: boolean} | null}
 */
export function countFor(name, home) {
  const nav = home?.nav;
  if (!nav) return null;
  switch (name) {
    case "memories":
      return { text: formatNumber(nav.live), label: count(nav.live, "live memory", "live memories"), alert: false };
    case "activity":
      return nav.activity_week > 0 ? { text: formatNumber(nav.activity_week), label: `${count(nav.activity_week, "change")} by the system this week`, alert: false } : null;
    case "trash":
      return nav.trash > 0 ? { text: formatNumber(nav.trash), label: `${count(nav.trash, "memory", "memories")} in the trash`, alert: false } : null;
    case "capsule": {
      if (nav.capsule_chars === null || nav.capsule_chars === undefined || !nav.capsule_cap) return null; // the cap comes from the Worker
      const p = percent(nav.capsule_chars, nav.capsule_cap);
      return { text: `${p}%`, label: `The capsule is at ${p} percent of its cap`, alert: p >= 90 };
    }
    case "people":
      return nav.pending > 0 ? { text: formatNumber(nav.pending), label: `${count(nav.pending, "change")} waiting for you`, alert: true } : null;
    case "health":
      return nav.attention > 0 ? { text: formatNumber(nav.attention), label: `${nav.attention === 1 ? "1 check needs" : `${formatNumber(nav.attention)} checks need`} attention`, alert: true } : null;
    default:
      return null;
  }
}

/** The small print at the foot of the sidebar. The version, the index state and the host. */
export function colophonText({ version, host, unvectorized, known }) {
  const index = !known ? "" : unvectorized > 0 ? html`<span class="colophon__line">${icon("warn")}${count(unvectorized, "memory", "memories")} waiting for vectors</span>` : html`<span class="colophon__line">${icon("ok")}Index in sync</span>`;
  return html`${index}<span class="colophon__line colophon__host">${host}</span>${version ? html`<span class="colophon__line">Version ${version}</span>` : ""}`;
}
