// Development only. Never deployed (wrangler does not bundle this folder, and it is not in the assets folder).
// Runs the real Worker code on http://127.0.0.1:8787 over in-memory fakes of D1, Vectorize and AI, serves the dashboard from
// ../ui, signs a browser login for you on every request, and seeds a few memories, some with hostile text.
//   node worker/dev/dev-server.js [port]
import { createServer } from "node:http";
import { createWorker } from "../index.js";
import { createKeyCache } from "../auth.js";
import { migratedDb } from "../test/helpers/app.js";
import { FakeAI, FakeR2, FakeVectorize } from "../test/helpers/fakes.js";
import { fakeAssets } from "../test/helpers/ui.js";
import { AUD, TEAM, browserClaims, certsFetch, createIssuer } from "../test/helpers/jwt.js";

const PORT = Number(process.argv[2] ?? 8787);
const HOST = "127.0.0.1";
const ADMIN = "dev-admin-token-not-a-secret-0123456789";

const issuer = createIssuer();
const worker = createWorker({ fetch: certsFetch([issuer]), now: Date.now, cache: createKeyCache() });
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const env = {
  DB: await migratedDb(),
  VECTORIZE: new FakeVectorize(),
  AI: new FakeAI(),
  BACKUP_BUCKET: new FakeR2(),
  ASSETS: fakeAssets,
  AUTH_TOKEN: ADMIN,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ACCESS_SERVICE_COMMON_NAMES: "dev.access",
  ACCESS_ALLOWED_EMAILS: "dev@example.com",
  ACCESS_TOKEN_EXPIRES: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
};

const login = () => issuer.sign(browserClaims(Date.now(), "dev@example.com", { exp: Math.floor(Date.now() / 1000) + 3600 }));

async function handle(req, res) {
  const url = `http://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("cf-access-jwt-assertion", login());
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const out = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, ctx);
  await Promise.all(pending.splice(0));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}

// Seed through the real routes with the admin token.
async function seed(path, method, body) {
  const res = await worker.fetch(new Request(`http://${HOST}:${PORT}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "cf-access-jwt-assertion": issuer.sign({ iss: `https://${TEAM}`, aud: [AUD], common_name: "dev.access", exp: Math.floor(Date.now() / 1000) + 3600 }), "content-type": "application/json" }, body: body && JSON.stringify(body) }), env, ctx);
  await Promise.all(pending.splice(0));
  return res.json();
}
const note = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const memories = [
  [note("identity", "who I am", "I am Alex. I build with plain JavaScript and keep things small."), ["capsule:core", "capsule-slot:identity", "status:canonical"]],
  [note("preferences", "how I like to work", "1. Short answers.\n2. Lead with the result."), ["capsule:core", "capsule-slot:preferences", "status:canonical"]],
  [note("constraints", "hard rules", "No dashes as connectors."), ["capsule:core", "capsule-slot:constraints", "status:canonical"]],
  [note("principles", "worldview", "Analyze, optimize, automate."), ["capsule:core", "capsule-slot:principles", "status:canonical"]],
  [note("profile", "The user's own details", "Full name: Alex Example\nEmail: alex@example.com (confirmed 2026-10-01)\nTimezone: Africa/Johannesburg (confirmed 2026-10-01)"), ["profile", "name", "email", "status:canonical"], { source: "profile" }],
  [note("person-alvin", "What the user needs to know about Alvin", "Relationship: neighbour (confirmed 2026-10-01)\nEmail: alvin@example.com"), ["person", "person:alvin"], { source: "person" }],
  [note("profile-proposal-phone", "A proposed change to the profile", "Proposed Phone: 082 555 0100\nCurrent Phone: 082 555 0199\nSaid on 2026-10-16"), ["profile-proposal", "status:pending"], { source: "profile" }],
  [note("Recall uses reciprocal rank fusion", "How recall merges vector and keyword results", "Vector search and FTS5 keyword search run in parallel and are merged by rank."), ["recall", "search"], { project: "anymem" }],
  [note("<script>alert('name')</script>", "<img src=x onerror=alert(1)>", "</pre><script>alert('body')</script>\n**bold** [link](javascript:alert(1)) `code` <b>html</b>\n\" onmouseover=\"alert(1)"), ["<b>tag</b>", "x\"y"], {}],
  ["A captured note about a Cloudflare Worker limit that nobody recalled yet.", ["status:active"], { source: "session-capture" }],
];
const ids = [];
for (const [content, tags, extra] of memories) ids.push((await seed("/capture", "POST", { content, tags, ...extra })).id);
await seed("/append", "POST", { id: ids[7], addition: "Added a second paragraph later." });
await seed("/update", "POST", { id: ids[7], content: note("Recall uses reciprocal rank fusion", "How recall merges vector and keyword results", "Vector search and FTS5 keyword search run in parallel and merged by rank, with a rare word boost.") });
await seed("/link", "POST", { source_id: ids[7], target_id: ids[9], type: "related" });
await seed("/forget", "POST", { id: ids[9] });
const extra = (await seed("/capture", "POST", { content: "A memory in the trash that can still be restored.", tags: [] })).id;
await seed("/forget", "POST", { id: extra });
await env.DB.prepare("INSERT INTO runs (job, started_at, finished_at, ok, summary) VALUES ('nightly', ?, ?, 1, ?)").bind(Date.now() - 3_600_000, Date.now() - 3_500_000, JSON.stringify({ audit_purged: 12, merged: 1, retired: 0, purged: 2 })).run();

createServer((req, res) => handle(req, res).catch((err) => (console.error(err), res.writeHead(500).end("dev server error")))).listen(PORT, HOST, () => console.log(`dashboard on http://${HOST}:${PORT}/ (dev only, fake data)`));
