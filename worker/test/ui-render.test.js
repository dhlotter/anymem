// Memories are untrusted text. Every function that renders store data must escape it, and the copy the views write themselves must follow the house rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { badge, emptyState, harnessChip, originChip, provenance, segmented, shareBar, stateMark, tagList } from "../ui/lib/components.js";
import { stackedBars } from "../ui/lib/chart.js";
import { appliedChips } from "../ui/lib/grid.js";
import { activeFilters, detailView, diffView, editForm, factsView, historyView, linksView, listView, tableRow } from "../ui/screens/memories.js";
import { ADDABLE_LINK_TYPES, linkForm } from "../ui/lib/drawer.js";
import { capsuleText, capsuleView } from "../ui/screens/capsule.js";
import { auditRows, stripView } from "../ui/screens/audit.js";
import { backupsView, capacityView, capturesView, checksView, countsView, limitView, runsView } from "../ui/screens/health.js";
import { askView, figuresView, growthView, headView, latestView, probationView, quietView, recallsView, sourcesView, statusView, toolRows, toolsView, toolTable, usageView } from "../ui/screens/home.js";
import { pendingView, peopleView, profileView } from "../ui/screens/people.js";
import { listView as subjectListView, newForm, tableRow as subjectRow } from "../ui/screens/subjects.js";
import { aliasForm, briefForm, fieldsForm, subjectView } from "../ui/lib/subject-drawer.js";
import { hitView, injectedView, resultsView, rulesView, searchForm } from "../ui/screens/search.js";
import { entryView, feedView, summaryView } from "../ui/screens/activity.js";
import { trashView } from "../ui/screens/trash.js";
import { injectedText } from "../ui/lib/relevance.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const EVIL = {
  script: "<script>alert(1)</script>",
  img: "<img src=x onerror=alert(1)>",
  quote: `" onmouseover="alert(1)" x="`,
  pre: "</pre><script>steal()</script>",
  md: "**bold** [click](javascript:alert(1)) ![x](https://evil.example/p.png) <https://evil.example>",
  attr: `'><svg onload=alert(1)>`,
};
const BENIGN = Object.fromEntries(Object.keys(EVIL).map((k) => [k, "plain"]));

/** An entry whose every text field comes from the given set. */
const entry = (t, over = {}) => ({
  id: "11111111-aaaa-bbbb-cccc-222222222222",
  name: t.script,
  description: t.img,
  type: "user",
  body: t.md,
  content: `---\nname: ${t.script}\n---\n${t.pre}\n${t.md}\nProposed Phone: ${t.img}\nEmail: ${t.attr}\nRelationship: ${t.quote}`,
  tags: [t.quote, t.attr],
  status: "canonical",
  origin: "explicit",
  harness: t.img,
  harness_label: t.pre,
  session: t.quote,
  project: t.attr,
  kind: "semantic",
  pinned: true,
  valid_from: NOW - 1000,
  valid_until: null,
  superseded_by: null,
  recall_count: 3,
  last_recalled_at: NOW - 500,
  created_at: NOW - 100_000,
  updated_at: NOW - 50_000,
  deleted_at: null,
  ...over,
});

/** A subject card as GET /subject returns it, every text field from the given set. */
const subject = (t, over = {}) => ({
  id: "33333333-aaaa-bbbb-cccc-444444444444",
  slug: "pip",
  kind: "pet",
  status: "active",
  scope: "private",
  name: t.script,
  aliases: [t.quote, t.attr],
  fields: { name: { value: t.img, confirmed_at: NOW - DAY, source: "user" }, vet: { value: t.pre, confirmed_at: NOW - 5000, source: "user" }, [t.attr]: { value: t.md, confirmed_at: NOW, source: "user" } },
  brief: `${t.md}\n${t.pre}`,
  member_count: 3,
  members: [{ id: t.quote, name: t.script, updated_at: NOW - 50 }, { id: "m2", name: t.img, updated_at: NOW }],
  created_at: NOW - 100_000,
  updated_at: NOW - 100,
  ...over,
});

const checks = (t) => [
  { rule: "close_in_meaning", met: true, detail: t.script },
  { rule: "agreement", met: false, detail: t.img },
];
const hit = (t, over = {}) => ({
  ...entry(t),
  score: 0.03,
  similarity: 0.71,
  rerank: 0.4,
  relevant: true,
  why: { dense_score: 0.71, dense_rank: 1, keyword_rank: 2, keyword_terms: [{ term: t.script, level: 2, idf: 8 }, { term: t.img, level: 2, idf: 9 }], checks: checks(t) },
  ...over,
});
const days = (n, f) => Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, ...f(i) }));

