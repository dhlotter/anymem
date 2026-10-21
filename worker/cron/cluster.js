// The nightly clustering step. It looks for live captures and explicit notes that belong to no subject, groups the ones
// that share a name, and proposes a subject for a group of five or more. A proposal is only a question for the person
// (a pending card), nothing is linked to a subject until they click Accept.
//
// The signals are free and deterministic. A group is a shared plain tag, a shared project, or a shared leading word of
// the memory name. Then the vectors check that the group is really about one thing: the mean cosine of the members must
// be 0.55 or more. A group that cannot be checked because the budget is gone is dropped and tried again tomorrow, it is
// never proposed unchecked. A memory with an about link to any subject (a private one too) is not a candidate, so a
// proposal never pulls a private subject's members into a shared one. At most three proposals a night.
import { autoOn } from "../subjects/auto.js";
import { LIVE } from "../system.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_MS = 90 * DAY_MS;
export const MIN_GROUP = 5;
export const MAX_PROPOSALS = 3;
export const MIN_COHESION = 0.55;
/** Vectorize takes at most 20 ids in one getByIds call, so a group is judged on its 20 newest members. */
export const SAMPLE = 20;
// Groups looked at in one night. Each costs a Vectorize call, so a night with many weak groups does not spend its budget on them.
const MAX_CHECKS = 6;
const FETCH = 3000;
const MIN_TOKEN = 4;
const MAX_DROPPED = 50;

// Subrequests. Three reads open the step (candidates, their tags, the subjects that exist), a check is one getByIds call,
// and a proposal is one createProposed call. That call writes the card, the subject row, one batch with every about link and
// its own audit row, so it costs about 8 whatever the evidence size. The price below errs high: a step that runs out stops
// early and the rest is done tomorrow.
const READS = 3;
const CHECK_COST = 1;
const PROPOSE_COST = 10;

// Tags the system writes by itself say where a memory came from, not what it is about. A project tag is held in the
// project column (the parser lifts it out of the tags), and status and kind are reserved the same way.
const AUTO_TAG = /^(auto-capture|subject|subject:.*|subject-kind:.*|captured-by:.*|session:.*|status:.*|project:.*|capsule:.*|capsule-slot:.*)$/;
const TAG = /^[a-z][a-z0-9-]*$/;
const TOKEN = /^[a-z][a-z0-9]*$/;

// Words that open many capture names without naming a thing. Both a leading name word and a group name are checked against it.
export const STOP = new Set(
  `about above across after again against all also always and any are around because before being below between both but can could
   did does doing down during each either else even ever every few for from further had has have having her here him his how into its
   just keep like made make many may might more most much must never new next not now off often once only other our out over own same
   see she should since some still such take than that the their them then there these they this those through too under until upon
   use used uses using very want was were what when where which while who why will with within without would you your
   add added adding fix fixed fixes note notes memory memories rule rules user users prefer prefers preference preferences feature
   bug bugs test tests testing config setup error errors issue issues decision decisions pattern patterns lesson lessons learned
   important remember reminder todo summary context working work default correct correction avoid check build builds deploy code
   file files data thing things project projects session sessions system team home idea plan plans guideline workflow approach
   convention update updated updates change changes refactor review reviews task tasks item items info misc general other temp
   tmp draft drafts stuff topic topics area areas capture captured explicit fact facts`.split(/\s+/),
);

/** Lowercase letters and digits with single dashes, 2 to 40 characters, or null. The same rule a subject slug follows. */
export function slugOf(text) {
  const slug = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length >= 2 && slug.length <= 40 ? slug : null;
}

