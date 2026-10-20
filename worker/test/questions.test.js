import { test } from "node:test";
import assert from "node:assert/strict";
import { likelyQuestions, QUESTION_MODEL } from "../search/questions.js";
import { FakeAI } from "./helpers/fakes.js";
import { appWith, note } from "./helpers/search.js";

const chat = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
const post = (app, path, body) => app.call(path, { method: "POST", body });
const keys = async (app, id, type) => (await app.env.DB.prepare("SELECT position, text, vector_id FROM memory_keys WHERE memory_id = ? AND key_type = ? ORDER BY position").bind(id, type).all()).results;

test("questions are read from a chat reply or a plain response, trimmed, filtered and capped at three", async () => {
  const ai = new FakeAI();
  ai.reply(QUESTION_MODEL, chat({ questions: ["  Where do the otters sleep?  ", "x", 5, "What do otters hold?", "How do otters stay together?", "A fourth question here?"] }));
  assert.deepEqual(await likelyQuestions(ai, "text"), ["Where do the otters sleep?", "What do otters hold?", "How do otters stay together?"]);
  ai.reply(QUESTION_MODEL, { response: { questions: ["Where do otters live?"] } });
  assert.deepEqual(await likelyQuestions(ai, "text"), ["Where do otters live?"]);
  ai.reply(QUESTION_MODEL, { response: JSON.stringify({ questions: ["Where do otters swim?"] }) });
  assert.deepEqual(await likelyQuestions(ai, "text"), ["Where do otters swim?"]);
  assert.equal(ai.calls[0].input.messages[1].content, "text");
});

test("a failing or malformed reply throws, so it is never taken for an answer", async () => {
  const ai = new FakeAI();
  ai.reply(QUESTION_MODEL, () => {
    throw new Error("down");
  });
  await assert.rejects(likelyQuestions(ai, "t"), /down/);
  ai.reply(QUESTION_MODEL, { choices: [{ message: { content: "not json" } }] });
  await assert.rejects(likelyQuestions(ai, "t"), /JSON/);
  ai.reply(QUESTION_MODEL, {});
  await assert.rejects(likelyQuestions(ai, "t"), /questions list/);
  ai.reply(QUESTION_MODEL, chat({ questions: "none" }));
  await assert.rejects(likelyQuestions(ai, "t"), /questions list/);
});

test("an answer with no usable question is an empty list, not a failure", async () => {
  const ai = new FakeAI();
  ai.reply(QUESTION_MODEL, chat({ questions: [] }));
  assert.deepEqual(await likelyQuestions(ai, "t"), []);
  ai.reply(QUESTION_MODEL, chat({ questions: ["x", 5] }));
  assert.deepEqual(await likelyQuestions(ai, "t"), []);
});

test("input is cut at 3,000 characters", async () => {
  const ai = new FakeAI();
  ai.reply(QUESTION_MODEL, chat({ questions: [] }));
  await likelyQuestions(ai, "a".repeat(9000));
  assert.equal(ai.calls[0].input.messages[1].content.length, 3000);
});

test("POST /admin/questions writes keys, reindex embeds them, and recall finds a memory by its question", async () => {
  const { app, ids } = await appWith([note("sleep-habits", "Habits", "They link paws on the water.")]);
  app.env.AI.reply(QUESTION_MODEL, chat({ questions: ["Why do otters never drift apart?", "Do otters sleep in groups?"] }));
  const res = await post(app, "/admin/questions", {});
  assert.deepEqual(res.json, { ok: true, memories: 1, questions: 2, failed: 0 });
  assert.equal((await app.call("/stats")).json.unvectorized, 1, "the new keys wait for a reindex");
  assert.deepEqual((await post(app, "/admin/reindex", {})).json, { ok: true, processed: 1, remaining: 0 });
  const q = await keys(app, ids[0], "question");
  assert.deepEqual(q.map((k) => k.vector_id), [`${ids[0]}:question:0`, `${ids[0]}:question:1`]);
  assert.ok(app.env.VECTORIZE.vectors.has(`${ids[0]}:question:1`));
  const found = await app.call(`/recall?query=${encodeURIComponent("why do otters never drift apart")}`);
  assert.equal(found.json.results[0].id, ids[0]);
  assert.deepEqual((await post(app, "/admin/questions", {})).json, { ok: true, memories: 0, questions: 0, failed: 0 }, "nothing left to do");
});

