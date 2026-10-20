// Offline tests for plugin.js with a fake child process boundary. Run: node --test adapters/kilo/plugin.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const plugin = (await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin.js"))).default;

// What hook.py prints: session-start and prompt always carry keep (the policy answer), with the context text when there is some.
// Capture prints nothing. A string answer is printed as it is.
function stdoutFor(event, answer, keep) {
  if (typeof answer === "string") return answer;
  if (event !== "session-start" && event !== "prompt") return "";
  return JSON.stringify({ keep, ...(answer ? { additionalContext: answer.ctx } : {}) }) + "\n";
}

// A fake boundary: records every call, answers from a table keyed by hook event, and appends spool lines to memory.
// opts.keep is the policy answer hook.py gives (default true, the policy allows keeping text).
function rig(answers = {}, opts = {}) {
  const calls = [];
  const spool = [];
  const run = async (argv, stdin, timeoutMs, env, fire) => {
    const event = argv[2];
    calls.push({ argv, payload: JSON.parse(stdin), timeoutMs, env, fire, event });
    const answer = answers[event];
    if (answer instanceof Error) throw answer;
    return { code: opts.code ?? 0, stdout: stdoutFor(event, answer, opts.keep ?? true) };
  };
  const append = (file, line) => spool.push({ file, rec: JSON.parse(line) });
  return { calls, spool, testing: { __anymemTesting: true, run, append } };
}

process.env.ANYMEM_PLUGIN_ROOT = "/fake/root";
process.env.ANYMEM_PYTHON = "/fake/python3";
process.env.ANYMEM_CACHE_DIR = "/fake/cache";

const ctx = { directory: "/work/project" };
const transform = async (hooks, sid) => {
  const output = { system: ["base prompt"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, output);
  return output.system;
};
const say = async (hooks, sid, text) => hooks["chat.message"]({ sessionID: sid }, { message: {}, parts: [{ type: "text", text }] });

test("the plugin exports exactly one function, so Kilo cannot call a helper as a plugin", async () => {
  const mod = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin.js"));
  assert.deepEqual(Object.keys(mod), ["default"]);
});

test("recall runs once per prompt and its block is pushed on each model call of that turn, then dropped at idle", async () => {
  const r = rig({ prompt: { ctx: "RECALL BLOCK" }, "session-start": { ctx: "CAPSULE" } });
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "which codename did we pick for the ferry route");
  assert.equal(r.calls.filter((c) => c.event === "prompt").length, 1);
  const first = await transform(hooks, "s1");
  const second = await transform(hooks, "s1");
  assert.ok(first.includes("RECALL BLOCK") && second.includes("RECALL BLOCK"));
  assert.equal(first.filter((x) => x === "RECALL BLOCK").length, 1, "never twice in one system prompt");
  assert.equal(r.calls.filter((c) => c.event === "prompt").length, 1, "recall is not re-run per model call");
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(!(await transform(hooks, "s1")).includes("RECALL BLOCK"));
});

test("a new prompt replaces the previous recall block", async () => {
  const answers = { prompt: { ctx: "FIRST" } };
  const r = rig(answers);
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "first question about the ferry route");
  assert.ok((await transform(hooks, "s1")).includes("FIRST"));
  answers.prompt = { ctx: "SECOND" };
  await say(hooks, "s1", "second question about the ferry route");
  const sys = await transform(hooks, "s1");
  assert.ok(sys.includes("SECOND") && !sys.includes("FIRST"));
});

test("the capsule is fetched once per session, at the first model call, and kept on later calls", async () => {
  const r = rig({ "session-start": { ctx: "CAPSULE" } });
  const hooks = await plugin(ctx, r.testing);
  assert.equal(r.calls.length, 0, "nothing runs at plugin load");
  await hooks.event({ event: { type: "session.created", properties: { sessionID: "s1", info: { id: "s1" } } } });
  assert.equal(r.calls.length, 0, "nothing runs at session.created either");
  const [a, b] = await Promise.all([transform(hooks, "s1"), transform(hooks, "s1")]);
  const c = await transform(hooks, "s1");
  assert.equal(r.calls.filter((x) => x.event === "session-start").length, 1);
  assert.ok(a.includes("CAPSULE") && b.includes("CAPSULE") && c.includes("CAPSULE"));
  await transform(hooks, "s2");
  assert.equal(r.calls.filter((x) => x.event === "session-start").length, 2, "a second session asks again");
});

