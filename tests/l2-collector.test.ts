import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateBucket, L2Collector } from '../server/l2/collector.ts';
import type { L2Snapshot } from '../shared/l2.ts';
import type { HistoryEvent } from '../shared/history.ts';
import type { MarketProject } from '../shared/types.ts';

const snapshot = (over: Partial<L2Snapshot> = {}): L2Snapshot => ({
  venue: 'binance', symbol: 'BTCUSDT', state: 'live', sequence: { first: 1, last: 2, previous: null },
  bids: [{ price: 100, quantity: 1, notional: 100 }], asks: [{ price: 101, quantity: 1, notional: 101 }],
  bestBid: 100, bestAsk: 101, midPrice: 100.5, spreadBps: 99.5, bidDepthUsd: 100, askDepthUsd: 100, imbalancePct: 0,
  eventTime: 1_000, syncedAt: 1_000, lastMessageAt: 1_000, lastValidUpdate: 2, gaps: 0, resyncs: 0,
  integrity: 'ok', verified: true, epoch: 1, limitations: [], ...over,
});

const project = (mode: 'active' | 'standard' | 'paused'): MarketProject => ({
  id: 'p1', name: 'P', tokenSymbol: 'P', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
  markets: [{ id: 'binance:perpetual:BTCUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', status: 'trading' }],
  primaryMarketId: 'binance:perpetual:BTCUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: mode },
  archived: false, order: 0, createdAt: 1, updatedAt: 1,
});

test('bucket aggregation reports coverage, net depth change and worst integrity', () => {
  const samples = [snapshot(), snapshot({ bidDepthUsd: 80, askDepthUsd: 90, integrity: 'checksum-unchecked' }), snapshot({ bidDepthUsd: 60, askDepthUsd: 80, integrity: 'gap' }), snapshot({ bidDepthUsd: 50, askDepthUsd: 70 }), snapshot({ bidDepthUsd: 40, askDepthUsd: 60 })];
  const bucket = aggregateBucket('p1', 'binance', 'BTCUSDT', samples, 5_000, 1_000, 1_000, 6_000);
  assert.equal(bucket.coveragePct, 100);
  assert.equal(bucket.samples, 5);
  assert.equal(bucket.bidDepthChangePct, -60);
  assert.equal(bucket.liquidityWithdrawalPct, 50);
  assert.equal(bucket.integrity, 'gap');
  assert.equal(bucket.verified, true);
  assert.equal(bucket.attribution, 'net-of-fills-not-separated');
});

test('collector only samples Active projects and persists completed buckets', async () => {
  const appended: Array<{ kind: string; payload: unknown }> = [];
  const collector = new L2Collector(() => [project('active'), { ...project('paused'), id: 'p2' }], {} as never, {
    intervalMs: 1_000,
    buckets: [1_000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot() }),
    append: async (event) => { appended.push({ kind: event.kind, payload: event.payload }); },
  });
  await collector.tick(1_000);
  assert.equal(appended.length, 0, 'the first tick opens a bucket, it does not close one');
  await collector.tick(2_000);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, 'l2');
  collector.stop();
});

test('unverified or stale books are stored for audit but are not research-usable', () => {
  const samples = [snapshot({ verified: false, integrity: 'checksum-unchecked' }), snapshot({ state: 'stale' }), snapshot({ integrity: 'gap' })];
  const bucket = aggregateBucket('p1', 'binance', 'BTCUSDT', samples, 5_000, 1_000, 1_000, 6_000);
  assert.equal(bucket.researchUsable, false);
  assert.ok(bucket.exclusionReasons.includes('unverified-book'));
  assert.ok(bucket.exclusionReasons.includes('non-live-state'));
  assert.ok(bucket.exclusionReasons.includes('integrity-not-ok'));
  assert.ok(bucket.samples === 3, 'raw samples are preserved for the audit trail');
});

test('an unchanged book is not counted twice as a fresh sample', async () => {
  const appended: Array<{ payload: unknown }> = [];
  const collector = new L2Collector(() => [project('active')], {} as never, {
    intervalMs: 1_000,
    buckets: [1_000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot() }),
    append: async (event) => { appended.push({ payload: event.payload }); },
  });
  await collector.tick(1_000);
  await collector.tick(1_400);
  await collector.tick(2_000);
  assert.equal(appended.length, 1);
  const bucket = appended[0].payload as { samples: number; staleSkipped: number; researchUsable: boolean; exclusionReasons: string[] };
  assert.equal(bucket.samples, 1, 'the repeated sequence is not a second observation');
  assert.ok(bucket.staleSkipped >= 1);
  assert.equal(bucket.researchUsable, false);
  assert.ok(bucket.exclusionReasons.includes('stale-sequence-skipped'));
  collector.stop();
});

test('a bucket spanning two book epochs is audit-only', () => {
  const bucket = aggregateBucket('p1', 'binance', 'BTCUSDT', [snapshot({ epoch: 1 }), snapshot({ epoch: 2 })], 5_000, 1_000, 1_000, 6_000);
  assert.equal(bucket.researchUsable, false);
  assert.ok(bucket.exclusionReasons.includes('epoch-change'));
  assert.deepEqual(bucket.epochs, [1, 2]);
  assert.equal(bucket.epochChanges, 1);
});

