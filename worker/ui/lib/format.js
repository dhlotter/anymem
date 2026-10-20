// Pure formatting helpers. No DOM, no network.

const pad = (n) => String(n).padStart(2, "0");
export const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 2026-10-17 14:03 in the viewer's time zone. Empty text for a missing time. */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "17 Oct" from a YYYY-MM-DD day key. The key is a UTC day and is never moved by the viewer's zone. */
export function shortDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
}

/** "Sunday 18 October" in the viewer's zone. */
export function longDate(ms) {
  const d = new Date(ms);
  const month = new Date(2000, d.getMonth(), 1).toLocaleString("en", { month: "long" });
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${month}`;
}

/** The greeting for an hour of the day, 0 to 23. */
export const greeting = (hour) => (hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

/** "3 minutes ago", "2 days ago", "in 4 days". */
export function ago(ms, now) {
  if (!Number.isFinite(ms)) return "never";
  const diff = now - ms;
  const abs = Math.abs(diff);
  const units = [[DAY_MS, "day"], [3_600_000, "hour"], [60_000, "minute"]];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const label = `${n} ${name}${n === 1 ? "" : "s"}`;
      return diff >= 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return diff >= 0 ? "just now" : "in a moment";
}

/** 12345 becomes 12,345. */
export const formatNumber = (n) => (Number.isFinite(n) ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "0");

/** 12345 becomes 12.3k, small numbers stay whole. */
export function compact(n) {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 999_500) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** A byte count as B, KB, MB or GB. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Shorten text to at most max characters, ending with an ellipsis. */
export function truncate(text, max) {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Whole percent of part in whole, at most 999. */
export const percent = (part, whole) => (whole > 0 ? Math.min(999, Math.round((part / whole) * 100)) : 0);

/** A percent with one decimal for small shares, such as 0.1 percent of a limit. */
export function shareLabel(part, whole) {
  if (!(whole > 0)) return "0%";
  const p = (part / whole) * 100;
  return `${p < 1 && p > 0 ? p.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : Math.round(p)}%`;
}

/** The title to show for a memory. Its name, else the first line of its text. */
export function titleOf(entry) {
  if (entry.title) return entry.title;
  if (entry.name) return entry.name;
  const first = String(entry.content ?? "").split("\n").find((l) => l.trim()) ?? "";
  return truncate(first.trim(), 80) || "(empty)";
}

/** Days left until a token expires, as a sentence. */
export function daysLeftLabel(days) {
  if (days < 0) return `expired ${-days} day${days === -1 ? "" : "s"} ago`;
  if (days === 0) return "expires today";
  return `${days} day${days === 1 ? "" : "s"} left`;
}

/** "1 memory", "3 memories". */
export const count = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** How this period compares with the one before, in words. */
export function against(now, before, unit) {
  if (now === before) return `Same as last ${unit}`;
  return `Last ${unit} it was ${formatNumber(before)}`;
}