test("the questions are kept when the memory changes, and not asked for again", async () => {
  const { app, ids } = await appWith([note("n", "d", "first")]);
  app.env.AI.reply(QUESTION_MODEL, chat({ questions: ["What is the first thing?"] }));
  await post(app, "/admin/questions", {});
  await post(app, "/admin/reindex", {});
  const calls = app.env.AI.calls.filter((c) => c.model === QUESTION_MODEL).length;
  await post(app, "/update", { id: ids[0], content: note("n", "d", "second") });
  assert.deepEqual((await keys(app, ids[0], "question")).map((k) => [k.text, k.vector_id === `${ids[0]}:question:0`]), [["What is the first thing?", true]]);
  assert.equal(app.env.AI.calls.filter((c) => c.model === QUESTION_MODEL).length, calls);
});

test("a memory the model answers with no usable question is marked and skipped on the next call", async () => {
  const { app } = await appWith([note("n", "d", "body")]);
  app.env.AI.reply(QUESTION_MODEL, chat({ questions: ["x"] }));
  assert.deepEqual((await post(app, "/admin/questions", {})).json, { ok: true, memories: 1, questions: 0, failed: 0 });
  assert.deepEqual((await post(app, "/admin/questions", {})).json, { ok: true, memories: 0, questions: 0, failed: 0 });
  assert.equal(app.env.AI.calls.filter((c) => c.model === QUESTION_MODEL).length, 1, "the marked memory is not sent to the model again");
});

test("an outage marks nothing, counts the failures, and the next call asks the model again", async () => {
  const { app, ids } = await appWith([note("a", "d", "first body"), note("b", "d", "second body")]);
  let down = true;
  app.env.AI.reply(QUESTION_MODEL, () => {
    if (down) throw new Error("rate limited");
    return chat({ questions: ["What is in the second note?"] });
  });
  assert.deepEqual((await post(app, "/admin/questions", {})).json, { ok: true, memories: 2, questions: 0, failed: 2 });
  const marks = (await app.env.DB.prepare("SELECT key FROM meta WHERE key LIKE 'no_questions:%'").all()).results;
  assert.deepEqual(marks, [], "a failure leaves no permanent mark");
  down = false;
  const again = (await post(app, "/admin/questions", {})).json;
  assert.deepEqual(again, { ok: true, memories: 2, questions: 2, failed: 0 });
  assert.equal((await keys(app, ids[0], "question")).length, 1);
  assert.equal((await keys(app, ids[1], "question")).length, 1);
});

test("the question keys also reach the keyword index", async () => {
  const { app, ids } = await appWith([note("n", "d", "body")]);
  app.env.AI.reply(QUESTION_MODEL, chat({ questions: ["Where is the zeppelin hangar?"] }));
  await post(app, "/admin/questions", {});
  await post(app, "/admin/reindex", {});
  const rows = (await app.env.DB.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH '\"zeppelin\"'").all()).results;
  assert.deepEqual(rows.map((r) => r.memory_id), [ids[0]]);
});

test("the route is admin only and takes a limit of 1 to 100", async () => {
  const { app } = await appWith([]);
  const device = (await post(app, "/devices", { label: "x" })).json.token;
  assert.equal((await app.call("/admin/questions", { method: "POST", body: {}, token: null })).status, 401);
  assert.equal((await app.call("/admin/questions", { method: "POST", body: {}, token: device })).status, 403);
  assert.equal((await app.call("/admin/questions", { method: "POST", body: {}, token: null, jwt: app.browserJwt("me@example.com") })).status, 403);
  for (const limit of [0, 101, "x"]) assert.equal((await post(app, "/admin/questions", { limit })).status, 400);
  assert.equal((await post(app, "/admin/questions", { limit: 100 })).status, 200);
});
