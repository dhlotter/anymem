// anymem begin (managed by the anymem cline adapter, remove it with install.py --uninstall cline)
//
// Cline has no shell hooks anymem can use and no transcript file, so this plugin does the work. It calls one Python script,
// adapters/cline/hook.py, which holds all the memory logic (credentials, recall gating, redaction, capture).
//
//   beforeRun     records where this run starts, nothing else. At this point Cline has not added the user's message yet.
//   beforeModel   first model call of a run: hook.py session-start (the capsule, once per conversation) and hook.py prompt
//                 (recall for the user's message), run in parallel. The text is added to the request as a message wrapped in
//                 <hook_context source="anymem">. Every model call of the conversation gets the same blocks again, in the same
//                 place, because Cline rebuilds the request from its own messages each time. Nothing is stored in Cline's messages.
//   afterRun      user and assistant text that is new since the last run goes to a spool file, one JSON line each, only while
//                 hook.py said the capture policy allows it. Then hook.py capture starts a detached capture worker.
//
// Cline gives a hook 3 seconds. Every child process here has a shorter deadline, so a slow Worker means "no memory this
// time", never an error: a hook that fails or times out counts against the plugin and Cline turns it off after five.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BAKED = { root: "", python: "" };
// Cline stops a hook after 3000 ms. The child is killed at 2600 ms and the whole hook gives up at 2750 ms.
const CHILD_TIMEOUT_MS = 2600;
const HOOK_BUDGET_MS = 2750;
// hook.py starts its clock once Python is up (about 0.3 s after the spawn), so a 2 second recall deadline and a 2 second
// network call for the capsule both answer before the 2600 ms kill. Recall alone takes a client median of about 1.3 s.
const HOOK_DEADLINE = "2";
const HOOK_NET_TIMEOUT = "2";
const MAX_SPOOL_TEXT = 20000;
const MAX_BLOCKS = 12;
const MAX_CONVERSATIONS = 50;
const CAPSULE_ATTEMPTS = 2;

const setupInfo = { cwd: "", sessionId: "" };
const conversations = new Map();

function cacheDir() {
  return process.env.ANYMEM_CACHE_DIR || path.join(os.homedir(), ".cache", "anymem");
}

function safeName(id) {
  return String(id || "session").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "session";
}

// Runs a command with a timeout. Resolves {code, stdout} and never rejects. With fire true the child is detached and
// not waited for (the capture hook only starts its own detached worker, so there is nothing to read back).
function defaultRun(argv, stdin, timeoutMs, env, fire) {
  return new Promise((resolve) => {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", fire ? "ignore" : "pipe", "ignore"],
        env: { ...process.env, ...env },
        detached: Boolean(fire),
        windowsHide: true,
      });
      let out = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout: out });
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish(-1);
      }, timeoutMs);
      if (child.stdout) child.stdout.on("data", (b) => { out += b.toString("utf8"); });
      child.on("error", () => finish(-1));
      child.on("close", (code) => finish(code === null ? -1 : code));
      child.stdin.on("error", () => {});
      child.stdin.end(stdin, () => {
        if (fire) {  // the payload is written, the child carries on without us
          child.unref();
          finish(0);
        }
      });
    } catch {
      resolve({ code: -1, stdout: "" });
    }
  });
}

function defaultAppend(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line, { mode: 0o600 });
}

// Test doubles come from globalThis, and only when they carry the marker. Nothing in Cline sets this.
function deps() {
  const t = globalThis.__anymemTesting;
  const on = Boolean(t) && t.__anymemTesting === true;
  return {
    run: (on && t.run) || defaultRun,
    append: (on && t.append) || defaultAppend,
    wait: (on && typeof t.budgetMs === "number") ? t.budgetMs : HOOK_BUDGET_MS,
  };
}

function config() {
  const root = process.env.ANYMEM_PLUGIN_ROOT || BAKED.root;
  const python = process.env.ANYMEM_PYTHON || BAKED.python || "python3";
  return { root, python, script: path.join(root || "", "adapters", "cline", "hook.py") };
}

function directory() {
  return setupInfo.cwd || process.cwd();
}

// ---- reading Cline's messages, every access defensive

function isSub(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return true;
  if (snapshot.parentAgentId !== undefined && snapshot.parentAgentId !== null && snapshot.parentAgentId !== "") return true;
  return typeof snapshot.agentRole === "string" && /teammate|sub[-_ ]?agent/i.test(snapshot.agentRole);
}