/** Every view with data from one set of texts, as [name, markup] pairs. */
function views(t) {
  const e = entry(t);
  const home = {
    owner: t.script,
    headline: { live: 1042, added_week: 12, added_prev: 7, recalled_week: 5, recall_calls_week: 90, recall_calls_prev: 80, closed_week: 2, closed_prev: 0 },
    checks: [
      { id: "nightly", label: t.script, state: "ok", detail: t.img, href: "#/health" },
      { id: "backup", label: "Backup", state: "warn", detail: t.quote, href: "#/health" },
      { id: "index", label: "Search index", state: "fail", detail: t.attr, href: "#/health" },
      { id: "token", label: "Access token", state: "off", detail: t.md, href: "#/health" },
    ],
    summary: { attention: 2, worst: "fail" },
  };
  const calm = { ...home, checks: home.checks.map((c) => ({ ...c, state: "ok" })), summary: { attention: 0, worst: "ok" } };
  const growth = { days: 30, bucket: "day", origins: ["explicit", "capture", "import", "profile", "person", "system"], total: 9, buckets: days(3, (i) => ({ start: `2026-10-0${i + 1}`, counts: { explicit: i, capture: 2, import: 0, profile: 0, person: 0, system: i === 2 ? 1 : 0 } })).map(({ start, counts }) => ({ start, counts })) };
  const recalls = { days: days(3, (i) => ({ calls: 10 + i, empty: i })), total: 33, empty: 3, by_harness: [{ harness: t.script, label: t.img, calls: 20, empty: 2 }, { harness: "claude", label: "Claude Code", calls: 13, empty: 1 }], most_recalled: [{ id: t.quote, title: t.script, origin: "explicit", project: t.attr, recall_count: 9, last_recalled_at: NOW }, { id: "b", title: t.img, origin: "capture", project: "", recall_count: 3, last_recalled_at: NOW }], never_recalled: { count: 4, sample: [{ id: t.quote, title: t.script, origin: t.img, project: "", created_at: NOW - 9 * DAY }] } };
  const probation = { total: 3, entries: [{ id: t.quote, title: t.script, origin: "capture", project: "", created_at: NOW - 50 * DAY, probation_until: NOW + 10 * DAY, days_left: 10, recall_count: 0, retires: true, retire_at: NOW + 10 * DAY }, { id: "b", title: t.img, origin: "capture", project: "", created_at: NOW - 5 * DAY, probation_until: NOW + 55 * DAY, days_left: 55, recall_count: 2, retires: true, retire_at: null }, ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, title: t.md, origin: "capture", project: "", created_at: NOW, probation_until: NOW + DAY, days_left: 1, recall_count: 0, retires: true, retire_at: null }))] };
  const versions = [{ seq: 2, reason: t.attr, at: NOW - 1000, summary: `${t.script} ${t.img}` }, { seq: 1, reason: "update", at: NOW - 5000, summary: "" }];
  const links = [{ direction: "out", other_id: t.quote, other_name: t.script, type: t.attr, made_by: "user", confidence: null, created_at: NOW }, { direction: "in", other_id: "x", other_name: t.img, type: "about", made_by: "system", confidence: 0.8, created_at: NOW }];
  const extras = { probation_until: NOW + 1000, links: [{ direction: "out", id: t.quote, name: t.script, type: t.attr }, { direction: "in", id: "x", name: t.img, type: "related" }], saved_by: { at: NOW - 5000, by: t.script, kind: "device", script: `hook:${t.img}` }, recalled_by: [{ harness: t.quote, label: t.attr, times: 8 }, { harness: "codex", label: "Codex", times: 2 }], recall_log_since: NOW - 3 * DAY };
  const harnesses = {
    sources: { total: 12, rows: [{ harness: t.script, label: t.img, filter: t.quote, memories: 7 }, { harness: "", label: "Imported", filter: "none", memories: 3 }, { harness: "", label: t.attr, filter: "none", memories: 2 }] },
    recalls: { total: 30, empty: 3, by_harness: [{ harness: t.script, label: t.img, calls: 20, empty: 2 }, { harness: "", label: t.attr, calls: 4, empty: 1 }] },
    used: { since: NOW - 10 * DAY, total: 6, by_harness: [{ harness: t.script, label: t.img, recalls: 4, memories: 2, top: [{ id: t.quote, title: t.script, count: 3 }, { id: "b", title: t.pre, count: 1 }] }, { harness: "codex", label: "Codex", recalls: 2, memories: 1, top: [{ id: "c", title: t.md, count: 2 }] }] },
    outcomes: { since: "2026-10-10", windows: [{ days: 7, injected: 3, quiet: 9, failed: 1, prompts: 12, quiet_percent: 75 }, { days: 30, injected: 10, quiet: 30, failed: 2, prompts: 40, quiet_percent: 75 }], by_harness: [{ harness: t.script, label: t.img, injected: 10, quiet: 30, failed: 2, quiet_percent: 75 }] },
  };
  const none = { sources: { total: 0, rows: [] }, recalls: { total: 0, empty: 0, by_harness: [] }, used: { since: null, total: 0, by_harness: [] }, outcomes: { since: null, windows: [{ days: 7, injected: 0, quiet: 0, failed: 0, prompts: 0, quiet_percent: null }, { days: 30, injected: 0, quiet: 0, failed: 0, prompts: 0, quiet_percent: null }], by_harness: [] } };
  const act = (over = {}) => ({ version_id: 1, memory_id: t.quote, title: t.script, origin: "capture", harness: t.img, harness_label: t.pre, project: "", kind: "replaced", reason: "supersede", at: NOW - 1000, state: "closed", can_undo: true, purge_at: null, replaced_by: { id: t.attr, title: t.img }, ...over });
  const acts = [act(), act({ version_id: 2, kind: "merged", reason: "merge" }), act({ version_id: 3, kind: "retired", reason: "retire_never_recalled", state: "trashed", purge_at: NOW + 5 * DAY, replaced_by: null }), act({ version_id: 4, state: "changed_since", can_undo: false, replaced_by: null })];
  const capsule = { sections: [{ slot: t.script, content: t.pre, source_id: t.quote, updated_at: NOW }, { slot: "identity", content: t.md, source_id: "b", updated_at: NOW }], chars: 20, cap: 9500, over_cap: true, warning: t.img };
  const names = { [t.quote]: t.script };
  const usage = { plan: { plan: t.script, checked: "2026-10-18" }, db: { size_bytes: 5_000_000, limit_bytes: 10 * 1024 ** 3 }, vectors: { count: 346, limit: 20_000_000, dimensions: 384, stored_dimensions: 132_864, included_dimensions: 10_000_000 }, write_limit: { limit: 40, window_minutes: 10, tokens: [{ id: "admin", label: t.script, used: 4, resets_in_seconds: 90 }] }, days: days(3, () => ({ proposed: 5, screened: 2, saved: 3, refused: 1, limited: 0, duplicates: 1, model_failures: 0 })) };
  const runs = [{ id: 2, job: "nightly", started_at: NOW, finished_at: NOW, ok: false, steps: [{ name: t.script, state: "failed", headline: t.img }, { name: "backup", state: "ok", headline: t.quote, more: true, ms: 40 }] }, { id: 1, job: "manual", started_at: NOW - DAY, finished_at: NOW - DAY, ok: true, steps: [{ name: t.script, state: "ok", headline: "" }] }];
  const overview = { count: 3, pending: 1, trash: 1, unclassified: 1, by_status: { [t.script]: 1 }, by_origin: { [t.img]: 2 }, by_project: { [t.quote]: 1 }, by_kind: { [t.attr]: 1 }, model_failures: { last_7_days: { [t.script]: 2 } } };
  const facets = { days: 14, harnesses: [{ harness: t.script, label: t.img, calls: 3 }, { harness: "claude", label: "Claude Code", calls: 2 }], routes: [{ route: t.quote, calls: 3 }], per_day: days(3, (i) => ({ ok: i + 1, bad: 1 })) };
  const audit = [{ id: 1, ts: NOW, actor_kind: t.script, actor_id: t.img, harness: t.quote, harness_label: t.md, script: t.attr, method: "GET", route: t.pre, status: 200, duration_ms: 3, memory_ids: [t.quote, t.script, "a", "b"] }, { id: 2, ts: NOW, actor_kind: "browser", actor_id: t.img, harness: "", script: "", method: "POST", route: "/x", status: 422, duration_ms: 3, memory_ids: [] }];
  const pending = entry(t, { name: "profile-proposal-phone", content: `---\nname: profile-proposal-phone\n---\n\nProposed Phone: ${t.script}\nCurrent Phone: ${t.img}\n` });
  const profile = entry(t, { content: `---\nname: profile\n---\nFull name: ${t.script}\nEmail: ${t.img} (${t.attr})`, tags: ["profile"] });
  return [
    ["badge", badge(t.script, t.quote)],
    ["tagList", tagList([t.script, t.quote])],
    ["provenance", provenance(e)],
    ["originChip", originChip(t.script)],
    ["tableRow", tableRow(e, NOW, true, {})],
    ["emptyState", emptyState(t.script, t.img)],
    ["shareBar", shareBar(0.4, t.quote)],
    ["segmented", segmented(t.quote, t.script, [[t.img, t.attr]], t.img, t.md)],
    ["appliedChips", appliedChips([{ label: t.script, value: t.quote, href: t.img }])],
    ["stateMark", stateMark(t.script)],
    ["headView", headView(home, [t.script, t.img], NOW)],
    ["askView", askView([t.script, t.quote])],
    ["statusView attention", statusView(home)],
    ["statusView calm", statusView(calm)],
    ["figuresView", figuresView(home.headline)],
    ["latestView", latestView([e, entry(t, { id: t.quote })], NOW)],
    ["growthView", growthView(growth, 30, false)],
    ["growthView table", growthView({ ...growth, bucket: "week", days: 365 }, 365, true)],
    ["recallsView", recallsView(recalls, false)],
    ["recallsView with harnesses", recallsView(recalls, false, harnesses)],
    ["recallsView with no harness data", recallsView(recalls, true, none)],
    ["quietView", quietView(harnesses.outcomes)],
    ["quietView empty", quietView(none.outcomes)],
    ["toolTable", toolTable(harnesses)],
    ["sourcesView", sourcesView(harnesses)],
    ["sourcesView empty", sourcesView(none)],
    ["toolsView", toolsView(harnesses)],
    ["toolsView empty", toolsView(none)],
    ["harnessChip", harnessChip(e)],
    ["usageView", usageView(recalls)],
    ["probationView", probationView(probation, NOW)],
    ["searchForm", searchForm(t.quote, t.attr)],
    ["hitView", hitView(hit(t), 1, [])],
    ["rulesView", rulesView(hit(t))],
    ["injectedView", injectedView(injectedText([hit(t)]), [hit(t)])],
    ["resultsView", resultsView({ results: [hit(t), hit(t, { relevant: false })], degraded: t.script, took_ms: 4 }, t.quote)],
    ["listView", listView([e], t.quote, NOW, e.id, { origin: t.script, project: t.quote, tag: t.attr, time: t.img, status: t.img, type: t.script, sort: t.md, harness: t.quote }, harnesses.sources.rows)],
    ["factsView", factsView(e, extras, NOW)],
    ["linksView", linksView(links)],
    ["historyView", historyView(versions, NOW)],
    ["editForm", editForm(e)],
    ["linkForm", linkForm()],
    ["factsView with subjects", factsView(e, extras, NOW, [{ id: "c1", slug: t.quote, name: t.script }, { id: "c2", slug: "corolla", name: t.img }])],
    ["linksView without actions", linksView(links, false)],
    ["subjectView", subjectView(subject(t), links, NOW, t.quote)],
    ["subjectView retired", subjectView(subject(t, { status: "retired", scope: "shared", aliases: [], fields: {}, brief: "" }), null, NOW, "#/subjects")],
    ["subjectView capped members", subjectView(subject(t, { member_count: 300 }), [], NOW, "#/subjects")],
    ["subjectView no members", subjectView(subject(t, { members: [], member_count: 0 }), [], NOW, "#/subjects")],
    ["briefForm", briefForm(subject(t))],
    ["fieldsForm", fieldsForm(subject(t))],
    ["aliasForm", aliasForm()],
    ["newForm", newForm()],
    ["subjectRow", subjectRow(subject(t), NOW, true, { kind: t.script })],
    ["subjects listView", subjectListView([subject(t), subject(t, { slug: "corolla", status: "stale", scope: "shared", aliases: [] })], NOW, "pip", { kind: t.script, status: t.img, scope: t.quote, q: t.attr, sort: t.md })],
    ["subjects listView empty", subjectListView([], NOW, "", {})],
    ["subjects listView none match", subjectListView([], NOW, "", { q: t.quote })],
    ["detailView", detailView(e, { versions, extras, links }, NOW)],
    ["detailView trashed", detailView(entry(t, { deleted_at: NOW - 5 * DAY }), { versions, extras, links: null }, NOW)],
    ["detailView closed", detailView(entry(t, { valid_until: NOW - 5, superseded_by: t.quote }), { versions, extras, links: null }, NOW)],
    ["diffView", diffView(`a\n${t.script}\nc`, `a\nX${t.img}\nc\nX${t.pre}`, "This change")],
    ["entryView", entryView(acts[0], NOW)],
    ["feedView", feedView(acts, NOW)],
    ["summaryView", summaryView({ last_30_days: { replaced: 1, merged: 2, retired: 3 }, purge_soon: 2 })],
    ["trashView", trashView({ window_days: 14, entries: [{ id: t.quote, title: t.script, origin: "capture", project: t.img, deleted_at: NOW - 12 * DAY, purge_at: NOW + 2 * DAY }], shown: 1, matching: 1, total: 1, soon: 1, older: 2, projects: [t.img] }, NOW)],
    ["capsuleView", capsuleView(capsule, names, NOW)],
    ["profileView", profileView(profile)],
    ["pendingView", pendingView([pending, entry(t)], { phone: { value: t.script, note: "" } }, NOW)],
    ["peopleView", peopleView([entry(t)])],
    ["checksView", checksView(home.checks)],
    ["runsView", runsView(runs, NOW)],
    ["capacityView", capacityView(usage, { configured: true, expires: t.script, days_left: 3 })],
    ["capturesView", capturesView(usage, overview, true)],
    ["limitView", limitView(usage)],
    ["backupsView", backupsView([{ day: "2026-10-17", name: t.script, size: 5, entries: 7 }])],
    ["countsView", countsView(overview)],
    ["stripView", stripView(facets, true)],
    ["auditRows", auditRows(audit, { actor: t.quote, route: t.attr, since: t.img, harness: t.script, result: t.md }, facets)],
    ["stackedBars", stackedBars({ buckets: [{ label: t.script, short: t.img, values: { a: 2 } }], series: [{ key: "a", label: t.quote, cls: "s1" }], width: 300, summary: t.attr, axisLabel: (b) => b.short })],
  ];
}

