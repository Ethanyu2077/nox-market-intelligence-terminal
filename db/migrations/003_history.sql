-- Apply with a database operator account. No credentials belong in the frontend.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS nox_history_events (
  id text NOT NULL, kind text NOT NULL, market_key text NOT NULL, project_id text,
  event_time timestamptz NOT NULL, ingest_time timestamptz NOT NULL,
  source text NOT NULL, quality text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (event_time, id)
);
SELECT create_hypertable('nox_history_events', 'event_time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS nox_history_project_time ON nox_history_events(project_id, kind, event_time DESC);
