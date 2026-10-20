-- Migration 0003. One short row for every memory a counted recall returned, so the dashboard can say which tool used which memory.
-- No query text and no prompt is stored. The nightly job deletes rows older than 90 days. See db/schema.sql.

CREATE TABLE IF NOT EXISTS recall_log (
  ts INTEGER NOT NULL,
  harness TEXT NOT NULL DEFAULT '',
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recall_log_memory ON recall_log (memory_id, ts);
CREATE INDEX IF NOT EXISTS idx_recall_log_ts ON recall_log (ts);