const OPEN_TAG = /<([a-z][a-z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/gi;
const CLOSE_TAG = /<\/([a-z][a-z0-9]*)>/gi;

/** Reads the real tags and attribute names out of generated HTML, and fails if any "<" is not part of a real tag. */
function parse(out, name) {
  const tags = [];
  const attrs = [];
  for (const m of out.matchAll(OPEN_TAG)) {
    tags.push(m[1].toLowerCase());
    for (const a of m[2].matchAll(/\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?/g)) attrs.push(`${m[1].toLowerCase()}.${a[1].toLowerCase()}`);
  }
  const closing = [...out.matchAll(CLOSE_TAG)].length;
  assert.equal(out.split("<").length - 1, tags.length + closing, `${name} has a "<" that is not a well formed tag`);
  return { tags: tags.sort(), attrs: attrs.filter((a, i, all) => all.indexOf(a) === i).sort() };
}

test("no view lets store text add a tag or an attribute", () => {
  const nasty = views(EVIL);
  const benign = views(BENIGN);
  assert.equal(nasty.length, benign.length);
  assert.ok(nasty.length >= 78, `${nasty.length} views are covered`);
  nasty.forEach(([name, view], i) => {
    const got = parse(String(view), name);
    assert.deepEqual(got, parse(String(benign[i][1]), name), `${name} has different tags or attributes with hostile text`);
    assert.equal(got.attrs.some((a) => /\.on|\.style$|\.srcdoc$/.test(a)), false, name);
    assert.doesNotMatch(String(view), /<(script|img|iframe)/i, name);
  });
});

test("the only svg a view makes is its own, with no script, style or link out, and its sprite references stay in the page", () => {
  for (const [name, view] of views(EVIL)) {
    const out = String(view);
    const { attrs } = parse(out, name);
    assert.equal(attrs.some((a) => /^(svg|use|path|rect|g|line|text)\.(on|style|xlink)/.test(a)), false, name);
    assert.doesNotMatch(out, /<foreignObject|<animate|<set\b|<image/i, name);
    for (const m of out.matchAll(/<use\s[^>]*href="([^"]*)"/g)) assert.match(m[1], /^#i-[a-z]+$/, `${name} has a use that points outside the sprite`);
  }
});

test("hostile text appears escaped, as text", () => {
  const out = String(detailView(entry(EVIL), { versions: [], extras: null, links: null }, NOW));
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(out.includes("&lt;/pre&gt;&lt;script&gt;steal()&lt;/script&gt;"));
  assert.ok(out.includes("**bold** [click](javascript:alert(1))"), "markdown is shown as typed, never rendered");
  assert.ok(out.includes("&quot; onmouseover=&quot;alert(1)&quot; x=&quot;"));
  assert.ok(out.includes("&#39;&gt;&lt;svg onload=alert(1)&gt;"));
});

test("hostile ids cannot break out of a link or an attribute", () => {
  const e = entry(EVIL, { id: EVIL.quote });
  const out = String(tableRow(e, NOW, false, {}));
  assert.match(out, /href="#\/memories\/%22%20onmouseover%3D%22alert\(1\)%22%20x%3D%22"/);
  const cap = String(capsuleView({ sections: [{ slot: "identity", content: "x", source_id: EVIL.quote, name: null, updated_at: NOW }], chars: 1, cap: 9500 }, NOW));
  assert.deepEqual(parse(cap, "capsule").attrs.filter((a) => a.includes("onmouseover")), []);
  assert.match(cap, /id="sec-&quot; onmouseover=&quot;/);
  const feed = String(entryView({ version_id: 1, memory_id: EVIL.quote, title: "t", origin: "capture", kind: "retired", reason: "retire_never_recalled", at: NOW, state: "trashed", can_undo: true, purge_at: NOW, replaced_by: null }, NOW));
  assert.match(feed, /data-id="&quot; onmouseover=&quot;alert\(1\)&quot; x=&quot;"/);
});

test("memory links in text are never turned into links", () => {
  const out = String(tableRow(entry({ ...EVIL, md: "see [x](https://evil.example)" }), NOW, false, {}));
  assert.doesNotMatch(out, /href="https?:/);
});

test("the search form says that nothing here counts as a recall and offers no switch to turn that off", () => {
  const out = String(searchForm());
  assert.match(out, /Nothing here counts as a recall/);
  assert.doesNotMatch(out, /name="count"/);
});

test("a calm status is one line, an unwell one lists what needs a look and says how many checks are fine", () => {
  const calm = String(statusView({ checks: [{ id: "nightly", label: "Nightly job", state: "ok", detail: "Ran 6 hours ago.", href: "#/health" }, { id: "backup", label: "Backup", state: "off", detail: "No bucket.", href: "#/health" }], summary: { attention: 0, worst: "ok" } }));
  assert.match(calm, /<strong>All is well\.<\/strong>/);
  assert.match(calm, /Nightly job<\/span> ran 6 hours ago\./, "the phrase follows the label as one sentence");
  assert.doesNotMatch(calm, /<span class="fact__label">Access token/, "only the two with an age are in the line, the rest are one click away");
  assert.match(calm, /All 2 checks/);
  assert.doesNotMatch(calm, /need attention|issues/);
  const bad = String(statusView({ checks: [{ id: "a", label: "A", state: "warn", detail: "x", href: "#/health" }, { id: "b", label: "B", state: "fail", detail: "y", href: "#/people" }, { id: "c", label: "C", state: "ok", detail: "z", href: "#/health" }], summary: { attention: 2, worst: "fail" } }));
  assert.match(bad, /2 things need attention/);
  assert.match(bad, /The other check is fine\./);
  assert.match(bad, /Needs a look/);
  assert.match(bad, /Failing/);
  assert.match(bad, /href="#\/people">Open</);
  const one = String(statusView({ checks: [{ id: "a", label: "A", state: "warn", detail: "x", href: "#/health" }], summary: { attention: 1, worst: "warn" } }));
  assert.match(one, /1 thing needs attention/);
});

test("every state has a word and a shape, so colour is never the only signal", () => {
  for (const state of ["ok", "warn", "fail", "off"]) {
    const out = String(stateMark(state));
    assert.match(out, /<svg class="icon " aria-hidden="true"/, state);
    assert.match(out, /<span class="state__word">[A-Za-z ]+<\/span>/, state);
  }
  assert.match(String(resultRow(200)), /Went through/);
  assert.match(String(resultRow(422)), /Refused/);
  assert.match(String(resultRow(429)), /Held back/);
  assert.match(String(resultRow(403)), /Not allowed/);
  assert.match(String(resultRow(502)), /Failed, 502/);
});
const resultRow = (status) => auditRows([{ id: 1, ts: NOW, actor_kind: "device", actor_id: "d", harness: "claude", script: "", method: "GET", route: "/x", status, duration_ms: 1, memory_ids: [] }]);

test("when the overview could not be read the captures panel does not claim that no model call failed", () => {
  const usage = { days: [{ day: "2026-10-01", proposed: 1, screened: 0, saved: 1, refused: 0, limited: 0, duplicates: 0, model_failures: 0 }] };
  assert.match(String(capturesView(usage, null, false)), /Whether a model call failed is not known right now\./);
  assert.match(String(capturesView(usage, { model_failures: { last_7_days: {} } }, false)), /No model call failed this week\./);
});

test("a chart always has a table twin and a legend, and a tooltip on every bar", () => {
  const growth = { days: 30, bucket: "day", total: 4, buckets: [{ start: "2026-10-01", counts: { explicit: 1, capture: 3 } }] };
  const out = String(growthView(growth, 30, false));
  assert.match(out, /<table class="data">/);
  assert.match(out, /<ul class="legend">/);
  assert.match(out, /Show as table/);
  assert.match(out, /data-table="growth" hidden/);
  const asTable = String(growthView(growth, 30, true));
  assert.match(asTable, /data-plot="growth"[^>]*hidden/);
  assert.match(asTable, /aria-pressed="true"/);
  assert.match(String(stackedBars({ buckets: [{ label: "1 Oct", values: { a: 1 } }], series: [{ key: "a", label: "A", cls: "s1" }], width: 300, summary: "s" })), /data-tip="1 Oct\nA 1"/);
});

const link = (over = {}) => ({ type: "about", direction: "out", other_id: "id-other-1", other_name: "corolla-service", made_by: "user", confidence: null, created_at: NOW, ...over });

test("links are grouped by type, name the other memory, and say which way they go", () => {
  const out = String(linksView([link(), link({ other_id: "id-other-2", other_name: "pip-vet", direction: "in", type: "about" }), link({ other_id: "id-other-3", other_name: "alpha-plan", type: "part_of" })]));
  assert.equal([...out.matchAll(/<h4 class="h3">(\w+)<\/h4>/g)].map((m) => m[1]).join(","), "about,part_of", "one heading a type, in the order of the list");
  assert.match(out, /Links to <a href="#\/memories\/id-other-1">corolla-service<\/a>/);
  assert.match(out, /Linked from <a href="#\/memories\/id-other-2">pip-vet<\/a>/);
  assert.match(String(linksView([])), /No links yet/);
  assert.equal(String(linksView(null)), "", "a Worker that could not list them leaves the section out");
});

test("a link of a type outside the list shows as related, and its button still carries the stored type", () => {
  const out = String(linksView([link({ type: "likes-a-lot" })]));
  assert.match(out, /<h4 class="h3">related<\/h4>/);
  assert.doesNotMatch(out, /<h4[^>]*>likes-a-lot/);
  assert.match(out, /data-type="likes-a-lot"/);
});

test("a system link shows its confidence and offers Not this, and a user link offers Remove", () => {
  const sys = String(linksView([link({ made_by: "system", confidence: 0.82 })]));
  assert.match(sys, /made by anymem/);
  assert.match(sys, /82% sure/);
  assert.match(sys, /data-action="unlink"[^>]*data-made-by="system">Not this/);
  const mine = String(linksView([link()]));
  assert.match(mine, /data-made-by="user">Remove/);
  assert.doesNotMatch(mine, /made by anymem|sure/);
  assert.doesNotMatch(String(linksView([link({ made_by: "system", confidence: null })])), /sure/, "a link without a confidence shows none");
});

test("the link form offers the closed list of types except the two the system writes", () => {
  const out = String(linkForm());
  assert.deepEqual([...out.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]), ADDABLE_LINK_TYPES);
  assert.equal(ADDABLE_LINK_TYPES.length, 8);
  assert.doesNotMatch(out, /value="supersedes"|value="derived_from"/);
  assert.match(out, /<option value="related" selected>/);
  assert.doesNotMatch(out, /<input name="type"/, "the type is chosen, never typed");
});

test("the memory panel offers actions only where they work", () => {
  const live = String(detailView(entry(BENIGN), { versions: [], extras: null, links: null }, NOW));
  for (const a of ['data-form-name="edit"', 'data-form-name="append"', 'data-form-name="link"', 'data-action="undo"', 'data-action="forget"', 'data-form="status"']) assert.ok(live.includes(a), a);
  const trashed = String(detailView(entry(BENIGN, { deleted_at: NOW - 3 * DAY }), { versions: [], extras: { purge_at: NOW - 3 * DAY + 14 * DAY }, links: null }, NOW));
  assert.match(trashed, /data-action="restore"/);
  assert.match(trashed, /goes for good in 11 days/, "the day count is the Worker's purge time");
  assert.match(String(detailView(entry(BENIGN, { deleted_at: NOW - 3 * DAY }), { versions: [], extras: null, links: null }, NOW)), /This memory is in the trash\./, "without the purge time there is no count to make up");
  assert.doesNotMatch(trashed, /data-action="forget"|data-form-name="edit"/);
  const closed = String(detailView(entry(BENIGN, { valid_until: NOW - 1, superseded_by: "abcdef0123456789" }), { versions: [], extras: null, links: null }, NOW));
  assert.match(closed, /closed history, replaced by <a href="#\/memories\/abcdef0123456789">abcdef01<\/a>/);
  assert.equal(activeFilters({ origin: "capture", sort: "created", time: "all", tag: "" }), 1);
  assert.equal(activeFilters({ sort: "recalls" }), 1);
  const table = String(listView([], null, NOW, "", { origin: "capture", sort: "recalls" }));
  assert.match(table, /aria-sort="descending"[^>]*><button[^>]*data-sort="recalls"/, "the sorted column says so");
  assert.match(table, /class="th__filter is-set" popovertarget="pop-origin" aria-label="Filter by Origin, now capture"/, "a set filter is marked in its header");
  assert.match(table, /Origin <strong>capture<\/strong>/, "and listed above the table with a way to remove it");
  assert.match(table, /No memories match/, "the headers stay when nothing matches");
});

test("the activity table lists what the system did, shows undo only when it works, and says why", () => {
  const base = { memory_id: "m", title: "A fact", origin: "capture", project: "", at: NOW, state: "closed", can_undo: true, purge_at: null, replaced_by: { id: "n", title: "A newer fact" } };
  const entries = [{ ...base, version_id: 1, kind: "replaced", reason: "supersede" }, { ...base, version_id: 2, kind: "retired", reason: "retire_idle_project", state: "changed_since", can_undo: false, replaced_by: null, at: NOW - 3 * DAY }];
  const out = String(feedView(entries, NOW));
  assert.equal([...out.matchAll(/data-action="undo-row"/g)].length, 1);
  assert.match(out, /Replaced by <a href="#\/memories\/n">A newer fact<\/a>, which contradicts it\./);
  assert.match(out, /project memory was not recalled for 90 days/);
  assert.match(out, /title="Changed since, by an undo or an edit\."/);
  assert.match(out, /href="#\/activity\/m"/, "the memory opens in a drawer on this page");
  assert.match(String(feedView([], NOW)), /The system has not changed anything yet/);
  // The Worker filters by state, so a filter with no rows in the reply says Nothing matches, and the headers stay.
  const filtered = String(feedView([], NOW, { state: "trashed" }));
  assert.match(filtered, /Now <strong>In the trash<\/strong>/, "the filter in use is named and can be removed");
  assert.match(filtered, /Nothing matches/, "and the headers stay so it can be loosened");
  assert.match(filtered, /popovertarget="pop-kind"/);
});


test("the trash lists the closest to the end first, with the days left in words", () => {
  // A reply as GET /ui/api/trash sends it: the rows in order, each with its purge time, and the counts for the filters.
  const row = (id, daysAgo) => ({ id, title: BENIGN.name, origin: "capture", project: "", deleted_at: NOW - daysAgo * DAY, purge_at: NOW - daysAgo * DAY + 14 * DAY });
  const reply = { ok: true, window_days: 14, entries: [row("a", 12), row("x", 1)], shown: 2, matching: 2, total: 2, soon: 1, older: 1, projects: [] };
  const out = String(trashView(reply, NOW));
  assert.match(out, /2 memories in the trash, 1 gone for good within 3 days/);
  assert.match(out, /2 days<\/span>/);
  assert.match(out, /13 days<\/span>/);
  assert.match(out, /1 older memory is past 14 days/);
  assert.match(String(trashView({ ...reply, entries: [row("a", 12)], shown: 1, matching: 3 }, NOW)), /The list shows the first 1 of 3\./, "a list cut at the cap says so");
  assert.match(String(trashView({ window_days: 14, entries: [], shown: 0, matching: 0, total: 0, soon: 0, older: 0, projects: [] }, NOW)), /The trash is empty/);
});

test("the capsule shows size against the cap, the over cap warning, and the text as a session receives it", () => {
  const sections = [{ slot: "preferences", content: "Short answers.", source_id: "b", updated_at: NOW }, { slot: "identity", content: "I am Alex.", source_id: "a", updated_at: NOW }, { slot: "identity", content: "I live in Cape Town.", source_id: "c", updated_at: NOW }];
  assert.equal(capsuleText(sections), "## Memory capsule (anymem Worker, live)\n\nAlways-on rules from the shared memory store. Recall anything else with the anymem skill's recall script.\n\n### identity\nI am Alex.\n\nI live in Cape Town.\n\n### preferences\nShort answers.");
  const named = sections.map((s) => ({ ...s, name: s.source_id === "a" ? "identity-note" : null })); // the Worker sends each section with its memory name
  const out = String(capsuleView({ sections: named, chars: 10000, cap: 9500, over_cap: true, warning: "Too long." }, NOW));
  assert.match(out, /10,000<\/strong> of 9,500 characters, 105 percent\. 500 over\./);
  assert.match(out, /role="alert"/);
  assert.match(out, /<a class="mem__title" href="#\/capsule\/a">identity-note<\/a>/, "a section opens its memory in a drawer on the capsule");
  assert.match(out, /<a class="mem__title" href="#\/capsule\/b">memory b<\/a>/);
  assert.match(out, /Over the cap/, "the fullness is said in words");
  assert.match(out, /<td colspan="4" class="muted">Empty\. No canonical memory fills this slot yet\./, "a standard slot nothing fills is shown as empty");
  assert.match(String(capsuleView({ sections: [], chars: 0, cap: 9500 }, NOW)), /The capsule is empty/);
  assert.doesNotMatch(out, /cuts it at/, "a short capsule needs no warning about the hook's cut");
  const long = String(capsuleView({ sections: [{ slot: "identity", content: "x".repeat(9600), source_id: "a", name: null, updated_at: NOW }], chars: 9600, cap: 9500 }, NOW));
  assert.match(long, /The session start hook cuts it at 9,500, so the end would not reach a session\./);
});

test("the nightly job grid has one column per run and says in words what each cell is", () => {
  const out = String(runsView([{ id: 2, job: "nightly", started_at: NOW, finished_at: NOW, ok: false, steps: [{ name: "backup", state: "refused", headline: "Refused." }, { name: "merge", state: "ok", headline: "merged 1" }] }, { id: 1, job: "manual", started_at: NOW - DAY, finished_at: NOW - DAY, ok: true, steps: [{ name: "merge", state: "skipped", headline: "off" }] }], NOW));
  assert.equal([...out.matchAll(/class="grid-table__run"/g)].length, 2);
  assert.match(out, /The latest run had a failing step\./);
  assert.match(out, /<span class="sr">Refused, Refused\.<\/span>/);
  assert.match(out, /<span class="sr">Skipped, off<\/span>/);
  assert.match(out, /<span class="sr">Not run<\/span>/, "a step a run did not have is marked");
  assert.match(out, />hand<\/span>/);
  assert.match(String(runsView([], NOW)), /The nightly job has not run yet/);
});

test("size against the plan names the limit and says where it came from", () => {
  const out = String(capacityView({ plan: { plan: "Workers Paid", checked: "2026-10-18" }, db: { size_bytes: 956_000, limit_bytes: 10 * 1024 ** 3 }, vectors: { count: 346, limit: 20_000_000, dimensions: 384, stored_dimensions: 132_864, included_dimensions: 10_000_000 }, write_limit: {}, days: [] }, { configured: false }));
  assert.match(out, /933\.6 KB<\/strong> of 10\.00 GB, 0\.01%/);
  assert.match(out, /346<\/strong> of 20,000,000 the index can hold, 0%/);
  assert.match(out, /132,864<\/strong> of 10,000,000 included in the plan, 1%\. Beyond that a small charge applies, nothing stops\./);
  assert.match(out, /Workers Paid, from the Cloudflare documentation on 2026-10-18/);
  assert.match(out, /No expiry date is set/);
  assert.match(String(capacityView({ plan: { plan: "p", checked: "d" }, db: { size_bytes: null, limit_bytes: 1 }, vectors: null }, null)), /Size not reported by this Worker\.[\s\S]*The index did not answer\./);
});

test("the write limit lists the tokens that wrote lately and says so when none did", () => {
  const out = String(limitView({ write_limit: { limit: 40, window_minutes: 10, tokens: [{ id: "d", label: "MacBook", used: 40, resets_in_seconds: 200 }] } }));
  assert.match(out, /40 of 40/);
  assert.match(out, /4 min/);
  assert.match(out, /sbar--soon/);
  assert.match(String(limitView({ write_limit: { limit: 40, window_minutes: 10, tokens: [] } })), /Nothing has written in the last 10 minutes/);
});

test("the probation list folds the rest away and says what happens to each capture", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, title: `t${i}`, origin: "capture", project: "", created_at: NOW - 50 * DAY, probation_until: NOW + 10 * DAY, days_left: 10 - i, recall_count: i === 0 ? 2 : 0, retires: i !== 3, retire_at: i === 1 ? NOW + 10 * DAY : null }));
  const out = String(probationView({ total: 10, entries }, NOW));
  assert.match(out, /Show 2 more/);
  assert.match(out, /Stays once the 60 days end\./);
  assert.match(out, /Goes to the trash on \d+ \w+ unless it is recalled\./);
  assert.match(out, /Goes to the trash if it is never recalled\./);
  assert.match(out, /Stays, the nightly job never retires this one\./, "a memory the job never retires is not promised the trash");
  assert.match(String(probationView({ total: 0, entries: [] }, NOW)), /No capture is on probation/);
});

