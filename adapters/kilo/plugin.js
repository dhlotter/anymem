// anymem begin (managed by the anymem kilo adapter, remove it with install.py --uninstall kilo)
// created-dirs: []
//
// Kilo has no shell hooks and no transcript file, so this plugin does the work. It calls one Python script,
// adapters/kilo/hook.py, which holds all the memory logic (credentials, recall gating, redaction, capture).
//
//   first model call of a session   hook.py session-start   the always-on capsule
//   user message (chat.message)     hook.py prompt          recall for that prompt, kept until the turn ends
//   every model call                pushes both onto the system prompt (Kilo rebuilds the system prompt on each call)
//   user and assistant text         appended to a spool file, one JSON line each, only while hook.py says the capture policy allows it
//   session.idle (end of a turn)    hook.py capture         starts a detached capture worker on the spool file
//
// Nothing here may break or slow a session: every hook body is wrapped, every child process has a timeout, and a
// failure means "no memory this time", never an error.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BAKED = { root: "", python: "" };
const RECALL_TIMEOUT_MS = 8000;
// hook.py's own deadline starts once Python is running, about half a second after the spawn, so it gets 7 seconds and its
// reply lands before the 8 second kill above.
const RECALL_HOOK_DEADLINE = "7";
const CAPSULE_TIMEOUT_MS = 8000;
const MAX_SPOOL_TEXT = 20000;

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

