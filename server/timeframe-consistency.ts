import type { MarketProject, MarketSeries } from '../shared/types.ts';
import {
  TIMEFRAME_FLOW_COVERAGE_MIN_PCT, TIMEFRAME_INTERVALS, TIMEFRAME_PRICE_THRESHOLDS_PCT,
  type TimeframeAlignment, type TimeframeAlignmentResponse, type TimeframeInterval, type TimeframeObservation,
} from '../shared/timeframe.ts';
import { marketSeries } from './binance.ts';

const CANDLE_MS: Record<TimeframeInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
// A closed OI window is naturally up to one candle old before the next endpoint exists.
// Freshness must allow that closing period plus a small collection lag; a fixed 15m mark
// made normal 1h/4h windows look stale most of the time.
const COLLECTION_LAG_MS = 5 * 60_000;
const FUTURE_TOLERANCE_MS = 60_000;

export function insufficientObservation(interval: TimeframeInterval, reason: string): TimeframeObservation {
  return {
    interval, state: 'insufficient', priceChangePct: null, oiDeltaBase: null, oiDeltaPctBase: null, flowDeltaUsd: null,
    flowCoveragePct: null, windowFrom: null, windowTo: null, freshness: 'unavailable', reasons: [reason],
  };
}

/**
 * One timeframe observation is always a HYPOTHESIS about the latest closed OI window:
 * price change over the same window as the OI delta, aggressor flow over the same buckets.
 * The state only becomes bullish/bearish when price, base OI delta and complete-bucket flow agree.
 */
export function observeTimeframe(interval: TimeframeInterval, series: MarketSeries, now = Date.now()): TimeframeObservation {
  const deltas = series.positionFlow.oiDelta;
  const last = deltas.at(-1), previous = deltas.at(-2);
  if (!last || !previous) return insufficientObservation(interval, 'fewer than two OI snapshots are available');
  const windowMs = last.time - previous.time;
  const candleMs = CANDLE_MS[interval];
  if (!(windowMs > 0)) return insufficientObservation(interval, 'invalid OI window');
  const candleByTime = new Map(series.candles.map((candle) => [candle.time, candle]));
  const current = candleByTime.get(last.time - candleMs);
  const previousCandle = candleByTime.get(previous.time - candleMs);
  if (!current || !previousCandle || !previousCandle.close) return insufficientObservation(interval, 'closing candles for the OI window are unavailable');
  const priceChangePct = (current.close - previousCandle.close) / previousCandle.close * 100;
  const flowPoints = series.positionFlow.volumeFlow.filter((point) => point.time >= previous.time && point.time < last.time);
  const completeFlow = flowPoints.filter((point) => point.complete);
  const expectedBuckets = Math.max(1, Math.round(windowMs / candleMs));
  const flowCoveragePct = Math.min(100, completeFlow.length / expectedBuckets * 100);
  const flowDeltaUsd = completeFlow.length ? completeFlow.reduce((sum, point) => sum + point.deltaNotional, 0) : null;
  const windowAgeMs = now - last.time;
  const futureTimestamp = last.time > now + FUTURE_TOLERANCE_MS;
  const expectedAgeMs = candleMs + COLLECTION_LAG_MS;
  const freshness = futureTimestamp || windowAgeMs > expectedAgeMs ? 'stale' as const : 'live' as const;
  const reasons: string[] = [];
  if (futureTimestamp) reasons.push('latest OI window timestamp is in the future (clock skew); freshness is refused');
  else if (freshness === 'stale') reasons.push(`latest OI window is older than one ${interval} close plus ${Math.round(COLLECTION_LAG_MS / 60_000)}m collection lag`);
  if (flowCoveragePct < TIMEFRAME_FLOW_COVERAGE_MIN_PCT) {
    reasons.push(`complete aggressor-flow buckets ${completeFlow.length}/${expectedBuckets} (${Math.round(flowCoveragePct)}% < ${TIMEFRAME_FLOW_COVERAGE_MIN_PCT}%)`);
    return { interval, state: 'insufficient', priceChangePct, oiDeltaBase: last.deltaBase, oiDeltaPctBase: last.pctBase, flowDeltaUsd, flowCoveragePct, windowFrom: previous.time, windowTo: last.time, freshness, reasons };
  }
  const threshold = TIMEFRAME_PRICE_THRESHOLDS_PCT[interval];
  if (Math.abs(priceChangePct) < threshold) {
    reasons.push(`price change ${priceChangePct.toFixed(3)}% is below the ${interval} threshold ${threshold}%`);
    return { interval, state: 'mixed', priceChangePct, oiDeltaBase: last.deltaBase, oiDeltaPctBase: last.pctBase, flowDeltaUsd, flowCoveragePct, windowFrom: previous.time, windowTo: last.time, freshness, reasons };
  }
  const direction = Math.sign(priceChangePct);
  const oiAgrees = Math.sign(last.deltaBase) === direction && last.deltaBase !== 0;
  const flowAgrees = flowDeltaUsd != null && Math.sign(flowDeltaUsd) === direction && flowDeltaUsd !== 0;
  if (!oiAgrees) reasons.push('base OI delta does not agree with the price direction');
  if (!flowAgrees) reasons.push('aggressor flow does not agree with the price direction');
  if (oiAgrees && flowAgrees && freshness === 'live') {
    return { interval, state: direction > 0 ? 'bullish' : 'bearish', priceChangePct, oiDeltaBase: last.deltaBase, oiDeltaPctBase: last.pctBase, flowDeltaUsd, flowCoveragePct, windowFrom: previous.time, windowTo: last.time, freshness, reasons };
  }
  return { interval, state: 'mixed', priceChangePct, oiDeltaBase: last.deltaBase, oiDeltaPctBase: last.pctBase, flowDeltaUsd, flowCoveragePct, windowFrom: previous.time, windowTo: last.time, freshness, reasons };
}

