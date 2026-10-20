// Embeddings through the Workers AI binding. One model, 384 dimensions, cosine.

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const DIMENSIONS = 384;
const BATCH = 50;

/**
 * Embed texts in batches of 50. The order of the result matches the order of the input.
 * @param {{run: (model: string, input: any) => Promise<any>}} ai the AI binding
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(ai, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await ai.run(EMBEDDING_MODEL, { text: batch });
    const data = res?.data;
    if (!Array.isArray(data) || data.length !== batch.length || data.some((v) => !Array.isArray(v) || v.length !== DIMENSIONS)) {
      throw new Error("The embedding model returned an unexpected shape.");
    }
    out.push(...data);
  }
  return out;
}
