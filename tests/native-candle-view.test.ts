import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectMarket } from '../shared/types.ts';
import { FLOW_INTERVALS } from '../shared/orderflow.ts';
import type { NativeCandleUpdate } from '../shared/native-candles.ts';
import { completedBy, mergeCandleUpdates, nativeCandleView, supportsNativeCandles } from '../shared/native-candle-view.ts';

function update(time: number, offset: number, close: number, volume: number, closed = false): NativeCandleUpdate {
  return { eventTime: time + offset, closed, candle: { time, open: 10, high: 18, low: 8, close, volumeBase: volume, volumeUsd: 10 * volume } };
}

test('every native timeframe revises one open candle each second and rolls only at its UTC boundary', () => {
  const start = Date.UTC(2026, 0, 2);
  for (const step of Object.values(FLOW_INTERVALS)) {
    const seed = update(start, 300, 11, 1);
    const one = update(start, 1000, 12, 2);
    const two = update(start, 2000, 13, 3);
    let live = mergeCandleUpdates([], [one, two]);
    assert.deepEqual(nativeCandleView([seed.candle], live), [two.candle]);
    assert.equal(mergeCandleUpdates(live, [one, two]), live);
    const close = update(start, step, 14, 4, true);
    const next = update(start + step, 110, 15, 1);
    live = mergeCandleUpdates(live, [close, next]);
    assert.deepEqual(nativeCandleView([seed.candle], live), [close.candle, next.candle]);
    assert.equal(mergeCandleUpdates(live, [update(start, step + 1, 15, 3)]), live);
  }
});

test('delayed history cannot roll back live close or double count volume; a more complete REST seed reconciles a disconnection', () => {
  const now = Date.UTC(2026, 0, 2);
  const a = update(now, 1000, 12, 4);
  const b = update(now, 2000, 14, 7);
  assert.deepEqual(nativeCandleView([a.candle], [b]), [b.candle]);
  assert.deepEqual(nativeCandleView([b.candle], [a]), [b.candle]);
  const next = update(now + 60_000, 1000, 14, 3);
  assert.deepEqual(nativeCandleView([b.candle, next.candle], [a]), [b.candle, next.candle]);
  assert.deepEqual(nativeCandleView([], [b]), [b.candle]);
  const laterSameMillis = update(now, 2000, 15, 8);
  assert.deepEqual(mergeCandleUpdates([b], [laterSameMillis]), [laterSameMillis]);
});

test('retains bounded bars even without REST, with no synthetic candles for missing intervals', () => {
  const frames = Array.from({length: 250}, (_, i) => update(i * 120_000, 59_999, 12, 4, true));
  const merged = mergeCandleUpdates([], frames);
  assert.deepEqual(merged, frames.slice(-120));
  assert.deepEqual(nativeCandleView(frames.map(f => f.candle), merged), frames.slice(-120).map(f => f.candle));
});

test('replay excludes a bar containing the cursor and native perp adapters reject same-symbol spot or another venue', () => {
  const start = Date.UTC(2026, 0, 2);
  const bars = [update(start, 59_999, 12, 2).candle, update(start+60_000, 59_999, 13, 3).candle];
  assert.deepEqual(completedBy(bars, start+59_999, 60_000), []);
  assert.deepEqual(completedBy(bars, start+60_000, 60_000), [bars[0]]);
  assert.deepEqual(completedBy(bars, start+90_000, 60_000), [bars[0]]);
  const finalized = update(start, 60_010, 14, 10, true);
  const stillOpen = update(start+60_000, 20_000, 16, 8);
  assert.deepEqual(nativeCandleView([], [finalized, stillOpen], start+60_000), []);
  assert.deepEqual(nativeCandleView([], [finalized, stillOpen], start+90_000), [finalized.candle]);
  const market = {exchange: 'binance', marketType: 'perpetual', symbol: 'BTCUSDT'} as ProjectMarket;
  assert.ok(supportsNativeCandles(market));
  assert.ok(supportsNativeCandles({...market, exchange: 'aster'}));
  assert.equal(supportsNativeCandles({...market, marketType: 'spot'}), false);
  assert.equal(supportsNativeCandles({...market, exchange: 'okx'}), false);
});