/**
 * Combines timeframe observations. A directional claim requires at least three valid timeframes
 * that all agree; any bullish/bearish mix is a conflict and a refusal, not a vote.
 */
export function evaluateTimeframeAlignment(observations: TimeframeObservation[]): TimeframeAlignment {
  const valid = observations.filter((observation) => observation.state !== 'insufficient');
  const bullish = valid.filter((observation) => observation.state === 'bullish').length;
  const bearish = valid.filter((observation) => observation.state === 'bearish').length;
  const mixed = valid.filter((observation) => observation.state === 'mixed').length;
  const reasons: string[] = [];
  const invalidation = [
    'The next OI window retraces the price move while flow reverses.',
    'A higher timeframe flips direction or loses complete-bucket flow coverage.',
    'A single venue carries the move while aligned venues stay flat or reverse.',
  ];
  if (!valid.length) {
    reasons.push('no timeframe has complete price, OI and flow windows');
    return { state: 'insufficient', directionalClaimAllowed: false, validTimeframes: 0, alignedTimeframes: 0, reasons, invalidation };
  }
  if (bullish > 0 && bearish > 0) {
    reasons.push(`timeframes conflict: ${bullish} bullish vs ${bearish} bearish`);
    return { state: 'conflict', directionalClaimAllowed: false, validTimeframes: valid.length, alignedTimeframes: 0, reasons, invalidation };
  }
  if (valid.length < 3) {
    reasons.push(`only ${valid.length} valid timeframe(s); at least 3 are required for a directional claim`);
    return { state: 'insufficient', directionalClaimAllowed: false, validTimeframes: valid.length, alignedTimeframes: 0, reasons, invalidation };
  }
  if (mixed > 0) {
    reasons.push(`${mixed} timeframe(s) are mixed (price/OI/flow disagreement or sub-threshold move)`);
    return { state: 'mixed', directionalClaimAllowed: false, validTimeframes: valid.length, alignedTimeframes: 0, reasons, invalidation };
  }
  if (bullish === valid.length || bearish === valid.length) {
    const direction = bullish === valid.length ? 'bullish' : 'bearish';
    reasons.push(`${valid.length} valid timeframes agree (${direction}) with complete flow coverage`);
    return { state: direction === 'bullish' ? 'aligned-bullish' : 'aligned-bearish', directionalClaimAllowed: true, validTimeframes: valid.length, alignedTimeframes: valid.length, reasons, invalidation };
  }
  reasons.push('timeframes do not form a consistent directional picture');
  return { state: 'mixed', directionalClaimAllowed: false, validTimeframes: valid.length, alignedTimeframes: 0, reasons, invalidation };
}

export function buildTimeframeAlignmentResponse(projectId: string, symbol: string, observations: TimeframeObservation[], now = Date.now()): TimeframeAlignmentResponse {
  return {
    projectId,
    symbol,
    generatedAt: now,
    observations,
    alignment: evaluateTimeframeAlignment(observations),
    methodology: [
      'Each observation pairs the latest OI delta window with the closing candle at the same timestamps and the complete aggressor-flow buckets inside that window.',
      `Price thresholds per interval are heuristics (${TIMEFRAME_INTERVALS.map((interval) => `${interval}:${TIMEFRAME_PRICE_THRESHOLDS_PCT[interval]}%`).join(', ')}); they are not calibrated probabilities.`,
      `Flow coverage below ${TIMEFRAME_FLOW_COVERAGE_MIN_PCT}% makes the timeframe insufficient instead of guessing.`,
      'A directional claim requires at least three valid timeframes that all agree; conflicting timeframes produce an explicit refusal (no vote).',
      'Native Binance perpetual windows only; other venues are not mixed into this alignment.',
    ],
  };
}

const cache = new Map<string, { until: number; value: TimeframeAlignmentResponse }>();
export function clearTimeframeCache() { cache.clear(); }

export async function timeframeAlignment(project: MarketProject, fetcher: (symbol: string, interval: TimeframeInterval) => Promise<MarketSeries> = marketSeries, now = Date.now()): Promise<TimeframeAlignmentResponse> {
  const market = project.markets.find((candidate) => candidate.exchange === 'binance' && candidate.marketType === 'perpetual');
  if (!market) throw new Error('A Binance USDT perpetual is required for synchronized timeframe windows');
  const key = `${project.id}:${market.symbol}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const results = await Promise.allSettled(TIMEFRAME_INTERVALS.map((interval) => fetcher(market.symbol, interval)));
  const observations = results.map((result, index) => result.status === 'fulfilled'
    ? observeTimeframe(TIMEFRAME_INTERVALS[index], result.value, now)
    : insufficientObservation(TIMEFRAME_INTERVALS[index], result.reason instanceof Error ? result.reason.message : 'timeframe series unavailable'));
  const response = buildTimeframeAlignmentResponse(project.id, market.symbol, observations, now);
  cache.set(key, { until: Date.now() + 20_000, value: response });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return response;
}
