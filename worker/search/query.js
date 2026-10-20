// Cleans a prompt into a search query. The same rules the prompt hook applied on the client (hooks/memory_recall.py clean_query).

export const MAX_QUERY_CHARS = 240;
export const MIN_QUERY_CHARS = 3; // the plan said 12, but that drops bare identifiers such as R05 or ABC-12027. The hooks keep their own floor.

const PRIVATE_CLOSED = /<\s*private\s*>[\s\S]*?<\s*\/\s*private\s*>/gi;
const PRIVATE_OPEN = /<\s*private\s*>[\s\S]*$/i; // an unclosed tag hides the rest of the text
const PRIVATE_STRAY = /<\s*\/\s*private\s*>/gi;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const FENCE = /```[\s\S]*?```/g;

// Sentences that tell the assistant how to answer, not what is asked. They dilute the meaning of the query.
const FORMAT = new RegExp(
  "^[^\\p{L}\\p{N}_]*(?:please\\s+)?(?:" +
    [
      "answer",
      "reply",
      "respond",
      "say\\s+(?:none|nothing|so)",
      "keep\\s+(?:it|the answer|your)",
      "be\\s+(?:brief|concise|short)",
      "do\\s+not\\s+use",
      "don'?t\\s+use",
      "use\\s+(?:bullet|plain|only|the\\s+(?:memories|context))",
      "explain\\s+(?:briefly|in\\s+(?:one|two|simple))",
      "in\\s+(?:one|two|three)\\s+(?:sentence|word|line)",
      "one\\s+(?:sentence|line|word)",
      "if\\s+(?:there\\s+is|nothing|none|no\\s+)",
      "from\\s+the\\s+(?:memories|context)",
      "only\\s+use",
      "no\\s+markdown",
      "limit\\s+(?:it|your)",
      "under\\s+\\w+\\s+words",
    ].join("|") +
    ")",
  "iu",
);

function stripPrivate(text) {
  if (!/private/i.test(text)) return text;
  return text.replace(PRIVATE_CLOSED, "").replace(PRIVATE_OPEN, "").replace(PRIVATE_STRAY, "").trim();
}

/**
 * The query to search with, or an empty string when there is nothing worth searching for.
 * Strips private text, system reminders and fenced code, collapses whitespace, drops sentences that only say how to
 * answer (unless nothing else is left), caps the length at 240 characters, and gives nothing under 3.
 * @param {unknown} prompt
 * @returns {string}
 */
export function cleanQuery(prompt) {
  const text = stripPrivate(typeof prompt === "string" ? prompt : "").replace(REMINDER, "").replace(FENCE, " ").split(/\s+/).filter(Boolean).join(" ");
  const kept = text.split(/(?<=[.?!])\s+/).filter((sentence) => !FORMAT.test(sentence));
  const query = (kept.length ? kept.join(" ") : text).slice(0, MAX_QUERY_CHARS);
  return query.length >= MIN_QUERY_CHARS ? query : "";
}
