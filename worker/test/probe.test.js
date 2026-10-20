// The vector probe behind the skill's `doctor.py --probe`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { FakeVectorize } from "./helpers/fakes.js";
import { indexAll, runNightly, seed } from "./helpers/maintenance.js";

const start = (app, opts) => app.call("/vectorize-probe", { method: "POST", body: {}, ...opts });
const read = (app, nonce, opts) => app.call(`/vectorize-probe?probe=${nonce}`, opts);

test("a probe writes one reserved vector and finds it with and without the filter", async () => {
  const app = await createApp();
  const started = await start(app);
  assert.equal(started.status, 200);
  assert.match(started.json.probe, /^[0-9a-f]{16}$/);
  const vectors = [...app.env.VECTORIZE.vectors.values()];
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].id, `${started.json.probe}:probe:0`);
  assert.equal(vectors[0].values.length, 384);
  assert.equal(vectors[0].metadata.origin, "probe");
  const seen = await read(app, started.json.probe);
  assert.deepEqual([seen.status, seen.json.filtered, seen.json.unfiltered], [200, true, true]);
});

test("a new probe deletes the previous probe vector, so only one exists", async () => {
  const app = await createApp();
  const first = (await start(app)).json.probe;
  const second = (await start(app)).json.probe;
  assert.notEqual(first, second);
  assert.equal(app.env.VECTORIZE.vectors.size, 1);
  assert.deepEqual([(await read(app, first)).json.filtered, (await read(app, first)).json.unfiltered], [false, false]);
  assert.equal((await read(app, second)).json.filtered, true);
});

test("found without the filter but not with it means the metadata index is missing", async () => {
  const app = await createApp();
  app.env.VECTORIZE = new FakeVectorize({ indexed: ["project"] });
  const { probe } = (await start(app)).json;
  const seen = (await read(app, probe)).json;
  assert.deepEqual([seen.filtered, seen.unfiltered], [false, true]);
});

test("a vector that is not searchable yet is found by neither query", async () => {
  const app = await createApp();
  const { probe } = (await start(app)).json;
  app.env.VECTORIZE.query = async () => ({ count: 0, matches: [] });
  const seen = (await read(app, probe)).json;
  assert.deepEqual([seen.filtered, seen.unfiltered], [false, false]);
});

test("the probe leaves no trace in counts, stats, the list or recall", async () => {
  const app = await createApp();
  await seed(app, { name: "real-memory", text: "alpha beta gamma delta" });
  await indexAll(app);
  const snapshot = async () => ({
    count: (await app.call("/count")).json,
    stats: (await app.call("/stats")).json,
    list: (await app.call("/list")).json,
    recall: (await app.call("/recall?query=alpha+beta+gamma&count=0")).json,
    memories: (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first()).n,
    keys: (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memory_keys").first()).n,
  });
  const before = await snapshot();
  const { probe } = (await start(app)).json;
  await read(app, probe);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.recall.results.length, 1);
});

test("the nightly job deletes the last probe vector", async () => {
  const app = await createApp();
  await start(app);
  assert.equal(app.env.VECTORIZE.vectors.size, 1);
  const out = (await runNightly(app, { steps: ["purge_old"] })).summary.purge_old;
  assert.equal(out.probe_cleared, true);
  assert.equal(app.env.VECTORIZE.vectors.size, 0);
  assert.equal((await runNightly(app, { steps: ["purge_old"] })).summary.purge_old.probe_cleared, false);
});

test("the probe routes need a login, but not the admin token, and check the nonce", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json.token;
  const started = await start(app, { token: device });
  assert.equal(started.status, 200, "a device token may probe");
  assert.equal((await read(app, started.json.probe, { token: device })).status, 200);
  assert.equal((await start(app, { token: null })).status, 401);
  assert.equal((await read(app, started.json.probe, { token: null })).status, 401);
  assert.equal((await app.call("/vectorize-probe")).status, 400);
  assert.equal((await read(app, "not-a-nonce")).status, 400);
  assert.equal((await read(app, "ABCDEF0123456789")).status, 400);
  assert.equal((await app.call("/vectorize-probe", { method: "DELETE" })).status, 405);
});

test("a Vectorize failure is a plain server error, not a leak", async () => {
  const app = await createApp();
  app.env.VECTORIZE.upsert = async () => {
    throw new Error("secret detail");
  };
  const res = await start(app);
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.json).includes("secret"));
});