/** The first word of a memory name that can open a group, or null. */
function leadToken(name) {
  const token = (name ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).find(Boolean);
  return token && token.length >= MIN_TOKEN && TOKEN.test(token) && !STOP.has(token) ? token : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Mean cosine over every pair. Vectors are compared by angle, so a vector that is not unit length still counts fairly. */
export function cohesion(vectors) {
  const norm = vectors.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      let dot = 0;
      for (let k = 0; k < vectors[i].length; k++) dot += vectors[i][k] * vectors[j][k];
      sum += dot / (norm[i] * norm[j]);
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

/** The memories no subject has claimed: live, captured or written by hand, recent, not a card, with no about link. */
const CANDIDATES = `${LIVE} AND origin IN ('capture', 'explicit') AND created_at >= ?
  AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = memories.id AND l.link_type = 'about')
  AND NOT EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = memories.id AND t.tag = 'subject')`;

async function readCandidates(db, now) {
  const since = now() - WINDOW_MS;
  const { results: memories } = await db.prepare(`SELECT id, name, project, created_at FROM memories WHERE ${CANDIDATES} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(since, FETCH).all();
  const { results: tags } = await db
    .prepare(`SELECT memory_id AS id, tag FROM memory_tags WHERE memory_id IN (SELECT id FROM memories WHERE ${CANDIDATES} ORDER BY created_at DESC, id DESC LIMIT ?)`)
    .bind(since, FETCH)
    .all();
  return { memories, tags };
}

/** Every slug and alias a subject has, in any status. A retired subject keeps its slug on purpose, it is what stops a proposal coming back. */
async function takenNames(db) {
  const { results } = await db.prepare("SELECT slug, aliases FROM subjects").all();
  const taken = new Set();
  for (const r of results) {
    taken.add(r.slug);
    let aliases = [];
    try {
      aliases = JSON.parse(r.aliases);
    } catch {
      // an unreadable list holds no alias we can honour
    }
    for (const a of Array.isArray(aliases) ? aliases : []) {
      taken.add(String(a).toLowerCase());
      const slug = slugOf(a);
      if (slug) taken.add(slug);
    }
  }
  return taken;
}

/** Groups of memories by shared project, plain tag and leading name word. A group with one slug can have several signals. */
function groupUp({ memories, tags }) {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const groups = new Map();
  const add = (slug, source, id) => {
    let g = groups.get(slug);
    if (!g) groups.set(slug, (g = { slug, sources: new Set(), ids: new Set() }));
    g.sources.add(source);
    g.ids.add(id);
  };
  for (const m of memories) {
    if (m.project) {
      const slug = slugOf(m.project);
      if (slug) add(slug, "project", m.id);
    }
    const token = leadToken(m.name);
    if (token) add(token, "token", m.id);
  }
  for (const { id, tag } of tags) {
    if (byId.has(id) && !AUTO_TAG.test(tag) && TAG.test(tag) && slugOf(tag) === tag) add(tag, "tag", id);
  }
  return [...groups.values()]
    .filter((g) => g.ids.size >= MIN_GROUP)
    .map((g) => ({
      slug: g.slug,
      name: g.slug,
      kind: g.sources.has("project") ? "project" : "topic",
      source: ["project", "tag", "token"].find((s) => g.sources.has(s)),
      // newest first, which is also the order the cohesion sample is taken in
      members: [...g.ids].map((id) => byId.get(id)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1)),
    }))
    .sort((a, b) => b.members.length - a.members.length || (a.slug < b.slug ? -1 : 1));
}

/** The vector of a memory's first chunk, by memory id, for the ones Vectorize holds. */
async function firstChunks(env, ids) {
  const found = await env.VECTORIZE.getByIds(ids.map((id) => `${id}:chunk:0`));
  const out = new Map();
  for (const v of found ?? []) if (v?.values?.length) out.set(String(v.id).slice(0, -":chunk:0".length), Array.from(v.values));
  return out;
}

/** createProposed is loaded when a proposal is made, so the step can be read and tested on its own. */
async function loadPropose() {
  return (await import("../subjects/propose.js")).createProposed;
}

/**
 * Work out the groups and, when apply is true, propose the ones that pass. With apply false nothing is written, and the
 * result is what a run would do with the budget it has.
 * @param {Record<string, any>} env
 * @param {{now: () => number, budget: {has: (n?: number) => boolean, left: () => number}, apply: boolean, propose?: Function}} args
 */
export async function planClusters(env, { now, budget, apply, propose }) {
  const out = { memories: 0, groups: 0, checked: 0, proposed: [], candidates: [], dropped: [], skipped_budget: 0, failed: 0 };
  if (!budget.has(READS)) {
    out.skipped_budget++;
    return out;
  }
  const found = await readCandidates(env.DB, now);
  out.memories = found.memories.length;
  const groups = groupUp(found);
  out.groups = groups.length;
  if (!groups.length) return out;
  const taken = await takenNames(env.DB);
  const drop = (g, reason, extra = {}) => {
    if (reason === "skipped_budget") out.skipped_budget++;
    if (out.dropped.length < MAX_DROPPED) out.dropped.push({ name: g.name, slug: g.slug, kind: g.kind, size: g.members.length, reason, ...extra });
  };

  for (const g of groups) {
    if (STOP.has(g.slug)) drop(g, "generic");
    else if (taken.has(g.slug)) drop(g, "exists");
    else if (out.candidates.length >= MAX_PROPOSALS) drop(g, "over_cap");
    else if (out.checked >= MAX_CHECKS) drop(g, "check_limit");
    else if (!budget.has(CHECK_COST + (apply ? PROPOSE_COST : 0))) drop(g, "skipped_budget");
    else {
      out.checked++;
      const sample = g.members.slice(0, SAMPLE);
      let vectors;
      try {
        vectors = await firstChunks(env, sample.map((m) => m.id));
      } catch {
        drop(g, "vectors_failed");
        continue;
      }
      // Evidence is the members whose vectors were read, so a group that is half unindexed waits for the indexer.
      const evidence = sample.filter((m) => vectors.has(m.id));
      if (evidence.length < MIN_GROUP) {
        drop(g, "not_indexed", { indexed: evidence.length });
        continue;
      }
      const mean = round2(cohesion(evidence.map((m) => vectors.get(m.id))));
      if (mean < MIN_COHESION) {
        drop(g, "low_cohesion", { cohesion: mean });
        continue;
      }
      const candidate = { name: g.name, slug: g.slug, kind: g.kind, source: g.source, size: g.members.length, cohesion: mean, evidence: evidence.map((m) => ({ id: m.id, name: m.name })) };
      if (!apply) {
        out.candidates.push(candidate);
        continue;
      }
      try {
        // step "cluster" makes createProposed write the audit row (route cluster.propose, actor cluster), so this step writes none.
        const made = await (propose ?? (await loadPropose()))(env, { name: g.name, kind: g.kind, evidence: candidate.evidence.map((e) => ({ id: e.id, confidence: mean })), now, step: "cluster" });
        if (!made?.ok) {
          drop(g, made?.reason ?? "refused", { cohesion: mean });
          continue;
        }
        out.candidates.push({ ...candidate, slug: made.slug ?? g.slug, id: made.id });
        out.proposed.push(made.slug ?? g.slug);
      } catch {
        // createProposed does not throw. This is the module failing to load, or a stand in that does.
        out.failed++;
        drop(g, "failed", { cohesion: mean });
      }
    }
  }
  return out;
}

const countOf = (list) => list.reduce((acc, d) => ({ ...acc, [d.reason]: (acc[d.reason] ?? 0) + 1 }), {});

/**
 * The nightly step. Registered in STEPS by the maintenance job.
 * @param {Record<string, any>} env
 * @param {{now: () => number, budget: {has: (n?: number) => boolean, left: () => number}, propose?: Function}} ctx propose replaces createProposed, for tests
 */
export async function clusterStep(env, { now, budget, propose }) {
  if (!autoOn(env)) return { skipped: "off" };
  const r = await planClusters(env, { now, budget, apply: true, propose });
  return { memories: r.memories, groups: r.groups, checked: r.checked, proposed: r.proposed.length, slugs: r.proposed, skipped_budget: r.skipped_budget, failed: r.failed, dropped: countOf(r.dropped) };
}
