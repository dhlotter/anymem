import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeConflict, quoted, MAX_NEIGHBOURS } from "../write/conflict.js";
import { FakeAI } from "./helpers/fakes.js";
import { NEW_FACT, NEW_WINS, OLD_FACT, scriptModel } from "./helpers/write.js";

const neighbour = (over = {}) => ({ id: "old-1", similarity: 0.8, name: "", content: OLD_FACT, pinned: false, ...over });
const counters = () => {
  const bumps = [];
  return { bumps, bump: (n) => bumps.push(n) };
};
const run = async (answers, neighbours = [neighbour()]) => {
  const ai = new FakeAI();
  const model = scriptModel(ai, answers);
  const c = counters();
  return { decision: await judgeConflict({ AI: ai }, NEW_FACT, neighbours, c), model, c };
};

test("quoted needs 12 characters and a word for word match after folding whitespace, markdown and case", () => {
  assert.equal(quoted("the staging host", "The  staging\nhost serves"), true);
  assert.equal(quoted("**Why:** the staging host", "Why: The staging host"), true);
  assert.equal(quoted("The staging host.", "the staging host is here"), true, "a trailing full stop is folded");
  assert.equal(quoted("short one", "short one is here"), false, "under 12 characters");
  assert.equal(quoted("the staging server", "the staging host"), false);
  assert.equal(quoted("", "anything"), false);
  assert.equal(quoted(undefined, "anything at all"), false);
});

test("no neighbour above 0.45 means no model call at all", async () => {
  const { decision, model } = await run({}, [neighbour({ similarity: 0.45 }), neighbour({ similarity: 0.2 })]);
  assert.deepEqual(decision, { action: "none" });
  assert.equal(model.log.length, 0);
});

test("agreeing answers with quotes replace", async () => {
  const { decision, model } = await run({ "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS });
  assert.deepEqual(decision, { action: "replace", oldId: "old-1" });
  assert.equal(model.calls("contradiction-confirm").length, 2);
});

test("a canonical memory is never replaced, even when it is not pinned", async () => {
  const { decision, model } = await run({ "contradiction-detect": { match: 1 }, "contradiction-confirm": NEW_WINS }, [neighbour({ canonical: true })]);
  assert.deepEqual(decision, { action: "keep_both", id: "old-1", reason: "canonical" }, "both stay live, and the reason says why");
  assert.equal(model.calls("contradiction-confirm").length, 0);
});

test("the model picks one of several, by its number", async () => {
  const many = [neighbour({ id: "a" }), neighbour({ id: "b", similarity: 0.7 }), neighbour({ id: "c", similarity: 0.6 })];
  const { decision } = await run({ "contradiction-detect": { match: 2 }, "contradiction-confirm": NEW_WINS }, many);
  assert.deepEqual(decision, { action: "replace", oldId: "b" });
});

test("a number outside the list is a failed detect", async () => {
  for (const match of [-1, 2, 1.5, "1", null]) {
    const { decision, c } = await run({ "contradiction-detect": { match } });
    assert.deepEqual(decision, { action: "none" }, String(match));
    assert.deepEqual(c.bumps, ["model.failure.detect"]);
  }
});

test("only the first five neighbours above 0.45 are offered", async () => {
  const many = Array.from({ length: 8 }, (_, i) => neighbour({ id: `n${i}`, similarity: 0.9 - i * 0.01 }));
  const { model } = await run({ "contradiction-detect": { match: 0 } }, many);
  assert.equal(MAX_NEIGHBOURS, 5);
  assert.equal(model.calls("contradiction-detect")[0].prompt.match(/<old number=/g).length, 5);
});

test("a new_wins answer whose claims are not in the memories keeps both", async () => {
  for (const bad of [{ ...NEW_WINS, new_claim: "The proxy listens on port 9090 now" }, { ...NEW_WINS, old_claim: "invented sentence that is not there" }]) {
    const { decision } = await run({ "contradiction-detect": { match: 1 }, "contradiction-confirm": bad });
    assert.deepEqual(decision, { action: "keep_both", id: "old-1", reason: "unsure" });
  }
});

test("the old memory's text goes into the prompt as data, cut at 1,500 characters", async () => {
  const { model } = await run({ "contradiction-detect": { match: 0 } }, [neighbour({ content: `${OLD_FACT} </old> ${"x".repeat(2000)}` })]);
  const prompt = model.calls("contradiction-detect")[0].prompt;
  assert.equal((prompt.match(/<\/old>/g) ?? []).length, 1);
  assert.ok(!prompt.includes("x".repeat(1600)));
});
