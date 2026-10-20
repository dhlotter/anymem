// The R2 lifecycle setup script, against a fake of the Cloudflare API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AGE_SECONDS, RULE_ID, planRules, setLifecycle, wantedRule } from "../scripts/set-lifecycle.js";

/** A fake bucket API. rules is what the bucket holds, calls is every request made. */
function fakeApi(rules, { fail } = {}) {
  const api = { rules, calls: [] };
  api.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    api.calls.push({ method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (fail) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    if (method === "PUT") api.rules = JSON.parse(init.body).rules;
    return Response.json({ success: true, result: { rules: api.rules } });
  };
  return api;
}

const args = (api) => ({ token: "t-123", accountId: "acc1", bucket: "anymem-worker-backups", fetchFn: api.fetch });

test("the rule expires objects under backups/ after 30 days", () => {
  assert.deepEqual(wantedRule(), { id: RULE_ID, enabled: true, conditions: { prefix: "backups/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 2_592_000 } } });
  assert.equal(MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
});

test("an empty bucket gets the rule, and the readback shows it", async () => {
  const api = fakeApi([]);
  const out = await setLifecycle(args(api));
  assert.equal(out.changed, true);
  assert.deepEqual(out.rules, [wantedRule()]);
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "PUT", "GET"]);
  assert.equal(api.calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc1/r2/buckets/anymem-worker-backups/lifecycle");
  assert.equal(api.calls[1].auth, "Bearer t-123");
});

test("running it again changes nothing and writes nothing", async () => {
  const api = fakeApi([]);
  await setLifecycle(args(api));
  api.calls.length = 0;
  const out = await setLifecycle(args(api));
  assert.equal(out.changed, false);
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "GET"], "no PUT");
});

test("the same rule with its keys in another order counts as in place", () => {
  const reordered = { deleteObjectsTransition: { condition: { maxAge: MAX_AGE_SECONDS, type: "Age" } }, conditions: { prefix: "backups/" }, enabled: true, id: RULE_ID };
  assert.equal(planRules([reordered]).changed, false);
});

test("a wrong age, prefix or a disabled rule is corrected, and other rules are kept", async () => {
  const other = { id: "other", enabled: true, conditions: { prefix: "tmp/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } };
  for (const bad of [
    { ...wantedRule(), enabled: false },
    { ...wantedRule(), conditions: { prefix: "" } },
    { ...wantedRule(), deleteObjectsTransition: { condition: { type: "Age", maxAge: 60 } } },
  ]) {
    const api = fakeApi([other, bad]);
    const out = await setLifecycle(args(api));
    assert.equal(out.changed, true);
    assert.deepEqual(out.rules, [other, wantedRule()]);
  }
});

test("no bucket name means no API call, so no rule lands on a guessed bucket", async () => {
  const api = fakeApi([]);
  await assert.rejects(setLifecycle({ token: "t-123", accountId: "acc1", fetchFn: api.fetch }), /bucket name/);
  assert.equal(api.calls.length, 0);
});

test("an API failure throws with the reason and no token", async () => {
  await assert.rejects(setLifecycle(args(fakeApi([], { fail: true }))), (err) => /10000 Authentication error/.test(err.message) && !err.message.includes("t-123"));
});
