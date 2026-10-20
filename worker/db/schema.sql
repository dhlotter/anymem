-- The full anymem v2 schema. Migrations 0001 to 0006 together create exactly this.
-- Times are milliseconds since the epoch. Tags are lowercase. A live memory has deleted_at and valid_until both null.
-- The Worker never applies schema on a request, worker/migrate.js does.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  type TEXT CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  body TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('canonical', 'active', 'deprecated', 'pending')),
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'capture', 'import', 'profile', 'person', 'system')),
  harness TEXT NOT NULL DEFAULT '',
  session TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  kind TEXT CHECK (kind IN ('semantic', 'episodic')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  probation_until INTEGER,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  superseded_by TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories (content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_name ON memories (name);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
CREATE INDEX IF NOT EXISTS idx_memories_origin ON memories (origin);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at);
CREATE INDEX IF NOT EXISTS idx_memories_deleted_at ON memories (deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories (valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_probation ON memories (probation_until) WHERE probation_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags (tag, memory_id);

CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (memory_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_reason ON memory_versions (reason, created_at);

CREATE TABLE IF NOT EXISTS memory_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK (key_type IN ('chunk', 'description', 'question')),
  position INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  vector_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_keys_memory ON memory_keys (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_keys_unvectorized ON memory_keys (memory_id) WHERE vector_id IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  memory_id UNINDEXED,
  name,
  description,
  body,
  keys,
  tokenize = 'trigram'
);

-- made_by and confidence are on the created_at line because that is where ALTER TABLE ADD COLUMN puts them in migration 0005.
CREATE TABLE IF NOT EXISTS links (
  source_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  created_at INTEGER NOT NULL, made_by TEXT NOT NULL DEFAULT 'user' CHECK (made_by IN ('user','system')), confidence REAL,
  PRIMARY KEY (source_id, target_id, link_type)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_id);

-- A link the user turned down, so the system never makes it again.
CREATE TABLE IF NOT EXISTS link_rejections (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL, link_type TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, link_type)
) WITHOUT ROWID;

-- A subject is a thing memories are about. Its card is an ordinary memory (id is the card memory id) that holds the brief.
-- A memory is a member when an about link runs from it to the card. fields is JSON {key: {value, confirmed_at, source}}, aliases a JSON list.
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

-- allow_private is last and on its own line because that is where ALTER TABLE ADD COLUMN puts it in migration 0006.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
, allow_private INTEGER NOT NULL DEFAULT 1 CHECK (allow_private IN (0,1)));

CREATE TABLE IF NOT EXISTS capsule_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  etag TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER CHECK (ok IN (0, 1)),
  summary TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_job_started ON runs (job, started_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  memory_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit (actor_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_route ON audit (route, ts);

CREATE TABLE IF NOT EXISTS write_counter (
  token_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  writes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, window_start)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS counters (
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS recall_log (
  ts INTEGER NOT NULL,
  harness TEXT NOT NULL DEFAULT '',
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recall_log_memory ON recall_log (memory_id, ts);
CREATE INDEX IF NOT EXISTS idx_recall_log_ts ON recall_log (ts);