function keyOf(snapshot) {
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  return pick(snapshot.conversationId) || setupInfo.sessionId || pick(snapshot.agentId) || "session";
}

function convo(key) {
  let st = conversations.get(key);
  if (!st) {
    if (conversations.size >= MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
    st = { capsule: "", capsuleDone: false, capsuleTries: 0, keep: false, spooled: null, runId: undefined, lastPromptId: undefined, blocks: [], epoch: 0 };
    conversations.set(key, st);
  }
  return st;
}

function displayRole(msg) {
  return msg && msg.metadata && typeof msg.metadata === "object" ? msg.metadata.displayRole : undefined;
}

function rawText(msg) {
  const c = msg && msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

// Cline wraps what the person typed as <user_input mode="act">...</user_input>. The wrapper is not the person's words.
function unwrap(text) {
  const m = /^\s*<user_input\b[^>]*>([\s\S]*?)<\/user_input>\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

// The person's words in a user message, or "" when the message is one Cline or a hook wrote (hook context, [SYSTEM] reminders,
// teammate updates, anything with displayRole system).
function personText(msg) {
  if (!msg || msg.role !== "user" || displayRole(msg) === "system") return "";
  const text = unwrap(rawText(msg));
  if (!text || text.startsWith("<hook_context") || text.startsWith("[SYSTEM]") || text.startsWith("System-delivered")) return "";
  return text;
}

function assistantText(msg) {
  if (!msg || msg.role !== "assistant" || displayRole(msg) === "system") return "";
  return rawText(msg).trim();
}

// The latest message the person wrote, with its index. Null when there is none.
function lastPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = personText(messages[i]);
    if (text) return { text, id: typeof messages[i].id === "string" ? messages[i].id : "", index: i };
  }
  return null;
}

function wrap(text) {
  const inner = String(text).trim().replace(/<(\/?)hook_context/gi, "<\\$1hook_context");
  return `<hook_context source="anymem">\n${inner}\n</hook_context>`;
}

function hookMessage(id, text) {
  return { id, role: "user", content: [{ type: "text", text: wrap(text) }], createdAt: Date.now(), metadata: { userRunSpan: 0, displayRole: "system" } };
}

// The request with our blocks in it: the capsule first, each recall block right after the message it was recalled for. A block
// whose message is gone (Cline compacted it away) is left out. Returns the same array when there is nothing to add.
function withBlocks(messages, st) {
  const after = new Map();
  let prompt;
  for (const b of st.blocks) {
    let at = -1;
    if (b.anchor) at = messages.findIndex((m) => m && m.id === b.anchor);
    else if (b.epoch === st.epoch) {
      prompt = prompt === undefined ? lastPrompt(messages) : prompt;
      at = prompt ? prompt.index : -1;
    }
    if (at >= 0) after.set(at, [...(after.get(at) || []), b]);
  }
  if (!st.capsule && after.size === 0) return messages;
  const out = [];
  if (st.capsule) out.push(hookMessage("anymem_capsule", st.capsule));
  messages.forEach((m, i) => {
    out.push(m);
    for (const b of after.get(i) || []) out.push(hookMessage(b.id, b.text));
  });
  return out;
}

// ---- the plugin

const plugin = {
  name: "anymem",
  manifest: { capabilities: ["hooks"] },

  // Fast and synchronous on purpose, Cline gives setup 4 seconds. It only remembers where it runs.
  setup(_api, ctx) {
    try {
      if (ctx && typeof ctx.cwd === "string") setupInfo.cwd = ctx.cwd;
      if (ctx && ctx.session && typeof ctx.session.sessionId === "string") setupInfo.sessionId = ctx.session.sessionId;
    } catch {}
  },

  hooks: {
    // The user's message is not in the snapshot yet (Cline adds it after the beforeRun hooks), so this only records how many
    // messages came before this run, which is where the spool starts.
    async beforeRun(arg) {
      try {
        const snapshot = arg && arg.snapshot;
        if (isSub(snapshot)) return undefined;
        const st = convo(keyOf(snapshot));
        if (st.spooled === null) st.spooled = Array.isArray(snapshot.messages) ? snapshot.messages.length : 0;
        st.epoch += 1;
      } catch {}
      return undefined;
    },

    async beforeModel(arg) {
      try {
        const snapshot = arg && arg.snapshot;
        const messages = arg && arg.request && arg.request.messages;
        if (isSub(snapshot) || !Array.isArray(messages)) return undefined;
        const key = keyOf(snapshot);
        const st = convo(key);
        const runKey = snapshot.runId || "run" + st.epoch;
        if (st.runId !== runKey) {  // the first model call of this run
          st.runId = runKey;
          await gather(key, st, messages);
        }
        const out = withBlocks(messages, st);
        return out === messages ? undefined : { messages: out };
      } catch {
        return undefined;
      }
    },

    async afterRun(arg) {
      try {
        const snapshot = arg && arg.snapshot;
        if (isSub(snapshot) || !Array.isArray(snapshot.messages)) return undefined;
        const key = keyOf(snapshot);
        const st = convo(key);
        const from = st.spooled === null ? snapshot.messages.length : st.spooled;
        st.spooled = snapshot.messages.length;
        if (!st.keep) return undefined;
        let wrote = 0;
        for (const msg of snapshot.messages.slice(from)) {
          const role = msg && msg.role;
          const text = (role === "user" ? personText(msg) : assistantText(msg)).slice(0, MAX_SPOOL_TEXT);
          if (!text || (role !== "user" && role !== "assistant")) continue;
          deps().append(spoolFile(key), JSON.stringify({ role, text }) + "\n");
          wrote += 1;
        }
        if (wrote) await callHook("capture", { sessionID: key, directory: directory(), spool: spoolFile(key) }, 2000, true);  // afterRun gets 3 seconds from Cline too
      } catch {}
      return undefined;
    },
  },
};

function spoolFile(key) {
  return path.join(cacheDir(), "cline", safeName(key) + ".jsonl");
}

// One call into hook.py. Returns {ok, context, keep}: ok says hook.py answered, context is the text it printed, keep says
// whether the capture policy allows keeping text. Any problem gives ok false, no context and keep false. Never rejects.
async function callHook(event, payload, timeoutMs, fire) {
  const none = { ok: false, context: "", keep: false };
  try {
    const { root, python, script } = config();
    if (!root) return none;
    const env = { ANYMEM_PLUGIN_ROOT: root, ANYMEM_HOOK_DEADLINE: HOOK_DEADLINE, ANYMEM_HOOK_TIMEOUT: HOOK_NET_TIMEOUT };
    const res = await deps().run([python, script, event], JSON.stringify(payload), timeoutMs, env, fire);
    if (fire || !res || res.code !== 0) return none;
    const line = String(res.stdout || "").trim().split("\n").pop();
    if (!line) return none;
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return none;
    return { ok: true, context: typeof parsed.additionalContext === "string" ? parsed.additionalContext : "", keep: parsed.keep === true };
  } catch {
    return none;
  }
}

// The capsule (once per conversation) and the recall for the new message, in parallel, inside the hook budget. What arrives
// after the budget is dropped, so a slow answer is no memory this time and never a late block in the middle of a run.
async function gather(key, st, messages) {
  const prompt = lastPrompt(messages);
  const fresh = prompt && prompt.id !== st.lastPromptId ? prompt : null;
  if (prompt) st.lastPromptId = prompt.id || prompt.text;
  const wantCapsule = !st.capsuleDone && st.capsuleTries < CAPSULE_ATTEMPTS;
  if (!wantCapsule && !fresh) return;
  const spool = spoolFile(key);
  const dir = directory();
  let open = true;
  const work = [];
  const replies = [];
  if (wantCapsule) {
    st.capsuleTries += 1;
    work.push(callHook("session-start", { sessionID: key, directory: dir, spool }, CHILD_TIMEOUT_MS, false).then((r) => {
      if (!open) return;
      replies.push(r);
      if (r.ok) { st.capsuleDone = true; st.capsule = r.context; }
    }));
  }
  if (fresh) {
    work.push(callHook("prompt", { sessionID: key, prompt: fresh.text, directory: dir, spool }, CHILD_TIMEOUT_MS, false).then((r) => {
      if (!open) return;
      replies.push(r);
      if (r.ok && r.context) {
        st.blocks.push({ anchor: fresh.id, epoch: st.epoch, text: r.context, id: "anymem_recall_" + st.epoch });
        if (st.blocks.length > MAX_BLOCKS) st.blocks.shift();
      }
    }));
  }
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, deps().wait); });
  await Promise.race([Promise.all(work), late]);
  clearTimeout(timer);
  open = false;
  // The policy answer: text may be kept only when every reply that came back says so, and at least one came back.
  st.keep = replies.length > 0 && replies.every((r) => r.ok && r.keep);
}

export default plugin;
// anymem end
