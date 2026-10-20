/* Migration 0005. A link records who made it and how sure the system was, and a link the user turned down is remembered
   so the system never makes it again. Existing links are the user's own. See db/schema.sql. */

ALTER TABLE links ADD COLUMN made_by TEXT NOT NULL DEFAULT 'user' CHECK (made_by IN ('user','system'));
ALTER TABLE links ADD COLUMN confidence REAL;

CREATE TABLE IF NOT EXISTS link_rejections (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL, link_type TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, link_type)
) WITHOUT ROWID;
