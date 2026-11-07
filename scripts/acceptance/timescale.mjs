#!/usr/bin/env node
/** Checks a disposable Timescale instance. Without DATABASE_URL it reports NOT VERIFIED. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.log(JSON.stringify({ status: 'NOT VERIFIED', reason: 'DATABASE_URL is not set; run against a disposable Timescale instance' }, null, 2));
  process.exit(0);
}
let Pool;
try { ({ Pool } = await import('pg')); }
catch { console.log(JSON.stringify({ status: 'NOT VERIFIED', reason: 'pg is not installed' })); process.exit(0); }
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
try {
  const table = await pool.query("SELECT to_regclass('public.nox_history_events') AS name");
  if (!table.rows[0]?.name) { console.log(JSON.stringify({ status: 'NOT VERIFIED', reason: 'nox_history_events is missing; run the migrations first' })); process.exit(0); }
  const count = await pool.query('SELECT count(*)::int AS n FROM nox_history_events');
  const latest = await pool.query('SELECT max(ingest_time) AS t FROM nox_history_events');
  console.log(JSON.stringify({ status: 'PASS', rows: count.rows[0].n, latestIngest: latest.rows[0].t }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'NOT VERIFIED', reason: error instanceof Error ? error.message : 'query failed' }, null, 2));
} finally { await pool.end(); }
