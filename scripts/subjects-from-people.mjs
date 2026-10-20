#!/usr/bin/env node
// Makes a subject of kind person for each person memory (origin person) that has none yet. The person memory stays as it is,
// it is the data, so no link is written. Each subject takes its slug from the memory name (person-dana gives dana) and its
// fields from the labelled lines of the memory: Relationship, Known as, Work, Birthday, and Contact (or Email and Phone, which
// is how client/hm/commands/person.py records contact details).
//
//   node scripts/subjects-from-people.mjs            show what would be created, change nothing
//   node scripts/subjects-from-people.mjs --apply    create the subjects
//
// Reads ANYMEM_URL and ANYMEM_TOKEN (the admin token, a device token cannot write a card) from the environment, and
// ANYMEM_ACCESS_CLIENT_ID and ANYMEM_ACCESS_CLIENT_SECRET when the Worker sits behind Access. Safe to run again: a person that
// has a subject is skipped. A line that looks like health, money, legal or ID text, that is not confirmed, or that is too long
// is never written, and is reported instead.
import { fileURLToPath } from "node:url";

const MAX_VALUE = 200;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PAGE = 500;

// Label of a person memory line to the field of a person subject. A person memory has no Contact line when it was made by
// `person.py`, which writes Email and Phone, so those two fill contact when there is no Contact line.
const FIELD_OF = { Relationship: "relationship", "Known as": "known_as", Work: "work", Contact: "contact", Birthday: "birthday" };
const LABELS = [...Object.keys(FIELD_OF), "Email", "Phone"];

// The topics anymem never records, the same word list as worker/write/screen.js.
const BLOCKED_RE = new RegExp(
  "\\b(?:diagnos\\w*|cancer|oncolog\\w*|chemo\\w*|tumou?rs?|prostate|medications?|prescriptions?|surger\\w+|surgeon|hospital\\w*|symptoms?|" +
    "therap(?:y|ist)\\w*|medical|blood pressure|dementia|depress(?:ion|ed)|anxiety|illness|disease|" +
    "salary|payslip|bank balance|account number|iban|card number|credit card|tax return|" +
    "lawsuit|litigation|attorney|solicitor|divorce|custody|last will|deceased estate|court (?:order|case)|subpoena|" +
    "id number|identity number|passport number|social security number)\\b|(?<!\\d)\\d{13}(?!\\d)",
  "i",
);

/**
 * The person fields a memory holds, and the lines that were left out with the reason.
 * @param {string} content the whole memory, frontmatter included
 * @returns {{fields: Record<string, string>, left: {label: string, why: string}[]}}
 */
export function personFacts(content) {
  const body = String(content ?? "").replace(/^---.*?---\s*/s, "");
  const lines = {};
  const left = [];
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z][A-Za-z ]+):\s*(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(line);
    if (!m || !LABELS.includes(m[1])) continue;
    const [, label, raw, note = ""] = m;
    const value = raw.split(/\s+/).filter(Boolean).join(" ");
    if (!value) continue;
    if (BLOCKED_RE.test(`${label} ${value}`)) left.push({ label, why: "looks like health, money, legal or ID text" });
    else if (/unconfirmed/i.test(note)) left.push({ label, why: "not confirmed by the person" });
    else if (value.length > MAX_VALUE) left.push({ label, why: `longer than ${MAX_VALUE} characters` });
    else lines[label] = value;
  }
  const fields = {};
  for (const [label, key] of Object.entries(FIELD_OF)) if (lines[label] && key !== "contact") fields[key] = lines[label];
  const contact = lines.Contact ?? [lines.Email, lines.Phone].filter(Boolean).join("; ");
  if (contact && contact.length <= MAX_VALUE) fields.contact = contact;
  else if (contact) left.push({ label: "Contact", why: `longer than ${MAX_VALUE} characters` });
  return { fields, left };
}

/** The slug a person memory gives its subject, or null when the name is not person-<slug> or the slug is not one a subject can have. */
export function slugOf(name) {
  const m = /^person-(.+)$/.exec(String(name ?? ""));
  return m && m[1].length >= 2 && m[1].length <= 40 && SLUG.test(m[1]) ? m[1] : null;
}

/** The name a person goes by on the card: a Full name line, else Known as, else the slug in capitals. */
function displayName(content, slug) {
  const body = String(content ?? "").replace(/^---.*?---\s*/s, "");
  for (const label of ["Full name", "Known as"]) {
    const m = new RegExp(`^${label}:\\s*(.*?)(?:\\s+\\([^()]*\\))?\\s*$`, "m").exec(body);
    if (m?.[1] && m[1].length <= 80) return m[1].split(/\s+/).join(" ");
  }
  return slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** Why this Worker address must not receive the token, or "" when it may. Plain http is only for this machine. */
export function urlProblem(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "it is not an address";
  }
  if (u.protocol === "https:") return "";
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? "" : "it must be https://, or http:// for this machine";
}

