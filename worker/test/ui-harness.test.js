// The harness views and the words behind them. The Worker names every harness, the page only shows what it is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessOptions, harnessText, quietSentence, recalledByView, savedByText, viaWords } from "../ui/lib/harness.js";
import { harnessChip, provenance } from "../ui/lib/components.js";
import { listQuery } from "../ui/lib/filters.js";
import { activeFilters, detailView, factsView, listView, tableRow } from "../ui/screens/memories.js";
import { quietView, recallsView, sourcesView, toolRows, toolsView, toolTable } from "../ui/screens/home.js";
import { auditRows, harnessLabel } from "../ui/screens/audit.js";
import { entryView } from "../ui/screens/activity.js";
import { hitView } from "../ui/screens/search.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const mem = (over = {}) => ({ id: "11111111-aaaa", name: "otters", description: "d", content: "c", tags: [], status: "active", origin: "capture", harness: "claude", harness_label: "Claude Code", session: "sess-1", project: "", recall_count: 0, last_recalled_at: null, created_at: NOW - DAY, updated_at: NOW - DAY, deleted_at: null, valid_until: null, valid_from: NOW - DAY, superseded_by: null, pinned: false, kind: "semantic", type: null, ...over });

test("the words for a harness come from the Worker, and an older reply falls back to the raw name", () => {
  assert.equal(harnessText({ harness: "claude", harness_label: "Claude Code" }), "Claude Code");
  assert.equal(harnessText({ harness: "", harness_label: "Imported" }), "Imported");
  assert.equal(harnessText({ harness: "kilo" }), "kilo");
  assert.equal(harnessText({ harness: "" }), "Unknown");
  assert.equal(harnessText({}), "Unknown");
});

test("the filter options carry counts, and the blank groups share one option", () => {
  const rows = [
    { harness: "claude", label: "Claude Code", filter: "claude", memories: 456 },
    { harness: "", label: "Imported", filter: "none", memories: 383 },
    { harness: "", label: "Unknown", filter: "none", memories: 123 },
    { harness: "codex", label: "Codex", filter: "codex", memories: 24 },
  ];
  assert.deepEqual(harnessOptions(rows), [["claude", "Claude Code, 456"], ["none", "Not recorded, 506"], ["codex", "Codex, 24"]]);
  assert.deepEqual(harnessOptions([], "kilo"), [["kilo", "kilo, 0"]], "the one in use stays even when nothing counted it");
  assert.deepEqual(harnessOptions([], "none"), [["none", "Not recorded, 0"]]);
  assert.deepEqual(harnessOptions(undefined), []);
  assert.deepEqual(harnessOptions(rows, "codex").length, 3);
});

test("a script label becomes words with no colon", () => {
  assert.equal(viaWords("hook:capture"), "the capture hook");
  assert.equal(viaWords("remember"), "the remember script");
  assert.equal(viaWords(""), "");
  assert.equal(viaWords(null), "");
});

test("who saved a memory reads as a sentence, says when the audit trail cannot know, and is left out when not sent", () => {
  assert.equal(savedByText({ at: NOW - 3 * DAY, by: "laptop", kind: "device", script: "hook:capture" }, NOW), "laptop, through the capture hook, 3 days ago");
  assert.equal(savedByText({ at: NOW - 3600_000, by: "The admin token", kind: "admin", script: "" }, NOW), "The admin token, 1 hour ago");
  assert.equal(savedByText(null, NOW), "Not in the audit trail, which keeps 90 days.");
  assert.equal(savedByText(undefined, NOW), null);
});

test("the tools a memory was given read as one sentence, with what the count can and cannot know", () => {
  const some = recalledByView({ recalled_by: [{ harness: "claude", label: "Claude Code", times: 8 }, { harness: "codex", label: "Codex", times: 1 }], recall_log_since: Date.parse("2026-10-18T10:00:00Z") });
  assert.equal(some.text, "Claude Code 8 times, Codex 1 time.");
  assert.match(some.note, /Counted from 2026-10-18, and kept for 90 days\./);
  assert.match(recalledByView({ recalled_by: [], recall_log_since: Date.parse("2026-10-18T10:00:00Z") }).text, /No counted recall since 2026-10-18\./);
  assert.equal(recalledByView({ recalled_by: [], recall_log_since: null }).text, "No counted recall recorded yet.");
  assert.equal(recalledByView({}), null, "an older Worker sends nothing, so nothing is claimed");
  assert.equal(recalledByView(null), null);
});

