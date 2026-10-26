export function historyPolicy(compressionDays = 0, retentionDays = 0) {
  for (const days of [compressionDays, retentionDays])
    if (!Number.isInteger(days) || days < 0 || days > 36500)
      throw new Error("Policy days must be integers between 0 and 36500");
  if (compressionDays && retentionDays && retentionDays <= compressionDays)
    throw new Error("Retention must exceed compression age");
  const statements: Array<{ sql: string; values: number[] }> = [];
  if (compressionDays) {
    statements.push({
      sql: "ALTER TABLE nox_history_events SET (timescaledb.compress, timescaledb.compress_segmentby='kind,market_key', timescaledb.compress_orderby='event_time DESC')",
      values: [],
    });
    statements.push({
      sql: "SELECT add_compression_policy('nox_history_events',compress_after=>make_interval(days=>$1))",
      values: [compressionDays],
    });
  }
  if (retentionDays)
    statements.push({
      sql: "SELECT add_retention_policy('nox_history_events',drop_after=>make_interval(days=>$1))",
      values: [retentionDays],
    });
  return {
    statements,
    destructive: retentionDays > 0,
    compressionDays,
    retentionDays,
  };
}
