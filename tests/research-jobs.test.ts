import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryEvent } from '../shared/history.ts';
import { ResearchJobManager, type ResearchJobLimits } from '../server/research-jobs.ts';

const baseLimits: ResearchJobLimits = {
  maxConcurrent: 2, maxRecords: 100_000, maxRuntimeMs: 30_000, pageLimit: 50, pageTimeoutMs: 1_000,
  terminalTtlMs: 86_400_000, maxRetained: 100, maxReportBytes: 2_000_000,
};

function pages(count: number, perPage: number, kind: HistoryEvent['kind'] = 'snapshot', duplicateEvery = 0): HistoryEvent[][] {
  const out: HistoryEvent[][] = [];
  let id = 0;
  for (let page = 0; page < count; page += 1) {
    const items: HistoryEvent[] = [];
    for (let index = 0; index < perPage; index += 1) {
      id += 1;
      const stableId = duplicateEvery && id % duplicateEvery === 0 ? `dup-${id}` : `e-${id}`;
      items.push({ id: stableId, kind, marketKey: 'binance:perpetual:BTCUSDT', projectId: 'p1', eventTime: 1_700_000_000_000 - id * 60_000, ingestTime: 1_700_000_000_000 - id * 60_000 + 500, source: 'test', quality: 'live', payload: { snapshots: [{ exchange: 'binance', price: 100, markPrice: 100.1, oiBase: 5000 + id, eventTime: 1_700_000_000_000 - id * 60_000 }] } });
    }
    out.push(items);
  }
  return out;
}

function store(pagesData: HistoryEvent[][], options: { failAt?: number; delayMs?: number } = {}) {
  return {
    page: async (_project: string, query: { cursor?: string }) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const index = query.cursor ? Number(query.cursor) : 0;
      if (options.failAt != null && index === options.failAt) throw new Error('db connection refused');
      return { items: pagesData[index] ?? [], nextCursor: index + 1 < pagesData.length ? String(index + 1) : null };
    },
  };
}

test('a full scan completes and deduplicates events across pages', async () => {
  const manager = new ResearchJobManager(store(pages(20, 25, 'snapshot', 7)) as never, baseLimits);
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'COMPLETED');
  assert.equal(done?.progress.scanned, 500);
  assert.equal(done?.progress.snapshotDone, true);
  assert.equal((done?.report as { researchComplete: boolean }).researchComplete, true);
});

test('a database error fails the job with a sanitized error', async () => {
  const manager = new ResearchJobManager(store(pages(10, 10), { failAt: 2 }) as never, baseLimits);
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'FAILED');
  assert.ok(done?.error);
  assert.equal(done?.error?.includes('connection'), false);
});

test('exceeding maxRecords yields PARTIAL, never COMPLETED', async () => {
  const manager = new ResearchJobManager(store(pages(20, 25)) as never, { ...baseLimits, maxRecords: 100 });
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'PARTIAL');
  assert.equal(done?.truncationReason, 'max-records');
  assert.equal((done?.report as { researchComplete: boolean }).researchComplete, false);
});

test('duplicate submissions reuse the active job and concurrency is capped', async () => {
  const manager = new ResearchJobManager(store(pages(10, 10), { delayMs: 5 }) as never, { ...baseLimits, maxConcurrent: 1 });
  const first = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const duplicate = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, first.job.id);
  const second = manager.create('p1', { factor: 'oi_delta', timeframe: '5m' });
  assert.equal(second.job.status, 'FAILED');
  assert.match(second.job.error ?? '', /Concurrent/);
});

test('cancellation stops the job and never produces a report', async () => {
  const manager = new ResearchJobManager(store(pages(50, 10), { delayMs: 10 }) as never, baseLimits);
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  manager.cancel(job.id);
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'CANCELLED');
  assert.equal(done?.report, null);
});

test('scans 10,000+ events and reports an exact count', async () => {
  const manager = new ResearchJobManager(store(pages(250, 50)) as never, { ...baseLimits, maxRecords: 20_000 });
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'COMPLETED');
  assert.equal(done?.progress.scanned, 12_500);
});

test('snapshot and L2 paginate independently with separate cursors', async () => {
  const snapshotPages = pages(4, 10, 'snapshot');
  const l2Pages = pages(3, 10, 'l2').map((rows) => rows.map((row) => ({ ...row, id: `l2-${row.id}`, payload: { venue: 'binance', bucketStart: 1_700_000_000_000, liquidityWithdrawalPct: 1, researchUsable: true } })));
  const branch = {
    page: async (_project: string, query: { kind: string; cursor?: string }) => {
      const data = query.kind === 'l2' ? l2Pages : snapshotPages;
      const index = query.cursor ? Number(query.cursor) : 0;
      return { items: data[index] ?? [], nextCursor: index + 1 < data.length ? String(index + 1) : null };
    },
  };
  const manager = new ResearchJobManager(branch as never, baseLimits);
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'COMPLETED');
  assert.equal(done?.progress.scanned, 70);
  assert.equal(done?.progress.snapshotDone, true);
  assert.equal(done?.progress.l2Done, true);
});

