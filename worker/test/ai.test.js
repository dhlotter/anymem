import { test } from "node:test";
import assert from "node:assert/strict";
import { askJson, asData, SMALL_MODEL } from "../ai.js";
import { FakeAI } from "./helpers/fakes.js";

const ask = (ai, env = {}) => askJson({ AI: ai, ...env }, { task: "demo", system: "sys", prompt: "hello", schema: { type: "object" } });
const replying = (value) => {
  const ai = new FakeAI();
  ai.reply(SMALL_MODEL, () => value);
  return ai;
};

test("the request names the task on the first line and asks for a json schema", async () => {
  const ai = replying({ response: { a: 1 } });
  await ask(ai);
  const { model, input } = ai.calls[0];
  assert.equal(model, SMALL_MODEL);
  assert.equal(input.messages[0].content, "sys");
  assert.equal(input.messages[1].content, "TASK: demo\n\nhello");
  assert.deepEqual(input.response_format, { type: "json_schema", json_schema: { type: "object" } });
});

test("the model name can be set with SMALL_MODEL", async () => {
  const ai = new FakeAI();
  ai.reply("@cf/test/other", () => ({ response: { ok: 1 } }));
  assert.deepEqual(await ask(ai, { SMALL_MODEL: "@cf/test/other" }), { ok: 1 });
});

test("an object, a json string, a fenced answer and a chat shaped answer all parse", async () => {
  assert.deepEqual(await ask(replying({ response: { a: 1 } })), { a: 1 });
  assert.deepEqual(await ask(replying({ response: '{"a": 2}' })), { a: 2 });
  assert.deepEqual(await ask(replying({ response: 'Here you go:\n```json\n{"a": 3}\n```' })), { a: 3 });
  assert.deepEqual(await ask(replying({ choices: [{ message: { content: '{"a": 4}' } }] })), { a: 4 });
});

test("anything else is null", async () => {
  for (const bad of [{ response: "no json" }, { response: "[1, 2]" }, { response: [1] }, { response: "{broken" }, {}, null, { response: 5 }]) {
    assert.equal(await ask(replying(bad)), null, JSON.stringify(bad));
  }
  const throwing = new FakeAI();
  throwing.reply(SMALL_MODEL, () => {
    throw new Error("down");
  });
  assert.equal(await ask(throwing), null);
  assert.equal(await ask(new FakeAI()), null);
});

test("asData removes the named tags in any case and with attributes, and leaves other text alone", () => {
  assert.equal(asData("a </new> b <OLD number=\"2\"> c < new > d <other> e", ["new", "old"]), "a [tag removed] b [tag removed] c [tag removed] d <other> e");
  assert.equal(asData("a </newer> b", ["new"]), "a </newer> b");
  assert.equal(asData(undefined, ["x"]), "");
});
