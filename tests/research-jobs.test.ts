import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryEvent } from '../shared/history.ts';
import { ResearchJobManager, type ResearchJobLimits } from '../server/research-jobs.ts';

const baseLimits: ResearchJobLimits = { maxConcurrent: 2, maxRecords: 100_000, maxRuntimeMs: 30_000, pageLimit: 50, pageTimeoutMs: 1_000 };

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
