#!/usr/bin/env node
/**
 * Journal -> Timescale migration tool. Dry-run by default.
 *
 *   node scripts/migration/journal-to-timescale.mjs --data-dir <dir> [--apply --allow-writes]
 *
 * Safety:
 *  - never deletes or truncates the journal;
 *  - --apply also requires MIGRATION_ALLOW_WRITES=1 and DATABASE_URL;
 *  - inserts are idempotent (ON CONFLICT (event_time,id) DO NOTHING);
 *  - checkpoint is bound to the file SHA256, so a changed journal aborts instead of skewing.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || '1']; }));
const dataDir = args.get('data-dir') ?? 'data';
const journalDir = path.join(dataDir, 'history');
const apply = args.has('apply');
const allowWrites = process.env.MIGRATION_ALLOW_WRITES === '1';
const batchSize = Math.max(50, Number(args.get('batch-size') ?? 500));
const checkpointPath = path.join(dataDir, 'migration-checkpoint.json');
const databaseUrl = process.env.DATABASE_URL;

if (apply && !allowWrites) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'set MIGRATION_ALLOW_WRITES=1 to write' })); process.exit(2); }
if (apply && !databaseUrl) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'DATABASE_URL is required for --apply' })); process.exit(2); }

const files = (await readdir(journalDir).catch(() => [])).filter((name) => name.endsWith('.ndjson')).sort();
let checkpoint = null;
try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch { /* first run */ }

let pool = null;
if (apply) {
  const pg = await import('pg');
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  const table = await pool.query("SELECT to_regclass('public.nox_history_events') AS name");
  if (!table.rows[0]?.name) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'nox_history_events is missing; run db/migrations/003_history.sql' })); await pool.end(); process.exit(2); }
}

const report = { generatedAt: new Date().toISOString(), apply, dryRun: !apply, files: [], totals: { lines: 0, records: 0, malformed: 0, duplicates: 0, inserted: 0 }, status: 'PARTIAL' };
for (const file of files) {
  const full = path.join(journalDir, file);
  const hash = createHash('sha256');
  const stream = createReadStream(full);
  stream.on('data', (chunk) => hash.update(chunk));
  await new Promise((resolve) => stream.on('end', resolve).on('error', resolve));
  const sha = hash.digest('hex');
  const resume = checkpoint?.files?.[file];
  if (resume && resume.sha256 !== sha) {
    report.files.push({ file, status: 'ABORTED', reason: 'journal changed since checkpoint' });
    await pool?.end();
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  const skipLines = resume?.lines ?? 0;
  let lineNo = 0, lines = 0, malformed = 0, seen = new Set(), duplicates = 0, inserted = 0, batch = [];
  const rl = readline.createInterface({ input: createReadStream(full), crlfDelay: Infinity });
  const flush = async () => {
    if (!pool || !batch.length) { batch = []; return; }
    const values = batch.map((event, index) => `($${index * 9 + 1},$${index * 9 + 2},$${index * 9 + 3},$${index * 9 + 4},$${index * 9 + 5},$${index * 9 + 6},$${index * 9 + 7},$${index * 9 + 8},$${index * 9 + 9})`).join(',');
    const params = batch.flatMap((event) => [event.id, event.kind, event.marketKey, event.projectId, new Date(event.eventTime), new Date(event.ingestTime), event.source, event.quality, event.payload]);
    const result = await pool.query(`INSERT INTO nox_history_events (id,kind,market_key,project_id,event_time,ingest_time,source,quality,payload) VALUES ${values} ON CONFLICT (event_time,id) DO NOTHING`, params);
    inserted += result.rowCount ?? 0;
    batch = [];
  };
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
    if (apply) { batch.push(event); if (batch.length >= batchSize) await flush(); }
  }
  await flush();
  report.files.push({ file, sha256: sha, lines, malformed, duplicates, inserted, resumedFromLine: skipLines });
  report.totals.lines += lines; report.totals.records += lines; report.totals.malformed += malformed; report.totals.duplicates += duplicates; report.totals.inserted += inserted;
  if (apply) {
    checkpoint = checkpoint ?? { version: 1, files: {} };
    checkpoint.files[file] = { sha256: sha, lines: lineNo, records: lines, updatedAt: Date.now() };
    await mkdir(dataDir, { recursive: true });
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  }
}
if (pool) {
  const count = await pool.query('SELECT count(*)::int AS n FROM nox_history_events');
  report.databaseRows = count.rows[0].n;
  await pool.end();
}
report.status = report.totals.malformed === 0 ? (apply ? 'APPLIED' : 'INSPECTED') : 'PARTIAL';
console.log(JSON.stringify(report, null, 2));
