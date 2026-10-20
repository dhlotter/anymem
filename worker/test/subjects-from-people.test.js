// The people migration script, against a fake of the Worker. All people are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { personFacts, run, slugOf, urlProblem } from "../../scripts/subjects-from-people.mjs";

const SCRIPT = new URL("../../scripts/subjects-from-people.mjs", import.meta.url).pathname;
const PERSON_KEYS = ["relationship", "known_as", "work", "contact", "birthday"];

const memory = (name, lines, over = {}) => ({ id: `id-${name}`, name, origin: "person", content: `---\nname: ${name}\ndescription: A person.\n---\n\n${lines.join("\n")}\n`, ...over });

const DANA = memory("person-dana", [
  "Relationship: neighbour (confirmed 2026-10-01)",
  "Full name: Dana Reed (confirmed 2026-10-01)",
  "Known as: Dee (confirmed 2026-10-01)",
  "Work: runs the bakery on Main Road (confirmed 2026-10-01)",
  "Birthday: 3 March (confirmed 2026-10-01)",
  "Email: dana@example.com (confirmed 2026-10-01)",
  "Phone: 555 0100 (confirmed 2026-10-01)",
  "Language: English (confirmed 2026-10-01)",
]);
const SAM = memory("person-sam", ["Relationship: friend (confirmed 2026-10-01)", "Work: oncology nurse at the ward (confirmed 2026-10-01)", "Birthday: 1234567890123 (confirmed 2026-10-01)"]);
const JO = memory("person-jo", ["Relationship: colleague (confirmed 2026-10-01)", "Work: possibly at example.com (derived from the domain of jo@example.com, unconfirmed)"]);
const LEE = memory("person-lee", ["Relationship: cousin (confirmed 2026-10-01)"]);
const ODD = [memory("person-x", ["Relationship: friend"]), memory("note-on-people", ["Relationship: friend"]), memory("person-Bad Name", ["Relationship: friend"])];

/** A fake Worker. people is what /list returns for origin person, two to a page. subjects is what /subjects holds, and /subject adds to it. */
function fakeWorker(people, existing = [], { reply } = {}) {
  const api = { subjects: existing.map((slug) => ({ slug })), calls: [], created: [] };
  api.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    api.calls.push({ method, path: u.pathname, search: u.search, headers: init.headers, redirect: init.redirect });
    if (u.pathname === "/list") {
      assert.equal(u.searchParams.get("origin"), "person");
      const from = Number(u.searchParams.get("cursor") ?? 0);
      const next = from + 2;
      return Response.json({ ok: true, entries: people.slice(from, next), next_cursor: next < people.length ? String(next) : null });
    }
    if (u.pathname === "/subjects") return Response.json({ ok: true, subjects: api.subjects });
    if (u.pathname === "/subject" && method === "POST") {
      const body = JSON.parse(init.body);
      api.created.push(body);
      const custom = reply?.(body);
      if (custom) return Response.json(custom.body, { status: custom.status });
      api.subjects.push({ slug: body.slug });
      return Response.json({ ok: true, subject: { id: `card-${body.slug}`, slug: body.slug } });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  };
  return api;
}

const go = (api, apply = false) => {
  const lines = [];
  const done = run({ url: "https://worker.test/", headers: { authorization: "Bearer admin" }, apply, fetchFn: api.fetch, out: (l) => lines.push(l) });
  return done.then((total) => ({ total, lines }));
};

test("a person memory gives the five person fields, with Email and Phone as the contact", () => {
  const { fields, left } = personFacts(DANA.content);
  assert.deepEqual(fields, { relationship: "neighbour", known_as: "Dee", work: "runs the bakery on Main Road", birthday: "3 March", contact: "dana@example.com; 555 0100" });
  assert.deepEqual(left, [], "a Language line is not a person field and is not reported");
  assert.equal(personFacts("Contact: by message\nEmail: dana@example.com").fields.contact, "by message", "a Contact line wins");
});

test("a line about health, money, legal matters or an ID is left out and reported, and so are unconfirmed and long ones", () => {
  const sam = personFacts(SAM.content);
  assert.deepEqual(sam.fields, { relationship: "friend" });
  assert.deepEqual(sam.left.map((l) => l.label), ["Work", "Birthday"]);
  assert.ok(sam.left.every((l) => /health, money, legal or ID/.test(l.why)));
  assert.deepEqual(personFacts(JO.content).left, [{ label: "Work", why: "not confirmed by the person" }]);
  const long = personFacts(`Work: ${"a".repeat(201)}\nRelationship: friend`);
  assert.deepEqual([long.fields, long.left.map((l) => l.why)], [{ relationship: "friend" }, ["longer than 200 characters"]]);
  assert.deepEqual(personFacts("Relationship:\nWork: x (confirmed 2026-10-01)").fields, { work: "x" }, "an empty line gives nothing");
});

test("the slug is what follows person- and has to be a slug a subject can have", () => {
  assert.deepEqual(["person-dana", "person-dana-reed", "person-x", "person-Bad Name", "dana", "person-" + "a".repeat(41), undefined].map(slugOf), ["dana", "dana-reed", null, null, null, null, null]);
});

