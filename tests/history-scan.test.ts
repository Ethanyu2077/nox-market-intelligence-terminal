import assert from 'node:assert/strict';
import test from 'node:test';
import { scanHistory } from '../server/history-scan.ts';
import type { HistoryEvent } from '../shared/history.ts';

const event = (id: string, time: number): HistoryEvent => ({ id, kind: 'snapshot', marketKey: 'binance:perpetual:BTCUSDT', projectId: 'p1', eventTime: time, ingestTime: time, source: 'test', quality: 'live', payload: {} });

function pager(pages: Array<{ items: HistoryEvent[]; nextCursor: string | null }>) {
  let index = 0;
  return { page: async () => pages[index++] ?? { items: [], nextCursor: null } };
}

test('reaching maxRecords mid-page still processes the whole page and resumes after it', async () => {
  const pages = [
    { items: [event('a', 300), event('b', 300), event('c', 200)], nextCursor: 'c1' },
    { items: [event('d', 100)], nextCursor: null },
  ];
  const first = await scanHistory(pager(pages), 'p1', { kind: 'snapshot', limit: 3, maxPages: 5, maxRecords: 2, timeoutMs: 1_000 });
  assert.deepEqual(first.items.map((item) => item.id), ['a', 'b', 'c'], 'no record from the current page is skipped');
  assert.equal(first.reason, 'max-records');
  assert.equal(first.cursor, 'c1');

  const second = await scanHistory(pager(pages.slice(1)), 'p1', { kind: 'snapshot', cursor: 'c1', limit: 3, maxPages: 5, maxRecords: 2, timeoutMs: 1_000 });
  assert.deepEqual(second.items.map((item) => item.id), ['d']);
  assert.equal(second.cursor, null);
});

test('batched scans over multiple resumes equal a single full scan', async () => {
  const pages = [
    { items: [event('e5', 500), event('e4', 500)], nextCursor: 'c1' },
    { items: [event('e3', 400)], nextCursor: 'c2' },
    { items: [event('e2', 300), event('e1', 200)], nextCursor: null },
  ];
  const full = await scanHistory(pager(pages), 'p1', { kind: 'snapshot', limit: 2, maxPages: 10, maxRecords: 100, timeoutMs: 1_000 });
  const byCursor = (cursor: string | null) => ({ page: async () => cursor === 'c1' ? pages[1] : cursor === 'c2' ? pages[2] : pages[0] });
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 5; round += 1) {
    const result = await scanHistory(byCursor(cursor), 'p1', { kind: 'snapshot', cursor, limit: 2, maxPages: 1, maxRecords: 2, timeoutMs: 1_000 });
    ids.push(...result.items.map((item) => item.id));
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  assert.deepEqual(ids, full.items.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length, 'no record is counted twice');
});

test('same event time with different ids keeps a stable order', async () => {
  const pages = [{ items: [event('z', 100), event('a', 100), event('m', 100)], nextCursor: null }];
  const result = await scanHistory(pager(pages), 'p1', { kind: 'snapshot', limit: 5, maxPages: 2, maxRecords: 100, timeoutMs: 1_000 });
  assert.deepEqual(result.items.map((item) => item.id), ['z', 'a', 'm']);
});

test('resuming keeps start/end/asOf and does not silently change the window', async () => {
  const seenQueries: Array<Record<string, unknown>> = [];
  const store = { page: async (_project: string, query: Record<string, unknown>) => { seenQueries.push(query); return { items: [], nextCursor: null }; } };
  await scanHistory(store as never, 'p1', { kind: 'snapshot', cursor: 'abc', from: 10, to: 20, asOf: 30, limit: 2, maxPages: 1, maxRecords: 5, timeoutMs: 1_000 });
  assert.equal(seenQueries[0].from, 10);
  assert.equal(seenQueries[0].to, 20);
  assert.equal(seenQueries[0].asOf, 30);
  assert.equal(seenQueries[0].cursor, 'abc');
});

test('snapshot and L2 cursors are independent and truncation is reported', async () => {
  const snapshots = pager([{ items: [event('s1', 100)], nextCursor: 's2' }]);
  const l2 = pager([{ items: [event('l1', 100)], nextCursor: 'l2' }]);
  const snap = await scanHistory(snapshots, 'p1', { kind: 'snapshot', limit: 1, maxPages: 1, maxRecords: 10, timeoutMs: 1_000 });
  const depth = await scanHistory(l2, 'p1', { kind: 'l2', limit: 1, maxPages: 1, maxRecords: 10, timeoutMs: 1_000 });
  assert.equal(snap.cursor, 's2');
  assert.equal(depth.cursor, 'l2');
  assert.equal(snap.truncated, true);
  assert.equal(depth.truncated, true);
});
