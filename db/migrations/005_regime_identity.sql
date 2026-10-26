CREATE INDEX IF NOT EXISTS nox_history_event_identity
  ON nox_history_events(project_id,kind,id,event_time DESC);
