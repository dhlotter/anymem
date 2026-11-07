import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_MIN_RERANK, DEFAULT_MIN_SIM, inNameToken, isRelevant, lookedUp, looksLikeName, minRerank, minSimilarity, rareTerms } from "../search/relevance.js";

const t = (term, level = 2, idf = 6) => ({ term, level, idf });
const check = (over) => isRelevant({ similarity: null, terms: [], query: "a plain question about things", cutoff: 0.6, ...over });

test("the reranker score is relevant at its cutoff and above when the cosine supports it", () => {
  const supported = (over) => check({ similarity: 0.6, cutoff: 0.99, rerank: 0.2, rerankCutoff: 0.2, ...over });
  assert.equal(supported(), true);
  assert.equal(supported({ rerank: 0.9 }), true);
  assert.equal(supported({ rerank: 0.19 }), false);
  assert.equal(supported({ rerank: null }), false);
  assert.equal(supported({ similarity: 0.59 }), false, "a high reranker score on a hit far in meaning is a surface match");
  assert.equal(supported({ similarity: null }), false, "a hit the meaning search never found has no support");
  assert.equal(minRerank({}), DEFAULT_MIN_RERANK);
  assert.equal(minRerank({ RERANK_MIN: "0.3" }), 0.3);
  assert.equal(minRerank({ RERANK_MIN: "x" }), DEFAULT_MIN_RERANK);
});

test("a low reranker score is relevant when the hit is close in meaning and in the top three of the meaning search", () => {
  const low = (over) => check({ similarity: 0.66, cutoff: 0.99, rerank: 0.05, rerankCutoff: 0.2, denseRank: 3, ...over });
  assert.equal(low(), true, "the edges are in");
  assert.equal(low({ rerank: 0.049 }), false);
  assert.equal(low({ similarity: 0.659 }), false);
  assert.equal(low({ denseRank: 4 }), false);
  assert.equal(low({ denseRank: null }), false);
  assert.equal(low({ rerank: null }), false);
  assert.equal(low({ similarity: null }), false);
});

test("the cutoff comes from RECALL_MIN_SIM and falls back to 0.6", () => {
  assert.equal(minSimilarity({}), DEFAULT_MIN_SIM);
  assert.equal(minSimilarity({ RECALL_MIN_SIM: "0.72" }), 0.72);
  assert.equal(minSimilarity({ RECALL_MIN_SIM: "0" }), 0);
  for (const bad of ["abc", "1.5", "-1", ""]) assert.equal(minSimilarity({ RECALL_MIN_SIM: bad }), DEFAULT_MIN_SIM);
  assert.equal(minSimilarity(undefined), DEFAULT_MIN_SIM);
});

test("close in meaning is relevant, at the cutoff and above", () => {
  assert.equal(check({ similarity: 0.6 }), true);
  assert.equal(check({ similarity: 0.83 }), true);
  assert.equal(check({ similarity: 0.59 }), false);
  assert.equal(check({ similarity: null }), false);
});

test("two rare words matched by name are relevant", () => {
  assert.equal(check({ similarity: 0.3, terms: [t("residential"), t("scraping")] }), true);
});

test("one plain rare word is not enough, a body hit or a common word does not count", () => {
  assert.equal(check({ similarity: 0.3, terms: [t("residential")] }), false);
  assert.equal(check({ similarity: 0.3, terms: [t("residential", 1), t("scraping", 1)] }), false);
  assert.equal(check({ similarity: 0.3, terms: [t("capital", 2, 3), t("city", 2, 2)] }), false);
  assert.deepEqual(rareTerms([t("a", 2, 5), t("b", 2, 4.9), t("c", 1, 9)]), ["a"]);
});

test("one rare word that looks like a name in the prompt is relevant", () => {
  assert.equal(check({ similarity: 0.3, terms: [t("hollowmere", 2, 6.4)], query: "what do we owe on Hollowmere this month" }), true);
  assert.equal(check({ similarity: 0.3, terms: [t("abc", 2, 6.4)], query: "status of ticket ABC-12027 please" }), true);
  assert.equal(check({ similarity: 0.3, terms: [t("phoneleash", 2, 6.4)], query: "tell me about phoneLeash today" }), true);
  assert.equal(check({ similarity: 0.3, terms: [t("residential")], query: "residential address of my dad" }), false);
  assert.equal(check({ similarity: 0.3, terms: [t("hollowmere", 2, 5.5)], query: "what do we owe on Hollowmere this month" }), false, "a name like word needs idf 6, a word in a few memories is not enough");
});

