// Backups in R2. One gzipped export per UTC day under backups/. A backup that is much smaller than the last one is
// refused, because a half empty export means something is wrong, and the old one stays. The export is streamed to R2 as a
// multipart upload, so the whole store is never held in memory.
import { dayOf } from "../counters.js";
import { PURGED_KEY } from "../cron/purge.js";
import { badRequest, HttpError, intParam, json, notFound, readJson } from "../http.js";
import { exportStore, exportText } from "./export.js";

export const PREFIX = "backups/";
export const MIN_SHARE = 0.8;
/** The size of one part of a streamed backup. R2 takes parts of 5 MB or more, except the last one. */
export const PART_BYTES = 8 * 1024 * 1024;
const KEY = /^backups\/anymem-(\d{4}-\d{2}-\d{2})\.json\.gz$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST_PAGES = 10;

const keyFor = (day) => `${PREFIX}anymem-${day}.json.gz`;

function bucketOf(env) {
  if (!env.BACKUP_BUCKET) throw notFound("This Worker has no backup bucket. Add the BACKUP_BUCKET binding and deploy again.", "no_backup_bucket");
  return env.BACKUP_BUCKET;
}

/** Gzip a string. */
export async function gzip(text) {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** Gunzip bytes to a string. */
export async function gunzip(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/**
 * The backups in the bucket, newest first. purged is the count of trash purges when the backup was made, null for a backup
 * from before that was recorded.
 * @returns {Promise<{day: string, key: string, size: number, entries: number | null, created_at: number | null, purged: number | null}[]>}
 */
export async function listBackups(bucket) {
  const found = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await bucket.list({ prefix: PREFIX, cursor, include: ["customMetadata"] });
    for (const o of res.objects) {
      const m = KEY.exec(o.key);
      if (!m) continue;
      const entries = Number(o.customMetadata?.entries);
      const created = Number(o.customMetadata?.created_at);
      const purged = Number(o.customMetadata?.purged);
      found.push({
        day: m[1],
        key: o.key,
        size: o.size,
        entries: Number.isFinite(entries) && o.customMetadata?.entries !== undefined ? entries : null,
        created_at: Number.isFinite(created) && o.customMetadata?.created_at !== undefined ? created : null,
        purged: Number.isFinite(purged) && o.customMetadata?.purged !== undefined ? purged : null,
      });
    }
    if (!res.truncated) break;
    cursor = res.cursor;
  }
  return found.sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** How many memories the trash purge has deleted in all. */
async function purgedCount(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(PURGED_KEY).first();
  return Number(row?.value ?? 0) || 0;
}

/**
 * Gzip the text pieces and upload the bytes as one R2 multipart upload, a part at a time. Only one part and one piece are
 * held at once. A failure aborts the upload, so no partial object is left behind.
 * @returns {Promise<number>} the gzip bytes written
 */
export async function streamGzipTo(bucket, key, options, pieces, partBytes) {
  const upload = await bucket.createMultipartUpload(key, options);
  const zip = new CompressionStream("gzip");
  const writer = zip.writable.getWriter();
  const reader = zip.readable.getReader();
  const encoder = new TextEncoder();
  // The pieces go in while the compressed bytes come out, so the two run side by side.
  const feed = (async () => {
    try {
      for await (const piece of pieces) await writer.write(encoder.encode(piece));
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
  })();
  feed.catch(() => {});
  const parts = [];
  let held = [];
  let heldBytes = 0;
  let total = 0;
  // R2 wants every part but the last to be the same length, so a part is cut at exactly size bytes and the rest is kept for the next one.
  const uploadPart = async (size) => {
    const body = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = held[0];
      const take = Math.min(chunk.byteLength, size - at);
      body.set(chunk.subarray(0, take), at);
      at += take;
      if (take === chunk.byteLength) held.shift();
      else held[0] = chunk.subarray(take);
    }
    heldBytes -= size;
    parts.push(await upload.uploadPart(parts.length + 1, body));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      held.push(value);
      heldBytes += value.byteLength;
      total += value.byteLength;
      while (heldBytes >= partBytes) await uploadPart(partBytes);
    }
    await feed;
    if (heldBytes || !parts.length) await uploadPart(heldBytes);
    await upload.complete(parts);
    return total;
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
}

/**
 * Write today's backup, streamed to R2. Refused when it has fewer than 80 percent of the entries of the newest backup
 * already there, after allowing for the memories that the trash purge has removed since then.
 * @param {{DB: any, BACKUP_BUCKET: any}} env
 * @param {() => number} now
 * @param {{force?: boolean, partBytes?: number}} [opts] force skips the size check, partBytes is the size of one upload part
 * @returns {Promise<{ok: boolean, key: string, entries: number, bytes: number, refused?: {entries: number, previous_entries: number, previous_key: string}}>}
 */
export async function runBackup(env, now, { force = false, partBytes = PART_BYTES } = {}) {
  const bucket = bucketOf(env);
  const [previous] = await listBackups(bucket);
  // Read before the export, so a purge that lands during it is counted with the next backup and not this one.
  const purged = await purgedCount(env.DB);
  const entries = (await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first()).n;
  // A purge removes memories on purpose, so the drop it causes is allowed. Only a drop beyond the purges is checked.
  const purgedSince = previous?.purged === null || previous?.purged === undefined ? 0 : Math.max(0, purged - previous.purged);
  const expected = previous?.entries ? previous.entries - purgedSince : 0;
  if (!force && previous?.entries && entries < expected * MIN_SHARE) {
    return { ok: false, key: previous.key, entries, bytes: previous.size, refused: { entries, previous_entries: previous.entries, previous_key: previous.key } };
  }
  const schema = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  const created = now();
  const key = keyFor(dayOf(created));
  const bytes = await streamGzipTo(
    bucket,
    key,
    {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { entries: String(entries), created_at: String(created), schema: String(schema?.value ?? ""), purged: String(purged) },
    },
    exportText(env.DB, now),
    partBytes,
  );
  return { ok: true, key, entries, bytes };
}

/** GET /backup */
export async function listBackupsRoute({ env }) {
  const backups = await listBackups(bucketOf(env));
  const latest = backups[0] ? { day: backups[0].day, entries: backups[0].entries, size: backups[0].size, created_at: backups[0].created_at } : null;
  return json({ ok: true, backups, latest });
}

/** The same backup without the device token hashes, gzipped again. */
async function withoutTokenHashes(bytes) {
  const doc = JSON.parse(await gunzip(bytes));
  if (Array.isArray(doc.devices)) doc.devices = doc.devices.map(({ token_hash, ...device }) => device);
  return gzip(JSON.stringify(doc));
}

/** GET /backup/<day>. The gzip bytes. A bearer caller gets the stored bytes, a restore needs the token hashes. A browser login gets a copy without them. */
export async function downloadBackupRoute({ env, url, actor }) {
  const day = decodeURIComponent(url.pathname.slice("/backup/".length));
  if (!DAY.test(day)) throw badRequest("The day must look like 2026-10-17.");
  const object = await bucketOf(env).get(keyFor(day));
  if (!object) throw notFound("No backup for that day.");
  const headers = { "content-type": "application/gzip", "content-disposition": `attachment; filename="anymem-${day}.json.gz"`, "cache-control": "no-store" };
  if (actor.kind !== "browser") return new Response(object.body, { headers: { ...headers, "content-length": String(object.size) } });
  const bytes = await withoutTokenHashes(new Uint8Array(await new Response(object.body).arrayBuffer()));
  return new Response(bytes, { headers: { ...headers, "content-length": String(bytes.byteLength) } });
}

/** POST /backup/run {force?}. Takes today's backup now. */
export async function runBackupRoute({ request, env, now, maxBody }) {
  const body = request.body ? await readJson(request, maxBody) : {};
  if (body.force !== undefined && typeof body.force !== "boolean") throw badRequest("force must be true or false.");
  try {
    return json(await runBackup(env, now, { force: body.force === true }));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("backup failed", err?.name);
    throw new HttpError(502, "backup_failed", "The backup could not be written. Try again.");
  }
}

const MAX_EXPORT_PAGE = 1000;

/**
 * GET /export?cursor=&limit= or GET /export?offset=&limit=. The whole store, or one page of entries. A cursor page starts
 * after the cursor (cursor=start for the first page) and returns next_cursor, which a purge cannot shift. An offset page
 * returns next_offset. Above the size cap the caller has to page. A browser login gets no device token hashes.
 */
export async function exportRoute({ env, url, now, memoryIds, actor }) {
  const keyed = url.searchParams.has("cursor");
  const offset = intParam(url, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  const limit = intParam(url, "limit", { min: 1, max: MAX_EXPORT_PAGE });
  const data = await exportStore(env.DB, now, { cursor: url.searchParams.get("cursor"), keyed, offset, limit: limit ?? null }, { capped: true });
  memoryIds.push(...data.entries.map((e) => e.id).slice(0, 100));
  if (actor.kind === "browser") data.devices = data.devices.map(({ token_hash, ...device }) => device);
  return json(data);
}
