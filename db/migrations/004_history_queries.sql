-- Database identity prevents an old local checkpoint skipping data on a fresh database.
CREATE TABLE IF NOT EXISTS nox_history_storage_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  store_id uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO nox_history_storage_meta(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS nox_project_market_links (
  project_id text NOT NULL,
  market_key text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  PRIMARY KEY (project_id, market_key, valid_from)
);
CREATE INDEX IF NOT EXISTS nox_history_market_range
  ON nox_history_events(kind,market_key,event_time DESC,id COLLATE "C" DESC);
CREATE INDEX IF NOT EXISTS nox_history_project_range
  ON nox_history_events(project_id,kind,event_time DESC,id COLLATE "C" DESC);
CREATE INDEX IF NOT EXISTS nox_history_ingest_time ON nox_history_events(ingest_time DESC);
