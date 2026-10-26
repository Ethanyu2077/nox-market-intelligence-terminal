CREATE INDEX IF NOT EXISTS nox_regime_interval_research
  ON nox_history_events(project_id,source,(payload->>'interval'),event_time DESC)
  WHERE kind='regime';
