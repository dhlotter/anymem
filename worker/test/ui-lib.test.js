import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { esc, html, raw } from "../ui/lib/html.js";
import { against, ago, compact, count, daysLeftLabel, formatBytes, formatNumber, formatTime, greeting, longDate, percent, shareLabel, shortDay, titleOf, truncate, DAY_MS } from "../ui/lib/format.js";
import { appendPage, auditQuery, listQuery, parseLocalTime, recallQuery, splitTags } from "../ui/lib/filters.js";
import { arms, closeness, heldBack, hookQuery, injectedHits, injectedText, parseEntry, rareWords, ruleSplit } from "../ui/lib/relevance.js";
import { findProfile, parseFacts, pendingCurrent, pendingField, pendingValue, personLines, renderFacts, setFact, tagsFor } from "../ui/lib/profile.js";
import { hashFor, memoryLink, parseHash } from "../ui/lib/route.js";
import { redoUndo } from "../ui/lib/drawer.js";
import { ApiError, describeError, isMissingRoute, request } from "../ui/lib/api.js";
import { backupItems } from "../ui/screens/health.js";
import { daysLeft } from "../ui/screens/trash.js";
import { trashQuery } from "../ui/lib/filters.js";

test("esc escapes the five dangerous characters and the backtick", () => {
  assert.equal(esc(`<a href="x" onclick='y'>&\``), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
  assert.equal(esc(null), "");
  assert.equal(esc(42), "42");
});

test("html escapes values, keeps nested html and arrays, and drops empty values", () => {
  const nested = html`<b>${"<i>"}</b>`;
  assert.equal(String(nested), "<b>&lt;i&gt;</b>");
  assert.equal(String(html`<p>${nested}</p>`), "<p><b>&lt;i&gt;</b></p>");
  assert.equal(String(html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`), "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(String(html`${null}${undefined}${false}x`), "x");
  assert.equal(String(raw("<hr>")), "<hr>");
  assert.equal(String(html`${raw("<hr>")}`), "<hr>");
});

test("formatTime uses the viewer's local time and ignores bad input", () => {
  assert.equal(formatTime(new Date(2026, 9, 17, 14, 3).getTime()), "2026-10-17 14:03");
  assert.equal(formatTime(null), "");
  assert.equal(formatTime(NaN), "");
});

test("ago and daysLeftLabel", () => {
  const now = 10 * DAY_MS;
  assert.equal(ago(now - 30_000, now), "just now");
  assert.equal(ago(now - 60_000, now), "1 minute ago");
  assert.equal(ago(now - 5 * 3_600_000, now), "5 hours ago");
  assert.equal(ago(now - 3 * DAY_MS, now), "3 days ago");
  assert.equal(ago(now + 2 * DAY_MS, now), "in 2 days");
  assert.equal(ago(null, now), "never");
  assert.equal(daysLeftLabel(1), "1 day left");
  assert.equal(daysLeftLabel(0), "expires today");
  assert.equal(daysLeftLabel(-3), "expired 3 days ago");
});

test("numbers, bytes, truncation, percent and titles", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(12), "12");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(10 * 1024 ** 3), "10.00 GB");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
  assert.equal(percent(6000, 12000), 50);
  assert.equal(percent(1, 0), 0);
  assert.equal(titleOf({ name: "Name", content: "x" }), "Name");
  assert.equal(titleOf({ name: "", content: "\n\n  first line  \nsecond" }), "first line");
  assert.equal(titleOf({ name: "", content: "" }), "(empty)");
});

test("short days, long dates, greetings, compact numbers, shares and comparisons", () => {
  assert.equal(shortDay("2026-10-05"), "5 Oct");
  assert.equal(shortDay("2026-12-31"), "31 Dec");
  assert.equal(shortDay("nonsense"), "");
  assert.equal(longDate(new Date(2026, 9, 18, 9).getTime()), "Sunday 18 October");
  assert.deepEqual([0, 4, 5, 11, 12, 17, 18, 23].map(greeting), ["Good evening", "Good evening", "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening"]);
  assert.deepEqual([0, 999, 1000, 1234, 12_345, 999_499, 999_999, 1_500_000, NaN].map(compact), ["0", "999", "1k", "1.2k", "12k", "999k", "1m", "1.5m", "0"]);
  assert.equal(shareLabel(956_000, 10 * 1024 ** 3), "0.01%");
  assert.equal(shareLabel(346, 20_000_000), "0%");
  assert.equal(shareLabel(5, 10), "50%");
  assert.equal(shareLabel(1, 0), "0%");
  assert.equal(count(1, "memory", "memories"), "1 memory");
  assert.equal(count(1234, "memory", "memories"), "1,234 memories");
  assert.equal(against(5, 5, "week"), "Same as last week");
  assert.equal(against(5, 1, "week"), "Last week it was 1");
  assert.equal(against(0, 0, "week"), "Same as last week");
  assert.equal(titleOf({ title: "From the API", name: "x" }), "From the API");
});

test("splitTags lowercases, drops hashes and repeats", () => {
  assert.deepEqual(splitTags("  #Alpha, beta  alpha,,gamma "), ["alpha", "beta", "gamma"]);
  assert.deepEqual(splitTags(""), []);
  assert.deepEqual(splitTags(undefined), []);
});

test("listQuery leaves empty filters out and turns a time range into after", () => {
  const now = 1_000 * DAY_MS;
  assert.equal(listQuery({}, { now }), "n=50");
  const q = new URLSearchParams(listQuery({ origin: "capture", status: "", project: " demo ", type: "user", tag: "a, b", time: "7d" }, { now, cursor: "abc_-", n: 20 }));
  assert.deepEqual([...q.entries()], [["origin", "capture"], ["project", "demo"], ["type", "user"], ["tag", "a"], ["tag", "b"], ["after", String(now - 7 * DAY_MS)], ["n", "20"], ["cursor", "abc_-"]]);
  assert.equal(new URLSearchParams(listQuery({ sort: "recalls" }, { now })).get("sort"), "recalls");
  assert.equal(new URLSearchParams(listQuery({ sort: "created" }, { now })).has("sort"), false, "the default order is not sent");
  assert.equal(new URLSearchParams(listQuery({ sort: "name; drop" }, { now })).has("sort"), false, "an unknown order is not sent");
  assert.equal(new URLSearchParams(listQuery({ time: "all" }, { now })).has("after"), false);
});

test("recallQuery always carries count=0, explain=1 and checks=1, and scopes to a project when given", () => {
  const q = new URLSearchParams(recallQuery("  what is my address & phone?  "));
  assert.equal(q.get("query"), "what is my address & phone?");
  assert.equal(q.get("count"), "0");
  assert.equal(q.get("explain"), "1");
  assert.equal(q.get("checks"), "1");
  assert.equal(q.has("scope"), false);
  assert.equal(new URLSearchParams(recallQuery("x", { project: "  AnyMem " })).get("scope"), "project:anymem");
  assert.equal(new URLSearchParams(recallQuery("x", { topK: 3 })).get("topK"), "3");
  assert.equal(new URLSearchParams(recallQuery("x")).get("topK"), "3", "the hook asks for three, so the search shows the same");
});

test("auditQuery turns local times into milliseconds and trims text", () => {
  const since = new Date(2026, 9, 17, 8, 30).getTime();
  const q = new URLSearchParams(auditQuery({ since: "2026-10-17T08:30", until: "", actor: " me@example.com ", route: "/capture", harness: " codex ", result: "refused" }, { cursor: 77, limit: 25 }));
  assert.deepEqual([...q.entries()], [["since", String(since)], ["actor", "me@example.com"], ["route", "/capture"], ["harness", "codex"], ["result", "refused"], ["limit", "25"], ["cursor", "77"]]);
  assert.equal(parseLocalTime(""), undefined);
  assert.equal(parseLocalTime("nonsense"), undefined);
});

test("appendPage keeps what was shown and the cursor, a missing cursor ends the paging", () => {
  const first = appendPage([], { entries: [1, 2], next_cursor: "c1" });
  assert.deepEqual(first, { items: [1, 2], cursor: "c1" });
  assert.deepEqual(appendPage(first.items, { entries: [3], next_cursor: null }), { items: [1, 2, 3], cursor: null });
  assert.deepEqual(appendPage([], {}), { items: [], cursor: null });
});

test("relevance display: closeness, yes or no, rare words, and the first three relevant hits", () => {
  assert.equal(closeness({ similarity: 0.71234 }), "0.712");
  assert.equal(closeness({ similarity: null }), "none");
  const why = { keyword_terms: [{ term: "acmeco", level: 2, idf: 7 }, { term: "common", level: 2, idf: 1 }, { term: "body", level: 1, idf: 9 }] };
  assert.deepEqual(rareWords({ why }), ["acmeco"]);
  assert.deepEqual(rareWords({}), []);
  const hits = [{ id: 1, relevant: false }, { id: 2, relevant: true }, { id: 3, relevant: true }, { id: 4, relevant: true }, { id: 5, relevant: true }];
  assert.deepEqual(injectedHits(hits).map((h) => h.id), [2, 3, 4]);
  assert.deepEqual(injectedHits(undefined), []);
});

test("injected hits follow the hook's scope: global memories always, a project memory only in its project", () => {
  const hits = [
    { id: 1, relevant: true, project: "" },
    { id: 2, relevant: true, project: "other" },
    { id: 3, relevant: true, project: "anymem" },
    { id: 4, relevant: true },
    { id: 5, relevant: false, project: "anymem" },
  ];
  assert.deepEqual(injectedHits(hits).map((h) => h.id), [1, 4], "with no project, a project memory is left out");
  assert.deepEqual(injectedHits(hits, "  AnyMem ").map((h) => h.id), [1, 3, 4], "the project is trimmed and compared in lower case");
  const crowd = [
    { id: 1, relevant: true, project: "other" },
    { id: 2, relevant: true, project: "other" },
    { id: 3, relevant: true, project: "anymem" },
    { id: 4, relevant: true, project: "anymem" },
    { id: 5, relevant: true, project: "" },
  ];
  assert.deepEqual(injectedHits(crowd, "anymem").map((h) => h.id), [3, 4, 5], "the scope is applied before the first three are taken, as the hook does");
});

test("relevance reads the arms, the rules, the held back reason and the hook's query", () => {
  // The client's copy of the held back rule is is_capsule in hooks/memory_recall.py: the same two tag prefixes.
  const hookPy = readFileSync(fileURLToPath(new URL("../../hooks/memory_recall.py", import.meta.url)), "utf8");
  const capsulePy = /def is_capsule\([\s\S]*?\n\n/.exec(hookPy)[0];
  assert.ok(capsulePy.includes('startswith("capsule:")') && capsulePy.includes('startswith("capsule-slot:")'));
  assert.deepEqual(arms({ why: { dense_rank: 2, keyword_rank: 1 } }), [{ arm: "meaning", rank: 2 }, { arm: "keyword", rank: 1 }]);
  assert.deepEqual(arms({ why: { dense_rank: null, keyword_rank: 4 } }), [{ arm: "keyword", rank: 4 }]);
  assert.deepEqual(arms({}), []);
  const checks = [{ rule: "a", met: true, detail: "x" }, { rule: "b", met: false, detail: "y" }];
  assert.deepEqual(ruleSplit({ why: { checks } }), { held: [checks[0]], missed: [checks[1]] });
  assert.deepEqual(ruleSplit({}), { held: [], missed: [] });
  assert.match(heldBack({ relevant: true, tags: ["capsule:core"] }), /capsule/);
  assert.match(heldBack({ relevant: true, status: "pending", tags: [] }), /pending/);
  assert.equal(heldBack({ relevant: false, tags: ["capsule:core"] }), "");
  assert.equal(heldBack({ relevant: true, tags: [] }), "");
  assert.equal(heldBack({ relevant: true, tags: ["capsules-team"] }), "", "only capsule: and capsule-slot: tags are held back");
  assert.match(heldBack({ relevant: true, tags: ["capsule-slot:identity"] }), /capsule/);
  assert.match(heldBack({ relevant: true, project: "other", tags: [] }, "anymem"), /project other/);
  assert.match(heldBack({ relevant: true, project: "other", tags: [] }), /project other/, "no project given, so a project memory is held back");
  assert.equal(heldBack({ relevant: true, project: "anymem", tags: [] }, "anymem"), "");
  const hits = [{ id: 1, relevant: true, tags: ["capsule:core"] }, { id: 2, relevant: true, status: "pending", tags: [] }, { id: 3, relevant: true, tags: [] }];
  assert.deepEqual(injectedHits(hits).map((h) => h.id), [3], "capsule and pending memories are never injected");
});

test("the hook's query is cleaned the way hooks/memory_recall.py cleans it", () => {
  // The client's copy: FORMAT_RE and QUERY_CHARS in hooks/memory_recall.py. The Worker's FORMAT must be the same pattern.
  const hookPy = readFileSync(fileURLToPath(new URL("../../hooks/memory_recall.py", import.meta.url)), "utf8");
  const formatPy = /FORMAT_RE = re\.compile\(\s*((?:r"[^"]*"\s*)+),\s*re\.I\)/.exec(hookPy);
  assert.ok(formatPy, "the client has a format rule");
  const pyPattern = [...formatPy[1].matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join("");
  const jsSrc = readFileSync(fileURLToPath(new URL("../ui/lib/relevance.js", import.meta.url)), "utf8");
  assert.equal(/^const FORMAT = \/(.*)\/i;$/m.exec(jsSrc)?.[1], pyPattern);
  assert.match(hookPy, /QUERY_CHARS = 240\b/);
  assert.match(jsSrc, /const QUERY_CHARS = 240;/);
  assert.deepEqual(hookQuery("short"), { query: null, reason: "The hook skips a prompt under 20 characters, so it would not search at all." });
  assert.match(hookQuery("/compact the conversation please now").reason, /slash/);
  assert.equal(hookQuery("What did we decide about the restore window?").query, "What did we decide about the restore window?");
  assert.equal(hookQuery("What did we decide about the restore window? Answer in one sentence.").query, "What did we decide about the restore window?", "a formatting instruction is dropped");
  assert.equal(hookQuery("```js\nconst a = 1\n``` What did we decide about the trash window").query, "What did we decide about the trash window");
  assert.equal(hookQuery("x".repeat(300)).query.length, 240);
  assert.equal(hookQuery("Answer in one sentence. Be brief and concise.").query, "Answer in one sentence. Be brief and concise.", "when every sentence is a formatting instruction the whole prompt is kept, as the hook does");
});

test("Undo the undo sends the id of the undo it was made on, and a failure goes to the toast", async () => {
  const sent = [];
  const events = [];
  const request = async (path, o) => (sent.push([path, o.body.id]), {});
  const deps = (open, over = {}) => ({
    isOpen: (id) => id === open,
    reload: () => events.push("reload"),
    changed: () => events.push("changed"),
    announce: () => events.push("announce"),
    fail: (m) => events.push(`fail:${m}`),
    ...over,
  });
  assert.equal(await redoUndo(request, "first", deps("second")), true, "another memory is open now");
  assert.deepEqual(sent, [["/undo", "first"]], "the id from the toast, not the open memory");
  assert.deepEqual(events, ["announce", "changed"], "the open memory is not reloaded");
  events.length = 0;
  await redoUndo(request, "first", deps(""));
  assert.deepEqual(events, ["announce", "changed"], "the drawer is closed, so it stays closed");
  events.length = 0;
  await redoUndo(request, "first", deps("first"));
  assert.deepEqual(events, ["announce", "reload", "changed"], "the same memory is open, so it reloads");
  events.length = 0;
  const down = async () => {
    throw new Error("The Worker is down.");
  };
  assert.equal(await redoUndo(down, "first", deps("first")), false);
  assert.deepEqual(events, ["fail:The Worker is down."], "the error goes to the toast and nothing reloads");
});

test("the injected text is the hook's block, with the body cut at 320 characters and the budget at 1,800", () => {
  const hit = (name, body) => ({ id: "11111111-aaaa", content: `---\nname: ${name}\ndescription: about ${name}\n---\n${body}` });
  assert.deepEqual(parseEntry(hit("n1", "one   two\nthree")), { name: "n1", description: "about n1", body: "one two three" });
  assert.equal(parseEntry({ id: "abcdef012345", content: "plain text only" }).name, "abcdef01");
  assert.equal(parseEntry(hit("n1", "x".repeat(900))).body.length, 320);
  assert.equal(injectedText([]), "");
  const text = injectedText([hit("n1", "body one"), hit("n2", "body two")]);
  assert.match(text, /^## Relevant memories \(anymem, recalled for this prompt\)\nContext only, check it against the prompt\./);
  assert.match(text, /\n- n1: about n1 body one\n- n2: about n2 body two$/);
  const many = Array.from({ length: 12 }, (_, i) => hit(`n${i}`, "y".repeat(400)));
  assert.ok(injectedText(many).length <= 1800 + 200, "stops at the budget");
  assert.ok(injectedText(many).split("\n").length < 14);
});

test("profile facts parse and render the way the client does", () => {
  const content = renderFacts({ email: { value: "a@b.c", note: "confirmed 2026-10-01" }, name: { value: "Jo Ward", note: "" } });
  assert.match(content, /^---\nname: profile\n/);
  assert.match(content, /Full name: Jo Ward\nEmail: a@b\.c \(confirmed 2026-10-01\)\n$/);
  assert.deepEqual(parseFacts(content), { name: { value: "Jo Ward", note: "" }, email: { value: "a@b.c", note: "confirmed 2026-10-01" } });
  assert.deepEqual(tagsFor({ email: {}, phone: {} }), ["profile", "email", "contact", "phone", "telephone", "mobile", "cell"]);
  const set = setFact({}, "phone", "  082   123 ", new Date(2026, 9, 17));
  assert.deepEqual(set, { phone: { value: "082 123", note: "confirmed 2026-10-17" } });
  assert.throws(() => setFact({}, "phone", "  "), /empty/);
  assert.throws(() => setFact({}, "shoe-size", "9"), /unknown/);
});

test("pending changes and person notes are read from the memory text", () => {
  const pending = { content: "---\nname: profile-proposal-phone\n---\n\nProposed Phone: 082 111\nCurrent Phone: 082 222\nSaid on 2026-10-17\n" };
  assert.equal(pendingField(pending), "phone");
  assert.equal(pendingValue(pending), "082 111");
  assert.equal(pendingCurrent(pending), "082 222");
  assert.equal(pendingField({ content: "nothing" }), "");
  assert.deepEqual(personLines("---\nname: person-al\n---\nRelationship: neighbour (confirmed 2026-10-01)\nEmail: al@x.y\n"), [["Relationship", "neighbour", "confirmed 2026-10-01"], ["Email", "al@x.y", ""]]);
  const profile = { tags: ["profile"], content: "---\nname: profile\n---\nEmail: a@b.c" };
  assert.equal(findProfile([{ tags: ["person"], content: "name: x" }, profile]), profile);
  assert.equal(findProfile([]), null);
});

test("hash routes: known screens, an id, filters, the old names, bad encoding, and the default", () => {
  assert.deepEqual(parseHash("#/search"), { name: "search", arg: "", params: {} });
  assert.deepEqual(parseHash("#/search?q=a%20b&project=x"), { name: "search", arg: "", params: { q: "a b", project: "x" } });
  assert.deepEqual(parseHash("#/memories/abc%20def?origin=capture"), { name: "memories", arg: "abc def", params: { origin: "capture" } });
  assert.deepEqual(parseHash("#/memory/abc"), { name: "memories", arg: "abc", params: {} }, "an old link still works");
  assert.deepEqual(parseHash("#/browse?status=active"), { name: "memories", arg: "", params: { status: "active" } });
  assert.deepEqual(parseHash("#/memories/%E0%A4%A"), { name: "memories", arg: "", params: {} });
  assert.equal(parseHash("#/activity").name, "activity");
  assert.deepEqual(parseHash("#/audit?route=/capture?x=1").params, { route: "/capture?x=1" });
  assert.deepEqual(parseHash("#/audit?a=1&a=2").params, { a: "1" }, "the first value wins");
  assert.deepEqual(parseHash("#/audit?constructor=x&toString=y").params, { constructor: "x", toString: "y" }, "a name from Object.prototype is still a filter");
  for (const bad of ["", "#", "#/", "#/nope", "#/__proto__", "#/constructor", "#/toString", undefined]) assert.equal(parseHash(bad).name, "home", String(bad));
});

test("hashFor builds an address with an id and only the filters that are set", () => {
  assert.equal(hashFor("home"), "#/home");
  assert.equal(hashFor("memories", { arg: "a b/c", params: { origin: "capture", status: "", tag: undefined, sort: "recalls" } }), "#/memories/a%20b%2Fc?origin=capture&sort=recalls");
  assert.equal(memoryLink("id-1"), "#/memories/id-1");
  assert.deepEqual(parseHash(hashFor("search", { params: { q: "what & why? #1" } })).params, { q: "what & why? #1" }, "it survives a round trip");
});

test("trash days left come from the Worker's purge time, never below zero, and the query carries only the filters that are set", () => {
  const now = 100 * DAY_MS;
  assert.equal(daysLeft({ purge_at: now + 2 * DAY_MS + 1000 }, now), 3, "a part day counts as a whole day, as the list always did");
  assert.equal(daysLeft({ purge_at: now + 12 * DAY_MS }, now), 12);
  assert.equal(daysLeft({ purge_at: now - DAY_MS }, now), 0);
  assert.equal(trashQuery({}), "");
  assert.equal(trashQuery({ sort: "left", origin: "", project: "" }), "", "the default sort is not sent");
  assert.equal(trashQuery({ sort: "forgotten", origin: "capture", project: " alpha " }), "sort=forgotten&origin=capture&project=alpha");
});

test("backupItems keeps the backups the Worker lists, newest first, and drops a row with no day", () => {
  const items = backupItems({ backups: [{ key: "backups/anymem-2026-10-15.json.gz", day: "2026-10-15", size: 10, entries: 4 }, { key: "backups/anymem-2026-10-17.json.gz", day: "2026-10-17", size: 20, entries: null }, { key: "junk" }] });
  assert.deepEqual(items.map((b) => b.day), ["2026-10-17", "2026-10-15"]);
  assert.equal(items[1].entries, 4);
  assert.deepEqual(backupItems(undefined), []);
});

test("request sends X-Anymem-UI on every call, JSON only on bodies, and no token", async () => {
  const seen = [];
  const fakeFetch = async (path, init) => (seen.push({ path, init }), new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  await request("/list?n=1", {}, fakeFetch);
  await request("/update", { method: "POST", body: { id: "x" } }, fakeFetch);
  for (const { init } of seen) {
    assert.equal(init.headers["X-Anymem-UI"], "1");
    assert.equal(init.credentials, "same-origin");
    assert.equal(Object.keys(init.headers).some((h) => /authorization|token/i.test(h)), false);
  }
  assert.equal(seen[0].init.headers["content-type"], undefined);
  assert.equal(seen[1].init.headers["content-type"], "application/json");
  assert.equal(seen[1].init.body, '{"id":"x"}');
});

test("request turns failures into readable errors", async () => {
  const reply = (status, body, type = "application/json") => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  await assert.rejects(request("/x", {}, reply(409, { error: "changed", code: "stale_update" })), (e) => e instanceof ApiError && e.status === 409 && e.code === "stale_update");
  await assert.rejects(request("/x", {}, reply(200, "<html>login</html>", "text/html")), (e) => e.code === "not_json");
  await assert.rejects(request("/x", {}, async () => { throw new TypeError("failed"); }), (e) => e.code === "network");
  assert.equal(isMissingRoute(new ApiError(404, "not_found", "No such route.")), true);
  assert.equal(isMissingRoute(new ApiError(404, "not_found", "x")), true);
  assert.equal(isMissingRoute(new ApiError(404, "no_memory", "x")), false);
  assert.equal(isMissingRoute(new ApiError(500, "internal", "x")), false);
  assert.match(describeError(new ApiError(409, "stale_update", "changed")), /Someone else changed this memory first\. Nothing was saved/);
  assert.match(describeError(new ApiError(409, "lost_race", "x")), /Reload the memory/);
  assert.match(describeError(new ApiError(403, "csrf_rejected", "x")), /Reload and try again/);
  assert.equal(describeError(new ApiError(500, "internal", "Boom")), "Boom");
  assert.equal(describeError(new Error("x")), "Something went wrong in the page.");
});
