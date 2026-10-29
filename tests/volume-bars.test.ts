import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVolumeBars } from '../server/volume-bars.ts';
import type { OrderFlowResponse } from '../shared/orderflow.ts';

const NOW = Date.now();

const bucket = (time: number, buy: number | null, sell: number | null, complete: boolean, count: number) => ({ time, buy, sell, delta: buy != null && sell != null ? buy - sell : null, cvd: null, base: buy != null && sell != null ? buy + sell : null, buyBase: buy, sellBase: sell, vwap: buy != null && sell != null && buy + sell > 0 ? 2 : null, high: 2, low: 2, maxTradeNotional: buy, complete, count, zScore: null, reset: false });
const market = (exchange: 'binance' | 'upbit', marketType: 'spot' | 'perpetual', symbol: string, quote: string) => ({ id: `${exchange}:${marketType}:${symbol}`, exchange, marketType, symbol, base: 'ARB', quote, status: 'trading' });

function snapshot(): OrderFlowResponse {
  return {
    projectId: 'p', generatedAt: NOW, interval: '1m', reset: 'window', unit: 'USDT',
    venues: [
      { key: 'binance:spot:ARBUSDT', market: market('binance', 'spot', 'ARBUSDT', 'USDT'), state: 'partial', transport: 'REST recent trades', lastTradeAt: NOW - 1_000, checkedAt: NOW, coverageFrom: NOW - 180_000, coverageTo: NOW, gaps: [{ from: NOW - 100_000, to: NOW - 90_000, reason: 'test-gap' }], buckets: [bucket(NOW - 120_000, 100, 50, true, 3), bucket(NOW - 60_000, null, null, false, 0)], warnings: [], retainedTrades: 5 },
      { key: 'binance:perpetual:ARBUSDT', market: market('binance', 'perpetual', 'ARBUSDT', 'USDT'), state: 'live', transport: 'WebSocket + REST overlap recovery', lastTradeAt: NOW - 500, checkedAt: NOW, coverageFrom: NOW - 180_000, coverageTo: NOW, gaps: [], buckets: [bucket(NOW - 60_000, 200, 300, true, 4)], warnings: [], retainedTrades: 4 },
      { key: 'upbit:spot:KRW-ARB', market: market('upbit', 'spot', 'KRW-ARB', 'KRW'), state: 'unavailable', transport: 'REST recent trades', lastTradeAt: null, checkedAt: null, coverageFrom: null, coverageTo: null, gaps: [], buckets: [], warnings: [], retainedTrades: 0 },
    ],
    aggregates: {
      spot: { requested: 1, covered: 1, keys: ['binance:spot:ARBUSDT'], buckets: [bucket(NOW - 60_000, 100, 50, true, 3)] },
      perpetual: { requested: 1, covered: 1, keys: ['binance:perpetual:ARBUSDT'], buckets: [bucket(NOW - 60_000, 200, 300, true, 4)] },
    },
    trades: [], tradeClusters: [], signals: [], liquidations: [], liquidationCoverage: [], methodology: [],
  };
}

test('event-time volume bars keep spot and perpetual tapes separate and KRW out', () => {
  const bars = buildVolumeBars('p', snapshot(), NOW);
  assert.equal(bars.venues.length, 2);
  assert.deepEqual(bars.venues.map((venue) => venue.marketType), ['spot', 'perpetual']);
  const spot = bars.venues[0];
  assert.equal(spot.buckets[0].volumeUsd, 150);
  assert.equal(spot.buckets[0].complete, true);
  assert.equal(spot.buckets[1].volumeUsd, null);
  assert.equal(spot.buckets[1].complete, false);
  assert.equal(spot.completeBuckets, 1);
  assert.equal(spot.observedBuckets, 1);
  assert.equal(spot.gaps, 1);
  assert.equal(spot.state, 'partial');
  const perp = bars.venues[1];
  assert.equal(perp.buckets[0].volumeUsd, 500);
  assert.equal(perp.buckets[0].base, 500);
  assert.equal(perp.buckets[0].vwap, 2);
  assert.equal(perp.buckets[0].maxTradeNotional, 200);
  assert.equal(perp.buckets[0].buyBase, 200);
  assert.equal(bars.aggregates.spot.buckets[0].volumeUsd, 150);
  assert.equal(bars.aggregates.perpetual.completeBuckets, 1);
  assert.ok(bars.methodology.some((item) => item.includes('KRW')));
});

test('empty tape returns an explicit empty response rather than fabricated zero bars', () => {
  const bars = buildVolumeBars('p', { ...snapshot(), venues: [], aggregates: { spot: { requested: 0, covered: 0, keys: [], buckets: [] }, perpetual: { requested: 0, covered: 0, keys: [], buckets: [] } } }, NOW);
  assert.deepEqual(bars.venues, []);
  assert.equal(bars.aggregates.spot.observedBuckets, 0);
  assert.ok(bars.methodology.length > 0);
});

test('trades count and completeness are preserved per bucket', () => {
  const bars = buildVolumeBars('p', snapshot(), NOW);
  assert.equal(bars.venues[0].buckets[0].trades, 3);
  assert.equal(bars.venues[1].buckets[0].trades, 4);
  assert.equal(bars.venues[1].retainedTrades, 4);
});
