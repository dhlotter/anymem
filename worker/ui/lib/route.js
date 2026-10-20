// Hash routes. #/home, #/search?q=, #/memories, #/memories/<id>, #/activity, #/trash, #/capsule, #/people, #/subjects, #/health, #/audit. Pure.
// The old #/browse and #/memory/<id> links still work and land on the memories screen.

/** The sidebar, in order. A group is a stretch of the list that sits together, with a hairline between groups. */
export const NAV = [
  { name: "home", label: "Home", icon: "home", group: 0 },
  { name: "search", label: "Search", icon: "search", group: 0 },
  { name: "memories", label: "Memories", icon: "memories", group: 1 },
  { name: "activity", label: "Activity", icon: "activity", group: 1 },
  { name: "trash", label: "Trash", icon: "trash", group: 1 },
  { name: "capsule", label: "Capsule", icon: "capsule", group: 2 },
  { name: "people", label: "People", icon: "people", group: 2 },
  { name: "subjects", label: "Subjects", icon: "subjects", group: 2 },
  { name: "health", label: "Health", icon: "health", group: 3 },
  { name: "audit", label: "Audit", icon: "audit", group: 3 },
];
const ALIASES = { browse: "memories", memory: "memories" };
const KNOWN = new Set(NAV.map((n) => n.name));

/**
 * @returns {{name: string, arg: string, params: Record<string, string>}} an unknown or empty hash is the home screen
 */
export function parseHash(hash) {
  const [path, ...query] = String(hash ?? "").replace(/^#\/?/, "").split("?");
  const [first, ...rest] = path.split("/");
  const name = Object.hasOwn(ALIASES, first) ? ALIASES[first] : first;
  if (!KNOWN.has(name)) return { name: "home", arg: "", params: {} };
  let arg = rest.join("/");
  try {
    arg = decodeURIComponent(arg);
  } catch {
    arg = "";
  }
  const params = {};
  for (const [k, v] of new URLSearchParams(query.join("?"))) if (!Object.hasOwn(params, k)) params[k] = v;
  return { name, arg, params };
}

/** The hash for a screen, with an optional id and the filters that are not empty. */
export function hashFor(name, { arg = "", params = {} } = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && String(v) !== "")).toString();
  return `#/${name}${arg ? `/${encodeURIComponent(arg)}` : ""}${q ? `?${q}` : ""}`;
}

export const memoryLink = (id) => hashFor("memories", { arg: id });
