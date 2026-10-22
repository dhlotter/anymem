// The harness names. An id is what a client sends in X-Anymem-Harness and what a memory keeps in its harness column.
// client/hm/harnesses.py holds the same list for the client, and a test in each language fails when the two differ.
// To add a harness, add a row here and in that file, then run both test suites.

/** @type {readonly {id: string, label: string, aliases: readonly string[]}[]} */
export const HARNESSES = [
  { id: "claude", label: "Claude Code", aliases: ["claude-code"] },
  { id: "codex", label: "Codex", aliases: [] },
  { id: "agy", label: "Antigravity", aliases: ["antigravity"] },
  { id: "dsh", label: "DSH", aliases: [] },
  { id: "kilo", label: "Kilo", aliases: [] },
  { id: "zcode", label: "ZCode", aliases: [] },
];

/** The dashboard calls the Worker too, but it is a caller and never the harness of a memory. */
export const DASHBOARD = { id: "dashboard", label: "Dashboard" };

/** The Worker's own background work (assignment, proposals, clustering, briefs) writes audit rows as this caller. */
export const SYSTEM = { id: "system", label: "Anymem" };

const byName = new Map(HARNESSES.flatMap((h) => [h.id, ...h.aliases].map((name) => [name, h])));

/** The row of a known id or alias, compared without regard to case. */
export const knownHarness = (name) => byName.get(String(name ?? "").trim().toLowerCase());

/** The id to store. A known alias becomes its id, any other name stays as written. */
export const harnessId = (name) => knownHarness(name)?.id ?? String(name ?? "").trim();

/**
 * The words to show for a memory's harness. A blank harness is Imported when the memory was imported, else Unknown.
 * A name this version does not know is shown as written.
 */
export function harnessLabel(harness, origin = "") {
  const known = knownHarness(harness);
  if (known) return known.label;
  if (harness) return String(harness);
  if (origin === "system") return "Anymem";
  return origin === "import" ? "Imported" : "Unknown";
}

/** The label of a caller in the audit trail, which may also be the dashboard. A blank one sent no name. */
export function callerLabel(name) {
  if (name === DASHBOARD.id) return DASHBOARD.label;
  if (name === SYSTEM.id) return SYSTEM.label;
  return knownHarness(name)?.label ?? (name ? String(name) : "Unknown");
}

/** Every stored value that counts as this harness, in lower case, so a filter by id also finds a row saved under an alias or a case variant. Compare with lower(column). */
export function harnessValues(name) {
  const known = knownHarness(name);
  return known ? [known.id, ...known.aliases] : [String(name).toLowerCase()];
}

/**
 * Rows keyed by a caller's name, added up under one row per id so an alias joins its harness. The first field decides the order,
 * biggest first. A blank name is one row labelled Unknown.
 * @param {{harness: string}[]} rows
 * @param {string[]} fields the numeric fields to add up
 */
export function foldByHarness(rows, fields) {
  const out = new Map();
  for (const r of rows) {
    const id = harnessId(r.harness);
    const row = out.get(id) ?? { harness: id, label: callerLabel(id), ...Object.fromEntries(fields.map((f) => [f, 0])) };
    for (const f of fields) row[f] += Number(r[f] ?? 0);
    out.set(id, row);
  }
  return [...out.values()].sort((a, b) => b[fields[0]] - a[fields[0]] || (a.harness < b.harness ? -1 : 1));
}
