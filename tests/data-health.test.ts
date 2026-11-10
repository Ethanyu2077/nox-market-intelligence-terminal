import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataHealth, classifyL2, classifySource, classifyStorage, type HealthInputs } from '../server/data-health.ts';

const now = 1_700_000_000_000;
const venue = (over: Record<string, unknown> = {}) => ({
  exchange: 'binance', symbol: 'BTCUSDT', marketType: 'perpetual', price: 100, oiBase: 10, fundingRate: 0.0001,
  volume24hUsd: 1000, eventTime: now - 5_000, fetchedAt: now - 4_000, quality: 'live', source: 'test', unavailable: [], ...over,
});
const base = (snapshots: Array<Record<string, unknown>>, over: Partial<HealthInputs> = {}): HealthInputs => ({
  now,
  storage: { mode: 'timescaledb-with-local-outbox', connected: true, journalBytes: 100, pendingBytes: 0, rows: 10 },
  collectors: [{ projectId: 'p1', mode: 'standard', error: null, checkedAt: now }],
  l2: { activeFeeds: 0, sampled: 0, lastPersistAt: null },
  breakers: [],
  projects: [{ id: 'p1', name: 'P', mode: 'standard', venues: { snapshots: snapshots as never }, coverage: { expectedCadenceMs: 300_000, kinds: [], summary: { notes: [] } } }],
  ...over,
});

test('classifySource distinguishes LIVE, PARTIAL, STALE, UNAVAILABLE and NOT VERIFIED', () => {
  assert.equal(classifySource({ quality: 'live', delayMs: 5_000, hasMetric: true }), 'LIVE');
  assert.equal(classifySource({ quality: 'partial', delayMs: 5_000, hasMetric: true }), 'PARTIAL');
  assert.equal(classifySource({ quality: 'live', delayMs: 6 * 60_000, hasMetric: true }), 'PARTIAL');
  assert.equal(classifySource({ quality: 'live', delayMs: 20 * 60_000, hasMetric: true }), 'STALE');
  assert.equal(classifySource({ quality: 'stale', delayMs: 1_000, hasMetric: true }), 'STALE');
  assert.equal(classifySource({ quality: 'live', delayMs: 1_000, hasMetric: false }), 'UNAVAILABLE');
  assert.equal(classifySource({ quality: 'live', delayMs: null, hasMetric: true }), 'NOT VERIFIED');
});

test('overall state is the worst source and counts are explicit', () => {
  const report = buildDataHealth(base([venue(), venue({ exchange: 'bybit', quality: 'partial' }), venue({ exchange: 'okx', quality: 'stale', eventTime: now - 3_600_000 })]));
  assert.equal(report.overall.state, 'STALE');
  assert.equal(report.overall.live, 1);
  assert.equal(report.overall.partial, 1);
  assert.equal(report.overall.stale, 1);
  assert.equal(report.sources.length, 3);
});

test('issues cover breaker, storage, l2 and stale coverage without fabricating data', () => {
  const report = buildDataHealth(base([venue({ eventTime: now - 3_600_000 })], {
    storage: { mode: 'local-journal', connected: false, pendingBytes: 500 },
    l2: { activeFeeds: 0, sampled: 0, lastPersistAt: null },
    breakers: [{ exchange: 'binance', family: 'snapshot', state: 'open', lastError: 'timeout', lastFailureAt: now - 1000 }],
    projects: [{ id: 'p1', name: 'P', mode: 'standard', venues: { snapshots: [venue({ eventTime: now - 3_600_000 })] as never }, coverage: { kinds: [{ kind: 'snapshot', state: 'stale', sampledEvents: 10, lastIngestAgeMs: 600_000, gaps: 2, from: 1, to: 2 }], summary: { notes: ['stale'] } } }],
  }));
  const categories = report.issues.map((issue) => issue.category);
  for (const category of ['data-delay', 'exchange-circuit', 'storage-local', 'journal-backlog', 'l2-idle', 'history-gap']) assert.ok(categories.includes(category), category);
  assert.equal(report.storage.connected, false);
  assert.equal(report.l2.state, 'NOT VERIFIED');
});

test('no sources means NOT VERIFIED, never LIVE', () => {
  const report = buildDataHealth(base([]));
  assert.equal(report.overall.state, 'NOT VERIFIED');
});

test('storage classification distinguishes local journal, disconnected and degraded', () => {
  assert.equal(classifyStorage({ mode: 'local-journal', connected: false }), 'LOCAL_JOURNAL');
  assert.equal(classifyStorage({ mode: 'timescaledb-with-local-outbox', connected: false }), 'TIMESCALE_DISCONNECTED');
  assert.equal(classifyStorage({ mode: 'timescaledb-with-local-outbox', connected: true, pendingBytes: 0 }), 'TIMESCALE_CONNECTED');
  assert.equal(classifyStorage({ mode: 'timescaledb-with-local-outbox', connected: true, pendingBytes: 10 }), 'STORAGE_DEGRADED');
  assert.equal(classifyStorage({ mode: '', connected: true }), 'NOT VERIFIED');
});

test('L2 health requires fresh verified integrity, not just an active feed', () => {
  const feed = { venue: 'binance', symbol: 'BTCUSDT', state: 'live', sequence: 10, epoch: 1, verified: true, integrity: 'ok', gaps: 0, resyncs: 0, lastMessageAt: now - 1_000 };
  assert.equal(classifyL2([], now), 'NOT VERIFIED');
  assert.equal(classifyL2([feed], now), 'LIVE');
  assert.equal(classifyL2([{ ...feed, verified: false }], now), 'UNAVAILABLE');
  assert.equal(classifyL2([{ ...feed, lastMessageAt: now - 120_000 }], now), 'UNAVAILABLE');
  assert.equal(classifyL2([feed, { ...feed, venue: 'bybit', verified: false }], now), 'PARTIAL');
});

test('provider health produces explicit issues and is reported', () => {
  const report = buildDataHealth(base([venue()], {
    providers: [
      { provider: 'CoinGlass', state: 'UNAVAILABLE', configured: true, lastSuccessAt: null, lastFailureAt: now - 1000, lastLatencyMs: 20, lastReason: 'HTTP 429' },
      { provider: 'Other', state: 'NOT VERIFIED', configured: false, lastSuccessAt: null, lastFailureAt: null, lastLatencyMs: null, lastReason: null },
    ],
  }));
  assert.equal(report.providers.length, 2);
  const categories = report.issues.map((issue) => issue.category);
  assert.ok(categories.includes('provider-error'));
  assert.ok(categories.includes('provider-not-configured'));
});
