import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveChecks, span, summarize } from "../dashboard-status.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

/** Facts for a healthy store, with any part replaced. */
const facts = (over = {}) => ({
  nightly: { ok: true, started_at: NOW - 7 * HOUR, finished_at: NOW - 7 * HOUR + 60_000, summary: {} },
  backup: { configured: true, latest: { day: "2026-10-18", created_at: NOW - 7 * HOUR } },
  unvectorized: 0,
  vectorCount: 120,
  keysWithVectors: 120,
  token: { configured: true, days_left: 200 },
  stats: { capture: { reasons: {}, last_7_days: { reasons: {} } }, model_failures: { last_7_days: {} } },
  pending: 0,
  ...over,
});
const by = (checks, id) => checks.find((c) => c.id === id);

test("span says the biggest whole unit", () => {
  assert.equal(span(10_000), "under a minute");
  assert.equal(span(61_000), "1 minute");
  assert.equal(span(59 * 60_000), "59 minutes");
  assert.equal(span(HOUR), "1 hour");
  assert.equal(span(47 * HOUR), "47 hours");
  assert.equal(span(2 * DAY), "2 days");
  assert.equal(span(-5), "under a minute");
});

test("a healthy store has nothing that needs attention", () => {
  const checks = deriveChecks(facts(), NOW);
  assert.equal(checks.length, 8);
  assert.deepEqual(summarize(checks), { attention: 0, worst: "ok" });
  assert.match(by(checks, "nightly").detail, /Ran 6 hours ago/);
  assert.match(by(checks, "index").detail, /In sync, 120 vectors/);
  assert.match(by(checks, "token").detail, /200 days left/);
});

test("the nightly job is a warning when missing or late and a failure when it failed, naming the step", () => {
  assert.equal(by(deriveChecks(facts({ nightly: null }), NOW), "nightly").state, "warn");
  assert.equal(by(deriveChecks(facts({ nightly: { ok: true, started_at: NOW - 40 * HOUR, finished_at: null, summary: {} } }), NOW), "nightly").state, "warn");
  const failed = by(deriveChecks(facts({ nightly: { ok: false, started_at: NOW - HOUR, finished_at: NOW - HOUR, summary: { purge_trash: { error: "boom" }, backup: { refused: { entries: 1 } } } } }), NOW), "nightly");
  assert.equal(failed.state, "fail");
  assert.match(failed.detail, /in purge trash and backup/);
});

test("a nightly run still open is running, and only one open past the run limit was cut off", () => {
  const open = (startedAgo) => by(deriveChecks(facts({ nightly: { ok: null, started_at: NOW - startedAgo, finished_at: null, summary: {} } }), NOW), "nightly");
  const running = open(5 * 60_000);
  assert.equal(running.state, "ok", "a run in progress is not a failure");
  assert.match(running.detail, /^Running now, started 5 minutes ago\.$/);
  assert.equal(open(2 * HOUR).state, "ok", "two hours is still inside the limit");
  const cut = open(3 * HOUR);
  assert.equal(cut.state, "fail");
  assert.match(cut.detail, /^Did not finish, started 3 hours ago\.$/);
});

test("the backup is off without a bucket, and ages from ok to warn to fail", () => {
  assert.equal(by(deriveChecks(facts({ backup: { configured: false } }), NOW), "backup").state, "off");
  assert.equal(by(deriveChecks(facts({ backup: { configured: true, error: true } }), NOW), "backup").state, "warn");
  assert.equal(by(deriveChecks(facts({ backup: { configured: true, latest: null } }), NOW), "backup").state, "fail");
  const at = (age) => by(deriveChecks(facts({ backup: { configured: true, latest: { day: "2026-10-01", created_at: NOW - age } } }), NOW), "backup").state;
  assert.deepEqual([at(DAY), at(3 * DAY), at(8 * DAY)], ["ok", "warn", "fail"]);
  const noTime = by(deriveChecks(facts({ backup: { configured: true, latest: { day: "2026-10-17", created_at: null } } }), Date.parse("2026-10-18T00:00:00Z")), "backup");
  assert.equal(noTime.state, "ok", "a backup without a stored time ages from its day");
});