test("the quiet sentence says since when, how many prompts, and leaves failed searches out", () => {
  const outcomes = { since: "2026-10-10", windows: [{ days: 7, injected: 1, quiet: 3, failed: 0, prompts: 4, quiet_percent: 75 }, { days: 30, injected: 10, quiet: 30, failed: 2, prompts: 40, quiet_percent: 75 }] };
  assert.equal(quietSentence(outcomes), "In 30 days the hooks searched for 40 prompts and added memories to 10. They left 30 quiet. 2 searches could not run and are left out. Reporting began on 10 Oct.");
  assert.match(quietSentence({ ...outcomes, windows: [outcomes.windows[0], { ...outcomes.windows[1], failed: 1 }] }), /1 search could not run and is left out\./);
  assert.match(quietSentence({ since: "2026-10-10", windows: [{ days: 7, injected: 0, quiet: 0, failed: 0, prompts: 0 }, { days: 30, injected: 0, quiet: 0, failed: 0, prompts: 0 }] }), /none searched for a prompt in the last 30 days\./);
  assert.equal(quietSentence({ since: null, windows: [] }), null);
  assert.equal(quietSentence(null), null);
});

test("every list row, the detail panel, a search hit and an activity row show the harness in the Worker's words", () => {
  const e = mem({ harness: "codex", harness_label: "Codex" });
  for (const [name, out] of [["chip", harnessChip(e)], ["provenance", provenance(e)], ["row", tableRow(e, NOW, false, {})], ["detail", detailView(e, { versions: [], extras: null, links: null }, NOW)], ["hit", hitView({ ...e, relevant: true, score: 0.03, similarity: 0.7, why: { keyword_terms: [], checks: [] } }, 1, [])], ["activity", entryView({ version_id: 1, memory_id: e.id, title: "t", origin: "capture", harness: "codex", harness_label: "Codex", kind: "retired", reason: "retire_never_recalled", at: NOW, state: "trashed", can_undo: false, purge_at: NOW, replaced_by: null }, NOW)]]) {
    assert.match(String(out), /<span class="tool"><svg[^>]*><use href="#i-tool"><\/use><\/svg><span class="sr">Source <\/span>Codex<\/span>/, name);
  }
  assert.match(String(harnessChip(mem({ harness: "", harness_label: "Imported", origin: "import" }))), /Imported<\/span>/);
  assert.match(String(harnessChip(mem({ harness: "", harness_label: "Unknown" }))), /Unknown<\/span>/);
});

test("the detail panel shows the harness, the session, who saved it, and which tools were given it", () => {
  const extras = { probation_until: null, links: [], saved_by: { at: NOW - 2 * DAY, by: "laptop", kind: "device", script: "hook:capture" }, recalled_by: [{ harness: "claude", label: "Claude Code", times: 8 }, { harness: "codex", label: "Codex", times: 2 }], recall_log_since: NOW - 5 * DAY };
  const out = String(factsView(mem(), extras, NOW));
  assert.match(out, /<dt>Tool<\/dt><dd>Claude Code<\/dd>/);
  assert.match(out, /<dt>Session<\/dt><dd class="mono">sess-1<\/dd>/);
  assert.match(out, /<dt>Saved by<\/dt><dd>laptop, through the capture hook, 2 days ago<\/dd>/);
  assert.match(out, /<dt>Recalled by<\/dt><dd>Claude Code 8 times, Codex 2 times\.<span class="cell__sub">Counted from \d{4}-\d{2}-\d{2}, and kept for 90 days\.<\/span><\/dd>/);
  const bare = String(factsView(mem({ harness: "", harness_label: "Unknown", session: "" }), null, NOW));
  assert.match(bare, /<dt>Tool<\/dt><dd>Unknown<\/dd>/);
  assert.match(bare, /<dt>Session<\/dt><dd class="mono">none<\/dd>/);
  assert.doesNotMatch(bare, /Saved by|Recalled by/, "without the extras nothing is claimed");
  assert.doesNotMatch(String(factsView(mem(), { ...extras, saved_by: undefined }, NOW)), /Saved by/, "a device token is not sent who saved it, and the row is left out");
  assert.match(String(factsView(mem(), { ...extras, saved_by: null }, NOW)), /Not in the audit trail, which keeps 90 days\./);
});

test("the harness filter shows when the Worker counted its sources, counts the filters in use, and goes into the list query", () => {
  const rows = [{ harness: "claude", label: "Claude Code", filter: "claude", memories: 5 }, { harness: "", label: "Imported", filter: "none", memories: 2 }];
  const list = (f, sources) => String(listView([], null, NOW, "", f, sources));
  const withSources = list({ harness: "claude" }, rows);
  assert.match(withSources, /<input type="radio" name="harness" value="claude" checked data-pick="filter"><span>Claude Code, 5<\/span>/);
  assert.match(withSources, /<input type="radio" name="harness" value="none" {2}data-pick="filter"><span>Not recorded, 2<\/span>/);
  assert.match(withSources, /Tool <strong>Claude Code<\/strong>/, "the filter in use is named and can be removed");
  assert.doesNotMatch(list({}, []), /name="harness"/, "a Worker that cannot count its sources gets no filter");
  assert.match(list({ harness: "none" }, []), /name="harness"/, "a filter in the address stays visible");
  assert.equal(activeFilters({ harness: "codex" }), 1);
  assert.equal(new URLSearchParams(listQuery({ harness: " codex " }, {})).get("harness"), "codex");
  assert.equal(new URLSearchParams(listQuery({ harness: "none" }, {})).get("harness"), "none");
  assert.equal(new URLSearchParams(listQuery({}, {})).has("harness"), false);
});

