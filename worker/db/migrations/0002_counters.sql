-- Migration 0002. Daily counters for the write path and extract. See db/schema.sql.

CREATE TABLE IF NOT EXISTS counters (
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, day)
) WITHOUT ROWID;
