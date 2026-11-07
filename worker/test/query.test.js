import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanQuery } from "../search/query.js";

test("private text is not searched", () => {
  assert.equal(cleanQuery("what is the plan for the weekend <private>my surprise trip to Rome</private> please tell me"), "what is the plan for the weekend please tell me");
  assert.equal(cleanQuery("<private>my surprise trip to Rome for the anniversary</private>"), "");
  assert.equal(cleanQuery("how do we deploy <PRIVATE >secret plan</ Private > the worker"), "how do we deploy the worker");
});

test("an unclosed private tag hides the rest, a stray closing tag is dropped", () => {
  assert.equal(cleanQuery("how do we deploy the worker <private>and my password is hunter2"), "how do we deploy the worker");
  assert.equal(cleanQuery("how do we deploy the worker</private> now"), "how do we deploy the worker now");
});

test("system reminders and fenced code are removed", () => {
  assert.equal(cleanQuery("<system-reminder>x</system-reminder> how do we deploy the worker"), "how do we deploy the worker");
  assert.equal(cleanQuery("<system-reminder>\nmulti\nline\n</system-reminder>how do we deploy"), "how do we deploy");
  assert.equal(cleanQuery("why does this fail ```js\nconst a = 1;\nthrow new Error()\n``` on the second run"), "why does this fail on the second run");
});

test("whitespace is collapsed", () => {
  assert.equal(cleanQuery("  how   do\n\nwe\tdeploy   the worker  "), "how do we deploy the worker");
});

test("answer format sentences are dropped, task sentences are kept", () => {
  assert.equal(cleanQuery("Which sign in flow does Alex prefer? Answer in one sentence."), "Which sign in flow does Alex prefer?");
  assert.equal(cleanQuery("Which sign in flow does Alex prefer? Be brief. Say NONE if nothing fits."), "Which sign in flow does Alex prefer?");
  assert.equal(cleanQuery("What do we know about the Hollowmere rent? Use only the memories. Please answer in two words."), "What do we know about the Hollowmere rent?");
  assert.equal(cleanQuery("Fix the failing test in the billing module. Keep it short."), "Fix the failing test in the billing module.");
  assert.equal(cleanQuery("Fix the failing test in billing."), "Fix the failing test in billing.");
});

test("a prompt that is only format sentences is kept as it is", () => {
  assert.equal(cleanQuery("Answer in one sentence please."), "Answer in one sentence please.");
});

test("the query is capped at 240 characters", () => {
  const q = cleanQuery("word ".repeat(100));
  assert.equal(q.length, 240);
});

test("under 3 characters gives nothing, identifiers of 3 or more are searched", () => {
  assert.equal(cleanQuery("ok"), "");
  assert.equal(cleanQuery(""), "");
  assert.equal(cleanQuery(undefined), "");
  assert.equal(cleanQuery(42), "");
  assert.equal(cleanQuery("<private>my surprise trip</private>"), "");
  assert.equal(cleanQuery("R05"), "R05");
  assert.equal(cleanQuery("ABC-12027"), "ABC-12027");
});