const harnesses = (over = {}) => ({
  sources: { total: 931, rows: [{ harness: "claude", label: "Claude Code", filter: "claude", memories: 456 }, { harness: "", label: "Imported", filter: "none", memories: 383 }, { harness: "zcode", label: "ZCode", filter: "zcode", memories: 35 }, { harness: "codex", label: "Codex", filter: "codex", memories: 24 }, { harness: "", label: "Unknown", filter: "none", memories: 33 }] },
  recalls: { total: 120, empty: 12, by_harness: [{ harness: "claude", label: "Claude Code", calls: 100, empty: 10 }, { harness: "codex", label: "Codex", calls: 18, empty: 2 }, { harness: "", label: "Unknown", calls: 2, empty: 0 }] },
  used: { since: Date.parse("2026-10-12T08:00:00Z"), total: 9, by_harness: [{ harness: "claude", label: "Claude Code", recalls: 8, memories: 3, top: [{ id: "a1", title: "otters", count: 5 }, { id: "b2", title: "badgers", count: 2 }] }, { harness: "codex", label: "Codex", recalls: 1, memories: 1, top: [{ id: "c3", title: "herons", count: 1 }] }] },
  outcomes: { since: "2026-10-10", windows: [{ days: 7, injected: 4, quiet: 12, failed: 1, prompts: 16, quiet_percent: 75 }, { days: 30, injected: 10, quiet: 30, failed: 2, prompts: 40, quiet_percent: 75 }], by_harness: [{ harness: "claude", label: "Claude Code", injected: 10, quiet: 20, failed: 2, quiet_percent: 67 }, { harness: "unknown", label: "Unknown", injected: 0, quiet: 10, failed: 0, quiet_percent: 100 }] },
  ...over,
});
const NONE = { sources: { total: 0, rows: [] }, recalls: { total: 0, empty: 0, by_harness: [] }, used: { since: null, total: 0, by_harness: [] }, outcomes: { since: null, windows: [{ days: 7, injected: 0, quiet: 0, failed: 0, prompts: 0, quiet_percent: null }, { days: 30, injected: 0, quiet: 0, failed: 0, prompts: 0, quiet_percent: null }], by_harness: [] } };

test("home says where memories come from, with shares, and offers the blank ones", () => {
  const out = String(sourcesView(harnesses()));
  assert.match(out, /931 live memories\. Claude Code is the biggest source, with 49 percent\./);
  for (const label of ["Claude Code", "Imported", "ZCode", "Codex", "Unknown"]) assert.match(out, new RegExp(`<span class="rank__title">${label}</span>`), label);
  assert.match(out, /416 memories have no harness recorded\. They are called Imported when they were imported and Unknown otherwise/);
  assert.match(out, /<a class="link" href="#\/memories\?harness=none">See them<\/a>/);
  assert.doesNotMatch(String(sourcesView(harnesses({ sources: { total: 5, rows: [{ harness: "claude", label: "Claude Code", filter: "claude", memories: 5 }] } }))), /no harness recorded/);
  assert.match(String(sourcesView(NONE)), /Nothing saved yet/);
});

test("home says which memories each tool was given, since when, and what an empty list means", () => {
  const out = String(toolsView(harnesses()));
  assert.match(out, /9 counted recalls gave memories to your tools in 30 days\. Recording began on 12 Oct and keeps 90 days, so older use is not here\./);
  assert.match(out, /Claude Code <span class="muted">8 recalls of 3 memories<\/span>/);
  assert.match(out, /Codex <span class="muted">1 recall of 1 memory<\/span>/);
  assert.match(out, /href="#\/memories\/a1" class="rank__title">otters<\/a><span class="rank__n">5<\/span>/);
  assert.match(String(toolsView(NONE)), /No recall recorded in 30 days/);
  assert.match(String(toolsView({ ...NONE, used: { since: Date.parse("2026-10-12T08:00:00Z"), total: 0, by_harness: [] } })), /Recording began on 12 Oct and keeps 90 days\./);
});

