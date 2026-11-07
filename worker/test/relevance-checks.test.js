import { test } from "node:test";
import assert from "node:assert/strict";
import { isRelevant, ruleChecks } from "../search/relevance.js";

const t = (term, level = 2, idf = 6) => ({ term, level, idf });
const base = { similarity: null, terms: [], query: "a plain question about things", cutoff: 0.75 };
const RULES = ["reranker_supported", "reranker_low_close", "close_in_meaning", "agreement", "lookup", "two_rare_words", "name_word"];

test("ruleChecks lists every rule in a fixed order, each with a sentence", () => {
  const checks = ruleChecks(base);
  assert.deepEqual(checks.map((c) => c.rule), RULES);
  for (const c of checks) {
    assert.equal(c.met, false);
    assert.ok(c.detail.length > 20, c.rule);
    assert.doesNotMatch(c.detail, /[:–—]| - |--/, `${c.rule} uses a colon or a dash`);
  }
});

test("each rule can be the one that holds", () => {
  const met = (over) => ruleChecks({ ...base, ...over }).filter((c) => c.met).map((c) => c.rule);
  assert.deepEqual(met({ similarity: 0.7, rerank: 0.3 }), ["reranker_supported"]);
  assert.deepEqual(met({ similarity: 0.7, rerank: 0.06, denseRank: 2 }), ["reranker_low_close"]);
  assert.deepEqual(met({ similarity: 0.8 }), ["close_in_meaning"]);
  assert.deepEqual(met({ position: 0, denseRank: 1, keywordRank: 2, terms: [t("alpha", 2, 4), t("beta", 2, 3)] }), ["agreement"]);
  assert.deepEqual(met({ terms: [t("residential"), t("scraping")] }), ["two_rare_words"]);
  assert.deepEqual(met({ terms: [t("hollowmere", 2, 6.4)], query: "what do we owe on Hollowmere this month" }), ["name_word"]);
  assert.deepEqual(met({ position: 0, keywordRank: 1, coverage: 0.9, words: 2, query: "status of ABC-12027", terms: [t("abc", 1, 5.5)] }), ["lookup"]);
});

test("the numbers in a sentence are the numbers of the hit", () => {
  const [supported] = ruleChecks({ ...base, similarity: 0.71, rerank: 0.41, rerankCutoff: 0.2 });
  assert.match(supported.detail, /scored it 0\.41 and it needs 0\.2, with a closeness of 0\.71 that needs 0\.6/);
  const close = ruleChecks({ ...base, similarity: 0.5 }).find((c) => c.rule === "close_in_meaning");
  assert.match(close.detail, /closeness in meaning is 0\.5 and it needs 0\.75/);
  assert.match(ruleChecks({ ...base, similarity: null }).find((c) => c.rule === "close_in_meaning").detail, /is none/);
  assert.match(ruleChecks({ ...base, words: 2, coverage: 0.4 }).find((c) => c.rule === "lookup").detail, /60 percent/);
});

test("isRelevant says yes for the hits a person would call relevant, and no for the rest", () => {
  const CASES = [
    [{ similarity: 0.75 }, true, "close in meaning at the cutoff"],
    [{ similarity: 0.74 }, false, "just under the cutoff with nothing else"],
    [{ similarity: 0.3, terms: [t("a", 2, 5), t("b", 2, 5.5)] }, true, "two rare words by name"],
    [{ similarity: 0.3, terms: [t("a", 2, 5)] }, false, "one plain rare word"],
    [{ similarity: 0.3, terms: [t("hollowmere", 2, 6.4)], query: "ask about Hollowmere now" }, true, "one name like word in the prompt"],
    [{ similarity: 0.3, terms: [t("hollowmere", 2, 6.4)], query: "ask about hollowmere now" }, false, "the same word in lower case is no name"],
    [{ similarity: 0.7, rerank: 0.5 }, true, "a reranker score the cosine supports"],
    [{ similarity: 0.5, rerank: 0.5 }, false, "a reranker score on a hit far in meaning"],
    [{ similarity: null, rerank: null }, false, "nothing matched"],
  ];
  for (const [over, want, why] of CASES) assert.equal(isRelevant({ ...base, ...over }), want, why);
});

test("GET /recall adds the rule checks only when checks=1 comes with explain=1, so the hook reply does not grow", async () => {
  const { appWith, note } = await import("./helpers/search.js");
  const { app } = await appWith([note("zorbax-notes", "Notes on zorbax", "Everything about zorbax devices")]);
  const get = async (extra) => (await app.call(`/recall?query=${encodeURIComponent("tell me about the zorbax devices please")}${extra}`)).json.results[0];
  const plain = await get("&explain=1");
  assert.equal(plain.why.checks, undefined);
  assert.equal((await get("&checks=1")).why, undefined, "checks alone adds nothing");
  const hit = await get("&explain=1&checks=1");
  assert.deepEqual(hit.why.checks.map((c) => c.rule), RULES);
  assert.equal(hit.relevant, hit.why.checks.some((c) => c.met));
  assert.equal((await app.call("/recall?query=zorbax&explain=1&checks=2")).status, 400);
});
