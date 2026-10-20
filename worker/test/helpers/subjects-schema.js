// Brings a test database up to the subjects tables and the devices.allow_private column. Migration 0006 does this in the real
// schema. While it is not part of the migrations a test database gets the same SQL here, and once it is this does nothing.
const SQL = `CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('person','pet','asset','project','area','topic')),
  status TEXT NOT NULL CHECK (status IN ('proposed','active','stale','retired')),
  scope TEXT NOT NULL DEFAULT 'shared' CHECK (scope IN ('shared','private')),
  fields TEXT NOT NULL DEFAULT '{}',
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (id) REFERENCES memories (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subjects_kind ON subjects (kind, status);`;
const ALTER = "ALTER TABLE devices ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 1 CHECK (allow_private IN (0,1));";

/** @template {{exec: (sql: string) => Promise<any>, prepare: (sql: string) => any}} D @param {D} db @returns {Promise<D>} the same database */
export async function ensureSubjectsSchema(db) {
  await db.exec(SQL);
  const columns = (await db.prepare("PRAGMA table_info(devices)").all()).results;
  if (!columns.some((c) => c.name === "allow_private")) await db.exec(ALTER);
  return db;
}
