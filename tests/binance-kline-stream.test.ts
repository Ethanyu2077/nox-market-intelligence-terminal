import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCandle } from '../server/binance-kline-stream.ts';

test('closed candles replace by time, stay ordered and capped', () => {
  const base = [{ time: 100, close: 1, volume: 10 }, { time: 200, close: 2, volume: 20 }];
  const merged = mergeCandle(base, { time: 200, close: 3, volume: 30 });
  assert.deepEqual(merged.map((candle) => candle.close), [1, 3]);
  const later = mergeCandle(merged, { time: 300, close: 4, volume: 40 });
  assert.equal(later.at(-1)?.time, 300);
});
