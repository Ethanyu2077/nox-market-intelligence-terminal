import assert from 'node:assert/strict';
import test from 'node:test';
import { scanHistory } from '../server/history-scan.ts';
import type { HistoryEvent } from '../shared/history.ts';

const event = (id: string, time: number): HistoryEvent => ({ id, kind: 'snapshot', marketKey: 'binance:perpetual:BTCUSDT', projectId: 'p1', eventTime: time, ingestTime: time, source: 'test', quality: 'live', payload: {} });

function pager(pages: Array<{ items: HistoryEvent[]; nextCursor: string | null }>) {
  let index = 0;
  return { page: async () => pages[index++] ?? { items: [], nextCursor: null } };
}

test('scans multiple pages, dedupes boundary duplicates and reports the next cursor', async () => {
  const pages = [
    { items: [event('b', 100), event('a', 100)], nextCursor: 'c1' },
    { items: [event('a', 100), event('c', 90)], nextCursor: null },
  ];
  const result = await scanHistory(pager(pages), 'p1', { kind: 'snapshot', limit: 2, maxPages: 5, maxRecords: 100, timeoutMs: 1_000 });
  assert.deepEqual(result.items.map((item) => item.id), ['b', 'a', 'c']);
  assert.equal(result.scanned, 4);
  assert.equal(result.duplicates, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.cursor, null);
});

test('resumes from a cursor and stops at max pages', async () => {
  const pages = [
    { items: [event('a', 100)], nextCursor: 'c1' },
    { items: [event('b', 90)], nextCursor: 'c2' },
    { items: [event('c', 80)], nextCursor: null },
  ];
  const result = await scanHistory(pager(pages), 'p1', { kind: 'snapshot', cursor: 'c1', limit: 1, maxPages: 2, maxRecords: 100, timeoutMs: 1_000 });
  assert.deepEqual(result.items.map((item) => item.id), ['a', 'b']);
  assert.equal(result.cursor, 'c2');
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'max-pages');
});

test('enforces max records and the query timeout', async () => {
  const pages = [{ items: [event('a', 100), event('b', 99)], nextCursor: 'c1' }];
  const capped = await scanHistory(pager(pages), 'p1', { kind: 'l2', limit: 2, maxPages: 5, maxRecords: 1, timeoutMs: 1_000 });
  assert.equal(capped.items.length, 1);
  assert.equal(capped.reason, 'max-records');
  let clock = 0;
  const timed = await scanHistory(pager([{ items: [event('a', 1)], nextCursor: 'c1' }]), 'p1', { kind: 'snapshot', limit: 1, maxPages: 5, maxRecords: 100, timeoutMs: 10, now: () => { clock += 20; return clock; } });
  assert.equal(timed.truncated, true);
  assert.equal(timed.reason, 'timeout');
});
