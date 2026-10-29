import type { CandlePoint } from './types.ts';

/** A theoretical next-bar-open outcome, not a claim of executable zero-latency fills. */
export function researchWindow(candles: CandlePoint[], index: number, horizon: number, options: { availableAt?: number; start?: number; end?: number; delayBars?: number } = {}) {
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error('horizon must be a positive integer');
  const delay = options.delayBars ?? 0;
  if (!Number.isInteger(delay) || delay < 0) throw new Error('delayBars must be a non-negative integer');
  const step = candles.length > 1 ? candles[1].time - candles[0].time : 0;
  const first = index + delay, last = first + horizon - 1;
  const entry = candles[first], exit = candles[last];
  if (index < 0 || !entry || !exit || !(step > 0)) return null;
  const exitTime = exit.time + step;
  if (entry.time < (options.availableAt ?? -Infinity) || entry.time < (options.start ?? -Infinity) || exitTime > (options.end ?? Infinity)) return null;
  for (let i = first; i <= last; i++) {
    const candle = candles[i];
    if (candle.time !== entry.time + (i - first) * step || !Number.isFinite(candle.open) || candle.open <= 0 || !Number.isFinite(candle.close) || candle.close <= 0) return null;
  }
  return { entryPrice: entry.open, exitPrice: exit.close, entryTime: entry.time, exitTime, priceReturnPct: (exit.close / entry.open - 1) * 100 };
}
