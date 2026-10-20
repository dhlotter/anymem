# Why scripts and hooks, not MCP

Anymem reaches your agent through a skill, short scripts and hooks. The Worker has no MCP endpoint, and nothing is added to your agent's tool list. This page gives the reasons, then the limits.

## The reasons

1. **Context cost.** An MCP server puts every tool definition into every session, whether or not memory comes up. A skill costs its one paragraph of description until it is used, and its body loads only when the agent needs it. We have not measured and published a token figure, so we do not quote one.
2. **Deterministic, not hopeful.** Hooks run on events. The recall hook runs on every prompt, the capsule hook at session start, and the capture hook at compaction and session end. With MCP, memory happens only when the model decides to call a tool. The trade is latency. Each hook is a process that has to finish inside its limit, and the recall hook is silent on any error, so a slow Worker never blocks a prompt.
3. **Visible and gated.** When the agent saves or looks up a memory it runs a shell command. That command shows in the transcript, passes the harness's own permission prompt, and can be replayed by hand. Hooks run without a prompt and their output arrives as injected context. Their activity is recorded in `~/.cache/anymem/capture.log` and in the audit log, which notes every call.
4. **Secrets stay out of agent config.** The scripts resolve the Worker address and token at the moment they run, from environment variables, then the config file, then an optional `credential_command` that can ask a secret manager. MCP client configs tend to hold a bearer token in plain JSON. The honest caveat is that the default config file holds the token in plain text, with file mode 0600. Use `credential_command` to keep it out of that file.
5. **Portable.** A skill file plus a script works wherever a shell exists. MCP transport and auth differ from tool to tool. The caveat is that hook protocols also differ per harness, so each needs a small adapter for its payload, its way of injecting context and its transcript format. The shared logic stays in one place and the adapters do not.
6. **Fails small.** A failed script ends that script. There is no long lived connection to drop and no server process in your agent to restart. Hooks catch their own errors and stay silent. A memory that cannot be saved goes to `~/.cache/anymem/failed.jsonl`, and `doctor.py` lists it.
7. **Reviewable.** The skill, the scripts, the hooks and the Worker are files in this repository. You can read them, diff them between versions and run their tests. The scripts are fixed. Nothing is built at run time from what the Worker sends back, so a compromised reply cannot become a new command.

## Honest limits

1. **Surfaces with no shell are not supported.** The claude.ai web app and the mobile apps cannot run a script or a hook, and there is no connector for them. That was a decision, not an oversight. It is the main thing you give up.
2. **The skill relies on the model following it.** The agent saves a memory in its own turn only if it follows the skill's rule. The capture hook is the backstop, and it reads what the agent saved so it only adds what is missing. See [capture](capture-design.md).
3. **Hooks cost a process per event.** On every prompt the recall hook starts a Python process and makes one network call. It stops itself at 8 seconds. If your network to Cloudflare is slow, you will feel it.
4. **It is a self hosted kit, not a one click app.** You need a Cloudflare account, an API token and a terminal. See [install](install.md).
