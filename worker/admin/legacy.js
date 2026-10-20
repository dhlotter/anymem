// Maps one entry of the old Worker's export (GET /export, field "entries") to the fields the store takes.
import { cleanLabel } from "../audit.js";
import { badRequest } from "../http.js";
import { harnessId } from "../harnesses.js";
import { KINDS, parseMemory, STATUSES } from "../memory/parse.js";
import { memoryIdFits } from "../search/chunk.js";

const SOURCE_TO_ORIGIN = {
  "session-capture": "capture",
  claude: "explicit",
  "vault-memory-import": "import",
  "zcode-native-memory": "import",
  profile: "profile",
  person: "person",
  system: "system",
};
// The 2 old digests, and the captures that were rolled up into them, go to the trash.
const TRASHED_TAGS = ["synthesized", "rolled-up"];
const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TAG_CHARS = 64;

/** The tags of an entry. The old export sends a list, older files a JSON string. */
function tagList(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = raw.split(",");
    }
  }
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const t of list) {
    if (typeof t !== "string") continue;
    const tag = t.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-");
    if (tag && tag.length <= MAX_TAG_CHARS) out.add(tag);
  }
  return [...out];
}

const time = (v, fallback) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);

/**
 * @param {any} entry one old entry
 * @param {number} importedAt when the import runs, the trash time of a rolled up entry
 * @returns the fields for store.create
 */
export async function mapLegacy(entry, importedAt) {
  if (!entry || typeof entry !== "object") throw badRequest("An entry must be an object.");
  if (typeof entry.id !== "string" || !entry.id.trim() || !memoryIdFits(entry.id)) throw badRequest("An entry needs an id of at most 50 bytes, so its search ids fit the 64 byte limit of Vectorize.");
  const tags = tagList(entry.tags);
  const column = { status: null, kind: null, project: null, harness: "", session: "" };
  const plain = [];
  for (const tag of tags) {
    const m = /^(status|kind|project|captured-by|session):(.*)$/.exec(tag);
    if (!m) {
      plain.push(tag);
      continue;
    }
    const [, key, value] = m;
    if (key === "status" && column.status === null && STATUSES.includes(value)) column.status = value;
    else if (key === "kind" && column.kind === null && KINDS.includes(value)) column.kind = value;
    else if (key === "project" && column.project === null && PROJECT_SLUG.test(value)) column.project = value;
    else if (key === "captured-by" && !column.harness) column.harness = harnessId(cleanLabel(value));
    else if (key === "session" && !column.session) column.session = cleanLabel(value);
  }
  const parsed = await parseMemory(entry.content, plain);
  const created = time(entry.created_at, importedAt);
  return {
    ...parsed,
    id: entry.id.trim(),
    origin: SOURCE_TO_ORIGIN[entry.source] ?? "explicit",
    status: column.status ?? "active",
    kind: column.kind,
    project: column.project ?? "",
    harness: column.harness,
    session: column.session,
    created_at: created,
    updated_at: time(entry.updated_at, created),
    valid_until: time(entry.valid_until, null),
    recall_count: time(entry.recall_count, 0),
    deleted_at: tags.some((t) => TRASHED_TAGS.includes(t)) ? importedAt : null,
  };
}
