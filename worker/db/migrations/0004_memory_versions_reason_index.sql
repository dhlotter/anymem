/* Migration 0004. The dashboard's Home and Activity read memory_versions by reason and time, which had no index, so each load scanned the table twice.
   See db/schema.sql. */

CREATE INDEX IF NOT EXISTS idx_memory_versions_reason ON memory_versions (reason, created_at);
