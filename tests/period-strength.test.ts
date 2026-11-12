import assert from 'node:assert/strict';
import test from 'node:test';
import { periodPrices, periodPriceSeries, periodPriceValueAt, priceRefreshMs } from '../shared/period-strength.ts';
import type { WatchRow } from '../shared/watch-overview.ts';

const row: WatchRow = {
  projectId: 'jct', venue: 'binance', symbol: 'JCTUSDT', marketType: 'perpetual', quote: 'USDT', error: null,
  candles: [{time: 0, close: 100, volume: 1}, {time: 300_000, close: 104, volume: 1}],
};

test('period prices keep true timestamps and combine closed, stored and socket prices within the window', () => {
  const seeded = { ...row, minuteCloses: [{time: 60_000, close: 102}, {time: 300_000, close: 103}],
    priceHistory: [{t: 100_000, p: 99}, {t: 306_000, p: 102}, {t: 309_000, p: 102}] };
  const result = periodPrices(seeded, [{t: 60_000, p: 103}, {t: 306_000, p: 105}, {t: 304_000, p: 0}], 0, 307_000);
  assert.deepEqual(result, [{t: 0, p: 100}, {t: 60_000, p: 102}, {t: 100_000, p: 99}, {t: 300_000, p: 104}, {t: 306_000, p: 105}]);
  assert.equal(periodPrices(seeded, undefined, 301_000, 307_000)[0].t, 60_000);
});

test('period prices retain both the baseline and the latest provisional price without using it as a closed candle', () => {
  const quotes = [{t: 1000, p: 100}, {t: 2000, p: 101}, {t: 4000, p: 102}, {t: 6000, p: 98}];
  const points = periodPriceSeries(quotes, undefined, 5000, 1000).points;
  assert.deepEqual(points.map(p => p.t), [1000, 2000, 4000, 6000]);
  assert.deepEqual(points.map(p => Math.round(p.value)), [0, 1, 2, -2]);
  assert.equal(periodPriceValueAt(points, 999), null);
  assert.equal(periodPriceValueAt(points, 20_000), points.at(-1)?.value);
  assert.deepEqual([1, 5, 15, 60, 240, 1440].map(priceRefreshMs), [1000, 2000, 5000, 10_000, 30_000, 60_000]);
});

test('period benchmark returns share a real starting observation and exclude unpaired stale or future benchmark prices', () => {
  const prices = [{t: 0, p: 50}, {t: 100_000, p: 100}, {t: 110_001, p: 140}, {t: 120_500, p: 112.5}];
  const reference = [{t: 100_000, p: 160}, {t: 120_000, p: 164}];
  const points = periodPriceSeries(prices, reference, 2000, 0).points;
  assert.deepEqual(points.map(p => p.t), [100_000, 120_500]);
  assert.equal(points[0].value, 0);
  assert.ok(Math.abs(points[1].value - 10) < 1e-9);
  assert.deepEqual(periodPriceSeries(prices, [], 2000, 0).points, []);
});


test('rolling window baselines use a recent real price on the left and advance across the next candle close', () => {
  const candles = [{t: 100_000, p: 80}, {t: 400_000, p: 100}, {t: 700_000, p: 120}, {t: 740_000, p: 125}];
  const before = periodPriceSeries(candles, undefined, 5000, 399_000).points;
  assert.deepEqual(before[0], {t: 399_000, value: 0});
  assert.equal(before.at(-1)?.value, 56.25);
  const after = periodPriceSeries(candles, undefined, 5000, 402_000).points;
  assert.deepEqual(after[0], {t: 402_000, value: 0});
  assert.equal(after.at(-1)?.value, 25);
  const missingStart = periodPriceSeries([candles[0], candles[3]], undefined, 5000, 700_000).points;
  assert.deepEqual(missingStart, [{t: 740_000, value: 0}]);
});


test('complete stored quotes alone qualify for a period, while isolated or gapped data only draws the trace', () => {
  const archive = [{t: 0, p: 100}, {t: 270_000, p: 102}, {t: 480_000, p: 101}, {t: 610_000, p: 99}];
  assert.equal(periodPriceSeries(archive, undefined, 5000, 1000).covered, true);
  assert.equal(periodPriceSeries([archive[0], archive[3]], undefined, 5000, 1000).covered, false);
  assert.equal(periodPriceSeries(archive.slice(1), undefined, 5000, 1000).covered, false);
  assert.equal(periodPriceSeries(archive.slice(0, 1), undefined, 5000, 1000).covered, false);
});

test('slower display buckets retain observed reversals in time order and the final level', () => {
  const prices = [100, 99, 102, 98, 101, 100].map((p, i) => ({t: 1000 * (i + 1), p}));
  const {points} = periodPriceSeries(prices, undefined, 30_000, 1000);
  assert.deepEqual(points.map(p => p.t), [1000, 3000, 4000, 6000]);
  assert.deepEqual(points.map(p => Math.round(p.value)), [0, 2, -2, 0]);
});
