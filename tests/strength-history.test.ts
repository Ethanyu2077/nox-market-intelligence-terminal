import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectMarket } from '../shared/types.ts';
import { liveStrengthReturns, StrengthHistory, strengthMarketKey, strengthValueAt } from '../shared/strength-history.ts';

const market: ProjectMarket = { id: 'BTC-PERP', exchange: 'binance', marketType: 'perpetual', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', status: 'TRADING' };
const project = { id: 'btc', primaryMarketId: market.id, markets: [market] };

test('strength history stores the newest positive price per second and keeps its source time', () => {
  const history = new StrengthHistory();
  history.watch([project]);
  const tick = { projectId: 'btc', price: 100, priceAt: 3100, at: 6900, stale: false };
  history.ingest([tick, { ...tick, price: 102, priceAt: 3490 }, { ...tick, price: 97 }], 7000);
  history.ingest([{ ...tick, price: 101, priceAt: 4100 }, { ...tick, price: 0, priceAt: 5100 }, { ...tick, projectId: 'other' }], 7000);
  history.ingest([{ ...tick, price: 101, priceAt: 4100, at: 8000 }], 8000);
  const view = history.snapshot(8000);
  assert.deepEqual([...view.series], [['btc', [{ t: 3490, p: 102 }, { t: 4100, p: 101 }]]]);
  assert.equal(view.staleIds.size, 0);
  assert.equal(history.snapshot(10_000).staleIds.has('btc'), true);
  history.ingest([{ ...tick, stale: true, priceAt: 8100 }], 8200);
  assert.equal(history.snapshot(8200).staleIds.has('btc'), true);
  assert.deepEqual(history.snapshot(64_100).series.get('btc'), [{ t: 4100, p: 101 }]);
  assert.equal(history.snapshot(64_101).series.size, 0);
});

test('changing the primary market clears its history and rejects queued quotes from the old feed', () => {
  const history = new StrengthHistory();
  history.watch([project]);
  const tick = { projectId: 'btc', price: 10, at: 2500, marketKey: strengthMarketKey(project) };
  history.ingest([tick], 3000);
  const spot = { ...market, id: 'BTC-SPOT', marketType: 'spot' as const };
  const changed = { ...project, markets: [market, spot], primaryMarketId: spot.id };
  history.watch([changed]);
  history.ingest([tick], 3100);
  assert.equal(history.snapshot(3100).series.size, 0);
  history.ingest([{ ...tick, marketKey: strengthMarketKey(changed) }], 3200);
  assert.equal(history.snapshot(3200).series.size, 1);
  history.watch([]);
  assert.equal(history.snapshot(3300).series.size, 0);
});

test('rolling watchlist returns use the first valid in-window quote and the latest observed quote', () => {
  const quotes = new Map([
    ['active', [
      { t: 999, p: 1 }, { t: 1000, p: 0 }, { t: 1001, p: 20 },
      { t: 60_000, p: 0 }, { t: 60_500, p: 21 }, { t: 61_001, p: 999 },
    ]],
    ['new', [{ t: 61_000, p: 5 }]],
    ['expired', [{ t: 500, p: 18 }]],
    ['unavailable', []],
  ]);
  const result = liveStrengthReturns(quotes, 61_000, new Set(), true);
  assert.deepEqual([...result.keys()], ['active', 'new']);
  assert.deepEqual(result.get('active'), { points: [{ t: 1001, value: 0 }, { t: 60_500, value: 5 }], latest: 5, stale: false });
  assert.deepEqual(result.get('new'), { points: [{ t: 61_000, value: 0 }], latest: 0, stale: false });
});

test('retained stale paths have no current return for rankings or averages', () => {
  const quotes = new Map([['btc', [{ t: 1000, p: 20 }, { t: 3000, p: 18 }]]]);
  const points = [{ t: 1000, value: 0 }, { t: 3000, value: -10 }];
  const fresh = liveStrengthReturns(quotes, 8000, new Set(), true);
  assert.deepEqual(fresh.get('btc'), { points, latest: -10, stale: false });
  for (const view of [
    liveStrengthReturns(quotes, 8001, new Set(), true),
    liveStrengthReturns(quotes, 3010, new Set(['btc']), true),
    liveStrengthReturns(quotes, 3010, new Set(), false),
  ]) assert.deepEqual(view.get('btc'), { points, latest: null, stale: true });
});

test('cursor reads the last observed value only within its freshness interval', () => {
  const points = [{ t: 2000, value: 0 }, { t: 3000, value: 4 }, { t: 10_000, value: -6 }];
  assert.equal(strengthValueAt(points, 1999), null);
  assert.equal(strengthValueAt(points, 2999), 0);
  assert.equal(strengthValueAt(points, 3000), 4);
  assert.equal(strengthValueAt(points, 3001), null);
  assert.equal(strengthValueAt(points, 8000), null);
  assert.equal(strengthValueAt(points, 8001), null);
  assert.equal(strengthValueAt(points, 10_000, 0), -6);
  assert.equal(strengthValueAt(points, 10_001, 0), null);
  assert.equal(strengthValueAt(points, 15_000), -6);
  assert.equal(strengthValueAt(points, 15_001), null);
  assert.equal(strengthValueAt([...points, { t: 11_000, value: null }], 11_040), null);
});

test('replay fills missing seconds in chronological order and retains the latest observation per second', () => {
  const history = new StrengthHistory();
  history.watch([project]);
  const projectId = project.id, marketKey = strengthMarketKey(project), now = 110_000;
  history.ingest([
    { projectId, at: 102_800, price: 100 },
    { projectId, at: 108_100, price: 103 },
  ], now);
  const group = { projectId, marketKey, points: [
    { t: 104_300, p: 104 }, { t: 101_000, p: 98 }, { t: 102_900, p: 101 },
    { t: 102_500, p: 90 }, { t: 108_100, p: 111 }, { t: 104_400, p: 105 },
    { t: 104_600, p: 0 }, { t: 49_999, p: 1 }, { t: 120_000, p: 3 }, null,
  ] };
  for (let i = 0; i < 2; i++) history.restore([group, { ...group, projectId: 'unknown' },
    { ...group, marketKey: 'wrong', points: [{ t: 109_000, p: 200 }] }], now);
  const restored = history.snapshot(now);
  assert.deepEqual([...restored.series], [[projectId, [
    { t: 101_000, p: 98 }, { t: 102_900, p: 101 }, { t: 104_400, p: 105 }, { t: 108_100, p: 103 },
  ]]]);
  assert.equal(restored.staleIds.size, 0);
});

test('replayed points alone never establish freshness or override a stale quote flag', () => {
  const history = new StrengthHistory();
  history.watch([project]);
  const group = { projectId: project.id, marketKey: strengthMarketKey(project), points: [{ t: 9000, p: 20 }] };
  const tick = { projectId: project.id, at: 9000, price: 20 };
  history.restore([group], 9500);
  assert.ok(history.snapshot(9500).staleIds.has(project.id));
  history.ingest([tick], 9500);
  assert.equal(history.snapshot(9500).staleIds.size, 0);
  history.restore([{ ...group, points: [{ t: 15_200, p: 22 }] }], 15_300);
  assert.ok(history.snapshot(15_300).staleIds.has(project.id));
  history.ingest([{ ...tick, at: 15_200, price: 22 }, { ...tick, stale: true }], 15_400);
  history.restore([group], 15_500);
  assert.ok(history.snapshot(15_500).staleIds.has(project.id));
  assert.deepEqual(history.snapshot(15_500).series.get(project.id), [{ t: 9000, p: 20 }, { t: 15_200, p: 22 }]);
});
