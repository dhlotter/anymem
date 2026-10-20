// Splits a memory into the pieces that are embedded, and lists the search keys of one memory.

export const CHUNK_CHARS = 1600;
export const OVERLAP_CHARS = 200;

/** How far back from the size limit a break may be looked for. A break in the first part of a chunk is not worth it. */
const MIN_FILL = 0.5;

/** The index just after the last break of this kind inside text[from, to), or -1. */
function lastBreak(text, from, to, pattern) {
  let found = -1;
  const re = new RegExp(pattern.source, "g");
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index + m[0].length <= to; m = re.exec(text)) found = m.index + m[0].length;
  return found;
}

/**
 * Cut text into chunks of at most size characters. A cut falls after a blank line if there is one in the last half of the
 * window, else after a sentence end, else after whitespace, else it is hard. Each chunk starts overlap characters before
 * the previous one ended, at the start of a word. Text that fits in one chunk comes back whole.
 * @param {string} text
 * @param {number} [size]
 * @param {number} [overlap]
 * @returns {string[]}
 */
export function chunkText(text, size = CHUNK_CHARS, overlap = OVERLAP_CHARS) {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    if (clean.length - start <= size) {
      chunks.push(clean.slice(start).trim());
      break;
    }
    const floor = start + Math.floor(size * MIN_FILL);
    const limit = start + size;
    let end = lastBreak(clean, floor, limit, /\n\s*\n/);
    if (end < 0) end = lastBreak(clean, floor, limit, /[.!?]["')\]]?\s/);
    if (end < 0) end = lastBreak(clean, floor, limit, /\s/);
    if (end < 0) end = limit;
    chunks.push(clean.slice(start, end).trim());
    let next = Math.max(end - overlap, start + 1);
    while (next < end && !/\s/.test(clean[next - 1])) next++;
    start = next < end ? next : end;
  }
  return chunks.filter(Boolean);
}

/**
 * The text that is embedded for a memory: its name, description and body.
 * @param {{name: string, description: string, body: string}} m
 */
export function memoryText(m) {
  return [m.name, m.description, m.body].map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n");
}

/**
 * The search keys of one memory, each with the text to embed. Chunks of the whole memory, plus the description on its own.
 * A memory with no name, description or body (only frontmatter) is keyed on its content, so it gets a key like any other.
 * @param {{name: string, description: string, body: string, content?: string}} m
 * @returns {{key_type: "chunk" | "description", position: number, text: string}[]}
 */
export function buildKeys(m) {
  const keys = chunkText(memoryText(m) || (m.content ?? "")).map((text, position) => ({ key_type: "chunk", position, text }));
  if (m.description?.trim()) keys.push({ key_type: "description", position: 0, text: m.description.trim() });
  return keys;
}

/** The deterministic Vectorize id of a key. Vectorize ids are at most 64 bytes, a UUID takes 36 of them. */
export const vectorId = (memoryId, keyType, position) => `${memoryId}:${keyType}:${position}`;

const VECTOR_ID_BYTES = 64;
/** A memory id is at most 50 bytes, so the longest vector id, with ":description:0" (14 bytes) after it, is 64. */
export const MEMORY_ID_BYTES = 50;
const bytes = (text) => new TextEncoder().encode(text).length;

/** Whether an imported memory id keeps its vector ids within Vectorize's 64 bytes. */
export const memoryIdFits = (id) => bytes(id) <= MEMORY_ID_BYTES;

/** Whether Vectorize takes this vector id. A longer one is refused, so it is never in the index and has nothing to delete. */
export const vectorIdFits = (id) => bytes(id) <= VECTOR_ID_BYTES;

/** The memory id inside a vector id made by vectorId. */
export const memoryIdOf = (id) => id.slice(0, id.lastIndexOf(":", id.lastIndexOf(":") - 1));
