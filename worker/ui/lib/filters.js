// Builds query strings for the read routes and handles cursors. Pure.
import { DAY_MS } from "./format.js";

export const ORIGINS = ["explicit", "capture", "import", "profile", "person", "system"];
export const STATUSES = ["canonical", "active", "deprecated", "pending"];
export const TYPES = ["user", "feedback", "project", "reference"];
export const TIME_RANGES = { all: null, "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, "90d": 90 * DAY_MS };
export const SORTS = [["created", "Newest saved"], ["updated", "Recently changed"], ["recalls", "Most recalled"]];
export const PAGE = 50;

/** Words and commas split a tag box into tags. Lowercase, no leading hash, no repeats. */
export function splitTags(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, "").toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The /list query for the Browse filters. Empty filters are left out. */
export function listQuery(filters, { cursor, now, n = PAGE } = {}) {
  const q = new URLSearchParams();
  for (const key of ["origin", "harness", "status", "project", "type"]) if (filters[key]) q.set(key, filters[key].trim());
  for (const tag of splitTags(filters.tag)) q.append("tag", tag);
  const span = TIME_RANGES[filters.time ?? "all"];
  if (span && Number.isFinite(now)) q.set("after", String(now - span));
  if (filters.sort && filters.sort !== "created" && SORTS.some(([k]) => k === filters.sort)) q.set("sort", filters.sort);
  q.set("n", String(n));
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

/** The /recall query. The dashboard never counts a recall, so count=0 is always there. It asks for the reason behind every hit. topK is the hook's TOP_K, so the search sees what the hook sees. */
export function recallQuery(text, { topK = 3, project = "" } = {}) {
  const q = new URLSearchParams({ query: String(text ?? "").trim(), topK: String(topK), explain: "1", checks: "1", count: "0" });
  const slug = String(project ?? "").trim().toLowerCase();
  if (slug) q.set("scope", `project:${slug}`);
  return q.toString();
}

/** A local date and time from a datetime-local box, in milliseconds. NaN input gives undefined. */
export function parseLocalTime(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The /ui/api/trash query for the Trash filters and sort. The Worker filters and sorts, so the page asks for what it shows. */
export function trashQuery(filters) {
  const q = new URLSearchParams();
  if (filters.sort === "forgotten") q.set("sort", "forgotten");
  if (filters.origin?.trim()) q.set("origin", filters.origin.trim());
  if (filters.project?.trim()) q.set("project", filters.project.trim());
  return q.toString();
}

/** The /audit query for the Audit filters. */
export function auditQuery(filters, { cursor, limit = 100 } = {}) {
  const q = new URLSearchParams();
  const since = parseLocalTime(filters.since);
  const until = parseLocalTime(filters.until);
  if (since !== undefined) q.set("since", String(since));
  if (until !== undefined) q.set("until", String(until));
  if (filters.actor?.trim()) q.set("actor", filters.actor.trim());
  if (filters.route?.trim()) q.set("route", filters.route.trim());
  if (filters.harness?.trim()) q.set("harness", filters.harness.trim());
  if (filters.result?.trim()) q.set("result", filters.result.trim());
  q.set("limit", String(limit));
  if (cursor) q.set("cursor", String(cursor));
  return q.toString();
}

/** Add a page of results to the ones already shown and keep the cursor for the next page. */
export function appendPage(shown, page, key = "entries") {
  return { items: [...shown, ...(page[key] ?? [])], cursor: page.next_cursor ?? null };
}
