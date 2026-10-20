/* Migration 0006. A subject is a thing memories are about. Its card is an ordinary memory that holds the brief, and a row here holds
   the kind, status, scope, fields and aliases. A memory is a member of a subject when an about link runs from it to the card.
   A device can also be kept away from private subjects. See db/schema.sql. */

CREATE TABLE IF NOT EXISTS subjects (
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
CREATE INDEX IF NOT EXISTS idx_subjects_kind ON subjects (kind, status);

ALTER TABLE devices ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 1 CHECK (allow_private IN (0,1));
