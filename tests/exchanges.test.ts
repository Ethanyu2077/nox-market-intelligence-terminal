import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSnapshots, computeExchangeContribution, detectCrossExchangeInsights, normalizeContractQuantity } from '../server/exchanges.ts';
import type { VenueMarketSnapshot } from '../shared/types.ts';

function row(values: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    exchange: 'binance', symbol: 'TESTUSDT', marketType: 'perpetual', price: null, markPrice: null,
    change24hPct: null, volume24hBase: null, volume24hUsd: null, takerBuyVolumeUsd: null,
    takerSellVolumeUsd: null, volumeDeltaUsd: null, cvd: null, oiBase: null, oiUsd: null,
    oiDeltaBase: null, oiDeltaUsd: null, fundingRate: null, nextFundingTime: null, bid: null,
    ask: null, spreadBps: null, eventTime: 1, fetchedAt: Date.now(), quality: 'partial', source: 'test', unavailable: [],
    ...values
  };
}

test('contract quantities are normalized with venue multipliers', () => {
  assert.equal(normalizeContractQuantity(1_000, 0.01), 10);
  assert.equal(normalizeContractQuantity(null, 0.01), null);
  assert.equal(normalizeContractQuantity(100, null), null);
});

test('aggregation weights price and funding instead of summing them', () => {
  const result = aggregateSnapshots([
    row({ exchange: 'binance', price: 100, markPrice: 101, change24hPct: 2, volume24hUsd: 1_000, oiBase: 10, oiUsd: 1_000, fundingRate: 0.0001, spreadBps: 2 }),
    row({ exchange: 'bybit', price: 110, markPrice: 109, change24hPct: -1, volume24hUsd: 3_000, oiBase: 20, oiUsd: 3_000, fundingRate: 0.0003, spreadBps: 1 })
  ]);
  assert.equal(result.price, 107.5);
  assert.equal(result.change24hPct, -0.25);
  assert.ok(Math.abs(result.fundingRate! - 0.00025) < 1e-12);
  assert.equal(result.oiBase, 30);
  assert.equal(result.spreadBps, 1);
});

test('missing metrics remain unavailable and are not silently converted to zero', () => {
  const result = aggregateSnapshots([row({ exchange: 'mexc', price: 50 })]);
  assert.equal(result.price, 50);
  assert.equal(result.volume24hUsd, null);
  assert.equal(result.oiUsd, null);
  assert.equal(result.fundingRate, null);
});

test('exchange contribution shares use only covered non-null venue totals', () => {
  const summary = computeExchangeContribution([
    row({ exchange: 'binance', volume24hUsd: 750, oiUsd: 200 }),
    row({ exchange: 'bybit', volume24hUsd: 250, oiUsd: 300 }),
    row({ exchange: 'mexc', volume24hUsd: null, oiUsd: null })
  ], 3);
  assert.equal(summary.totals.volume24hUsd, 1_000);
  assert.equal(summary.totals.oiUsd, 500);
  assert.equal(summary.rows.find((item) => item.exchange === 'binance')?.volumeSharePct, 75);
  assert.equal(summary.rows.find((item) => item.exchange === 'bybit')?.oiSharePct, 60);
  assert.equal(summary.rows.find((item) => item.exchange === 'mexc')?.volumeSharePct, null);
  assert.equal(summary.coverage.volumeVenues, 2);
  assert.equal(summary.coverage.depthVenues, 0);
});

test('cross-exchange insights disclose concentration as inference with coverage evidence', () => {
  const rows = [
    row({ exchange: 'binance', volume24hUsd: 900, oiUsd: 900, fundingRate: 0.0002, price: 101 }),
    row({ exchange: 'bybit', volume24hUsd: 100, oiUsd: 100, fundingRate: 0.00001, price: 100 })
  ];
  const insights = detectCrossExchangeInsights(rows, computeExchangeContribution(rows, 2));
  assert.ok(insights.some((item) => item.type === 'volume_concentration'));
  assert.ok(insights.some((item) => item.type === 'oi_concentration'));
  assert.ok(insights.some((item) => item.type === 'funding_divergence'));
  assert.ok(insights.every((item) => /not|does not|observational|contextual/i.test(item.inferenceNotice)));
});

test('a single covered venue is not misclassified as cross-exchange concentration', () => {
  const rows = [row({ exchange: 'binance', volume24hUsd: 900, oiUsd: 900, fundingRate: 0.0001, price: 100 })];
  assert.deepEqual(detectCrossExchangeInsights(rows, computeExchangeContribution(rows, 1)), []);
});
