-- A database restore or late outbox replay must not resurrect pressure-evicted chunks.
ALTER TABLE nox_history_storage_meta ADD COLUMN IF NOT EXISTS retained_from timestamptz;
