// The one line status of the dashboard home. Pure. It turns the facts the Worker holds into a list of checks, each with a
// state the page can show as a word and a shape (never colour alone). Quiet when all is well, specific when it is not.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RUN_LIMIT_MS = 2 * HOUR_MS; // a run still open after this long was cut off, not still going

/** A time span as a short phrase, such as "7 hours" or "3 days". */
export function span(ms) {
  const n = Math.max(0, ms);
  if (n < 60_000) return "under a minute";
  if (n < HOUR_MS) return plural(Math.floor(n / 60_000), "minute");
  if (n < 2 * DAY_MS) return plural(Math.floor(n / HOUR_MS), "hour");
  return plural(Math.floor(n / DAY_MS), "day");
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const sum = (obj) => Object.values(obj ?? {}).reduce((a, b) => a + b, 0);

/** Capture reasons that mean a screen turned a memory away. A duplicate or a held back write is not a refusal. */
export const REFUSAL_REASONS = ["secret", "instruction", "injected_block", "blocked_topic", "sensitive"];

const refusals = (reasons) => REFUSAL_REASONS.reduce((n, r) => n + (reasons?.[r] ?? 0), 0);

/**
 * @typedef {object} Facts
 * @property {{ok: boolean | null, started_at: number, finished_at: number | null, summary: Record<string, any>} | null} nightly the last run of the nightly job, ok null while it is still open
 * @property {{configured: boolean, error?: boolean, latest?: {day: string, created_at: number | null} | null}} backup
 * @property {number} unvectorized memories waiting for vectors
 * @property {number | null} vectorCount vectors the index reports
 * @property {number} keysWithVectors search keys that say they have a vector
 * @property {{configured: boolean, days_left?: number, warn?: boolean}} token the Access token, warn set by the Worker inside its warning window
 * @property {{capture?: any, model_failures?: any}} stats the counters from /stats
 * @property {number} pending memories waiting for a decision
 */

/** The failed steps of a nightly summary, by name. */
function failedSteps(summary) {
  return Object.entries(summary ?? {}).filter(([, v]) => v && (v.error || v.refused)).map(([k]) => k.replace(/_/g, " "));
}

/**
 * @param {Facts} f
 * @param {number} now
 * @returns {{id: string, label: string, state: "ok" | "warn" | "fail" | "off", detail: string, href: string}[]}
 */
export function deriveChecks(f, now) {
  const checks = [];
  const add = (id, label, state, detail, href) => checks.push({ id, label, state, detail, href });

  // The nightly job. A run still open is running, until it has been open longer than a run can take, then it was cut off.
  if (!f.nightly) add("nightly", "Nightly job", "warn", "Has not run yet.", "#/health");
  else {
    const age = now - (f.nightly.finished_at ?? f.nightly.started_at);
    const bad = failedSteps(f.nightly.summary);
    if (f.nightly.ok === null && now - f.nightly.started_at <= RUN_LIMIT_MS) add("nightly", "Nightly job", "ok", `Running now, started ${span(now - f.nightly.started_at)} ago.`, "#/health");
    else if (f.nightly.ok === null) add("nightly", "Nightly job", "fail", `Did not finish, started ${span(age)} ago.`, "#/health");
    else if (!f.nightly.ok) add("nightly", "Nightly job", "fail", `Failed ${span(age)} ago${bad.length ? `, in ${bad.join(" and ")}` : ""}.`, "#/health");
    else if (age > 36 * HOUR_MS) add("nightly", "Nightly job", "warn", `Last ran ${span(age)} ago, so a night was missed.`, "#/health");
    else add("nightly", "Nightly job", "ok", `Ran ${span(age)} ago, every step passed.`, "#/health");
  }

  // The backup.
  if (!f.backup.configured) add("backup", "Backup", "off", "No bucket on this Worker.", "#/health");
  else if (f.backup.error) add("backup", "Backup", "warn", "The list could not be read.", "#/health");
  else if (!f.backup.latest) add("backup", "Backup", "fail", "No backup yet.", "#/health");
  else {
    const at = f.backup.latest.created_at ?? Date.parse(`${f.backup.latest.day}T00:00:00Z`);
    const age = now - at;
    if (age > 7 * DAY_MS) add("backup", "Backup", "fail", `Newest is ${span(age)} old.`, "#/health");
    else if (age > 2 * DAY_MS) add("backup", "Backup", "warn", `Newest is ${span(age)} old.`, "#/health");
    else add("backup", "Backup", "ok", `Newest is ${span(age)} old.`, "#/health");
  }

  // The search index. Waiting memories catch up within minutes, so only a backlog or a mismatch is worth a flag.
  const drift = f.vectorCount === null ? 0 : Math.abs(f.vectorCount - f.keysWithVectors);
  if (f.unvectorized > 20) add("index", "Search index", "warn", `${plural(f.unvectorized, "memory", "memories")} still waiting for vectors.`, "#/health");
  else if (drift > 2) add("index", "Search index", "warn", `The index holds ${f.vectorCount} vectors and the database expects ${f.keysWithVectors}.`, "#/health");
  else if (f.unvectorized > 0) add("index", "Search index", "ok", `In sync. ${plural(f.unvectorized, "new memory", "new memories")} indexing now.`, "#/health");
  else add("index", "Search index", "ok", f.vectorCount === null ? "Nothing waiting for vectors." : `In sync, ${f.vectorCount} vectors.`, "#/health");

  // The Access token.
  if (!f.token.configured) add("token", "Access token", "off", "No expiry date is set.", "#/health");
  else if (f.token.days_left < 0) add("token", "Access token", "fail", `Expired ${plural(-f.token.days_left, "day")} ago.`, "#/health");
  else if (f.token.warn) add("token", "Access token", "warn", `Expires in ${plural(f.token.days_left, "day")}. Renew it first.`, "#/health");
  else add("token", "Access token", "ok", `${plural(f.token.days_left, "day")} left.`, "#/health");

  // Writes held back by the limit.
  const limited7 = f.stats.capture?.last_7_days?.reasons?.rate_limited ?? 0;
  const limitedToday = f.stats.capture?.reasons?.rate_limited ?? 0;
  if (limited7 > 0) add("limit", "Write limit", "warn", `${plural(limited7, "write")} held back this week, ${limitedToday} today.`, "#/health");
  else add("limit", "Write limit", "ok", "No write held back this week.", "#/health");

  // Captures a screen turned away.
  const refusedToday = refusals(f.stats.capture?.reasons);
  const refused7 = refusals(f.stats.capture?.last_7_days?.reasons);
  if (refusedToday > 0) add("captures", "Captures", "warn", `${plural(refusedToday, "capture")} refused today, ${refused7} this week.`, "#/health");
  else if (refused7 > 0) add("captures", "Captures", "ok", `${plural(refused7, "capture")} refused this week, none today.`, "#/health");
  else add("captures", "Captures", "ok", "None refused this week.", "#/health");

  // Model calls that failed.
  const failToday = sum(Object.fromEntries(Object.entries(f.stats.model_failures ?? {}).filter(([k]) => k !== "last_7_days")));
  const fail7 = sum(f.stats.model_failures?.last_7_days);
  if (failToday > 0) add("models", "Model calls", "warn", `${plural(failToday, "call")} failed today, ${fail7} this week.`, "#/health");
  else if (fail7 > 0) add("models", "Model calls", "ok", `${plural(fail7, "call")} failed this week, none today.`, "#/health");
  else add("models", "Model calls", "ok", "No call failed this week.", "#/health");

  // Decisions that only the owner can make.
  if (f.pending > 0) add("pending", "Waiting for you", "warn", `${plural(f.pending, "change")} to accept or dismiss.`, "#/people");
  else add("pending", "Waiting for you", "ok", "Nothing waiting.", "#/people");

  return checks;
}

/** How many checks need attention, and the worst state. */
export function summarize(checks) {
  const fail = checks.filter((c) => c.state === "fail").length;
  const warn = checks.filter((c) => c.state === "warn").length;
  return { attention: fail + warn, worst: fail ? "fail" : warn ? "warn" : "ok" };
}
