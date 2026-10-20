// Small fakes for Vectorize, Workers AI and R2. Deterministic, in memory.

const DIMENSIONS = 384;

/** A stable pseudo embedding from the words of a text. Same text, same vector. */
export function fakeEmbedding(text) {
  const v = new Array(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

// Vectorize counts an id in bytes and refuses the whole call when one id is over 64. Nothing is stored or deleted then.
const VECTOR_ID_LIMIT = 64;
// One delete takes at most this many ids. The documented Workers batch size is 1000 (no delete limit is published), so the fake refuses more.
const DELETE_LIMIT = 1000;
const refuseLongIds = (ids) => {
  if (ids.some((id) => new TextEncoder().encode(id).length > VECTOR_ID_LIMIT)) throw new Error("the vector id is longer than 64 bytes");
};

export class FakeVectorize {
  /**
   * delay is how long, by the now clock, a new vector takes to become searchable. The real index takes about two minutes.
   * indexed lists the metadata properties that have an index. A filter on any other property matches nothing, as on the real index.
   */
  constructor({ dimensions = DIMENSIONS, failing = false, delay = 0, now = () => 0, indexed = null } = {}) {
    this.indexed = indexed;
    this.dimensions = dimensions;
    this.failing = failing;
    this.delay = delay;
    this.now = now;
    this.vectors = new Map();
  }

  async describe() {
    if (this.failing) throw new Error("vectorize is down");
    return { dimensions: this.dimensions, vectorCount: this.vectors.size, processedUpToDatetime: null, processedUpToMutation: null };
  }

  async upsert(items) {
    refuseLongIds(items.map((v) => v.id));
    for (const v of items) this.vectors.set(v.id, { ...v, visibleAt: this.now() + this.delay });
    return { mutationId: String(this.vectors.size) };
  }

  async query(vector, { topK = 5, filter } = {}) {
    const matches = [...this.vectors.values()]
      .filter((v) => v.visibleAt <= this.now())
      .filter((v) => !filter || Object.entries(filter).every(([k, want]) => (this.indexed === null || this.indexed.includes(k)) && v.metadata?.[k] === want))
      .map((v) => ({ id: v.id, score: cosine(vector, v.values), metadata: v.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { count: matches.length, matches };
  }

  async deleteByIds(ids) {
    refuseLongIds(ids);
    if (ids.length > DELETE_LIMIT) throw new Error(`deleteByIds takes at most ${DELETE_LIMIT} ids, got ${ids.length}`);
    ids.forEach((id) => this.vectors.delete(id));
    return { mutationId: "x" };
  }
}

export class FakeAI {
  constructor() {
    this.replies = new Map();
    this.calls = [];
  }

  /** Set the reply for a model name. A function receives the input. */
  reply(model, value) {
    this.replies.set(model, value);
  }

  async run(model, input) {
    this.calls.push({ model, input });
    if (this.replies.has(model)) {
      const r = this.replies.get(model);
      return typeof r === "function" ? r(input) : r;
    }
    if (model.includes("bge") && Array.isArray(input?.text)) return { shape: [input.text.length, DIMENSIONS], data: input.text.map(fakeEmbedding) };
    if (model.includes("reranker")) {
      // the share of the query's words found in each context, enough to order texts the way a reranker would
      const words = input.query.toLowerCase().split(/\W+/).filter(Boolean);
      const scored = input.contexts.map((c, id) => ({ id, score: words.filter((w) => c.text.toLowerCase().includes(w)).length / Math.max(words.length, 1) }));
      return { response: scored.sort((a, b) => b.score - a.score).slice(0, input.top_k ?? scored.length) };
    }
    throw new Error(`FakeAI has no reply for ${model}`);
  }
}

const toBytes = (value) => (typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));

/** An R2 bucket in memory. Keeps bytes, custom metadata and an upload time. list pages by cursor like the real one. */
export class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.clock = 1_790_000_000_000;
  }

  async put(key, value, options = {}) {
    const bytes = toBytes(value);
    this.objects.set(key, { bytes, customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {}, uploaded: new Date(this.clock++) });
    return { key, size: bytes.byteLength };
  }

  #object(key, o) {
    return { key, size: o.bytes.byteLength, uploaded: o.uploaded, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata };
  }

  async head(key) {
    const o = this.objects.get(key);
    return o ? this.#object(key, o) : null;
  }

  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      ...this.#object(key, o),
      body: new Blob([o.bytes]).stream(),
      text: async () => new TextDecoder().decode(o.bytes),
      arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength),
    };
  }

  /** prefix, cursor and limit work. customMetadata is only returned when include asks for it, as on the real bucket. */
  async list({ prefix = "", cursor, limit = 1000, include = [] } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    const page = start < 0 ? [] : keys.slice(start, start + limit);
    const truncated = start >= 0 && start + limit < keys.length;
    const objects = page.map((key) => {
      const { customMetadata, ...rest } = this.#object(key, this.objects.get(key));
      return include.includes("customMetadata") ? { ...rest, customMetadata } : rest;
    });
    return { objects, truncated, ...(truncated ? { cursor: page.at(-1) } : {}) };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  /** A multipart upload as the bucket has it: parts are held until complete, and abort drops them. Nothing is listed before then. */
  async createMultipartUpload(key, options = {}) {
    const parts = new Map();
    const bucket = this;
    return {
      key,
      uploadPart: async (partNumber, value) => {
        parts.set(partNumber, toBytes(value));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async (uploaded) => {
        const pieces = uploaded.map((p) => parts.get(p.partNumber));
        // R2 refuses an upload whose parts, other than the last, are not all the same length.
        if (new Set(pieces.slice(0, -1).map((b) => b.byteLength)).size > 1) throw new Error("All non-trailing parts must have the same length.");
        const bytes = new Uint8Array(pieces.reduce((n, b) => n + b.byteLength, 0));
        let at = 0;
        for (const b of pieces) {
          bytes.set(b, at);
          at += b.byteLength;
        }
        bucket.objects.set(key, { bytes, customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {}, uploaded: new Date(bucket.clock++) });
        bucket.partCount = (bucket.partCount ?? 0) + pieces.length;
        return { key, size: bytes.byteLength };
      },
      abort: async () => {
        parts.clear();
      },
    };
  }
}
