#!/usr/bin/env node
/**
 * TimescaleDB read / write / recovery acceptance.
 *
 * Writes only to a disposable database: DATABASE_URL must look like a test instance and
 * ACCEPTANCE_ALLOW_WRITES=1 must be set. Otherwise read is attempted and write/recovery
 * report NOT VERIFIED. Test rows use an isolated `acceptance:<namespace>` source and are
 * deleted at the end.
 */
import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
const allowWrites = process.env.ACCEPTANCE_ALLOW_WRITES === '1' && /(test|acceptance|tmp|ci)/i.test(url ?? '');
const status = { read: 'NOT VERIFIED', write: 'NOT VERIFIED', recovery: 'NOT VERIFIED' };
const details = {};
const finish = (overall) => {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), overall, status, details }, null, 2));
  process.exit(0);
};

if (!url) { details.read = 'DATABASE_URL is not set'; details.write = 'no disposable database'; details.recovery = 'no disposable database'; finish('NOT VERIFIED'); }

let Pool;
try { ({ Pool } = await import('pg')); }
catch { details.read = 'pg is not installed'; finish('NOT VERIFIED'); }

const namespace = `accept_${Date.now()}`;
const source = `acceptance:${namespace}`;
const events = [
  { id: `${namespace}-a`, kind: 'snapshot', marketKey: 'acceptance:perpetual:BTCUSDT', eventTime: Date.now() - 120_000, ingestTime: Date.now() - 119_000, payload: { price: 100, seq: 1 } },
  { id: `${namespace}-b`, kind: 'snapshot', marketKey: 'acceptance:perpetual:BTCUSDT', eventTime: Date.now() - 60_000, ingestTime: Date.now() - 59_000, payload: { price: 101, seq: 2 } },
];

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
try {
  const table = await pool.query("SELECT to_regclass('public.nox_history_events') AS name");
  if (!table.rows[0]?.name) { details.read = 'nox_history_events missing (run migrations)'; finish('NOT VERIFIED'); }
  const range = await pool.query('SELECT count(*)::int AS n FROM nox_history_events WHERE event_time >= now() - interval \'7 days\'');
  status.read = 'PASS'; details.read = { table: 'nox_history_events', last7d: range.rows[0].n };

  if (!allowWrites) {
    details.write = 'requires ACCEPTANCE_ALLOW_WRITES=1 and a disposable (test) DATABASE_URL';
    details.recovery = details.write;
    finish('NOT VERIFIED');
  }

  for (const event of events) {
    await pool.query(
      `INSERT INTO nox_history_events (id, kind, market_key, project_id, event_time, ingest_time, source, quality, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [event.id, event.kind, event.marketKey, 'acceptance', new Date(event.eventTime), new Date(event.ingestTime), source, 'live', event.payload],
    );
  }
  await pool.query(`INSERT INTO nox_history_events (id, kind, market_key, project_id, event_time, ingest_time, source, quality, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [events[0].id, 'snapshot', 'acceptance:perpetual:BTCUSDT', 'acceptance', new Date(events[0].eventTime), new Date(events[0].ingestTime), source, 'live', { price: 999 }]);
  const readBack = await pool.query('SELECT id, event_time, ingest_time, payload FROM nox_history_events WHERE source=$1 ORDER BY event_time', [source]);
  const ids = readBack.rows.map((row) => row.id);
  const intact = readBack.rows.length === 2
    && ids.join(',') === events.map((event) => event.id).join(',')
    && Number(readBack.rows[0].payload.price) === 100;
  status.write = intact ? 'PASS' : 'FAIL';
  details.write = { inserted: events.length, readBack: readBack.rows.length, duplicateSuppressed: readBack.rows.length === 2, payloadIntact: intact };

  // Recovery: close the pool (fresh connections) and optionally restart the service.
  await pool.end();
  if (process.env.ACCEPTANCE_RESTART_CMD) {
    try { execSync(process.env.ACCEPTANCE_RESTART_CMD, { stdio: 'inherit', timeout: 60_000 }); details.restart = 'command executed'; }
    catch (error) { details.restart = `command failed: ${error instanceof Error ? error.message : error}`; }
  } else details.restart = 'not executed (ACCEPTANCE_RESTART_CMD unset); recovery checks a fresh connection only';
  const fresh = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    const after = await fresh.query('SELECT id, event_time, payload FROM nox_history_events WHERE source=$1 ORDER BY event_time', [source]);
    const recovered = after.rows.length === 2 && after.rows.every((row, index) => row.id === events[index].id && Number(row.payload.price) === events[index].payload.price);
    status.recovery = recovered ? 'PASS' : 'FAIL';
    details.recovery = { rows: after.rows.length, idsIntact: recovered, via: details.restart };
  } finally { await fresh.end(); }
} catch (error) {
  details.error = error instanceof Error ? error.message : 'query failed';
} finally {
  try { const cleanup = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 }); await cleanup.query('DELETE FROM nox_history_events WHERE source=$1', [source]); await cleanup.end(); } catch { /* best effort */ }
  await pool.end().catch(() => undefined);
}
finish(status.read === 'PASS' && status.write === 'PASS' && status.recovery === 'PASS' ? 'PASS' : 'NOT VERIFIED');