test("calls carry the interpreter, the script under the plugin root, the project folder and a timeout", async () => {
  const r = rig({ prompt: { ctx: "X" } });
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "ses/odd id", "a prompt long enough to be recalled");
  const call = r.calls[0];
  assert.deepEqual(call.argv, ["/fake/python3", "/fake/root/adapters/kilo/hook.py", "prompt"]);
  assert.equal(call.timeoutMs, 8000);
  assert.equal(call.env.ANYMEM_PLUGIN_ROOT, "/fake/root");
  assert.equal(call.env.ANYMEM_HOOK_DEADLINE, "7", "hook.py gets 7 seconds, so its reply lands before the 8 second kill");
  assert.equal(call.payload.directory, "/work/project");
  assert.equal(call.payload.prompt, "a prompt long enough to be recalled");
  assert.equal(call.payload.spool, "/fake/cache/kilo/ses_odd_id.jsonl");
});

test("a throwing or failing hook is swallowed and the system prompt is left alone", async () => {
  const r = rig({ prompt: new Error("boom"), "session-start": new Error("boom") });
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "a prompt that makes recall blow up");
  assert.deepEqual(await transform(hooks, "s1"), ["base prompt"]);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks["experimental.session.compacting"]({ sessionID: "s1" }, { context: [] });
  const failing = rig({ prompt: { ctx: "X" } }, { code: 1 });
  const h2 = await plugin(ctx, failing.testing);
  await say(h2, "s1", "a prompt where the script exits with an error");
  assert.deepEqual(await transform(h2, "s1"), ["base prompt"]);
});

test("garbage output from hook.py is ignored", async () => {
  const r = rig({ prompt: "not json at all", "session-start": '{"additionalContext": 7}' });
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "a prompt answered with garbage output");
  assert.deepEqual(await transform(hooks, "s1"), ["base prompt"]);
});

test("odd input never throws", async () => {
  const r = rig();
  const hooks = await plugin(undefined, r.testing);
  await hooks["chat.message"](undefined, undefined);
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: "nope" });
  await hooks["experimental.chat.system.transform"]({}, {});
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: "nope" });
  await hooks.event({ event: { type: "message.part.updated" } });
  await hooks.event({});
  await hooks.event(undefined);
  assert.equal(r.spool.length, 0);
});

test("an unconfigured plugin root does nothing", async () => {
  delete process.env.ANYMEM_PLUGIN_ROOT;
  try {
    const r = rig({ prompt: { ctx: "X" } });
    const hooks = await plugin(ctx, r.testing);
    await say(hooks, "s1", "a prompt with no plugin root set anywhere");
    assert.equal(r.calls.length, 0);
    assert.deepEqual(await transform(hooks, "s1"), ["base prompt"]);
  } finally {
    process.env.ANYMEM_PLUGIN_ROOT = "/fake/root";
  }
});

test("user messages and finished assistant text are spooled, nothing else", async () => {
  const r = rig();
  const hooks = await plugin(ctx, r.testing);
  const ev = (type, properties) => hooks.event({ event: { type, properties } });
  await hooks["chat.message"]({ sessionID: "s1" }, {
    message: {},
    parts: [{ type: "text", text: "the user asks" }, { type: "text", text: "injected by kilo", synthetic: true }, { type: "file", text: "no" }],
  });
  await ev("message.updated", { sessionID: "s1", info: { id: "mu", role: "user" } });
  await ev("message.updated", { sessionID: "s1", info: { id: "ma", role: "assistant" } });
  // reasoning, an unfinished text part, a user text part and a synthetic part are all skipped
  await ev("message.part.updated", { sessionID: "s1", part: { id: "p0", sessionID: "s1", messageID: "ma", type: "reasoning", text: "thinking", time: { start: 1, end: 2 } } });
  await ev("message.part.updated", { sessionID: "s1", part: { id: "p1", sessionID: "s1", messageID: "ma", type: "text", text: "", time: { start: 1 } } });
  await ev("message.part.updated", { sessionID: "s1", part: { id: "p2", sessionID: "s1", messageID: "mu", type: "text", text: "the user asks", time: { start: 1, end: 2 } } });
  await ev("message.part.updated", { sessionID: "s1", part: { id: "p3", sessionID: "s1", messageID: "ma", type: "text", text: "synthetic", synthetic: true, time: { start: 1, end: 2 } } });
  // the finished assistant text, sent twice: written once
  const done = { id: "p4", sessionID: "s1", messageID: "ma", type: "text", text: "the assistant answers", time: { start: 1, end: 2 } };
  await ev("message.part.updated", { sessionID: "s1", part: done });
  await ev("message.part.updated", { sessionID: "s1", part: done });
  assert.deepEqual(r.spool.map((x) => x.rec), [{ role: "user", text: "the user asks" }, { role: "assistant", text: "the assistant answers" }]);
  assert.ok(r.spool.every((x) => x.file === "/fake/cache/kilo/s1.jsonl"));
});

