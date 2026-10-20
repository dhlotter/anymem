// The profile memory and the pending changes, a port of client/hm/commands/profile.py. Pure.
// The profile is one memory tagged `profile`, a few labelled lines. A pending change is a memory named
// profile-proposal-<field> that says "Proposed <Label>: <value>".

/** key: [label in the memory, the extra tags that let a question find the profile] */
export const FIELDS = {
  name: ["Full name", ["name"]],
  "preferred-name": ["Preferred name", ["name"]],
  email: ["Email", ["email", "contact"]],
  phone: ["Phone", ["phone", "telephone", "mobile", "cell", "contact"]],
  address: ["Home address", ["address", "home"]],
  "postal-address": ["Postal address", ["address", "postal"]],
  work: ["Work", ["work", "employer", "job"]],
  "work-address": ["Work address", ["address", "work"]],
  language: ["Language", ["language"]],
  timezone: ["Timezone", ["timezone"]],
  units: ["Units", ["units"]],
  "last-name": ["Last name", ["name"]],
};
const LABELS = Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [v[0], k]));
const HEAD =
  "---\nname: profile\ndescription: The user's own details: my full name, my phone number, my email address, my home street address, " +
  "where I live, who I work for, my timezone and units. Kept up to date by anymem.\nmetadata:\n  type: user\n---\n\n";

const bodyOf = (content) => String(content ?? "").replace(/^---[\s\S]*?---\s*/, "");

/** {field key: {value, note}} from the lines of a profile memory. */
export function parseFacts(content) {
  const out = {};
  for (const line of bodyOf(content).split("\n")) {
    const m = /^([A-Za-z][A-Za-z ]+):\s*(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(line);
    if (m && LABELS[m[1]]) out[LABELS[m[1]]] = { value: m[2], note: m[3] ?? "" };
  }
  return out;
}

/** The memory text for a set of facts. */
export function renderFacts(facts) {
  const lines = Object.keys(FIELDS).filter((k) => facts[k]).map((k) => `${FIELDS[k][0]}: ${facts[k].value}${facts[k].note ? ` (${facts[k].note})` : ""}`);
  return `${HEAD}${lines.join("\n")}\n`;
}

/** The plain tags a profile with these facts carries. */
export function tagsFor(facts) {
  const tags = ["profile"];
  for (const key of Object.keys(facts)) for (const t of FIELDS[key]?.[1] ?? []) if (!tags.includes(t)) tags.push(t);
  return tags;
}

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The facts with one value set and marked as confirmed today. Throws on an empty value or an unknown field. */
export function setFact(facts, key, value, when = new Date()) {
  if (!FIELDS[key]) throw new Error("unknown profile field");
  const clean = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!clean) throw new Error("the value is empty");
  return { ...facts, [key]: { value: clean, note: `confirmed ${day(when)}` } };
}

/** The profile memory among entries: tagged profile and named profile. */
export const findProfile = (entries) => (entries ?? []).find((e) => e.tags?.includes("profile") && /^name:\s*profile\s*$/m.test(e.content ?? "")) ?? null;

/** The field a pending change is for, or empty text. */
export const pendingField = (entry) => /^name:\s*profile-proposal-(\S+)/m.exec(entry?.content ?? "")?.[1] ?? "";

/** The proposed value of a pending change, or empty text. */
export const pendingValue = (entry) => /^Proposed [^:\n]+:\s*(.+?)\s*$/m.exec(entry?.content ?? "")?.[1] ?? "";

/** The current value a pending change was written against, or empty text. */
export const pendingCurrent = (entry) => /^Current [^:\n]+:\s*(.+?)\s*$/m.exec(entry?.content ?? "")?.[1] ?? "";

/** The labelled lines of a person note, in order, as [label, value, note]. */
export function personLines(content) {
  const rows = [];
  for (const line of bodyOf(content).split("\n")) {
    const m = /^([A-Za-z][A-Za-z -]+):\s*(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(line);
    if (m) rows.push([m[1], m[2], m[3] ?? ""]);
  }
  return rows;
}
