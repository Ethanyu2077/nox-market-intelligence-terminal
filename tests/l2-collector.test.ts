import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateBucket, L2Collector } from '../server/l2/collector.ts';
import type { L2Snapshot } from '../shared/l2.ts';
import type { MarketProject } from '../shared/types.ts';

const snapshot = (over: Partial<L2Snapshot> = {}): L2Snapshot => ({
  venue: 'binance', symbol: 'BTCUSDT', state: 'live', sequence: { first: 1, last: 2, previous: null },
  bids: [{ price: 100, quantity: 1, notional: 100 }], asks: [{ price: 101, quantity: 1, notional: 101 }],
  bestBid: 100, bestAsk: 101, midPrice: 100.5, spreadBps: 99.5, bidDepthUsd: 100, askDepthUsd: 100, imbalancePct: 0,
  eventTime: 1_000, syncedAt: 1_000, lastMessageAt: 1_000, lastValidUpdate: 2, gaps: 0, resyncs: 0,
  integrity: 'ok', verified: true, limitations: [], ...over,
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