export default async function anymem(ctx, testing) {
  // `testing` is only honoured when it carries the marker, so a plugin options object from Kilo can never replace these.
  const deps = testing && testing.__anymemTesting === true ? testing : {};
  const run = deps.run || defaultRun;
  const append = deps.append || defaultAppend;
  const root = process.env.ANYMEM_PLUGIN_ROOT || BAKED.root;
  const python = process.env.ANYMEM_PYTHON || BAKED.python || "python3";
  const script = path.join(root || "", "adapters", "kilo", "hook.py");
  const directory = (ctx && (ctx.directory || ctx.worktree)) || process.cwd();
  const sessions = new Map();

  function session(id) {
    const key = String(id || "");
    let st = sessions.get(key);
    if (!st) {
      st = { capsule: null, stash: "", keep: false, child: false, roles: new Map(), seen: new Set(), pending: new Map() };
      sessions.set(key, st);
    }
    return st;
  }

  function spoolFile(id) {
    return path.join(cacheDir(), "kilo", safeName(id) + ".jsonl");
  }

  // Writes nothing unless the last reply of this session said the capture policy allows keeping text. A subagent session
  // never writes: its user text is the parent model's own words, not the person's.
  function spool(id, role, text) {
    try {
      const st = session(id);
      if (!st.keep || st.child) return;
      const clean = String(text || "").trim().slice(0, MAX_SPOOL_TEXT);
      if (clean) append(spoolFile(id), JSON.stringify({ role, text: clean }) + "\n");
    } catch {}
  }

  // One call into hook.py. Returns {context, keep}: the context text it printed and whether the policy allows keeping text.
  // Any problem gives no context and keep false.
  async function callHook(event, payload, timeoutMs, fire, extraEnv) {
    const none = { context: "", keep: false };
    try {
      if (!root) return none;
      const res = await run([python, script, event], JSON.stringify(payload), timeoutMs, { ANYMEM_PLUGIN_ROOT: root, ...extraEnv }, fire);
      if (fire || !res || res.code !== 0) return none;
      const line = String(res.stdout || "").trim().split("\n").pop();
      if (!line) return none;
      const parsed = JSON.parse(line);
      return {
        context: parsed && typeof parsed.additionalContext === "string" ? parsed.additionalContext : "",
        keep: Boolean(parsed && parsed.keep === true),
      };
    } catch {
      return none;
    }
  }

  // The session-start and prompt replies also set whether this session's text may be spooled.
  async function reply(sid, event, payload, timeoutMs, extraEnv) {
    const got = await callHook(event, payload, timeoutMs, false, extraEnv);
    session(sid).keep = got.keep;
    return got;
  }

  function textOf(parts) {
    return (Array.isArray(parts) ? parts : [])
      .filter((p) => p && p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }

  function recordAssistant(sid, st, part) {
    const key = part.id || part.messageID + ":" + part.text.length;
    if (st.seen.has(key)) return;
    st.seen.add(key);
    spool(sid, "assistant", part.text);
  }

  function capture(sid, event) {
    return callHook(event, { sessionID: sid, directory, spool: spoolFile(sid) }, 8000, true);
  }

  return {
    event: async (input) => {
      try {
        const event = (input && input.event) || {};
        const props = (event && event.properties) || {};
        const sid = props.sessionID || (props.info && props.info.id) || (props.part && props.part.sessionID) || "";
        if ((event.type === "session.created" || event.type === "session.updated") && props.info && props.info.id && props.info.parentID) {
          session(props.info.id).child = true;  // a subagent session, see spool()
        } else if (event.type === "session.deleted" && sid) {
          sessions.delete(String(sid));  // the per session state goes with the session
        } else if (event.type === "message.updated" && props.info && props.info.id) {
          // the message's own session, never the message id: a build without props.sessionID would split the state otherwise
          const owner = props.info.sessionID || props.sessionID || "";
          if (!owner) return;
          const st = session(owner);
          st.roles.set(props.info.id, props.info.role);
          const waiting = st.pending.get(props.info.id);
          st.pending.delete(props.info.id);
          if (props.info.role === "assistant") for (const part of waiting || []) recordAssistant(owner, st, part);
        } else if (event.type === "message.part.updated" && props.part) {
          const part = props.part;
          // A finished text part of an assistant message. User text is spooled from chat.message, reasoning is never kept.
          if (part.type !== "text" || part.synthetic || part.ignored || !part.time || !part.time.end || !part.text) return;
          const st = session(part.sessionID || sid);
          const role = st.roles.get(part.messageID);
          if (role === "assistant") recordAssistant(part.sessionID || sid, st, part);
          else if (role === undefined) st.pending.set(part.messageID, [...(st.pending.get(part.messageID) || []), part]);
        } else if (event.type === "session.idle" && sid) {
          const st = session(sid);
          st.stash = "";
          if (!st.child) await capture(sid, "capture");
        }
      } catch {}
    },

    "chat.message": async (input, output) => {
      try {
        const sid = input && input.sessionID;
        if (!sid) return;
        const st = session(sid);
        st.stash = "";
        const prompt = textOf(output && output.parts);
        if (!prompt) return;
        const got = await reply(sid, "prompt", { sessionID: sid, prompt, directory, spool: spoolFile(sid) }, RECALL_TIMEOUT_MS,
          { ANYMEM_HOOK_DEADLINE: RECALL_HOOK_DEADLINE });
        spool(sid, "user", prompt);  // after the reply, because the reply says whether the text may be kept
        st.stash = got.context;
      } catch {}
    },

    // The system prompt is rebuilt for every model call, so the capsule is fetched once per session and pushed on each call.
    // The recall block is pushed on every call of the turn it was made for (a tool loop makes several), then dropped at
    // session.idle or the next user message.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sid = input && input.sessionID;
        if (!sid || !output || !Array.isArray(output.system)) return;
        const st = session(sid);
        if (st.capsule === null) st.capsule = reply(sid, "session-start", { sessionID: sid, directory, spool: spoolFile(sid) }, CAPSULE_TIMEOUT_MS);
        const capsule = (await st.capsule).context;
        for (const text of [capsule, st.stash]) {
          if (text && !output.system.includes(text)) output.system.push(text);
        }
      } catch {}
    },

    "experimental.session.compacting": async (input) => {
      try {
        if (input && input.sessionID) await capture(input.sessionID, "pre-compact");
      } catch {}
    },
  };
}
// anymem end
