import type { StrengthPoint, StrengthReturnPoint } from './strength-history.ts';
import { BUCKET, type WatchRow } from './watch-overview.ts';

/** The display clock slows with the selected window. Quote collection keeps its original cadence. */
export function priceRefreshMs(minutes: number) {
  if (minutes <= 1) return 1_000;
  if (minutes <= 5) return 2_000;
  if (minutes <= 15) return 5_000;
  if (minutes <= 60) return 10_000;
  if (minutes <= 240) return 30_000;
  return 60_000;
}

/** At the same exchange timestamp the final candle close wins over provisional quotes. */
export function periodPrices(row: WatchRow, quotes: readonly StrengthPoint[] | undefined, start: number, end: number): StrengthPoint[] {
  const byTime = new Map<number, number>();
  const add = (time: number, price: number) => {
    if (time >= start - BUCKET && time <= end && Number.isFinite(price) && price > 0) byTime.set(time, price);
  };
  for (const point of row.priceHistory ?? []) add(point.t, point.p);
  for (const point of quotes ?? []) add(point.t, point.p);
  for (const candle of row.minuteCloses ?? []) add(candle.time, candle.close);
  for (const candle of row.candles) add(candle.time, candle.close);
  return Array.from(byTime, ([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}

/** Use only contemporaneous observed prices for a comparison, including its common baseline. */
export function periodPriceSeries(prices: readonly StrengthPoint[], benchmark: readonly StrengthPoint[] | undefined, cadence: number, start: number) {
  const result: StrengthReturnPoint[] = [];
  let first: number | undefined, firstBenchmark: number | undefined;
  // A full-day archive may return six-minute envelopes. Shorter windows retain 5m closes.
  const maxGap = Math.max(BUCKET, 6 * cadence);
  let covered = false, lastObserved = -Infinity;
  let bucket: { interval: number; low: StrengthReturnPoint; high: StrengthReturnPoint; last: StrengthReturnPoint } | undefined;
  const flush = () => {
    if (!bucket) return;
    const {low, high, last} = bucket;
    const extremes = low.t <= high.t ? [low, high] : [high, low];
    for (const point of [...extremes, last]) if (result.at(-1)?.t !== point.t) result.push(point);
  };
  let index = 0;
  for (const { t, p } of prices) {
    if (t < start - BUCKET) continue;
    let referencePrice: number | undefined;
    if (benchmark) {
      while (index + 1 < benchmark.length && benchmark[index + 1].t <= t) index++;
      const ref = benchmark[index];
      if (!ref || ref.t > t || t - ref.t > 5_000) continue;
      referencePrice = ref.p;
    }
    // The left edge is the most recently known common price, at most one 5m candle old.
    // Without such an observation the trace starts at its first real in-window quote.
    if (t <= start) {
      covered = true;
      lastObserved = t;
      first = p;
      firstBenchmark = referencePrice;
      result[0] = { t: start, value: 0 };
      continue;
    }
    if (t - lastObserved > maxGap) covered = false;
    lastObserved = t;
    first ??= p;
    firstBenchmark ??= referencePrice;
    const relative = referencePrice !== undefined && firstBenchmark !== undefined ? (referencePrice / firstBenchmark - 1) * 100 : 0;
    const point = { t, value: (p / first - 1) * 100 - relative };
    // Preserve true intraperiod peaks and reversals even on slow display clocks.
    const interval = Math.floor(t / cadence);
    if (interval !== bucket?.interval) {
      flush();
      bucket = {interval, low: point, high: point, last: point};
    } else {
      if (point.value < bucket.low.value) bucket.low = point;
      if (point.value > bucket.high.value) bucket.high = point;
      bucket.last = point;
    }
    if (!result.length) result.push(point);
  }
  flush();
  return {points: result, covered: covered && lastObserved > start};
}

export function periodPriceValueAt(points: readonly StrengthReturnPoint[], time: number): number | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].t <= time) return points[i].value;
  return null;
}
