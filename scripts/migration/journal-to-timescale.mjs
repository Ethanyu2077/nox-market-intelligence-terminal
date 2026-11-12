#!/usr/bin/env node
/**
 * Journal -> Timescale migration. Dry-run by default; --apply requires an explicit
 * target identity and (for production) a separate acknowledgement.
 *
 *   node scripts/migration/journal-to-timescale.mjs --data-dir=.data --target=test
 *   DATABASE_URL=... MIGRATION_EXPECTED_DB=nox_test MIGRATION_ALLOW_WRITES=1 \
 *     node ... --data-dir=.data --target=test --apply
 *
 * Safety: fingerprint and verify immutable blocks before import, atomic per-batch
 * checkpoint, idempotent inserts, no journal deletion.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { journalSegments, journalBytes } from '../../server/journal-archive.ts';
import { fingerprint, verifiedBlocks } from './lib/verified-blocks.mjs';
import { TimescaleRetention } from '../../server/timescale-retention.ts';
import path from 'node:path';
import readline from 'node:readline';
import { canonicalJson, evaluateTarget, reconcileIds, readCheckpoint, writeCheckpointAtomic } from './lib/migration-safety.mjs';

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || '1']; }));
const dataDir = args.get('data-dir') ?? 'data';
const journalDir = path.join(dataDir, 'history');
const target = args.get('target');
const apply = args.has('apply');
const batchSize = Math.max(50, Number(args.get('batch-size') ?? 500));
const checkpointPath = path.join(dataDir, 'migration-checkpoint.json');
const databaseUrl = process.env.DATABASE_URL;
const commitSha = process.env.NOX_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown';

async function journalHash(item) {
  const hash = createHash('sha256');
  for await (const chunk of journalBytes(item)) hash.update(chunk);
  return hash.digest('hex');
}

const list = () => journalSegments(journalDir, name => name.endsWith('.ndjson'));
const sources = await list().catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const sourceFiles = sources.map(item => item.key);
const sourceMeta = {}, byKey = new Map(sources.map(item => [item.key, item]));
for (const item of sources) {
  sourceMeta[item.key] = { size: item.size, mtimeMs: item.mtimeMs, ...await fingerprint(journalBytes(item)) };
}

if (apply && process.env.MIGRATION_ALLOW_WRITES !== '1') { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'set MIGRATION_ALLOW_WRITES=1' })); process.exit(2); }
if (apply && !databaseUrl) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'DATABASE_URL is required' })); process.exit(2); }

const retention = new TimescaleRetention();
let pool = null, storeId = null;
if (apply) {
  const pg = await import('pg');
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  const identity = (await pool.query('SELECT current_database() AS db')).rows[0]?.db;
  const verdict = evaluateTarget({ target, expectedDb: process.env.MIGRATION_EXPECTED_DB, actualDb: identity, productionAck: process.env.MIGRATION_PRODUCTION_ACK });
  if (!verdict.ok) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: verdict.reason })); await pool.end(); process.exit(2); }
  const table = await pool.query("SELECT to_regclass('public.nox_history_events') AS name");
  if (!table.rows[0]?.name) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'nox_history_events missing; run db/migrations/003_history.sql' })); await pool.end(); process.exit(2); }
  storeId = (await pool.query('SELECT store_id FROM nox_history_storage_meta WHERE singleton')).rows[0]?.store_id;
  if (!storeId) throw new Error('Missing database store identity');
  // Migration may admit or pause writes; only the running service reclaims chunks.
  await retention.check(pool, storeId, false);

}

const checkpoint = await readCheckpoint(checkpointPath) ?? { version: 2, committed: 0, files: {} };
// Older checkpoints referred to the plain daily filename. Its original byte stream
// keeps the same digest after rotation; a new late-arrival tail has a different key.
for (const item of sources) {
  const saved = checkpoint.files?.[item.name];
  if (item.key !== item.name && saved?.sha256 === sourceMeta[item.key].sha256) {
    checkpoint.files[item.key] = saved;
    delete checkpoint.files[item.name];
  }
}
const report = {
  generatedAt: new Date().toISOString(), dryRun: !apply, apply, target, commitSha,
  files: [], totals: { sourceRecords: 0, inserted: 0, duplicates: 0, expired: 0, malformed: 0, missing: 0 },
  timeRange: { eventFrom: null, eventTo: null, ingestFrom: null, ingestTo: null },
  status: 'INSPECTED',
};
if (checkpoint?.committed) report.resumedFrom = checkpoint.committed;

for (const file of sourceFiles) {
  const source = byKey.get(file);
  const resume = checkpoint?.files?.[file];
  if (resume && resume.sha256 !== sourceMeta[file].sha256) {
    report.files.push({ file, status: 'ABORTED', reason: 'source changed since checkpoint' });
    report.status = 'FAILED';
    break;
  }
  const skipLines = resume?.lines ?? 0;
  let lineNo = 0, lines = 0, malformed = 0, duplicates = 0, inserted = 0, expired = 0, seen = new Set(), batch = [], batchBytes = 0, batchLineNo = skipLines;
  let missing = 0, payloadMismatch = 0;
  const flush = async () => {
    if (!pool || !batch.length) { batch = []; return; }
    await retention.check(pool, storeId, false);
    const accepted = batch.filter(event => !retention.expired(event.eventTime));
    expired += batch.length - accepted.length;
    batch = accepted;
    let stored = 0;
    if (batch.length) {
      retention.checkBatchSize(batchBytes);
      const params = batch.flatMap((event) => [event.id, event.kind, event.marketKey, event.projectId, new Date(event.eventTime), new Date(event.ingestTime), event.source, event.quality, event.payload]);
      const values = batch.map((_, i) => `($${i * 9 + 1},$${i * 9 + 2},$${i * 9 + 3},$${i * 9 + 4},$${i * 9 + 5},$${i * 9 + 6},$${i * 9 + 7},$${i * 9 + 8},$${i * 9 + 9})`).join(',');
      const result = await pool.query(`INSERT INTO nox_history_events (id,kind,market_key,project_id,event_time,ingest_time,source,quality,payload) VALUES ${values} ON CONFLICT (event_time,id) DO NOTHING`, params);
      inserted += result.rowCount ?? 0;
      const ids = batch.map((event) => event.id);
      const times = batch.map((event) => new Date(event.eventTime));
      const found = await pool.query('SELECT e.id FROM nox_history_events e JOIN unnest($1::timestamptz[], $2::text[]) AS x(event_time,id) ON e.event_time=x.event_time AND e.id=x.id', [times, ids]);
      const reconciled = reconcileIds(ids, found.rows.map((row) => row.id));
      missing += reconciled.missing;
      const sample = batch[0];
      const sampleRow = await pool.query('SELECT payload FROM nox_history_events WHERE event_time=$1 AND id=$2', [new Date(sample.eventTime), sample.id]);
      if (sampleRow.rowCount && canonicalJson(sampleRow.rows[0].payload) !== canonicalJson(sample.payload)) payloadMismatch += 1;
      stored = result.rowCount ?? 0;
      retention.recordBatch(batchBytes, batch.length);
    }
    batch = [];
    batchBytes = 0;
    // Per-batch checkpoint: only after the transaction committed and was verified.
    const next = checkpoint;
    next.version = 2;
    next.files[file] = { sha256: sourceMeta[file].sha256, size: sourceMeta[file].size, mtimeMs: sourceMeta[file].mtimeMs, lines: batchLineNo, records: lines, updatedAt: Date.now() };
    next.committed = (next.committed ?? 0) + stored;
    await writeCheckpointAtomic(checkpointPath, next);
  };
  const rl = readline.createInterface({ input: Readable.from(verifiedBlocks(journalBytes(source), sourceMeta[file].digests)), crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo += 1;
    if (lineNo <= skipLines) continue;
    if (!line.trim()) continue;
    let event;
    try { const parsed = JSON.parse(line); event = parsed.event ?? parsed; } catch { malformed += 1; continue; }
    if (!event?.id || !Number.isFinite(event.eventTime) || !Number.isFinite(event.ingestTime)) { malformed += 1; continue; }
    lines += 1;
    const key = `${event.eventTime}:${event.id}`;
    if (seen.has(key)) duplicates += 1; else seen.add(key);
    report.timeRange.eventFrom = report.timeRange.eventFrom == null ? event.eventTime : Math.min(report.timeRange.eventFrom, event.eventTime);
    report.timeRange.eventTo = report.timeRange.eventTo == null ? event.eventTime : Math.max(report.timeRange.eventTo, event.eventTime);
    report.timeRange.ingestFrom = report.timeRange.ingestFrom == null ? event.ingestTime : Math.min(report.timeRange.ingestFrom, event.ingestTime);
    report.timeRange.ingestTo = report.timeRange.ingestTo == null ? event.ingestTime : Math.max(report.timeRange.ingestTo, event.ingestTime);
    if (apply) { batch.push(event); batchBytes += Buffer.byteLength(line) + 1; if (batch.length >= batchSize || batchBytes >= retention.batchBytes) { batchLineNo = lineNo; await flush(); } }
  }
  if (apply && batch.length) { batchLineNo = lineNo; await flush(); }
  // Source must be unchanged after reading; otherwise the migration is invalid.
  const current = (await list()).find(item => item.identity === source.identity && item.name === source.name && (source.birth === undefined || item.birth === undefined || item.birth === source.birth) && (source.key === source.name || item.key === source.key));
  const after = current && await journalHash(current);
  const changed = after !== sourceMeta[file].sha256;
  report.files.push({ file, sha256: sourceMeta[file].sha256, lines, malformed, duplicates, expired, inserted, missing, payloadMismatch, sourceChanged: changed, resumedFromLine: skipLines });
  report.totals.expired += expired; report.totals.sourceRecords += lines; report.totals.inserted += inserted; report.totals.duplicates += duplicates; report.totals.malformed += malformed; report.totals.missing += missing;
  report.totals.payloadMismatch = (report.totals.payloadMismatch ?? 0) + payloadMismatch;
  if (changed) { report.status = 'FAILED'; report.reason = `source changed during migration: ${file}`; break; }
}

if (pool) {
  const count = await pool.query('SELECT count(*)::int AS n FROM nox_history_events');
  report.databaseRows = count.rows[0].n;
  await pool.end();
}
report.reconciliation = {
  sourceRecords: report.totals.sourceRecords, targetRows: report.databaseRows ?? null,
  inserted: report.totals.inserted, duplicates: report.totals.duplicates, malformed: report.totals.malformed,
  missingEventIds: report.totals.missing, payloadMismatch: report.totals.payloadMismatch ?? 0,
  eventRange: { from: report.timeRange.eventFrom, to: report.timeRange.eventTo },
  ingestRange: { from: report.timeRange.ingestFrom, to: report.timeRange.ingestTo },
  sourceSha256: Object.fromEntries(Object.entries(sourceMeta).map(([file, meta]) => [file, meta.sha256])),
  commitSha,
};
if (report.status !== 'FAILED') report.status = report.totals.malformed === 0 && report.totals.missing === 0 && (report.totals.payloadMismatch ?? 0) === 0 ? (apply ? 'APPLIED' : 'INSPECTED') : 'PARTIAL';
console.log(JSON.stringify(report, null, 2));
