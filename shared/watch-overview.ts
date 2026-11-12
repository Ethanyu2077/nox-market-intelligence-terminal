export const BUCKET = 300_000;
export type WatchCandle = { time: number; close: number; volume: number };
export type WatchFlowBucket = { time: number; buy: number | null; sell: number | null; delta: number | null; cvd: number | null };
export type WatchFlow = {
  buy: number | null; sell: number | null; delta: number | null; cvd: number | null;
  spotDelta: number | null; perpDelta: number | null;
  buckets: WatchFlowBucket[];
  venues: Array<{ exchange: string; marketType: string; buy: number | null; sell: number | null; delta: number | null }>;
  covered: number; requested: number;
  source: 'orderflow';
};
export type WatchOiPoint = { time: number; oiUsd: number };
export type WatchMetricState = 'LIVE' | 'STALE' | 'UNAVAILABLE';
export type WatchMetric = { state: WatchMetricState; source: string | null; at: number | null; error: string | null };
export type WatchMetrics = { price: WatchMetric; kline: WatchMetric; oi: WatchMetric; funding: WatchMetric; spot: WatchMetric; perp: WatchMetric; cvd: WatchMetric };
export type WatchRow = { projectId: string; venue: string; symbol: string; marketType: string; quote: string; candles: WatchCandle[]; error: string | null; funding?: { rate: number; hours: number; time: number } | null;
  priceHistory?: { t: number; p: number }[];
  minuteCloses?: { time: number; close: number }[];
  flow?: WatchFlow | null; oiSeries?: WatchOiPoint[]; metrics?: WatchMetrics;
  collectionMode?: 'active' | 'standard' | 'paused'; hasSpot?: boolean; hasPerp?: boolean; }
export type WatchOverview = { asOf: number; end: number; rows: WatchRow[]; benchmarks: WatchRow[]; cache?: { stale: boolean; at: number } };
export function windowPoints(candles: WatchCandle[], end: number, minutes: number): WatchCandle[] | null {
  const start = end - minutes * 60_000;
  const points = candles.filter(p => p.time >= start && p.time <= end).sort((a,b)=>a.time-b.time);
  if (points.length !== minutes / 5 + 1 || points.some((p,i)=>p.time !== start+i*BUCKET || !Number.isFinite(p.close) || p.close <= 0)) return null;
  return points;
}
export function performance(candles: WatchCandle[], end: number, minutes: number): number | null {
  const points = windowPoints(candles,end,minutes);
  return points ? (points.at(-1)!.close/points[0].close-1)*100 : null;
}

export type WatchIndicator = 'price' | 'cvd' | 'flow' | 'oi';

function observedCloses(candles: WatchCandle[]) {
  return new Map(candles.filter(candle => Number.isFinite(candle.close) && candle.close > 0)
    .map(candle => [candle.time, candle.close]));
}

export function historicalStrengthPoints(
  row: WatchRow, reference: WatchRow | undefined, end: number, minutes: number,
  indicator: WatchIndicator, benchmark: string,
): { t: number; value: number }[] {
  const start = end - minutes * 60_000;
  const observations = indicator === 'price' ? observedCloses(row.candles) : indicator === 'oi'
    ? new Map(row.oiSeries?.map(point => [point.time, point.oiUsd]))
    : new Map(row.flow?.buckets.map(bucket => [bucket.time, indicator === 'flow' ? bucket.delta : bucket.cvd]));
  const benchmarkCloses = indicator === 'price' && benchmark !== 'absolute' ? observedCloses(reference?.candles ?? []) : null;
  let first: number | undefined;
  let firstBenchmark: number | undefined;
  let running = 0;
  const result: { t: number; value: number }[] = [];
  for (const [t, observation] of [...observations].sort(([a], [b]) => a - b)) {
    if (t < start || t > end || (end - t) % BUCKET !== 0) continue;
    if (observation == null || !Number.isFinite(observation)) continue;
    const benchmarkClose = benchmarkCloses?.get(t);
    if (benchmarkCloses && benchmarkClose === undefined) continue;
    // Each comparison starts at its first observed bucket shared by both markets.
    first ??= observation;
    if (indicator === 'oi' && first === 0) return [];
    let value = observation - first;
    if (indicator === 'oi' || indicator === 'price') value = (observation / first - 1) * 100;
    if (benchmarkClose !== undefined) {
      firstBenchmark ??= benchmarkClose;
      value -= (benchmarkClose / firstBenchmark - 1) * 100;
    }
    if (indicator === 'flow') {
      running += observation;
      value = running;
    }
    result.push({ t, value });
  }
  return result;
}

export function volumeRatio(candles: WatchCandle[], index: number): number | null {
  if(index < 12) return null;
  const sample=candles.slice(index-12,index);
  if(sample.some((p,i)=>p.time !== candles[index].time-(12-i)*BUCKET || !Number.isFinite(p.volume) || p.volume<0)) return null;
  const sorted=sample.map(p=>p.volume).sort((a,b)=>a-b); const median=(sorted[5]+sorted[6])/2;
  return median>0 && Number.isFinite(candles[index].volume) && candles[index].volume>=0 ? candles[index].volume/median : null;
}

/** Project-level status from independent metric availability; never all-or-nothing. */
export function watchStatus(row: WatchRow): 'LIVE' | 'PARTIAL' | 'UNAVAILABLE' {
  if (row.error) return row.flow || (row.oiSeries?.length ?? 0) > 0 ? 'PARTIAL' : 'UNAVAILABLE';
  return row.funding ? 'LIVE' : 'PARTIAL';
}

/** Per-metric availability so one failed upstream does not erase the others. */
export function buildWatchMetrics(row: WatchRow): WatchMetrics {
  const lastCandle = row.candles.at(-1)?.time ?? null;
  const lastFlow = row.flow?.buckets.at(-1)?.time ?? null;
  const lastOi = row.oiSeries?.at(-1)?.time ?? null;
  const source = row.venue || null;
  const metric = (ok: boolean, at: number | null, error: string | null = null): WatchMetric => ({ state: ok ? 'LIVE' : 'UNAVAILABLE', source, at, error });
  const flowReason = row.collectionMode && row.collectionMode !== 'active' ? 'COLLECTOR_NOT_STARTED' : 'NO_TRADES_IN_WINDOW';
  const spotReason = row.hasSpot === false ? 'UNSUPPORTED' : flowReason;
  const perpReason = row.hasPerp === false ? 'UNSUPPORTED' : flowReason;
  return {
    price: metric(!row.error && row.candles.length > 0, lastCandle, row.error ?? null),
    kline: metric(!row.error && row.candles.length > 0, lastCandle, row.error ?? null),
    oi: metric((row.oiSeries?.length ?? 0) > 1, lastOi, row.oiSeries ? null : 'OI history unavailable'),
    funding: metric(Boolean(row.funding), row.funding?.time ?? null, row.funding ? null : 'funding unavailable'),
    spot: metric(row.flow?.spotDelta != null, lastFlow, spotReason),
    perp: metric(row.flow?.perpDelta != null, lastFlow, perpReason),
    cvd: metric(row.flow?.cvd != null, lastFlow, perpReason),
  };
}