test("the search index warns on a backlog or on a count that drifted, and stays quiet for a few new memories", () => {
  assert.equal(by(deriveChecks(facts({ unvectorized: 3 }), NOW), "index").state, "ok");
  assert.match(by(deriveChecks(facts({ unvectorized: 3 }), NOW), "index").detail, /3 new memories indexing/);
  assert.equal(by(deriveChecks(facts({ unvectorized: 21 }), NOW), "index").state, "warn");
  const drift = by(deriveChecks(facts({ vectorCount: 90 }), NOW), "index");
  assert.equal(drift.state, "warn");
  assert.match(drift.detail, /90 vectors .* expects 120/);
  assert.equal(by(deriveChecks(facts({ vectorCount: 121 }), NOW), "index").state, "ok", "the doctor probe vector is not drift");
  assert.equal(by(deriveChecks(facts({ vectorCount: null }), NOW), "index").state, "ok");
});

test("the token warns when the Worker says it is inside its window, and fails once expired", () => {
  const at = (token) => by(deriveChecks(facts({ token }), NOW), "token");
  assert.equal(at({ configured: false }).state, "off");
  assert.equal(at({ configured: true, days_left: 31, warn: false }).state, "ok");
  assert.equal(at({ configured: true, days_left: 30, warn: true }).state, "warn");
  assert.equal(at({ configured: true, days_left: 0, warn: true }).state, "warn");
  assert.equal(at({ configured: true, days_left: -2, warn: true }).state, "fail");
  assert.match(at({ configured: true, days_left: -2, warn: true }).detail, /Expired 2 days ago/);
  // The window is the Worker's (dashboard-api.js tokenExpiryInfo), so the status line does not repeat the number.
  assert.equal(at({ configured: true, days_left: 45, warn: false }).state, "ok", "a token with no warn flag is not warned here");
});

test("held back writes, refused captures and model failures are counted from the counters", () => {
  const stats = {
    capture: { reasons: { secret: 2, rate_limited: 1, duplicate: 9 }, last_7_days: { reasons: { secret: 2, blocked_topic: 1, rate_limited: 4, near_duplicate: 3 } } },
    model_failures: { embed: 1, last_7_days: { embed: 2, detect: 1 } },
  };
  const checks = deriveChecks(facts({ stats, pending: 2 }), NOW);
  assert.equal(by(checks, "limit").state, "warn");
  assert.match(by(checks, "limit").detail, /4 writes held back this week, 1 today/);
  assert.equal(by(checks, "captures").state, "warn");
  assert.match(by(checks, "captures").detail, /2 captures refused today, 3 this week/, "duplicates and held back writes are not refusals");
  assert.equal(by(checks, "models").state, "warn");
  assert.match(by(checks, "models").detail, /1 call failed today, 3 this week/);
  assert.equal(by(checks, "pending").state, "warn");
  assert.deepEqual(summarize(checks), { attention: 4, worst: "warn" });
  const quiet = deriveChecks(facts({ stats: { capture: { reasons: {}, last_7_days: { reasons: { secret: 1 } } }, model_failures: { last_7_days: { embed: 1 } } } }), NOW);
  assert.equal(by(quiet, "captures").state, "ok");
  assert.match(by(quiet, "captures").detail, /none today/);
  assert.equal(by(quiet, "models").state, "ok");
});

test("no status text uses a colon or a dash", () => {
  const stats = { capture: { reasons: { secret: 1, rate_limited: 1 }, last_7_days: { reasons: { secret: 1, rate_limited: 1 } } }, model_failures: { embed: 1, last_7_days: { embed: 1 } } };
  for (const f of [facts(), facts({ nightly: null, backup: { configured: true, latest: null }, token: { configured: true, days_left: -1 }, unvectorized: 30, stats, pending: 1 })]) {
    for (const c of deriveChecks(f, NOW)) assert.doesNotMatch(`${c.label} ${c.detail}`, /[:–—]| - |--/, c.id);
  }
});
