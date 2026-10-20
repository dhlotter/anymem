// Words about harnesses. Pure, no DOM. The Worker decides every name (worker/harnesses.js), so nothing here knows which
// harnesses exist. It only turns the labels and counts the Worker sends into the sentences the screens show.
import { ago, count, formatNumber, formatTime, shortDay } from "./format.js";

/** The words for a memory's harness. The Worker sends harness_label, an older reply without it falls back to the raw name. */
export const harnessText = (e) => e.harness_label ?? (e.harness || "Unknown");

/** The options of the harness filter, from the sources the Worker counted. The blank ones share one option, because one filter finds them both. */
export function harnessOptions(rows, selected = "") {
  const seen = new Map();
  for (const r of rows ?? []) {
    const o = seen.get(r.filter) ?? { label: r.filter === "none" ? "Not recorded" : r.label, n: 0 };
    o.n += r.memories;
    seen.set(r.filter, o);
  }
  if (selected && !seen.has(selected)) seen.set(selected, { label: selected === "none" ? "Not recorded" : selected, n: 0 });
  return [...seen].map(([value, o]) => [value, `${o.label}, ${formatNumber(o.n)}`]);
}

/** A script label such as hook:capture or remember, in words with no colon. */
export function viaWords(script) {
  const s = String(script ?? "").trim();
  if (!s) return "";
  return s.startsWith("hook:") ? `the ${s.slice(5)} hook` : `the ${s} script`;
}

/** Who saved a memory, from memory-extras. Null means the page was not given the field, so nothing is said. */
export function savedByText(saved, now) {
  if (saved === undefined) return null;
  if (saved === null) return "Not in the audit trail, which keeps 90 days.";
  const via = viaWords(saved.script);
  return `${saved.by}${via ? `, through ${via}` : ""}, ${ago(saved.at, now)}`;
}

/** Which tools were given a memory, in words, and the line that says what the count can and cannot know. */
export function recalledByView(extras) {
  if (!extras || !Array.isArray(extras.recalled_by)) return null;
  const list = extras.recalled_by;
  const since = Number.isFinite(extras.recall_log_since) ? formatTime(extras.recall_log_since).slice(0, 10) : null;
  if (!list.length) {
    return { text: since ? `No counted recall since ${since}.` : "No counted recall recorded yet.", note: "Each counted recall stores which tool it was for. The list keeps 90 days." };
  }
  const parts = list.map((h) => `${h.label} ${count(h.times, "time")}`);
  return { text: `${parts.join(", ")}.`, note: `Counted from ${since ?? "the first recall"}, and kept for 90 days.` };
}

/** The sentence under the quiet rate figures. */
export function quietSentence(outcomes) {
  if (!outcomes || !outcomes.since) return null;
  const w = outcomes.windows.find((x) => x.days === 30);
  const failed = w.failed ? ` ${count(w.failed, "search", "searches")} could not run and ${w.failed === 1 ? "is" : "are"} left out.` : "";
  if (!w.prompts) return `Hooks have reported since ${shortDay(outcomes.since)}, but none searched for a prompt in the last 30 days.${failed}`;
  return `In 30 days the hooks searched for ${count(w.prompts, "prompt")} and added memories to ${formatNumber(w.injected)}. They left ${formatNumber(w.quiet)} quiet.${failed} Reporting began on ${shortDay(outcomes.since)}.`;
}