test('flush persists open buckets as incomplete audit records', async () => {
  const appended: Array<{ payload: unknown }> = [];
  const collector = new L2Collector(() => [project('active')], {} as never, {
    intervalMs: 1_000,
    buckets: [5_000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot() }),
    append: async (event) => { appended.push({ payload: event.payload }); },
  });
  await collector.tick(1_000);
  await collector.flush(2_000);
  assert.equal(appended.length, 1);
  const bucket = appended[0].payload as { researchUsable: boolean; exclusionReasons: string[] };
  assert.equal(bucket.researchUsable, false);
  assert.ok(bucket.exclusionReasons.includes('incomplete-bucket'));
  collector.stop();
});

test('health tracks sampling, writes, open buckets and flush', async () => {
  const collector = new L2Collector(() => [project('active')], {} as never, {
    intervalMs: 1_000, buckets: [5_000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot() }),
    append: async () => undefined,
  });
  await collector.tick(1_000);
  const health = collector.health();
  assert.ok(health.sampled > 0);
  assert.equal(health.activeFeeds, 1);
  assert.ok(health.pendingBuckets > 0);
  await collector.flush(2_000);
  assert.equal(collector.health().writes, 1);
  assert.equal(collector.health().pendingBuckets, 0);
  collector.stop();
});

test('a failed journal write is retried on the next tick', async () => {
  const attempts: HistoryEvent[] = [];
  const collector = new L2Collector(() => [project('active')], {} as never, {
    intervalMs: 1_000, buckets: [1_000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot() }),
    append: async event => { attempts.push(event); if (attempts.length <= 6) throw new Error('disk full'); },
  });
  await collector.tick(1_000);
  await collector.tick(2_000).catch(() => undefined);
  assert.equal(collector.health().writeFailures, 1);
  assert.equal(collector.health().pendingRetries, 1);
  for (let second = 3; second <= 8; second++) await collector.tick(second * 1000);
  assert.equal(attempts.length, 7, 'each retry gets a single attempt per tick');
  assert.deepEqual(attempts.at(-1), attempts[0], 'retry keeps observation time, quality and the complete bucket');
  assert.equal(attempts[0].quality, 'verified');
  assert.equal(collector.health().droppedBuckets, 0);
  assert.equal(collector.health().pendingRetries, 0);
  assert.ok(collector.health().writes >= 1);
  collector.stop();
});

test('blocked writes keep sampling without unbounded queues or extra writers', { timeout: 5_000 }, async () => {
  let sequence = 0, complete!: () => void;
  const blocked = new Promise<void>(resolve => { complete = resolve; });
  const writes: string[] = [];
  const collector = new L2Collector(() => [project('active')], {} as never, {
    intervalMs: 1000, buckets: [1000],
    acquire: () => ({ release: () => undefined, snapshot: () => snapshot({ sequence: { first: 1, last: ++sequence, previous: null } }) }),
    append: async event => { writes.push(event.id); await blocked; },
  });
  await collector.tick(1000);
  const firstWrite = collector.tick(2000);
  const limit = collector.health().maxPendingBuckets;
  for (let second = 3; second <= limit + 11; second++) await collector.tick(second * 1000);
  assert.equal(writes.length, 1);
  assert.equal(collector.health().pendingRetries, limit);
  assert.equal(collector.health().droppedBuckets, 10);
  complete();
  await firstWrite;
  assert.equal(writes.length, limit);
  assert.equal(new Set(writes).size, limit);
  assert.equal(writes[0], 'l2_p1_binance_BTCUSDT_1000_1000');
  assert.equal(writes.at(-1), `l2_p1_binance_BTCUSDT_1000_${(limit + 10) * 1000}`);
  assert.equal(collector.health().pendingRetries, 0);
  collector.stop();
});

test('open buckets retain only aggregate inputs and produce identical five-minute history', async () => {
  const expected: L2Snapshot[] = [];
  const events: HistoryEvent[] = [];
  const collector = new L2Collector(() => [project('active')], {} as never, {
    acquire: () => ({ release() {}, snapshot() {
      const index = expected.length;
      const row = snapshot({ sequence: {first: 1, last: index + 1, previous: index}, spreadBps: index, lastMessageAt: index * 1000 });
      expected.push(row);
      return row;
    } }),
    append: async event => { events.push(event); },
  });
  try {
    for (let n = 0; n < 300; n++) await collector.tick(n * 1000);
    const samples = [...collector['buckets'].values()][0].samples;
    assert.equal(samples.length, 300);
    assert.ok(samples.every(row => !('bids' in row) && !('asks' in row)));
    const reference = aggregateBucket('p1', 'binance', 'BTCUSDT', expected, 300_000, 0, 1000, 300_000);
    await collector.tick(300_000);
    assert.deepEqual(events[0].payload, reference);
  } finally { collector.stop(); }
});

test('pausing a project releases its feed and resuming acquires a new one', async () => {
  let mode: 'active' | 'paused' = 'active';
  let acquired = 0, released = 0;
  const collector = new L2Collector(() => [project(mode)], {} as never, {
    intervalMs: 1_000, buckets: [5_000],
    acquire: () => { acquired += 1; return { release: () => { released += 1; }, snapshot: () => snapshot() }; },
    append: async () => undefined,
  });
  await collector.tick(1_000);
  assert.equal(acquired, 1);
  assert.equal(released, 0);
  mode = 'paused';
  await collector.tick(2_000);
  assert.equal(released, 1);
  assert.equal(collector.health().activeFeeds, 0);
  mode = 'active';
  await collector.tick(3_000);
  assert.equal(acquired, 2);
  collector.stop();
});
