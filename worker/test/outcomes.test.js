import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";
import { counterKey, MAX_COUNT, parseOutcomes } from "../outcomes.js";
import { dayOf } from "../counters.js";

const counts = async (app) => Object.fromEntries((await app.env.DB.prepare("SELECT name, day, count FROM counters WHERE name LIKE 'hook.recall.%' ORDER BY name, day").all()).results.map((r) => [`${r.name} ${r.day}`, r.count]));
const send = (app, header, harness = "claude", opts = {}) => app.call("/health", { headers: { "x-anymem-outcomes": header, ...(harness === null ? {} : { "x-anymem-harness": harness }) }, ...opts });

test("the header parses to counts, and anything that is not in the shape is ignored whole", () => {
  assert.deepEqual(parseOutcomes("injected=2,quiet=5"), { injected: 2, quiet: 5 });
  assert.deepEqual(parseOutcomes("quiet=1"), { quiet: 1 });
  assert.deepEqual(parseOutcomes(" failed=3 , injected=0 "), { failed: 3, injected: 0 });
  assert.deepEqual(parseOutcomes("quiet=99999"), { quiet: MAX_COUNT }, "a count is capped");
  for (const bad of [null, undefined, "", "   ", "quiet", "quiet=", "quiet=-1", "quiet=1.5", "quiet=1,quiet=2", "other=3", "quiet=1,other=3", "injected=0", "quiet=00000", "quiet=1;quiet=1", "x".repeat(65), "QUIET=1", "quiet = 1"]) {
    assert.equal(parseOutcomes(bad), null, String(bad));
  }
});

test("the counter key is a known harness id, unknown for a blank name, other for any other", () => {
  assert.equal(counterKey("codex"), "codex");
  assert.equal(counterKey("Claude-Code"), "claude");
  assert.equal(counterKey(""), "unknown");
  assert.equal(counterKey(null), "unknown");
  assert.equal(counterKey("some new tool"), "unknown", "a name the audit would drop is treated as no name");
  assert.equal(counterKey("some-new-tool"), "other");
});

test("a call that reports its outcomes adds them to the daily counters of its harness", async () => {
  const app = await createApp();
  const day = dayOf(app.clock.t);
  assert.equal((await send(app, "injected=2,quiet=5")).status, 200);
  assert.deepEqual(await counts(app), { [`hook.recall.injected.claude ${day}`]: 2, [`hook.recall.quiet.claude ${day}`]: 5 });
  await send(app, "quiet=3,failed=1");
  await send(app, "quiet=1", "codex");
  assert.deepEqual(await counts(app), {
    [`hook.recall.failed.claude ${day}`]: 1,
    [`hook.recall.injected.claude ${day}`]: 2,
    [`hook.recall.quiet.claude ${day}`]: 8,
    [`hook.recall.quiet.codex ${day}`]: 1,
  });
  app.clock.t += 24 * 60 * 60 * 1000;
  await send(app, "quiet=4");
  assert.equal((await counts(app))[`hook.recall.quiet.claude ${dayOf(app.clock.t)}`], 4, "a new day is a new row");
});

test("an alias, a blank name and a name nobody knows are counted under their own keys", async () => {
  const app = await createApp();
  const day = dayOf(app.clock.t);
  await send(app, "quiet=1", "claude-code");
  await send(app, "quiet=1", null);
  await send(app, "quiet=1", "some-new-tool");
  assert.deepEqual(await counts(app), { [`hook.recall.quiet.claude ${day}`]: 1, [`hook.recall.quiet.other ${day}`]: 1, [`hook.recall.quiet.unknown ${day}`]: 1 });
});

test("a malformed header, a refused login and a browser login add nothing", async () => {
  const app = await createApp();
  await send(app, "quiet=1,quiet=1");
  await send(app, "garbage");
  await send(app, "quiet=1", "claude", { token: "wrong-token" });
  await send(app, "quiet=1", "claude", { token: null });
  const browser = await raw(app, "/health", { jwt: app.browserJwt("me@example.com"), headers: { "x-anymem-outcomes": "quiet=1", "x-anymem-harness": "claude" } });
  assert.equal(browser.status, 200);
  assert.deepEqual(await counts(app), {});
});

test("a device token reports like any caller, and the reply is not changed by the header", async () => {
  const app = await createApp();
  const device = (await app.call("/devices", { method: "POST", body: { label: "laptop" } })).json;
  const plain = await app.call("/health", { token: device.token });
  const with_ = await send(app, "injected=1", "kilo", { token: device.token });
  assert.deepEqual(with_.json, plain.json);
  assert.equal(Object.keys(await counts(app)).length, 1);
});

test("a counter write that fails never changes the reply", async () => {
  const app = await createApp();
  await app.env.DB.exec("DROP TABLE counters");
  const res = await send(app, "quiet=1");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test("the header adds no section to /stats and stores no text", async () => {
  const app = await createApp();
  await send(app, "injected=1,quiet=1");
  const stats = (await app.call("/stats")).json;
  assert.deepEqual(Object.keys(stats.capture).sort(), ["accepted", "last_7_days", "model_fallback", "reasons", "rejected", "updated"]);
  const rows = (await app.env.DB.prepare("SELECT name FROM counters").all()).results.map((r) => r.name);
  assert.ok(rows.every((n) => /^hook\.recall\.(injected|quiet|failed)\.[a-z]+$/.test(n)), rows.join(","));
});
