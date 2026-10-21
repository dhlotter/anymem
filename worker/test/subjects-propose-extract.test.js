// The subject hint on the Worker's extractor: the prompt asks for it, a good hint rides on its proposal, a bad one is dropped and the memory stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./helpers/app.js";
import { scriptModel } from "./helpers/write.js";

// Built at runtime so no secret shaped text sits in the file.
const FAKE_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

const FILLER = `USER: ${"We spent the morning talking through the household chores and who handles what. ".repeat(10)}`;
const TRANSCRIPT = `${FILLER}\n\nUSER: Pip is my dog and he is afraid of thunder\n\nASSISTANT: Noted.`;
const BODY = "Pip is a small beagle who is afraid of thunder, so keep the windows closed and the radio on during storms.";
const memory = (over = {}) => ({ type: "user", name: "pip-fears-thunder", description: "Pip is the user's dog and is afraid of thunder", body: BODY, ...over });

async function ask(items) {
  const app = await createApp();
  const model = scriptModel(app.env.AI, { extract: { items } });
  const res = await app.call("/extract", { method: "POST", body: { transcript: TRANSCRIPT, known: "", max: 2 } });
  assert.equal(res.status, 200);
  return { res: res.json, model };
}

test("the prompt asks for a subject hint, in plain words, and the schema allows one", async () => {
  const { model } = await ask([]);
  const call = model.calls("extract")[0];
  assert.match(call.prompt, /"subject": \{"name"/);
  assert.match(call.prompt, /named person, pet, vehicle, property, project or topic/);
  assert.match(call.prompt, /Never set it for a general rule or preference/);
  assert.match(call.prompt, /never for a company or a tool unless it is the user's own project/);
  assert.match(call.prompt, /At most one subject per memory/);
  assert.ok(!/[–—]/.test(call.prompt));
  assert.deepEqual(Object.keys(call.input.response_format.json_schema.properties.items.items.properties.subject.properties), ["name", "kind"]);
});

test("a good hint rides on its proposal and a proposal without one keeps its old shape", async () => {
  const { res } = await ask([memory({ subject: { name: "Pip", kind: "pet" } })]);
  assert.deepEqual(res.proposals, [{ name: "pip-fears-thunder", type: "user", description: "Pip is the user's dog and is afraid of thunder", body: BODY, subject: { name: "Pip", kind: "pet" } }]);
  const plain = await ask([memory()]);
  assert.deepEqual(Object.keys(plain.res.proposals[0]), ["name", "type", "description", "body"]);
});

test("a bad hint is dropped and the memory is kept", async () => {
  const bad = [
    "Pip",
    5,
    [],
    {},
    { name: "Pip" },
    { name: "Pip", kind: "cat" },
    { name: "P", kind: "pet" },
    { name: "x".repeat(61), kind: "pet" },
    { name: "Pi\np", kind: "pet" },
    { name: "Pip<b>", kind: "pet" },
    { name: ["Pip"], kind: "pet" },
    { name: "Rex", kind: "pet" },
    { name: "Pipeline", kind: "project" },
    { name: "the user", kind: "person" },
    { name: "Work", kind: "area" },
    { name: FAKE_KEY, kind: "topic" },
  ];
  for (const subject of bad) {
    const { res } = await ask([memory({ subject })]);
    assert.equal(res.proposals.length, 1, JSON.stringify(subject));
    assert.equal("subject" in res.proposals[0], false, JSON.stringify(subject));
  }
});

test("a hint on a profile or person item is not passed on", async () => {
  const profile = { type: "profile", field: "name", value: "Sam Example", said: "my name is Sam Example", subject: { name: "Sam", kind: "person" } };
  const app = await createApp();
  scriptModel(app.env.AI, { extract: { items: [profile] } });
  const res = await app.call("/extract", { method: "POST", body: { transcript: `${FILLER}\n\nUSER: my name is Sam Example`, known: "", max: 2 } });
  assert.deepEqual(res.json.proposals, [{ type: "profile", field: "name", value: "Sam Example", said: "my name is Sam Example" }]);
});