test("a message event without props.sessionID is filed under the message's own session, not its message id", async () => {
  const r = rig();
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "a question about the ferry route");
  const ev = (type, properties) => hooks.event({ event: { type, properties } });
  await ev("message.updated", { info: { id: "ma", sessionID: "s1", role: "assistant" } });
  await ev("message.part.updated", { part: { id: "p9", sessionID: "s1", messageID: "ma", type: "text", text: "the answer", time: { start: 1, end: 2 } } });
  assert.deepEqual(r.spool.map((x) => x.rec), [{ role: "user", text: "a question about the ferry route" }, { role: "assistant", text: "the answer" }]);
});

test("a subagent session writes no text and starts no capture, the parent session still does", async () => {
  const r = rig();
  const hooks = await plugin(ctx, r.testing);
  const ev = (type, properties) => hooks.event({ event: { type, properties } });
  await ev("session.created", { info: { id: "sub1", parentID: "s1" } });
  await say(hooks, "sub1", "the parent model's instruction to the subagent");
  await ev("message.updated", { sessionID: "sub1", info: { id: "ma", sessionID: "sub1", role: "assistant" } });
  await ev("message.part.updated", { sessionID: "sub1", part: { id: "p1", sessionID: "sub1", messageID: "ma", type: "text", text: "subagent answer", time: { start: 1, end: 2 } } });
  await ev("session.idle", { sessionID: "sub1" });
  assert.deepEqual(r.spool, [], "nothing from the subagent is spooled as the person's words");
  assert.equal(r.calls.filter((c) => c.event === "capture").length, 0);
  await say(hooks, "s1", "the person's own question about the ferry");
  assert.deepEqual(r.spool.map((x) => x.rec), [{ role: "user", text: "the person's own question about the ferry" }]);
});

test("session.deleted drops that session's state, so its next model call asks for the capsule again", async () => {
  const r = rig({ "session-start": { ctx: "CAPSULE" } });
  const hooks = await plugin(ctx, r.testing);
  await transform(hooks, "s1");
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
  await transform(hooks, "s1");
  assert.equal(r.calls.filter((c) => c.event === "session-start").length, 2);
});

test("an assistant part that arrives before its message is kept until the role is known", async () => {
  const r = rig();
  const hooks = await plugin(ctx, r.testing);
  await transform(hooks, "s1");  // the first model call, which carries the policy answer for the session
  const ev = (type, properties) => hooks.event({ event: { type, properties } });
  await ev("message.part.updated", { sessionID: "s1", part: { id: "p9", sessionID: "s1", messageID: "ma", type: "text", text: "early text", time: { start: 1, end: 2 } } });
  assert.equal(r.spool.length, 0);
  await ev("message.updated", { sessionID: "s1", info: { id: "ma", role: "assistant" } });
  assert.deepEqual(r.spool.map((x) => x.rec), [{ role: "assistant", text: "early text" }]);
});

