/* Migration 0007. What the nightly brief step needs to know about a subject. member_hash is a hash of the members the brief was
   built from, so a changed member makes the subject a candidate for a rebuild. built_at is when the brief was last built, null
   until it is. stale_reason names the check a new brief failed, and is empty for a subject that is not stale. Additive only. */

ALTER TABLE subjects ADD COLUMN member_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE subjects ADD COLUMN built_at INTEGER;
ALTER TABLE subjects ADD COLUMN stale_reason TEXT NOT NULL DEFAULT '';
