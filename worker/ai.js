// Small model calls in JSON mode through the Workers AI binding. Every caller treats null as "the model did not help".

// The model for every small job. One place, so measuring a better one is one line (or the SMALL_MODEL variable).
export const SMALL_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const TIMEOUT_MS = 25_000;
const MAX_TOKENS = 1500;

/** Pull a JSON object out of whatever the model returned. Models sometimes wrap it in prose or a code fence. */
function parseObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ask the small model for one JSON object that fits a schema.
 * The first line of the prompt names the task (TASK: name), which is also how tests script the model.
 * @param {{AI: any, SMALL_MODEL?: string}} env
 * @param {{task: string, system: string, prompt: string, schema: object, maxTokens?: number}} args
 * @returns {Promise<object | null>} the parsed object, or null when the call failed, timed out or did not parse
 */
export async function askJson(env, { task, system, prompt, schema, maxTokens = MAX_TOKENS }) {
  let timer;
  try {
    const call = env.AI.run(env.SMALL_MODEL ?? SMALL_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: `TASK: ${task}\n\n${prompt}` },
      ],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: maxTokens,
      temperature: 0,
    });
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("model timeout")), TIMEOUT_MS)));
    const res = await Promise.race([call, timeout]);
    return parseObject(res?.response ?? res?.choices?.[0]?.message?.content ?? null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text that goes into a prompt as data. The tags the prompt uses are taken out so the text cannot close a block and speak as the instructions.
 * @param {string} text
 * @param {string[]} tags
 */
export function asData(text, tags) {
  return String(text ?? "").replace(new RegExp(`</?\\s*(?:${tags.join("|")})\\b[^>]*>`, "gi"), "[tag removed]");
}
