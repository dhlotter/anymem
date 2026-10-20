// A line by line difference between two versions of a memory. Pure. Longest common subsequence over lines.

const MAX_LINES = 1500; // above this the cost grows too much, so the two texts are shown as one removal and one addition

/**
 * @param {string} before
 * @param {string} after
 * @returns {{type: "same" | "add" | "del", text: string}[]}
 */
export function diffLines(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return [...a.map((text) => ({ type: "del", text })), ...b.map((text) => ({ type: "add", text }))];
  // table[i][j] is the length of the common run of a[i..] and b[j..]
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (out.push({ type: "same", text: a[i] }), i++, j++);
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ type: "del", text: a[i++] });
  while (j < b.length) out.push({ type: "add", text: b[j++] });
  return out;
}

/** How many lines were added and removed. */
export function diffCounts(ops) {
  return { added: ops.filter((o) => o.type === "add").length, removed: ops.filter((o) => o.type === "del").length };
}

/** Collapse long runs of unchanged lines to a few lines of context around each change. */
export function withContext(ops, context = 2) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type !== "same") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) (out.push({ type: "skip", text: `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` }), (skipped = 0));
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ type: "skip", text: `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` });
  return out;
}