test("looksLikeName follows the client rule", () => {
  // The client's copy is looks_like_name in client/hm/relevance.py. Its token pattern and name shapes must be the Worker's.
  const pyFn = /def looks_like_name\([\s\S]*?(?=\ndef )/.exec(readFileSync(fileURLToPath(new URL("../../client/hm/relevance.py", import.meta.url)), "utf8"))[0];
  const pyPatterns = [...pyFn.matchAll(/re\.(?:finditer|search)\(\s*r"([^"]+)"/g)].map((m) => m[1].replace(/\\-/g, "-"));
  const shapes = ["[A-Za-z0-9_.-]+", "[0-9_.-]", "[a-z][A-Z]"];
  assert.deepEqual(pyPatterns, shapes);
  assert.ok(pyFn.includes("max(4, len(term) - 2)") && pyFn.includes("max(4, len(low) - 2)"), "the client stems the same way");
  const workerSrc = readFileSync(fileURLToPath(new URL("../search/relevance.js", import.meta.url)), "utf8");
  for (const p of shapes) assert.ok(workerSrc.includes(`/${p}/`), `the Worker uses ${p}`);
  assert.ok(workerSrc.includes("Math.max(4, t.length - 2)") && workerSrc.includes("Math.max(4, low.length - 2)"));
  assert.equal(looksLikeName("hollowmere", "what about Hollowmere rent"), true);
  assert.equal(looksLikeName("hollowmere", "Hollowmere is the first word"), false, "capitalised only because it opens the prompt");
  assert.equal(looksLikeName("oauth", "which oauth flow"), false);
  assert.equal(looksLikeName("backup", "the s3_backup bucket"), false);
  assert.equal(looksLikeName("zcode", "install zcode.native"), true);
  assert.equal(looksLikeName("", "anything"), false);
  assert.equal(looksLikeName("name", ""), false);
  assert.equal(looksLikeName("deploy", "how we Deployed it"), true, "stemmed term matches the longer prompt word");
});

test("the first hit is relevant when both searches rank it in their top three and its name words are rare enough together", () => {
  const terms = [t("transfer", 2, 4.5), t("saving", 2, 2.5)];
  const agree = (over) => check({ similarity: 0.5, rerank: 0.01, terms, position: 0, denseRank: 2, keywordRank: 1, ...over });
  assert.equal(agree(), true);
  assert.equal(agree({ denseRank: 3, keywordRank: 3 }), true);
  assert.equal(agree({ denseRank: 4 }), false, "the meaning search must rank it in its top three");
  assert.equal(agree({ keywordRank: 4 }), false, "the keyword search must rank it in its top three");
  assert.equal(agree({ denseRank: null }), false, "a hit the meaning search never found does not agree");
  assert.equal(agree({ keywordRank: null }), false);
  assert.equal(agree({ position: 1 }), false, "only the first hit");
  assert.equal(agree({ position: undefined }), false, "no position, no agreement");
  assert.equal(agree({ terms: [t("transfer", 2, 4.5), t("saving", 2, 2)] }), true, "6.5 is enough");
  assert.equal(agree({ terms: [t("transfer", 2, 4.5), t("saving", 2, 1.9)] }), false, "the name words must add up to 6.5");
  assert.equal(agree({ terms: [t("transfer", 1, 4.5), t("saving", 1, 2.5), t("account", 1, 3)] }), false, "body words do not count");
});

test("a name token is one with a digit, underscore, hyphen or dot inside, camel case, or a capital after the first word", () => {
  assert.equal(inNameToken("123", "what do we know about TOP-123"), true, "the word is inside a hyphenated token");
  assert.equal(inNameToken("analyst", "Analyst please"), false, "a capital at the start of the prompt is not a name");
  assert.equal(inNameToken("r84", "what is R84"), true);
  assert.equal(inNameToken("r10k", "what is r10k"), true, "a digit makes it a name even in lower case");
  assert.equal(inNameToken("phoneleash", "tell me about phoneLeash"), true);
  assert.equal(inNameToken("zcode", "install zcode.native"), true);
  assert.equal(inNameToken("s3_backup", "the s3_backup bucket"), true);
  assert.equal(inNameToken("swift", "how do I parse json in swift."), false, "a full stop that ends the sentence is not part of the word");
  assert.equal(inNameToken("swift", "how do I parse json in Swift"), true, "capitalised after the first word");
  assert.equal(inNameToken("analyst", "what do we know about analyst"), false, "a plain lower case word");
  assert.equal(inNameToken("analyst", "what do we know about Analyst"), true);
  assert.equal(inNameToken("zzz", "what is R84"), false, "the word must be in the token");
});

test("a short query naming one rare thing is relevant when a top keyword hit holds it and covers most of the query", () => {
  const look = (over) => check({ similarity: null, rerank: 0, terms: [t("r84", 1, 5.9)], position: 0, keywordRank: 1, coverage: 0.75, words: 2, query: "what is R84", ...over });
  assert.equal(look(), true);
  assert.equal(look({ words: 3, position: 2, keywordRank: 2, coverage: 0.6 }), true, "the edges are in");
  assert.equal(look({ query: "what is analyst now", terms: [t("analyst", 1, 5.9)] }), false, "a lower case word with no digit is not a name");
  assert.equal(look({ query: "what is Analyst", terms: [t("analyst", 1, 5.9)] }), true, "a capitalised name counts");
  assert.equal(look({ words: 4 }), false, "a longer query is not a lookup");
  assert.equal(look({ words: 0 }), false, "no words, no lookup");
  assert.equal(look({ position: 3 }), false, "only the first three of the reply");
  assert.equal(look({ position: -1 }), false, "no position, no lookup");
  assert.equal(look({ keywordRank: 3 }), false);
  assert.equal(look({ keywordRank: null }), false);
  assert.equal(look({ coverage: 0.59 }), false, "other words of the query matched nothing");
  assert.equal(look({ terms: [t("r84", 1, 4.9)] }), false, "the word must be rare");
  assert.equal(look({ terms: [] }), false);
  assert.equal(lookedUp({ position: 0, keywordRank: 1, terms: [t("r84", 2, 5)], coverage: 1, words: 1, query: "a R84" }), true, "a name or body hit both count");
});
