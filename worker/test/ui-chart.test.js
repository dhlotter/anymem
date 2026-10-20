import { test } from "node:test";
import assert from "node:assert/strict";
import { chartTable, growthBuckets, labelIndexes, legend, niceMax, stackedBars } from "../ui/lib/chart.js";
import { diffCounts, diffLines, withContext } from "../ui/lib/diff.js";

test("niceMax rounds up to 2, 4, 6, 8 or 10 times a power of ten, so the middle gridline is a round number too", () => {
  assert.deepEqual([0, 1, 3, 7, 9, 11, 24, 26, 41, 99, 101, 1234].map(niceMax), [4, 2, 4, 8, 10, 20, 40, 40, 60, 100, 200, 2000]);
  assert.equal(niceMax(NaN), 4);
  assert.equal(niceMax(-3), 4);
  for (const n of [1, 2, 5, 13, 37, 88, 250, 999]) assert.ok(Number.isInteger(niceMax(n) / 2) && niceMax(n) >= n, String(n));
});

test("label indexes are a regular step back from the newest bar and always include the newest", () => {
  assert.deepEqual(labelIndexes(0, 500), []);
  assert.deepEqual(labelIndexes(1, 500), [0]);
  assert.deepEqual(labelIndexes(5, 1000), [0, 1, 2, 3, 4]);
  const idx = labelIndexes(30, 500);
  assert.equal(idx.at(-1), 29);
  const steps = idx.slice(1).map((v, i) => v - idx[i]);
  assert.ok(steps.every((s) => s === steps[0]), "the gaps are equal");
  assert.ok(idx.length <= 6);
});

const series = [{ key: "a", label: "Alpha", cls: "s1" }, { key: "b", label: "Beta", cls: "s2" }];
const buckets = [{ label: "1 Oct", values: { a: 3, b: 1 } }, { label: "2 Oct", values: { a: 0, b: 0 } }, { label: "3 Oct", values: { a: 5 } }];

test("stacked bars draw one column per bucket, a hit area and a tooltip for each, and name the series that have values", () => {
  const svg = String(stackedBars({ buckets, series, width: 400, summary: "Three days of things." }));
  assert.match(svg, /^<svg class="plot" viewBox="0 0 400 220"/);
  assert.match(svg, /role="img" aria-label="Three days of things\."/);
  assert.equal([...svg.matchAll(/class="col"/g)].length, 3);
  assert.equal([...svg.matchAll(/class="hit"/g)].length, 3);
  assert.ok(svg.includes('data-tip="1 Oct&#10;'.replace("&#10;", "\n")), "a tooltip starts with the day");
  assert.match(svg, /data-tip="1 Oct\nAlpha 3\nBeta 1\nTotal 4"/);
  assert.match(svg, /data-tip="3 Oct\nAlpha 5"/, "one series needs no total");
  assert.match(svg, /data-tip="2 Oct"/, "an empty day has a tooltip with just the day");
  assert.equal([...svg.matchAll(/class="seg s1"/g)].length, 2);
  assert.equal([...svg.matchAll(/class="seg s2"/g)].length, 1);
  assert.doesNotMatch(svg, /style=|<script|onload|http/i);
});

test("a stacked bar keeps its marks under 24px, rounds only the top segment, and scales to a round maximum", () => {
  const svg = String(stackedBars({ buckets, series, width: 800, summary: "x" }));
  const widths = [...svg.matchAll(/<rect class="seg [^"]*" x="[\d.]+" y="[\d.]+" width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths.length > 0 && widths.every((w) => w <= 24));
  assert.equal([...svg.matchAll(/<path class="seg/g)].length, 2, "each column with data ends in one rounded top, the empty day has none");
  assert.match(svg, />6<\/text>/, "the tallest column is 5, so the axis tops out at 6");
  assert.match(svg, />3<\/text>/, "and the middle gridline is 3");
});

test("label text from the store stays text inside the chart", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const svg = String(stackedBars({ buckets: [{ label: evil, values: { a: 1 } }], series: [{ key: "a", label: evil, cls: "s1" }], width: 400, summary: evil, axisLabel: (b) => b.label }));
  assert.doesNotMatch(svg, /<img/);
  assert.ok(svg.includes("&lt;img src=x onerror=alert(1)&gt;"));
  const table = String(chartTable({ caption: evil, first: evil, columns: [evil], rows: [{ label: evil, cells: [1] }] }));
  assert.doesNotMatch(table, /<img/);
  assert.doesNotMatch(String(legend([{ cls: "s1", label: evil, note: evil }])), /<img/);
});

test("an empty chart still draws, and the table twin carries every number with a header for each column", () => {
  const svg = String(stackedBars({ buckets: [], series, width: 300, summary: "None." }));
  assert.match(svg, /^<svg/);
  const t = String(chartTable({ caption: "Things per day", first: "Day", columns: ["Alpha", "Total"], rows: [{ label: "1 Oct", cells: [3000, 4] }] }));
  assert.match(t, /<caption>Things per day<\/caption>/);
  assert.match(t, /<th scope="col">Day<\/th><th scope="col" class="num">Alpha<\/th>/);
  assert.match(t, /<th scope="row">1 Oct<\/th><td class="num">3,000<\/td>/);
});

test("growth buckets label days by date and weeks as the week of a date", () => {
  const day = growthBuckets({ bucket: "day", buckets: [{ start: "2026-10-05", counts: { a: 1 } }] });
  assert.deepEqual(day, [{ label: "5 Oct", short: "5 Oct", values: { a: 1 } }]);
  assert.equal(growthBuckets({ bucket: "week", buckets: [{ start: "2026-10-05", counts: {} }] })[0].label, "Week of 5 Oct");
});

test("the diff marks added and removed lines and keeps the rest", () => {
  const ops = diffLines("one\ntwo\nthree", "one\n2\nthree\nfour");
  assert.deepEqual(ops.map((o) => `${o.type}:${o.text}`), ["same:one", "del:two", "add:2", "same:three", "add:four"]);
  assert.deepEqual(diffCounts(ops), { added: 2, removed: 1 });
  assert.deepEqual(diffLines("same", "same"), [{ type: "same", text: "same" }]);
  assert.deepEqual(diffLines("", "x").map((o) => o.type), ["del", "add"], "an empty text is one empty line");
  assert.deepEqual(diffCounts(diffLines("a\nb", "a\nb")), { added: 0, removed: 0 });
});

test("the diff gives up on very large texts without hanging, and collapses long unchanged runs", () => {
  const big = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join("\n");
  const ops = diffLines(big, `${big}\nmore`);
  assert.equal(ops.filter((o) => o.type === "del").length, 1600);
  assert.equal(ops.filter((o) => o.type === "add").length, 1601);
  const text = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const changed = [...text];
  changed[10] = "changed";
  const folded = withContext(diffLines(text.join("\n"), changed.join("\n")), 2);
  assert.deepEqual(folded.filter((o) => o.type === "skip").map((o) => o.text), ["8 unchanged lines", "7 unchanged lines"], "two lines of context stay on each side of the change");
  assert.deepEqual(folded.filter((o) => o.type !== "skip").map((o) => o.text), ["l8", "l9", "l10", "changed", "l11", "l12"]);
  assert.deepEqual(withContext([{ type: "same", text: "a" }]), [{ type: "skip", text: "1 unchanged line" }]);
});
