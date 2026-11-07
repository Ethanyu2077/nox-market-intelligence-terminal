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
import { evaluateRestart } from './lib/restart.mjs';
import { isWritableDatabase } from './lib/db-safety.mjs';
import { authorizedGet, credentialsFromEnv } from './lib/api-session.mjs';

const url = process.env.DATABASE_URL;
let allowWrites = false;
const status = { read: 'NOT VERIFIED', write: 'NOT VERIFIED', connectionRecovery: 'NOT VERIFIED', processRestartRecovery: 'NOT VERIFIED' };
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
  const identity = await pool.query('SELECT current_database() AS name');
  const safety = isWritableDatabase({ allowWrites: process.env.ACCEPTANCE_ALLOW_WRITES === '1', expectedName: process.env.ACCEPTANCE_TEST_DB_NAME, actualName: identity.rows[0]?.name });
  allowWrites = safety.ok;
  details.database = { name: identity.rows[0]?.name ?? null, writeAllowed: allowWrites };

  if (!allowWrites) {
    details.write = safety.reason;
    details.connectionRecovery = details.write;
    details.processRestartRecovery = details.write;
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

  // Connection recovery: a new pool in the same process. This is NOT a service restart.
  await pool.end();
  const fresh = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    const after = await fresh.query('SELECT id, event_time, payload FROM nox_history_events WHERE source=$1 ORDER BY event_time', [source]);
    const recovered = after.rows.length === 2 && after.rows.every((row, index) => row.id === events[index].id && Number(row.payload.price) === events[index].payload.price);
    status.connectionRecovery = recovered ? 'PASS' : 'FAIL';
    details.connectionRecovery = { rows: after.rows.length, idsIntact: recovered, via: 'new connection pool' };
  } finally { await fresh.end(); }

  // Process restart recovery: requires an authorized restart command, an API base for
  // process identity and read-back, and a healthy API after the restart.
  const apiBase = process.env.NOX_API_URL;
  const restart = process.env.ACCEPTANCE_RESTART_CMD;
  if (!restart || !apiBase) {
    status.processRestartRecovery = 'NOT VERIFIED';
    details.processRestartRecovery = 'requires NOX_API_URL and ACCEPTANCE_RESTART_CMD; connection recovery is not a process restart';
  } else {
    const credentials = credentialsFromEnv();
    const apiJson = async (path) => {
      // One 401 re-authentication is handled inside authorizedGet; 403 is never retried.
      const result = await authorizedGet(apiBase, path, credentials);
      if (!result.ok) throw new Error(result.reason ?? `HTTP ${result.status}`);
      return result.data;
    };
    let identityBefore = null, idsBefore = [], restartOk = false, readyAfter = false;
    let identityAfter = null, idsAfter = [], apiReadAvailable = false;
    try {
      identityBefore = (await apiJson('/api/operations')).process?.startedAt ?? null;
      idsBefore = ((await apiJson(`/api/acceptance/records?source=${encodeURIComponent(source)}`)).items ?? []).map((item) => item.id);
    } catch (error) { details.preRestartRead = error instanceof Error ? error.message : 'API read failed'; }

    try { execSync(restart, { stdio: 'inherit', timeout: 60_000 }); restartOk = true; }
    catch (error) { restartOk = false; details.restart = error instanceof Error ? error.message : 'restart failed'; }

    for (let attempt = 0; attempt < 20 && !readyAfter; attempt += 1) {
      try { await apiJson('/api/health'); readyAfter = true; } catch { await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    }
    if (readyAfter) {
      try {
        identityAfter = (await apiJson('/api/operations')).process?.startedAt ?? null;
        idsAfter = ((await apiJson(`/api/acceptance/records?source=${encodeURIComponent(source)}`)).items ?? []).map((item) => item.id);
        apiReadAvailable = true;
      } catch (error) { details.postRestartRead = error instanceof Error ? error.message : 'API read failed'; }
    }

    const decision = evaluateRestart({ restartAuthorized: Boolean(restart), restartOk, identityBefore, identityAfter, readyAfter, apiReadAvailable, idsBefore, idsAfter });
    status.processRestartRecovery = decision.status;
    details.processRestartRecovery = { ...decision, identityBefore, identityAfter, idsBefore: idsBefore.length, idsAfter: idsAfter.length };
  }
} catch (error) {
  details.error = error instanceof Error ? error.message : 'query failed';
} finally {
  try { const cleanup = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 }); await cleanup.query('DELETE FROM nox_history_events WHERE source=$1', [source]); await cleanup.end(); } catch { /* best effort */ }
  await pool.end().catch(() => undefined);
}
const allPass = status.read === 'PASS' && status.write === 'PASS' && status.connectionRecovery === 'PASS' && status.processRestartRecovery === 'PASS';
finish(allPass ? 'PASS' : 'NOT VERIFIED');
