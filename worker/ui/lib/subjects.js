// What the dashboard knows about subjects, and the pure helpers around it. No DOM, no network.
// The kinds, statuses and field keys are the Worker's (worker/subjects/store.js), kept here so a form offers exactly what it accepts.
import { hashFor } from "./route.js";

export const KINDS = ["person", "pet", "asset", "project", "area", "topic"];
export const STATUSES = ["proposed", "active", "stale", "retired"];
export const SCOPES = ["shared", "private"];
export const FIELD_KEYS = {
  person: ["relationship", "known_as", "work", "contact", "birthday"],
  pet: ["name", "species", "breed", "born", "vet", "status", "health_note"],
  asset: ["type", "name", "identifier", "acquired", "status", "value_note"],
  project: ["what", "status", "owner", "repo"],
  area: ["what", "status"],
  topic: ["what"],
};
export const FILTER_KEYS = ["kind", "status", "scope", "q", "sort"];

/** Lowercase letters and digits with single dashes between them, 2 to 40 characters, the Worker's slug rule. */
export const validSlug = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length >= 2 && s.length <= 40;

/** "known_as" as "Known as". */
export const fieldLabel = (key) => `${key[0].toUpperCase()}${key.slice(1).replace(/_/g, " ")}`;

/** The query string GET /subjects takes. Sorting is done here, because a person's subjects fit on one page. */
export const subjectQuery = (f) => new URLSearchParams(["kind", "status", "scope", "q"].filter((k) => f[k]).map((k) => [k, f[k]])).toString();

/** The address of a subject drawer, keeping the filters that are set. */
export const subjectHref = (slug, filters = {}) => hashFor("subjects", { params: { ...filters, subject: slug } });

/** The list in the order asked for. Updated and Members start with the most, Name with A. A tie keeps the Worker's order, newest first. */
export function sortSubjects(list, sort = "updated") {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    members: (a, b) => b.member_count - a.member_count,
    updated: (a, b) => b.updated_at - a.updated_at,
  }[sort] ?? (() => 0);
  return list.map((s, i) => [s, i]).sort(([a, i], [b, j]) => by(a, b) || i - j).map(([s]) => s);
}

/** The subjects a memory is about: its outgoing about links whose other end is a card in the list. Each subject once, in link order. */
export function subjectsOf(links, subjects) {
  if (!links || !subjects) return [];
  const seen = new Set();
  return links.filter((l) => l.type === "about" && l.direction === "out").flatMap((l) => {
    const s = subjects.find((x) => x.id === l.other_id);
    return s && !seen.has(s.id) && seen.add(s.id) ? [s] : [];
  });
}

/** A brief written by hand. The Worker sets brief_pinned when a person saves a brief, and the nightly step then leaves it alone. Same reading as the Worker's isPinned. */
export function briefPinned(fields) {
  const f = fields?.brief_pinned;
  if (f === undefined || f === null) return false;
  const v = typeof f === "object" ? f.value : f;
  return v !== undefined && v !== null && v !== false && !["", "0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
}

const STALE_WORDS = {
  bad_shape: "the model's answer was not in the shape the brief needs",
  too_long: "the brief it wrote was too long",
  no_citation: "a line cited no memory",
  foreign_id: "a line cited a memory that is not about this subject",
  trashed_member: "a line cited a memory that was trashed or replaced",
  uncited_number: "a line had a number or a date that no cited memory says",
  instruction: "a line read like an instruction",
  bad_card: "the card could not hold a brief",
};

/** Why a brief is stale, in plain words. A reason the dashboard does not know is shown as it is, with the dots and underscores made spaces. */
export function staleWords(reason) {
  const text = String(reason ?? "").trim();
  if (!text) return "";
  if (STALE_WORDS[text]) return STALE_WORDS[text];
  const fail = /^model\.fail(?:\.(\d+))?$/.exec(text);
  if (fail) return fail[1] ? `the model did not answer ${fail[1]} nights in a row` : "the model did not answer";
  return text.replace(/[._]+/g, " ");
}