test("session.idle starts capture detached with the spool path, and compaction asks for a pre-compact capture", async () => {
  const r = rig();
  const hooks = await plugin(ctx, r.testing);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks["experimental.session.compacting"]({ sessionID: "s1" }, { context: [] });
  assert.deepEqual(r.calls.map((c) => [c.event, c.fire]), [["capture", true], ["pre-compact", true]]);
  assert.equal(r.calls[0].payload.spool, "/fake/cache/kilo/s1.jsonl");
  assert.equal(r.calls[0].payload.sessionID, "s1");
  assert.equal(r.calls[0].payload.directory, "/work/project");
});

test("a Kilo options object passed as the second argument is never taken for test doubles", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-kilo-js-"));
  const before = process.env.ANYMEM_CACHE_DIR;
  process.env.ANYMEM_CACHE_DIR = tmp;
  // a real child process that answers the way hook.py does (keep true, no context), so the real spool writer runs
  const stub = path.join(tmp, "stub-python.sh");
  fs.writeFileSync(stub, "#!/bin/sh\necho '{\"keep\": true}'\n", { mode: 0o755 });
  process.env.ANYMEM_PYTHON = stub;
  try {
    const hooks = await plugin(ctx, { run: () => { throw new Error("must not be used"); }, append: () => { throw new Error("must not be used"); } });
    await say(hooks, "s1", "a prompt for a plugin given an options object");
    assert.deepEqual(await transform(hooks, "s1"), ["base prompt"]);
    assert.ok(fs.readFileSync(path.join(tmp, "kilo", "s1.jsonl"), "utf8").includes("an options object"), "the real spool writer ran");
  } finally {
    process.env.ANYMEM_CACHE_DIR = before;
    process.env.ANYMEM_PYTHON = "/fake/python3";
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the hooks Kilo 7.7.5 really called (fixtures/events.jsonl) give one user line, one assistant line and one capture", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const records = fs.readFileSync(path.join(here, "fixtures", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const r = rig({ prompt: { ctx: "RECALL BLOCK" }, "session-start": { ctx: "CAPSULE" } });
  const hooks = await plugin(ctx, r.testing);
  let systemAtCall = null;
  for (const rec of records) {
    if (rec.hook === "event") await hooks.event({ event: rec.event });
    else if (rec.hook === "chat.message") await hooks["chat.message"](rec.input, { message: {}, parts: rec.output.parts });
    else if (rec.hook === "experimental.chat.system.transform") systemAtCall = await transform(hooks, rec.input.sessionID);
  }
  assert.deepEqual(r.spool.map((x) => x.rec), [{ role: "user", text: '"Reply with the single word OK"' }, { role: "assistant", text: "OK" }]);
  assert.deepEqual(systemAtCall, ["base prompt", "CAPSULE", "RECALL BLOCK"]);
  assert.deepEqual(r.calls.map((c) => c.event), ["prompt", "session-start", "capture"]);
});

test("when the policy does not allow keeping text, nothing is spooled, neither the user text nor the assistant text", async () => {
  const r = rig({ prompt: { ctx: "X" }, "session-start": { ctx: "CAPSULE" } }, { keep: false });
  const hooks = await plugin(ctx, r.testing);
  await say(hooks, "s1", "a question that must not be written anywhere");
  await transform(hooks, "s1");
  await hooks.event({ event: { type: "message.updated", properties: { sessionID: "s1", info: { id: "ma", role: "assistant" } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { sessionID: "s1", part: { id: "p4", sessionID: "s1", messageID: "ma", type: "text", text: "an answer", time: { start: 1, end: 2 } } } } });
  assert.deepEqual(r.spool, []);
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.deepEqual(r.calls.map((c) => c.event), ["prompt", "session-start", "capture"], "capture still runs, hook.py decides what it does");
});

test("a reply without the keep flag, or a failed reply, spools nothing", async () => {
  const old = rig({ prompt: "{\"additionalContext\": \"X\"}" });
  const hooks = await plugin(ctx, old.testing);
  await say(hooks, "s1", "an old hook.py that never says keep");
  assert.deepEqual(old.spool, []);
  const failed = rig({ "session-start": { ctx: "CAPSULE" }, prompt: new Error("boom") });
  const h2 = await plugin(ctx, failed.testing);
  await transform(h2, "s1");  // the policy answer from the session start says keep
  await say(h2, "s1", "a prompt whose recall call failed");
  assert.deepEqual(failed.spool, [], "a failed reply counts as keep false");
});
