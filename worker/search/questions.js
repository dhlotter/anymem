// Likely questions for a memory, written by a small model. Each becomes a search key that points at the memory.

export const QUESTION_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
const MAX_QUESTIONS = 3;
const MAX_INPUT_CHARS = 3000;

const SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: { type: "string" }, maxItems: MAX_QUESTIONS } },
  required: ["questions"],
};

/**
 * Up to three questions a person might ask whose answer is in this memory. An empty list when the model answered but
 * gave no usable question. Throws when the call fails or the reply is not the JSON it was asked for, so the caller can
 * tell a failure from an answer and try again later.
 * @param {{run: Function}} ai
 * @param {string} text the memory text
 * @returns {Promise<string[]>}
 */
export async function likelyQuestions(ai, text) {
  const res = await ai.run(QUESTION_MODEL, {
    messages: [
      { role: "system", content: "You write search questions. Given a note, write 3 short questions a person might type when they need this note, in their own casual words. Do not copy the note's wording. Reply with JSON only." },
      { role: "user", content: text.slice(0, MAX_INPUT_CHARS) },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 200,
  });
  const raw = res?.choices?.[0]?.message?.content ?? res?.response;
  let body;
  try {
    body = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("the question model did not reply with JSON");
  }
  if (!body || !Array.isArray(body.questions)) throw new Error("the question model reply has no questions list");
  return body.questions.filter((q) => typeof q === "string" && q.trim().length >= 8).map((q) => q.trim().slice(0, 200)).slice(0, MAX_QUESTIONS);
}
