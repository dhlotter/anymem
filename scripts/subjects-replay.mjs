#!/usr/bin/env node
// Replays recent memories through subject assignment and shows what it WOULD link. Nothing is written to the store.
// It walks GET /admin/subjects/assign-preview a few memories at a time, prints a summary, and saves a random sample of the
// would-be links to a file, so a person can read them and say how many are wrong before SUBJECTS_AUTO is switched on.
//
//   node scripts/subjects-replay.mjs --sample links.tsv            the last 7 days
//   node scripts/subjects-replay.mjs --days 30 --sample links.tsv  the last 30 days
//
// The sample file has one link a line, tab separated: memory name, snippet, subject slug, confidence, how.
// The snippets are memory text, so keep the file out of any repository.
// Reads ANYMEM_URL and ANYMEM_TOKEN (the admin token, a device token is refused by the route) from the environment, and
// ANYMEM_ACCESS_CLIENT_ID and ANYMEM_ACCESS_CLIENT_SECRET when the Worker sits behind Access.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { urlProblem } from "./subjects-from-people.mjs";

export const SAMPLE_SIZE = 40;
const MAX_PAGES = 5000;

async function call(fetchFn, base, headers, path) {
  // A redirect is never followed, so the token never reaches an address the person did not configure.
  const res = await fetchFn(base + path, { headers, redirect: "manual" });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** n items picked at random, each once. */
export function sampleOf(items, n, random = Math.random) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/** One line of the sample file. A tab or a line break inside a value would break the columns, so each becomes a space. */
export const sampleLine = (l) => [l.name, l.snippet, l.slug, l.confidence, l.how].map((v) => String(v ?? "").replace(/[\t\r\n]+/g, " ")).join("\t");

/**
 * @param {{url: string, headers: Record<string, string>, days?: number, fetchFn?: typeof fetch, random?: () => number, out?: (line: string) => void}} args
 * @returns {Promise<{seen: number, linking: number, links: number, ambiguous: number, failed: number, sample: string[]}>}
 */
export async function run({ url, headers, days = 7, fetchFn = fetch, random = Math.random, out = console.log }) {
  const base = url.replace(/\/+$/, "");
  const total = { seen: 0, linking: 0, links: 0, ambiguous: 0, failed: 0 };
  const wouldLink = [];
  let cursor = "";
  let pages = 0;
  do {
    const r = await call(fetchFn, base, headers, `/admin/subjects/assign-preview?days=${days}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) throw new Error(`GET /admin/subjects/assign-preview answered ${r.status} ${r.body?.code ?? r.body?.error ?? ""}`.trim());
    for (const m of r.body.memories ?? []) {
      total.seen++;
      if (m.skipped === "error") total.failed++;
      if (m.links.length) total.linking++;
      if (m.ambiguous.length) total.ambiguous++;
      total.links += m.links.length;
      for (const l of m.links) wouldLink.push({ name: m.name ?? "", snippet: m.snippet, slug: l.slug, confidence: l.confidence, how: l.how });
    }
    cursor = r.body.next_cursor ?? "";
    if (++pages > MAX_PAGES) throw new Error("The preview did not end after 5000 pages, so it was stopped.");
  } while (cursor);
  out(`${total.seen} memories seen in the last ${days} days`);
  out(`${total.linking} would link, ${total.links} links in all`);
  out(`${total.ambiguous} have an ambiguous name and would link to neither`);
  if (total.failed) out(`${total.failed} could not be checked`);
  return { ...total, sample: sampleOf(wouldLink, SAMPLE_SIZE, random).map(sampleLine) };
}

function parseArgs(args) {
  const opts = { days: 7, sample: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days" || a === "--sample") {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      if (a === "--sample") opts.sample = v;
      else {
        if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 365) throw new Error("--days must be a whole number from 1 to 365.");
        opts.days = Number(v);
      }
    } else throw new Error(`Unknown argument ${a}. The options are --days N and --sample FILE.`);
  }
  if (!opts.sample) throw new Error("Name the file for the sample of would-be links with --sample FILE.");
  return opts;
}

async function main(argv, env) {
  const { days, sample } = parseArgs(argv.slice(2));
  if (!env.ANYMEM_URL || !env.ANYMEM_TOKEN) throw new Error("Set ANYMEM_URL and ANYMEM_TOKEN (the admin token) in the environment.");
  const problem = urlProblem(env.ANYMEM_URL);
  if (problem) throw new Error(`ANYMEM_URL is refused: ${problem}.`);
  const headers = { authorization: `Bearer ${env.ANYMEM_TOKEN}` };
  if (env.ANYMEM_ACCESS_CLIENT_ID) {
    headers["cf-access-client-id"] = env.ANYMEM_ACCESS_CLIENT_ID;
    headers["cf-access-client-secret"] = env.ANYMEM_ACCESS_CLIENT_SECRET ?? "";
  }
  const result = await run({ url: env.ANYMEM_URL, headers, days });
  writeFileSync(sample, result.sample.map((l) => `${l}\n`).join(""));
  console.log(`${result.sample.length} would-be links written to ${sample}`);
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv, process.env).catch((err) => {
    console.error(`subjects-replay failed: ${err.message}`);
    process.exit(1);
  });
}
