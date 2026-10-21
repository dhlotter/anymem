// Helpers for the clustering tests. All sample text is invented.
import { createStore } from "../../memory/store.js";
import { parseMemory } from "../../memory/parse.js";
import { recordAudit } from "../../audit.js";
import { createBudget, countedEnv } from "../../cron/budget.js";
import { createApp } from "./app.js";
import { FakeVectorize } from "./fakes.js";
import { DAY, indexAll, seed } from "./maintenance.js";
import { note } from "./search.js";

/** The fake index with getByIds, which the real index has and the shared fake does not. A missing id is left out of the reply, as on the real one. */
export class VectorizeWithGet extends FakeVectorize {
  async getByIds(ids) {
    if (this.failing) throw new Error("vectorize is down");
    if (ids.length > 20) throw new Error("getByIds takes at most 20 ids");
    this.getCalls = (this.getCalls ?? 0) + 1;
    return ids.filter((id) => this.vectors.has(id)).map((id) => ({ id, values: this.vectors.get(id).values, metadata: this.vectors.get(id).metadata }));
  }
}

/** An app with both flags on (or the ones given) and the index that has getByIds. */
export async function clusterApp(env = {}) {
  const app = await createApp({ env: { SUBJECTS: "on", SUBJECTS_AUTO: "on", ...env } });
  app.env.VECTORIZE = new VectorizeWithGet();
  return app;
}

/** Text whose words are mostly shared, so the fake embeddings of a group of them are close. One word differs per memory. */
export const alike = (topic, i) => `${topic} service history covers oil filter tyres brake pads wiper fluid battery check note ${topic}${i}`;
/** Text of unrelated memories, so the fake embeddings are far apart. */
export const apart = (i) => `${["kiln glaze porcelain firing", "tax return deduction receipt", "sourdough starter hydration crumb", "router firmware reboot uplink", "violin rosin bridge tuning", "marathon pacing taper hydration"][i % 6]} entry ${i} ${i * 7919}`;

/** Make n live captures that share a tag, a project or a leading name word. Returns the ids. */
export async function group(app, { n = 5, topic = "corolla", tag, project, lead, text = (i) => alike(topic, i), origin = "capture", ageDays = 1, extraTags = [] } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(await seed(app, { name: `${lead ? `${lead}-` : "item"}${lead ? "" : topic}${i}`, text: text(i), origin, ageDays, tags: [...(tag ? [tag] : []), ...extraTags], ...(project ? { project } : {}) }));
  }
  return ids;
}

export { DAY, indexAll };

/**
 * A stand in for createProposed that does what the contract says it does, through the real stores: a pending card, a
 * subject row with status proposed, one batch of about links from the evidence memories, and one audit row for the step.
 * It records its calls.
 */
export function stubPropose({ refuse } = {}) {
  const calls = [];
  const fn = async (env, { name, kind, evidence, now, step = "propose" }) => {
    calls.push({ name, kind, evidence, step });
    if (refuse) return { ok: false, reason: refuse };
    const slug = name;
    if (await env.DB.prepare("SELECT 1 AS n FROM subjects WHERE slug = ?").bind(slug).first()) return { ok: false, reason: "exists" };
    const store = createStore(env.DB, now);
    const parsed = await parseMemory(note(slug, `${kind} card for ${name}`, "Proposed from conversation, waiting for your click."), ["subject", `subject:${slug}`, `subject-kind:${kind}`]);
    const card = await store.create({ ...parsed, type: "project", origin: "system", status: "pending" });
    await env.DB.prepare("INSERT INTO subjects (id, slug, kind, status, scope, fields, aliases, created_at, updated_at) VALUES (?, ?, ?, 'proposed', 'shared', '{}', '[]', ?, ?)").bind(card.id, slug, kind, now(), now()).run();
    await env.DB.batch(evidence.map((e) => env.DB.prepare("INSERT OR IGNORE INTO links (source_id, target_id, link_type, created_at, made_by, confidence) VALUES (?, ?, 'about', ?, 'system', ?)").bind(e.id, card.id, now(), e.confidence)));
    const route = step === "cluster" ? "cluster.propose" : "propose.subject";
    await recordAudit(env.DB, { ts: now(), actor: { kind: "system", id: step }, harness: "", script: `how:${step}.conf:${evidence[0].confidence}`, method: "SYSTEM", route, status: 200, durationMs: 0, memoryIds: [card.id, ...evidence.map((e) => e.id)] });
    return { ok: true, slug, id: card.id };
  };
  fn.calls = calls;
  return fn;
}

/** Run the step the way the nightly job does: a counted env and a budget of the given size. Returns the summary and the subrequests it used. */
export async function runStep(app, step, { subrequests = 5000, propose, ...ctx } = {}) {
  const now = () => app.clock.t;
  const budget = createBudget({ now, subrequests, wallMs: 600_000 });
  const summary = await step(countedEnv(app.env, budget), { now, budget, propose, ...ctx });
  return { summary, spent: budget.spent, budget };
}
