// The replay script, against a fake of the preview route. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { run, sampleLine, sampleOf, SAMPLE_SIZE } from "../../scripts/subjects-replay.mjs";

const SCRIPT = new URL("../../scripts/subjects-replay.mjs", import.meta.url).pathname;

/** n memories, every third linking to Pip and every fifth ambiguous, three to a page. */
function pages(n) {
  const all = Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `note-${i}`,
    snippet: `Pip note ${i}`,
    links: i % 3 === 0 ? [{ slug: "pip", confidence: 1, how: "alias" }] : [],
    ambiguous: i % 5 === 0 ? ["rowan-dog", "rowan-lee"] : [],
    skipped: null,
  }));
  return (from) => ({ ok: true, memories: all.slice(from, from + 3), next_cursor: from + 3 < n ? String(from + 3) : null });
}

function fakeWorker(page, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, days: u.searchParams.get("days"), cursor: u.searchParams.get("cursor"), headers: init.headers, redirect: init.redirect });
    return Response.json(status === 200 ? page(Number(u.searchParams.get("cursor") ?? 0)) : { error: "no", code: "forbidden" }, { status });
  };
  return { fetch, calls };
}

test("it walks every page, counts what it saw, and never follows a redirect", async () => {
  const w = fakeWorker(pages(10));
  const lines = [];
  const r = await run({ url: "https://worker.test/", headers: { authorization: "Bearer admin" }, days: 14, fetchFn: w.fetch, out: (l) => lines.push(l) });
  assert.deepEqual({ seen: r.seen, linking: r.linking, links: r.links, ambiguous: r.ambiguous, failed: r.failed }, { seen: 10, linking: 4, links: 4, ambiguous: 2, failed: 0 });
  assert.deepEqual(w.calls.map((c) => c.cursor), [null, "3", "6", "9"]);
  assert.ok(w.calls.every((c) => c.path === "/admin/subjects/assign-preview" && c.days === "14" && c.redirect === "manual" && c.headers.authorization === "Bearer admin"));
  assert.deepEqual(lines, ["10 memories seen in the last 14 days", "4 would link, 4 links in all", "2 have an ambiguous name and would link to neither"]);
});

test("the sample is at most 40 would-be links, each once, one tab separated line each", async () => {
  const many = pages(300);
  const r = await run({ url: "https://worker.test", headers: {}, fetchFn: fakeWorker(many).fetch, out: () => {} });
  assert.equal(r.links, 100);
  assert.equal(r.sample.length, SAMPLE_SIZE);
  assert.equal(new Set(r.sample).size, SAMPLE_SIZE);
  for (const line of r.sample) assert.match(line, /^note-\d+\tPip note \d+\tpip\t1\talias$/);
  const few = await run({ url: "https://worker.test", headers: {}, fetchFn: fakeWorker(pages(7)).fetch, out: () => {} });
  assert.equal(few.sample.length, 3);
});

test("the sample is random, and a tab or line break in a value cannot break the columns", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  assert.notDeepEqual(sampleOf(items, 40, () => 0.1), sampleOf(items, 40, () => 0.9));
  assert.deepEqual(sampleOf(items, 3, () => 0.5).length, 3);
  assert.equal(sampleLine({ name: "a\tb", snippet: "line one\nline two", slug: "pip", confidence: 0.54, how: "vote" }), "a b\tline one line two\tpip\t0.54\tvote");
});

test("a refusal from the Worker stops the run with the status", async () => {
  await assert.rejects(run({ url: "https://worker.test", headers: {}, fetchFn: fakeWorker(pages(1), { status: 403 }).fetch, out: () => {} }), /answered 403 forbidden/);
});

test("a memory that could not be checked is counted", async () => {
  const page = () => ({ ok: true, memories: [{ id: "a", name: "n", snippet: "s", links: [], ambiguous: [], skipped: "error" }], next_cursor: null });
  const r = await run({ url: "https://worker.test", headers: {}, fetchFn: fakeWorker(page).fetch, out: () => {} });
  assert.equal(r.failed, 1);
});

test("the command line reads the environment, writes the sample file, and refuses bad input", async () => {
  const seen = [];
  const page = pages(5);
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(`${u.pathname} ${req.headers.authorization} ${req.headers["cf-access-client-id"]}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(page(Number(u.searchParams.get("cursor") ?? 0))));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const env = { PATH: process.env.PATH, ANYMEM_URL: `http://127.0.0.1:${server.address().port}`, ANYMEM_TOKEN: "admin", ANYMEM_ACCESS_CLIENT_ID: "cid", ANYMEM_ACCESS_CLIENT_SECRET: "secret" };
  const exec = (args, e = env) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { env: e }).then((r) => ({ code: 0, ...r }), (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }));
  try {
    const out = join(dir, "sample.tsv");
    const done = await exec(["--days", "3", "--sample", out]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /5 memories seen in the last 3 days/);
    assert.match(done.stdout, /2 would-be links written to/);
    assert.deepEqual(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("\t")[0]).sort(), ["note-0", "note-3"]);
    assert.ok(seen.length > 0 && seen.every((s) => s === "/admin/subjects/assign-preview Bearer admin cid"), seen.join("\n"));
    assert.match((await exec([])).stderr, /--sample FILE/);
    assert.match((await exec(["--sample", out, "--days", "0"])).stderr, /--days must be/);
    assert.match((await exec(["--sample", out, "--now"])).stderr, /Unknown argument --now/);
    assert.match((await exec(["--sample"])).stderr, /--sample needs a value/);
    assert.match((await exec(["--sample", out], { PATH: process.env.PATH })).stderr, /Set ANYMEM_URL and ANYMEM_TOKEN/);
    assert.match((await exec(["--sample", out], { ...env, ANYMEM_URL: "http://worker.test" })).stderr, /must be https/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
