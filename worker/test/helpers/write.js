// Helpers for the write path and extract tests. All sample text here is invented.
import { SMALL_MODEL } from "../../ai.js";
import { fakeEmbedding } from "./fakes.js";

/**
 * Script the small model. Each task (the word after "TASK:" in the prompt) has an answer. The answer is an object, a string
 * (returned as is, so it can be unparseable), a function of the prompt, or a list that is used one entry at a time.
 * The word "fail" as an answer, or a function that throws, makes the call fail. A task with no answer fails.
 */
export function scriptModel(ai, answers = {}) {
  const log = [];
  ai.reply(SMALL_MODEL, (input) => {
    const prompt = input.messages[1].content;
    const task = /^TASK: (\S+)/.exec(prompt)[1];
    log.push({ task, prompt, input });
    let answer = answers[task];
    if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
    if (typeof answer === "function") answer = answer(prompt);
    if (answer === undefined || answer === "fail") throw new Error(`the model is down for ${task}`);
    return { response: answer };
  });
  return {
    answers,
    log,
    /** The calls made for one task. */
    calls: (task) => log.filter((c) => c.task === task),
  };
}

/** The same answers for the two checks that most tests do not care about: the privacy filter says no and the kind is semantic. */
export const QUIET = { sensitivity: { sensitive: false, category: "none" }, kind: { kind: "semantic" } };

export const cosine = (a, b) => {
  const x = fakeEmbedding(a);
  const y = fakeEmbedding(b);
  return x.reduce((sum, v, i) => sum + v * y[i], 0);
};

/** POST /capture. */
export const put = (app, content, extra = {}, opts = {}) => app.call("/capture", { method: "POST", body: { content, ...extra }, ...opts });

/** A capture, as the session hook sends it. */
export const putCapture = (app, content, extra = {}, opts = {}) => put(app, content, { source: "session-capture", ...extra }, opts);

/** Text that shares no words with any other index, so it is never a near duplicate of another. */
export const distinct = (i) => `zq${i}alpha zq${i}beta zq${i}gamma zq${i}delta zq${i}epsilon`;

export const THIRTY_WORDS = "river stone lantern copper maple harbor violet anchor meadow candle quartz ember falcon glacier hollow island jasmine kettle lagoon marble nectar orchard pebble raven summit timber umber velvet willow zephyr".split(" ").slice(0, 30);
/** A text of thirty words, and the same text with its last word swapped (similarity about 0.97). */
export const BASE_30 = THIRTY_WORDS.join(" ");
export const SWAP_30 = [...THIRTY_WORDS.slice(0, 29), "thistle"].join(" ");
/** Ten words, and ten words that share nine of them (similarity 0.9). */
export const TEN = "river stone lantern copper maple harbor violet anchor meadow candle";
export const TEN_NINE = "river stone lantern copper maple harbor violet anchor meadow thistle";

export const OLD_FACT = "The staging host serves the demo app on port 8080 behind the proxy.";
export const NEW_FACT = "From now on the staging host serves the demo app on port 9090 behind the proxy and the load balancer.";

/** A confirm answer that quotes both memories word for word and says the new one wins. */
export const NEW_WINS = { verdict: "new_wins", old_claim: "The staging host serves the demo app on port 8080", new_claim: "the staging host serves the demo app on port 9090" };
export const BOTH_TRUE = { verdict: "both_true", old_claim: "", new_claim: "" };

export { row } from "./maintenance.js";
export const liveCount = async (app) => (await app.env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL").first()).n;
export const counter = async (app, name) => (await app.env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM counters WHERE name = ?").bind(name).first()).n;

const window = () => ({
  capture: { accepted: 0, rejected: 0, reasons: {}, updated: 0, model_fallback: 0 },
  extract: { proposed: 0, screened: 0, reasons: {} },
  conflicts: { replaced: 0, similar_warning: 0, kept_both: {} },
  model_failures: {},
});
/** The counter sections of GET /stats on an empty store. */
export const EMPTY_COUNTERS = Object.fromEntries(Object.entries(window()).map(([k, v]) => [k, { ...v, last_7_days: window()[k] }]));