test("the quiet rate shows 7 and 30 days, says no data plainly, and never shows a rate for no prompts", () => {
  const out = String(quietView(harnesses().outcomes));
  assert.match(out, /<dt>Quiet over 7 days<\/dt><dd class="fig">75%<\/dd><dd class="muted small">16 prompts<\/dd>/);
  assert.match(out, /<dt>Quiet over 30 days<\/dt><dd class="fig">75%<\/dd>/);
  assert.match(out, /Quiet means the search ran and nothing was good enough to add to the prompt\./);
  assert.match(out, /2 searches could not run and are left out\./);
  const none = String(quietView(NONE.outcomes));
  assert.match(none, /No hook has reported what it did yet\./);
  assert.doesNotMatch(none, /%/);
  const part = String(quietView({ since: "2026-10-10", windows: [{ days: 7, injected: 0, quiet: 0, failed: 0, prompts: 0, quiet_percent: null }, { days: 30, injected: 2, quiet: 2, failed: 0, prompts: 4, quiet_percent: 50 }], by_harness: [] }));
  assert.match(part, /<dt>Quiet over 7 days<\/dt><dd class="is-none">No prompts reported<\/dd>/);
  assert.match(part, /<dt>Quiet over 30 days<\/dt><dd class="fig">50%<\/dd>/);
  assert.equal(String(quietView(null)), "");
});

test("recall activity by tool joins the audit calls with what the hooks reported, and says when a tool reports nothing", () => {
  const rows = toolRows(harnesses());
  assert.deepEqual(rows.map((r) => [r.label, r.calls, r.empty, r.prompts, r.quiet_percent]), [["Claude Code", 100, 10, 30, 67], ["Codex", 18, 2, null, null], ["Unknown", 2, 0, 10, 100]], "a blank harness joins the hooks that sent no name");
  const out = String(toolTable(harnesses()));
  assert.match(out, /<th scope="row">Claude Code<\/th><td class="num">100<\/td><td class="num">10, 10%<\/td><td class="num">30<\/td><td class="num">67%<\/td>/);
  assert.match(out, /<th scope="row">Codex<\/th><td class="num">18<\/td><td class="num">2, 11%<\/td><td class="num">not reported<\/td><td class="num">none<\/td>/);
  assert.match(out, /Calls come from the audit trail and include recall scripts as well as hooks\./);
  assert.match(out, /<div class="scroll" tabindex="0" role="region" aria-label="Recall activity by tool">/);
  assert.equal(String(toolTable(NONE)), "");
  const panel = String(recallsView({ days: [{ day: "2026-10-01", calls: 10, empty: 4 }], total: 10, empty: 4, by_harness: [], most_recalled: [], never_recalled: { count: 0, sample: [] } }, false, harnesses()));
  assert.match(panel, /Quiet over 7 days/);
  assert.match(panel, /<h3 class="h3">By tool<\/h3>/);
  assert.doesNotMatch(panel, /decided on your machine/);
  const bare = String(recallsView({ days: [], total: 0, empty: 0, by_harness: [], most_recalled: [], never_recalled: { count: 0, sample: [] } }, false, NONE));
  assert.doesNotMatch(bare, /By tool/, "no heading over an empty table");
  assert.match(bare, /No hook has reported what it did yet\./);
});

test("the audit screen takes its harness names from the Worker", () => {
  const facets = { days: 14, harnesses: [{ harness: "claude", label: "Claude Code", calls: 5 }, { harness: "", label: "Unknown", calls: 1 }, { harness: "dashboard", label: "Dashboard", calls: 9 }], routes: [], per_day: [] };
  const form = String(auditRows([], {}, facets));
  assert.match(form, /<span>Claude Code<\/span><\/label><label class="menu__opt"><input type="radio" name="harness" value="dashboard" {2}data-pick="filter"><span>Dashboard<\/span>/);
  assert.doesNotMatch(form, /value="">Unknown|<span>Unknown<\/span>/);
  assert.match(form, /name="route" value="" maxlength="200" autocomplete="off" list="routes">/, "the route filter is tied to its list of known routes");
  assert.match(String(auditRows([], { harness: "kilo" }, facets)), /<input type="radio" name="harness" value="kilo" checked data-pick="filter"><span>kilo<\/span>/, "the one in use stays");
  assert.doesNotMatch(String(auditRows([], {}, undefined)), /value="claude"/, "with no facets there is nothing to pick yet");
  assert.equal(harnessLabel({ harness: "codex", harness_label: "Codex" }), "Codex");
  assert.equal(harnessLabel({ harness: "" }), "Unknown");
  const row = String(auditRows([{ id: 1, ts: NOW, actor_kind: "device", actor_id: "d1", harness: "agy", harness_label: "Antigravity", script: "hook:recall", method: "GET", route: "/recall", status: 200, duration_ms: 3, memory_ids: [] }]));
  assert.match(row, /<td>Antigravity<span class="cell__sub">device d1 hook:recall<\/span><\/td>/);
});