test("the recall panel says how many calls found nothing, and without harness data that injection is decided on your machine", () => {
  const r = { days: [{ day: "2026-10-01", calls: 10, empty: 4 }], total: 10, empty: 4, by_harness: [], most_recalled: [], never_recalled: { count: 0, sample: [] } };
  const out = String(recallsView(r, false));
  assert.match(out, /asked for memories 10 times in 30 days\. 4 of those calls \(40 percent\) found nothing at all\./);
  assert.match(out, /What the hook did with the answer is decided on your machine\./);
  assert.doesNotMatch(out, /By tool|Quiet over/);
  assert.match(String(recallsView({ ...r, days: [], total: 0, empty: 0 }, false)), /No agent asked for memories/);
});
/** The words a view writes itself, without the memory text that came from the store. */
function proseOf(markup) {
  const withoutCode = String(markup).replace(/<(pre|code|textarea)\b[\s\S]*?<\/\1>/g, " ").replace(/<(title|desc)\b[\s\S]*?<\/\1>/g, " ");
  return withoutCode.replace(/<[^>]+>/g, " ").replace(/&(#39|quot|amp|lt|gt);/g, " ").replace(/\s+/g, " ");
}

test("the copy every view writes has no colon, no dash used as a connector and no emoji", () => {
  const all = views(BENIGN).map(([name, v]) => [name, proseOf(v)]);
  all.push(["searchForm", proseOf(searchForm())], ["empty feed", proseOf(feedView([], NOW))]);
  for (const [name, text] of all) {
    assert.doesNotMatch(text, /\D:|:\D/, `${name} has a colon in prose`); // a time such as 10:00 is data, not prose
    assert.doesNotMatch(text, /\s[-–—]\s|--|[–—]/, `${name} has a dash used as a connector`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${name} has an emoji`);
  }
});

test("every scrolling table can be reached and scrolled from the keyboard and has a name", () => {
  let seen = 0;
  for (const [name, view] of views(BENIGN)) {
    for (const m of String(view).matchAll(/<div class="scroll"([^>]*)>/g)) {
      seen++;
      assert.match(m[1], /tabindex="0"/, `${name} has a scrolling region the keyboard cannot reach`);
      assert.match(m[1], /role="region" aria-label="[^"]+"/, `${name} has an unnamed scrolling region`);
    }
  }
  assert.ok(seen >= 6, `${seen} scrolling regions were checked`);
});

test("an Access token that could not be read says so, and does not look like a token with no expiry", () => {
  const u = { plan: { plan: "Workers Paid", checked: "2026-10-18" }, db: { size_bytes: 956_000, limit_bytes: 10 * 1024 ** 3 }, vectors: null };
  const failed = String(capacityView(u, { failed: "The network failed." }));
  assert.match(failed, /The expiry date could not be read\. The network failed\./);
  assert.doesNotMatch(failed, /No expiry date is set/);
  assert.match(String(capacityView(u, { configured: false })), /No expiry date is set/, "a token with no date still says so");
});

test("the pending list says when it shows only the first page of the changes waiting", () => {
  const pending = entry(BENIGN, { name: "profile-proposal-phone", content: "---\nname: profile-proposal-phone\n---\n\nProposed Phone: 123\nCurrent Phone: 456" });
  const shown = String(pendingView([pending], {}, NOW, 503));
  assert.match(shown, /503 changes waiting for you/, "the heading counts every change, the same as the sidebar");
  assert.match(shown, /Showing the first 1 of 503\. Accept or dismiss these to see the rest\./);
  assert.doesNotMatch(String(pendingView([pending], {}, NOW, 1)), /Showing the first/, "a full page says nothing");
});

test("a subject card shows its brief and fields as typed text, the fields with when they were confirmed", () => {
  const out = String(subjectView(subject(EVIL), [], NOW, "#/subjects"));
  assert.ok(out.includes("**bold** [click](javascript:alert(1))"), "the brief is shown as typed, never rendered");
  assert.match(out, /<pre class="text" role="region" aria-label="Brief" tabindex="0">\*\*bold\*\*/);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.doesNotMatch(out, /href="https?:/);
  const pip = String(subjectView(subject(BENIGN, { fields: { vet: { value: "Dr Dana", confirmed_at: NOW - 2 * DAY, source: "user" }, health_note: { value: "none", confirmed_at: NOW, source: "user" } } }), [], NOW, "#/subjects"));
  assert.match(pip, /<dt>Vet<\/dt><dd>Dr Dana<span class="cell__sub" title="[^"]+">confirmed 2 days ago<\/span>/);
  assert.match(pip, /<dt>Health note<\/dt>/, "a key is shown by its label");
});

test("a subject card has the four buttons, a scope toggle, and the members as a table whose rows open the memory", () => {
  const out = String(subjectView(subject(BENIGN, { scope: "shared" }), [{ type: "about", direction: "in", other_id: "m2", other_name: "pip-vet", made_by: "user", confidence: null }], NOW, "#/subjects"));
  for (const label of ["Edit brief", "Edit fields", "Add alias", "Retire"]) assert.match(out, new RegExp(`>${label}</button>`), label);
  assert.match(out, /<input type="radio" name="subject-scope" value="shared" data-change="subject-scope" checked>/);
  assert.match(out, /<input type="radio" name="subject-scope" value="private" data-change="subject-scope" >/);
  assert.match(out, /<tr data-id="m2"><th scope="row" class="mem__cell"><a class="mem__title" href="#\/memories\/m2">plain<\/a>/);
  assert.match(out, /Linked from <a href="#\/memories\/m2">pip-vet<\/a>/, "the links of the card are the memory drawer's Links section");
  assert.doesNotMatch(out, /data-action="unlink"/, "and they are changed on the memory, not here");
  assert.match(String(linksView([{ type: "about", direction: "out", other_id: "m2", other_name: "x", made_by: "user" }])), /data-action="unlink"/, "the memory drawer keeps its buttons");
  assert.match(String(subjectView(subject(BENIGN, { member_count: 300 }), [], NOW, "#/subjects")), /Showing the newest 2 memories of 300 memories\./);
  assert.match(String(subjectView(subject(BENIGN, { members: [], member_count: 0 }), [], NOW, "#/subjects")), /No memory is about this subject yet\./);
});

test("a retired subject says so and offers to bring it back instead of Retire", () => {
  const out = String(subjectView(subject(BENIGN, { status: "retired" }), [], NOW, "#/subjects"));
  assert.match(out, /This subject is retired\. Recall does not offer a retired subject\./);
  assert.match(out, /data-status="active">Bring back</);
  assert.doesNotMatch(out, /data-status="retired"/);
});

test("the fields form offers the keys of the subject's kind and never one of another kind", () => {
  const names = (kind) => [...String(fieldsForm(subject(BENIGN, { kind, fields: {} }))).matchAll(/<input name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names("person"), ["relationship", "known_as", "work", "contact", "birthday"]);
  assert.deepEqual(names("pet"), ["name", "species", "breed", "born", "vet", "status", "health_note"]);
  assert.deepEqual(names("topic"), ["what"]);
  assert.deepEqual(names("nonsense"), []);
  assert.match(String(fieldsForm(subject(BENIGN))), /<input name="vet" value="plain" maxlength="200"/);
});

test("the new subject form asks for kind, name, slug and brief, and the slug has the Worker's rule", () => {
  const out = String(newForm());
  assert.deepEqual([...out.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]), ["person", "pet", "asset", "project", "area", "topic"]);
  for (const name of ["name", "slug", "brief"]) assert.match(out, new RegExp(`name="${name}"`), name);
  assert.match(out, /name="slug" required minlength="2" maxlength="40" pattern="\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*"/);
});

test("the subjects table has a column for name, kind, status, scope, members and changed, and says why it is empty", () => {
  const out = String(subjectListView([subject(BENIGN)], NOW, "", {}));
  for (const head of ["Subject", "Kind", "Status", "Scope", "Members", "Changed"]) assert.match(out, new RegExp(`<th scope="col" class="th[^"]*"[^>]*>(<span class="th__row">)?(<button[^>]*>)?${head}`), head);
  assert.match(out, /href="#\/subjects\?subject=pip"/);
  assert.match(out, /<td class="num">3<\/td>/);
  assert.match(String(subjectListView([], NOW, "", {})), /No subjects yet/);
  assert.match(String(subjectListView([], NOW, "", { kind: "pet" })), /No subjects match[\s\S]*Clear the filters/);
  assert.match(String(subjectListView([], NOW, "", { kind: "pet" })), /<th scope="col" class="th"><span class="th__row">Kind/, "the headers stay, they hold the filters");
  assert.match(String(subjectRow(subject(BENIGN, { aliases: ["pippa"] }), NOW, false, {})), /pip, also called pippa/);
});

test("the memory drawer shows the subjects a memory is about as chips that open the subject", () => {
  const out = String(factsView(entry(BENIGN), null, NOW, [{ id: "c1", slug: "pip", name: "Pip" }]));
  assert.match(out, /<dt>Subjects<\/dt><dd><ul class="tags" aria-label="Subjects"><li><a href="#\/subjects\?subject=pip">Pip<\/a><\/li><\/ul>/);
  assert.doesNotMatch(String(factsView(entry(BENIGN), null, NOW)), /Subjects/, "a memory about nothing has no Subjects row");
});