test("the dry run says what it would create and writes nothing", async () => {
  const api = fakeWorker([DANA, SAM, JO, LEE, ...ODD], ["lee"]);
  const { total, lines } = await go(api);
  assert.deepEqual(api.created, [], "no write in a dry run");
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "GET", "GET", "GET", "GET"], "the subjects once, the seven people in four pages");
  assert.deepEqual(total, { would: 3, created: 0, existing: 1, skipped: 3, failed: 0 });
  assert.ok(lines.includes('would create dana (person) "Dana Reed" relationship="neighbour" known_as="Dee" work="runs the bakery on Main Road" birthday="3 March" contact="dana@example.com; 555 0100"'), lines.join("\n"));
  assert.ok(lines.includes('would create sam (person) "Sam" relationship="friend"'));
  assert.ok(lines.includes("  sam: Work line not written, looks like health, money, legal or ID text"));
  assert.ok(lines.includes("  jo: Work line not written, not confirmed by the person"));
  assert.ok(lines.includes("skip lee: already has a subject"));
  assert.equal(lines.filter((l) => l.startsWith("skip id-")).length, 3, "a name that is not person-<slug> is skipped and named");
  assert.match(lines.at(-1), /^3 would be created, 1 already have one, 3 skipped\. Run again with --apply/);
});

test("--apply creates each subject with only person fields, and a second run finds them all", async () => {
  const api = fakeWorker([DANA, SAM, JO, LEE, ...ODD], ["lee"]);
  const { total, lines } = await go(api, true);
  assert.deepEqual(total, { would: 0, created: 3, existing: 1, skipped: 3, failed: 0 });
  assert.deepEqual(api.created.map((b) => [b.slug, b.kind, b.name]), [["dana", "person", "Dana Reed"], ["sam", "person", "Sam"], ["jo", "person", "Jo"]]);
  assert.deepEqual(api.created[0].fields, { relationship: "neighbour", known_as: "Dee", work: "runs the bakery on Main Road", birthday: "3 March", contact: "dana@example.com; 555 0100" });
  assert.deepEqual(api.created[1].fields, { relationship: "friend" });
  assert.deepEqual(api.created[2].fields, { relationship: "colleague" });
  for (const b of api.created) assert.ok(Object.keys(b.fields).every((k) => PERSON_KEYS.includes(k)), "never a field the person kind does not allow");
  assert.ok(!JSON.stringify(api.created).match(/oncology|1234567890123|possibly/), "the left out lines never reach the Worker");
  assert.ok(lines.includes("created dana (card-dana)"));
  assert.ok(api.calls.every((c) => c.headers.authorization === "Bearer admin" && c.redirect === "manual"));
  const again = await go(api, true);
  assert.deepEqual(again.total, { would: 0, created: 0, existing: 4, skipped: 3, failed: 0 });
  assert.equal(api.created.length, 3, "nothing is written twice");
});

test("a subject that appears between the list and the write is skipped, and one refusal does not stop the rest", async () => {
  const api = fakeWorker([DANA, SAM, JO], [], {
    reply: (b) => (b.slug === "dana" ? { status: 409, body: { ok: false, code: "subject_exists", error: "taken" } } : b.slug === "sam" ? { status: 422, body: { ok: false, code: "refused", error: "no" } } : null),
  });
  const { total, lines } = await go(api, true);
  assert.deepEqual(total, { would: 0, created: 1, existing: 1, skipped: 0, failed: 1 });
  assert.ok(lines.includes("skip dana: already has a subject"));
  assert.ok(lines.includes("failed sam: 422 refused no"));
  assert.ok(lines.includes("created jo (card-jo)"));
});

test("a Worker that refuses the listing stops the run with its answer", async () => {
  const fetchFn = async () => Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
  await assert.rejects(run({ url: "https://worker.test", headers: {}, fetchFn, out: () => {} }), /GET \/subjects answered 401 unauthorized/);
});

test("only https, or http on this machine, may receive the token", () => {
  assert.deepEqual(["https://worker.test", "http://127.0.0.1:8787", "http://localhost:8787", "http://worker.test", "worker.test", "ftp://x.test"].map(urlProblem).map(Boolean), [false, false, false, true, true, true]);
});

test("the command line is a dry run by default, reads the environment, and exits 1 when a write fails", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url.split("?")[0]} ${req.headers.authorization} ${req.headers["cf-access-client-id"] ?? ""}`);
      const send = (status, obj) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
      if (req.url.startsWith("/list")) return send(200, { ok: true, entries: [DANA, JO], next_cursor: null });
      if (req.url === "/subjects") return send(200, { ok: true, subjects: [] });
      return send(JSON.parse(body).slug === "jo" ? 422 : 200, JSON.parse(body).slug === "jo" ? { ok: false, code: "refused" } : { ok: true, subject: { id: "card-dana" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { PATH: process.env.PATH, ANYMEM_URL: `http://127.0.0.1:${server.address().port}`, ANYMEM_TOKEN: "admin", ANYMEM_ACCESS_CLIENT_ID: "cid", ANYMEM_ACCESS_CLIENT_SECRET: "secret" };
  const exec = (args, e = env) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { env: e }).then((r) => ({ code: 0, ...r }), (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }));
  try {
    const dry = await exec([]);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /would create dana/);
    assert.ok(seen.length > 0 && seen.every((s) => s.startsWith("GET ") && s.endsWith("Bearer admin cid")), seen.join("\n"));
    seen.length = 0;
    const applied = await exec(["--apply"]);
    assert.equal(applied.code, 1, "a failed write is a failed run");
    assert.match(applied.stdout, /created dana \(card-dana\)/);
    assert.match(applied.stdout, /failed jo: 422 refused/);
    assert.deepEqual(seen.filter((s) => s.startsWith("POST")).length, 2);
    assert.match((await exec(["--now"])).stderr, /Unknown argument --now/);
    const none = await exec([], { PATH: process.env.PATH });
    assert.deepEqual([none.code, /Set ANYMEM_URL and ANYMEM_TOKEN/.test(none.stderr)], [1, true]);
    const plain = await exec([], { ...env, ANYMEM_URL: "http://worker.test" });
    assert.deepEqual([plain.code, /must be https/.test(plain.stderr)], [1, true]);
  } finally {
    server.close();
  }
});