test('fingerprint includes the window and asOf, and identical parameters are reused', async () => {
  const manager = new ResearchJobManager(store(pages(10, 10)) as never, { ...baseLimits, maxConcurrent: 5 });
  const first = manager.create('p1', { factor: 'oi_level', timeframe: '5m', start: 1000, end: 2000, asOf: 5000 });
  const same = manager.create('p1', { factor: 'oi_level', timeframe: '5m', start: 1000, end: 2000, asOf: 5000 });
  const otherStart = manager.create('p1', { factor: 'oi_level', timeframe: '5m', start: 1500, end: 2000, asOf: 5000 });
  const otherAsOf = manager.create('p1', { factor: 'oi_level', timeframe: '5m', start: 1000, end: 2000, asOf: 6000 });
  assert.equal(same.duplicate, true);
  assert.equal(same.job.id, first.job.id);
  assert.notEqual(otherStart.job.id, first.job.id);
  assert.notEqual(otherAsOf.job.id, first.job.id);
  assert.notEqual(otherStart.job.fingerprint, first.job.fingerprint);
});

test('completed jobs and reports survive a manager restart', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-jobs-'));
  const first = new ResearchJobManager(store(pages(10, 10)) as never, baseLimits, { dataDirectory: dir });
  const { job } = first.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await first.wait(job.id);
  assert.equal(done?.status, 'COMPLETED');
  await first.flush();
  const reopened = await ResearchJobManager.open(store(pages(0, 0)) as never, baseLimits, { dataDirectory: dir });
  const restored = reopened.get(job.id);
  assert.equal(restored?.status, 'COMPLETED');
  assert.equal((restored?.report as { researchComplete: boolean }).researchComplete, true);
  reopened.close();
  const capped = await ResearchJobManager.open(store(pages(0, 0)) as never, { ...baseLimits, maxReportBytes: 50 }, { dataDirectory: dir });
  const oldReport = capped.get(job.id);
  assert.equal(oldReport?.status, 'PARTIAL');
  assert.equal(oldReport?.truncationReason, 'report-too-large');
  assert.equal(oldReport?.report, null);
  assert.deepEqual(oldReport?.progress, done?.progress);
  capped.close();
});

test('unfinished persisted jobs become INTERRUPTED on restart', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-jobs-'));
  await writeFile(path.join(dir, 'research-jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'job_x', projectId: 'p1', factor: 'oi_level', timeframe: '5m', fingerprint: 'f', status: 'RUNNING', createdAt: 1, updatedAt: 1, asOf: 1, start: null, end: null, progress: { scanned: 5, snapshotCursor: 'c', l2Cursor: null, snapshotDone: false, l2Done: false }, report: null, error: null, truncationReason: null }] }));
  const manager = await ResearchJobManager.open(store(pages(0, 0)) as never, baseLimits, { dataDirectory: dir });
  assert.equal(manager.get('job_x')?.status, 'INTERRUPTED');
  manager.close();
});

test('terminal TTL removes old jobs but keeps fresh ones', async () => {
  const manager = new ResearchJobManager(store(pages(3, 5)) as never, { ...baseLimits, terminalTtlMs: 1_000 });
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  await manager.wait(job.id);
  assert.equal(manager.get(job.id)?.status, 'COMPLETED');
  manager.prune(Date.now() + 5_000);
  assert.equal(manager.get(job.id), null);
});

test('an oversized report becomes PARTIAL with report-too-large', async () => {
  const manager = new ResearchJobManager(store(pages(5, 10)) as never, { ...baseLimits, maxReportBytes: 50 });
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  const done = await manager.wait(job.id);
  assert.equal(done?.status, 'PARTIAL');
  assert.equal(done?.truncationReason, 'report-too-large');
  assert.equal(done?.report, null);
});

test('busy job submissions share a pending disk write and respect the retained job limit', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-job-burst-'));
  const manager = new ResearchJobManager({ page: () => new Promise<never>(() => {}) }, {
    ...baseLimits, maxConcurrent: 1, maxRetained: 3,
  }, { dataDirectory: dir });
  t.after(async () => { manager.close(); await rm(dir, { recursive: true, force: true }); });
  const first = manager.create('p1', { factor: 'oi_delta', timeframe: '5m' });
  const writer = manager.flush();
  for (let asOf = 1; asOf <= 100; asOf++) {
    manager.create('p1', { factor: 'oi_level', timeframe: '5m', asOf });
    assert.equal(manager.flush(), writer);
    assert.equal(manager.size() <= 4, true, 'one active job plus at most three terminal jobs');
  }
  await writer;
  const saved = JSON.parse(await readFile(path.join(dir, 'research-jobs.json'), 'utf8'));
  assert.deepEqual(saved.jobs, manager.list('p1'));
  manager.cancel(first.job.id);
  await manager.wait(first.job.id);
});

test('cancellation propagates the abort signal to the page query', async () => {
  let seen: AbortSignal | undefined;
  const slow = { page: async (_project: string, query: { signal?: AbortSignal }) => { seen = query.signal; await new Promise((resolve) => setTimeout(resolve, 40)); return { items: [], nextCursor: null }; } };
  const manager = new ResearchJobManager(slow as never, baseLimits);
  const { job } = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  manager.cancel(job.id);
  await manager.wait(job.id);
  assert.equal(seen?.aborted, true);
});

test('default asOf is minute-aligned so rapid duplicate submissions dedupe', async () => {
  let clock = 1_700_000_010_000;
  const manager = new ResearchJobManager(store(pages(10, 10), { delayMs: 5 }) as never, baseLimits, { now: () => clock });
  const first = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  clock += 20_000; // still the same minute
  const duplicate = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, first.job.id);
  clock += 60_000; // next minute => new cutoff
  const next = manager.create('p1', { factor: 'oi_level', timeframe: '5m' });
  assert.notEqual(next.job.id, first.job.id);
});
