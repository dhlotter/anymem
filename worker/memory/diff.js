// A short plain description of what changed between two states of a memory.

const FIELDS = ["name", "description", "type", "status", "kind", "project", "pinned"];

/**
 * @param {Record<string, any> & {tags: string[]}} before a version snapshot
 * @param {Record<string, any> & {tags: string[]}} after the next snapshot, or the current row with its tags
 * @returns {string}
 */
export function summarize(before, after) {
  const parts = [];
  if (before.content !== after.content) {
    const delta = after.content.length - before.content.length;
    parts.push(delta === 0 ? "content changed" : `content ${delta > 0 ? "+" : "-"}${Math.abs(delta)} chars`);
  }
  for (const f of FIELDS) {
    if (before[f] !== after[f]) parts.push(`${f} ${before[f] ?? "none"} to ${after[f] ?? "none"}`);
  }
  if (before.valid_until !== after.valid_until) parts.push(after.valid_until === null ? "reopened" : "closed");
  if (before.deleted_at !== after.deleted_at) parts.push(after.deleted_at === null ? "restored from trash" : "moved to trash");
  const added = after.tags.filter((t) => !before.tags.includes(t));
  const removed = before.tags.filter((t) => !after.tags.includes(t));
  if (added.length) parts.push(`tags +${added.join(" +")}`);
  if (removed.length) parts.push(`tags -${removed.join(" -")}`);
  return parts.join(", ") || "no visible change";
}