async function call(fetchFn, base, headers, path, init = {}) {
  // A redirect is never followed, so the token never reaches an address the person did not configure.
  const res = await fetchFn(base + path, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) }, redirect: "manual" });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const fail = (path, r) => new Error(`${path} answered ${r.status} ${r.body?.code ?? r.body?.error ?? ""}`.trim());

/** Every person memory, a page at a time. */
async function people(fetchFn, base, headers) {
  const out = [];
  let cursor = null;
  do {
    const path = `/list?origin=person&n=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await call(fetchFn, base, headers, path);
    if (r.status !== 200) throw fail("GET /list", r);
    out.push(...(r.body.entries ?? []));
    cursor = r.body.next_cursor ?? null;
  } while (cursor);
  return out;
}

/**
 * Create a person subject for each person memory that has none. Dry run unless apply is set.
 * @param {{url: string, headers: Record<string, string>, apply?: boolean, fetchFn?: typeof fetch, out?: (line: string) => void}} args
 * @returns {Promise<{would: number, created: number, existing: number, skipped: number, failed: number}>}
 */
export async function run({ url, headers, apply = false, fetchFn = fetch, out = console.log }) {
  const base = url.replace(/\/+$/, "");
  const listed = await call(fetchFn, base, headers, "/subjects");
  if (listed.status !== 200) throw fail("GET /subjects", listed);
  const taken = new Set((listed.body.subjects ?? []).map((s) => s.slug));
  const total = { would: 0, created: 0, existing: 0, skipped: 0, failed: 0 };
  for (const memory of await people(fetchFn, base, headers)) {
    const slug = slugOf(memory.name);
    if (!slug) {
      total.skipped++;
      out(`skip ${memory.id}: the name ${JSON.stringify(memory.name ?? "")} is not person-<slug> with a usable slug`);
      continue;
    }
    if (taken.has(slug)) {
      total.existing++;
      out(`skip ${slug}: already has a subject`);
      continue;
    }
    const { fields, left } = personFacts(memory.content);
    for (const l of left) out(`  ${slug}: ${l.label} line not written, ${l.why}`);
    const name = displayName(memory.content, slug);
    const summary = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    if (!apply) {
      total.would++;
      out(`would create ${slug} (person) ${JSON.stringify(name)}${summary ? ` ${summary}` : ""}`);
      continue;
    }
    const r = await call(fetchFn, base, headers, "/subject", { method: "POST", body: JSON.stringify({ slug, kind: "person", name, fields }) });
    if (r.status === 200 && r.body.ok) {
      taken.add(slug);
      total.created++;
      out(`created ${slug} (${r.body.subject?.id ?? "no id"})`);
    } else if (r.body?.code === "subject_exists") {
      total.existing++;
      out(`skip ${slug}: already has a subject`);
    } else {
      total.failed++;
      out(`failed ${slug}: ${r.status} ${r.body?.code ?? ""} ${r.body?.error ?? ""}`.trimEnd());
    }
  }
  out(apply ? `${total.created} created, ${total.existing} already had one, ${total.skipped} skipped, ${total.failed} failed` : `${total.would} would be created, ${total.existing} already have one, ${total.skipped} skipped. Run again with --apply to write them.`);
  return total;
}

async function main(argv, env) {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length) throw new Error(`Unknown argument ${unknown[0]}. The only option is --apply.`);
  if (!env.ANYMEM_URL || !env.ANYMEM_TOKEN) throw new Error("Set ANYMEM_URL and ANYMEM_TOKEN (the admin token) in the environment.");
  const problem = urlProblem(env.ANYMEM_URL);
  if (problem) throw new Error(`ANYMEM_URL is refused: ${problem}.`);
  const headers = { authorization: `Bearer ${env.ANYMEM_TOKEN}` };
  if (env.ANYMEM_ACCESS_CLIENT_ID) {
    headers["cf-access-client-id"] = env.ANYMEM_ACCESS_CLIENT_ID;
    headers["cf-access-client-secret"] = env.ANYMEM_ACCESS_CLIENT_SECRET ?? "";
  }
  const total = await run({ url: env.ANYMEM_URL, headers, apply });
  if (total.failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv, process.env).catch((err) => {
    console.error(`subjects-from-people failed: ${err.message}`);
    process.exit(1);
  });
}
