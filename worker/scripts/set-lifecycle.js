// Sets the R2 lifecycle rule that deletes objects under backups/ after 30 days. A setup tool, not part of the Worker.
// Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment. Run it with the bucket name as the
// first argument, or with BACKUP_BUCKET set, for example
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node worker/scripts/set-lifecycle.js my-backup-bucket
// It is safe to run again: the rule has a fixed id, other rules on the bucket
// are kept, and nothing is written when the rule is already right. It prints the rules the bucket holds afterwards.
import { fileURLToPath } from "node:url";

export const RULE_ID = "expire-backups-30d";
export const PREFIX = "backups/";
export const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const wantedRule = () => ({
  id: RULE_ID,
  enabled: true,
  conditions: { prefix: PREFIX },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: MAX_AGE_SECONDS } },
});

// Compared field by field, because the bucket may return the same rule with its keys in another order.
const matches = (r) =>
  r.enabled === true && r.conditions?.prefix === PREFIX && r.deleteObjectsTransition?.condition?.type === "Age" && r.deleteObjectsTransition.condition.maxAge === MAX_AGE_SECONDS && !r.abortMultipartUploadsTransition;

/**
 * The rules the bucket should have, and whether that differs from what it has.
 * @param {any[]} current
 * @returns {{rules: any[], changed: boolean}}
 */
export function planRules(current) {
  const mine = current.filter((r) => r.id === RULE_ID);
  if (mine.length === 1 && matches(mine[0])) return { rules: current, changed: false };
  return { rules: [...current.filter((r) => r.id !== RULE_ID), wantedRule()], changed: true };
}

async function call(fetchFn, url, token, init = {}) {
  const res = await fetchFn(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const why = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare refused the request (${why})`);
  }
  return body.result;
}

/**
 * @param {{token: string, accountId: string, bucket: string, fetchFn?: typeof fetch}} args
 * @returns {Promise<{changed: boolean, rules: any[]}>} the rules after the call, read back from the bucket
 */
export async function setLifecycle({ token, accountId, bucket, fetchFn = fetch }) {
  if (!bucket) throw new Error("Give the R2 bucket name as the first argument, or set BACKUP_BUCKET.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`;
  const current = (await call(fetchFn, url, token))?.rules ?? [];
  const plan = planRules(current);
  if (plan.changed) await call(fetchFn, url, token, { method: "PUT", body: JSON.stringify({ rules: plan.rules }) });
  const after = (await call(fetchFn, url, token))?.rules ?? [];
  return { changed: plan.changed, rules: after };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.");
  const bucket = process.argv[2] ?? process.env.BACKUP_BUCKET;
  const { changed, rules } = await setLifecycle({ token, accountId, bucket });
  console.log(`${bucket}: ${changed ? "rule written" : "rule already in place"}`);
  console.log(JSON.stringify(rules, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`set-lifecycle failed: ${err.message}`);
    process.exit(1);
  });
}
