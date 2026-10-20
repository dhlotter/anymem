// Turns the text a caller sends into the fields a memory is stored with.
import { badRequest, tooLarge } from "../http.js";

export const MAX_CONTENT_CHARS = 30_000;
export const STATUSES = ["canonical", "active", "deprecated", "pending"];
export const KINDS = ["semantic", "episodic"];
export const TYPES = ["user", "feedback", "project", "reference"];

const MAX_TAGS = 50;
const MAX_TAG_CHARS = 64;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const HASHTAG = /(?<=^|[\s(\[,])#([A-Za-z](?:[\w-]*[A-Za-z0-9])?)/g;

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Read the name, description and nested metadata type from a leading frontmatter block.
 * Text without a closed block has no frontmatter, so name is null and the body is the whole text.
 * @param {string} text already trimmed
 * @returns {{name: string | null, description: string, type: string | null, body: string}}
 */
export function parseFrontmatter(text) {
  const match = text.startsWith("---") ? FRONTMATTER.exec(text) : null;
  if (!match) return { name: null, description: "", type: null, body: text };
  let name = null;
  let description = "";
  let type = null;
  let inMetadata = false;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata";
      if (top[1] === "name") name = unquote(top[2]) || null;
      else if (top[1] === "description") description = unquote(top[2]);
      continue;
    }
    const nested = inMetadata ? /^[ \t]+type:[ \t]*(.*)$/.exec(line) : null;
    if (nested) {
      const t = unquote(nested[1]).toLowerCase();
      type = TYPES.includes(t) ? t : null;
    }
  }
  return { name, description, type, body: text.slice(match[0].length).trim() };
}

/**
 * Hashtags in a text, lowercase, outside fenced code blocks. The text itself is not changed.
 * @param {string} text
 * @returns {string[]}
 */
export function liftHashtags(text) {
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  return [...prose.matchAll(HASHTAG)].map((m) => m[1].toLowerCase());
}

/**
 * Lowercase, strip a leading hash, drop duplicates. Throws 400 on a tag that has spaces or is too long.
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw badRequest("tags must be a list of strings.");
  const out = new Set();
  for (const raw of tags) {
    if (typeof raw !== "string") throw badRequest("tags must be a list of strings.");
    const tag = raw.trim().replace(/^#+/, "").toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS || /\s/.test(tag)) throw badRequest(`Tag "${raw.slice(0, 40)}" has spaces or is longer than ${MAX_TAG_CHARS} characters.`, "bad_tag");
    out.add(tag);
  }
  return [...out];
}

/** @param {string[]} tags */
export const isPinnedByTags = (tags) => tags.some((t) => t === "capsule:core" || t.startsWith("capsule-slot:"));

/** Origins only the admin token or a browser login may write. A device token gets a 403 for them. */
export const ADMIN_ORIGINS = ["profile", "person", "system", "import"];

/** The tags only the admin token or a browser login may set: the core capsule tags and the canonical status. */
export const adminOnlyTags = (tags) => tags.filter((t) => t === "status:canonical" || t === "capsule:core" || t.startsWith("capsule-slot:"));

/** What makes an existing memory admin only: capsule tags or the canonical status. Takes an entry. */
export const adminHeld = (e) => [...adminOnlyTags(e.tags), ...(e.status === "canonical" ? ["status:canonical"] : [])];

/** The 403 text for a device token that sends something it may not write. */
export const adminOnlyMessage = (what) => `A device token cannot write ${what.join(", ")}. Only the admin token or a browser login can.`;

function reserved(tags) {
  const found = { status: null, kind: null, project: null };
  const plain = [];
  for (const tag of tags) {
    const m = /^(status|kind|project):(.*)$/.exec(tag);
    if (!m) {
      plain.push(tag);
      continue;
    }
    const [, key, value] = m;
    const allowed = key === "status" ? STATUSES : key === "kind" ? KINDS : null;
    if (allowed ? !allowed.includes(value) : !PROJECT_SLUG.test(value)) {
      throw badRequest(allowed ? `${key}:${value} is not allowed. Use one of ${allowed.join(", ")}.` : `project:${value} is not a valid project slug.`, "bad_tag");
    }
    if (found[key] !== null && found[key] !== value) throw badRequest(`Two different ${key} tags were given.`, "bad_tag");
    found[key] = value;
  }
  return { ...found, plain };
}

/** SHA-256 of the content with every run of whitespace collapsed, as lowercase hex. */
export async function contentHash(content) {
  const bytes = new TextEncoder().encode(content.replace(/\s+/g, " ").trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @typedef {object} Parsed
 * @property {string | null} name
 * @property {string} description
 * @property {string | null} type
 * @property {string} body
 * @property {string} content the trimmed text exactly as given
 * @property {string} content_hash
 * @property {string[]} tags plain tags only, reserved tags are in status, kind and project
 * @property {string | null} status from a status tag, else null
 * @property {string | null} kind from a kind tag, else null
 * @property {string | null} project from a project tag, else null
 * @property {boolean} pinned set by capsule tags
 */

/**
 * @param {unknown} text
 * @param {unknown} [tags] tags the caller sent, merged with hashtags found in the body
 * @returns {Promise<Parsed>}
 */
export async function parseMemory(text, tags = []) {
  if (typeof text !== "string") throw badRequest("content must be a string.");
  const content = text.trim();
  if (!content) throw badRequest("content is empty.");
  if (content.length > MAX_CONTENT_CHARS) throw tooLarge(`Content is ${content.length} characters. The limit is ${MAX_CONTENT_CHARS}.`);
  const fm = parseFrontmatter(content);
  const all = normalizeTags([...normalizeTags(tags), ...liftHashtags(fm.body)]);
  const { plain, status, kind, project } = reserved(all);
  if (plain.length > MAX_TAGS) throw badRequest(`A memory can have at most ${MAX_TAGS} tags.`, "bad_tag");
  return { name: fm.name, description: fm.description, type: fm.type, body: fm.body, content, content_hash: await contentHash(content), tags: plain, status, kind, project, pinned: isPinnedByTags(plain) };
}
