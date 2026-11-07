import type { BacktestResult, CandlePoint, CvdPoint, LinePoint, OiDeltaPoint, PositionFlowSignal, PositionSignalType, VolumeFlowPoint } from '../shared/types.ts';
import { computeLedger } from '../shared/execution-ledger.ts';
import { researchWindow } from '../shared/research-window.ts';

export interface RawAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export function signedTradeNotional(trade: RawAggTrade): number {
  const notional = Number(trade.p) * Number(trade.q);
  // Binance m=true means the buyer is maker, therefore the aggressor is a seller.
  return trade.m ? -notional : notional;
}

export function aggregateCvd(trades: RawAggTrade[], bucketMs = 60_000): CvdPoint[] {
  if (!trades.length) return [];
  // Venue REST/WS overlap can repeat the same aggregate trade id; dedupe before bucketing.
  const seen = new Set<number>();
  const ordered = trades
    .filter((trade) => { if (seen.has(trade.a)) return false; seen.add(trade.a); return true; })
    .sort((a, b) => a.T - b.T || a.a - b.a);
  const buckets = new Map<number, { buy: number; sell: number; delta: number }>();
  for (const trade of ordered) {
    const time = Math.floor(trade.T / bucketMs) * bucketMs;
    const signed = signedTradeNotional(trade);
    const bucket = buckets.get(time) ?? { buy: 0, sell: 0, delta: 0 };
    if (signed >= 0) bucket.buy += signed;
    else bucket.sell += -signed;
    bucket.delta += signed;
    buckets.set(time, bucket);
  }
  let cumulative = 0;
  const windowFirst = ordered[0].T, windowLast = ordered[ordered.length - 1].T;
  return [...buckets.entries()].map(([time, bucket]) => {
    cumulative += bucket.delta;
    // A bucket is complete only if the returned tape spans its whole interval; the bucket that
    // contains the API window start/end is truncated by the 1000-trade limit and is incomplete.
    const complete = time >= windowFirst && time + bucketMs <= windowLast;
    return { time, value: cumulative, delta: bucket.delta, buyNotional: bucket.buy, sellNotional: bucket.sell, complete };
  });
}

export function openInterestUsd(baseQuantity: number, markPrice: number): number {
  return baseQuantity * markPrice;
}

export function fundingCountdown(nextFundingTime: number, now = Date.now()): number {
  return Math.max(0, nextFundingTime - now);
}

export function isFresh(eventTime: number, maxAgeMs: number, now = Date.now()): boolean {
  // Future timestamps are not "fresh": clock skew must not make stale/unknown data look live.
  return eventTime <= now && now - eventTime <= maxAgeMs;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function computeOiDeltas(oiBase: LinePoint[], oiUsd: LinePoint[]): OiDeltaPoint[] {
  const usdByTime = new Map(oiUsd.map((point) => [point.time, point.value]));
  const raw = oiBase.slice(1).map((point, index) => {
    const previous = oiBase[index];
    // USD open interest is a separate venue field. When a timestamp is missing on either
    // side the USD delta stays null: a zero would be a fabricated observation.
    const usdValue = usdByTime.get(point.time) ?? null;
    const previousUsd = usdByTime.get(previous.time) ?? null;
    const deltaBase = point.value - previous.value;
    const deltaUsd = usdValue != null && previousUsd != null ? usdValue - previousUsd : null;
    return {
      time: point.time,
      value: deltaBase,
      baseValue: point.value,
      usdValue,
      deltaBase,
      deltaUsd,
      pctBase: previous.value ? deltaBase / previous.value * 100 : 0,
      pctUsd: previousUsd != null && previousUsd !== 0 && deltaUsd != null ? deltaUsd / previousUsd * 100 : null
    };
  });
  // Baseline must be point-in-time: each score uses only PRIOR deltas (up to 60), never the
  // full fetched window. Otherwise appending future OI rewrites historical spike labels.
  const MIN_PRIOR = 4;
  const history: number[] = [];
  return raw.map((point) => {
    const sample = history.slice(-60);
    const center = sample.length >= MIN_PRIOR ? median(sample) : null;
    const mad = center != null ? (median(sample.map((value) => Math.abs(value - center))) || 0) : 0;
    const robustScore = center != null && mad > 0 ? 0.6745 * (point.deltaBase - center) / mad : 0;
    history.push(point.deltaBase);
    return { ...point, robustScore, spike: robustScore !== 0 && Math.abs(robustScore) >= 3.5 };
  });
}

export function computeVolumeFlow(cvd: CvdPoint[]): VolumeFlowPoint[] {
  return cvd.map((point, index) => {
    const gross = point.buyNotional + point.sellNotional;
    const previous = cvd[index - 1]?.delta;
    return {
      time: point.time,
      value: point.delta,
      buyNotional: point.buyNotional,
      sellNotional: point.sellNotional,
      deltaNotional: point.delta,
      imbalancePct: gross ? point.delta / gross * 100 : 0,
      deltaChangePct: previous && Math.sign(previous) === Math.sign(point.delta) ? (point.delta - previous) / Math.abs(previous) * 100 : null,
      complete: point.complete
    };
  });
}

const SIGNAL_LABELS: Record<PositionSignalType, string> = {
  potential_long_buildup: 'Potential Long Build-up',
  potential_short_buildup: 'Potential Short Build-up',
  potential_long_liquidation: 'Potential Long Liquidation',
  potential_short_covering: 'Potential Short Covering',
  market_absorption: 'Market Absorption',
  price_oi_delta_divergence: 'Price / OI / Delta Divergence'
};

/** Minimum share of window flow buckets needed before a flow-dependent label may be asserted. */
export const FLOW_COVERAGE_MIN_PCT = 80;

type SignalEvidence = { required: string[]; alternatives: string[]; invalidation: string[] };

// Every label is a hypothesis. `required` names the data that must exist before the label may be
// asserted; `alternatives` and `invalidation` force the same observations to be read against
// competing explanations and against future disconfirmation.
const SIGNAL_EVIDENCE: Record<PositionSignalType, SignalEvidence> = {
  potential_long_buildup: {
    required: ['synchronised price window', 'base-unit OI delta', 'aggressor-flow coverage'],
    alternatives: [
      'Short covering rather than new long opening: aggressive buying can close shorts.',
      'Spot-led buying with perpetual participants passively following.',
      'USD OI can rise from mark-price revaluation even when base OI is flat.'
    ],
    invalidation: [
      'The next 1-3 bars retrace the move while OI declines.',
      'Aggressive flow turns net sell while OI keeps rising (more compatible with short build-up / turnover).',
      'Only one venue shows the pattern while aligned venues show opposite OI or flow.'
    ]
  },
  potential_short_buildup: {
    required: ['synchronised price window', 'base-unit OI delta', 'aggressor-flow coverage'],
    alternatives: [
      'Long liquidation/unwinding rather than new short opening: aggressive selling can close longs.',
      'Spot-led selling with perpetual participants following.',
      'OI USD can fall/rise from price revaluation rather than position change.'
    ],
    invalidation: [
      'The next 1-3 bars recover the move while OI declines.',
      'Aggressive flow turns net buy while OI keeps rising (short covering / turnover).',
      'Venue-level OI/flow directions conflict instead of confirming.'
    ]
  },
  potential_long_liquidation: {
    required: ['synchronised price window', 'base-unit OI delta', 'aggressor-flow coverage', 'per-event liquidation data'],
    alternatives: [
      'Ordinary long reduction / deleveraging without forced liquidation.',
      'Short opening into a falling market (OI behaviour differs by venue and position changes).',
      'A data gap or cross-venue price dislocation rather than a real liquidation cascade.'
    ],
    invalidation: [
      'No per-event liquidation prints exist for the window.',
      'Price recovers quickly while OI rebounds (liquidity recovery rather than cascade).',
      'OI decline is fully explained by position turnover at unchanged price.'
    ]
  },
  potential_short_covering: {
    required: ['synchronised price window', 'base-unit OI delta', 'aggressor-flow coverage'],
    alternatives: [
      'New long opening rather than short covering: both can raise price and OI.',
      'Spot-led bid with perp basis compression rather than position closing.',
      'Funding-driven carry unwind that does not imply directional conviction.'
    ],
    invalidation: [
      'OI keeps rising on further price strength (new positioning rather than covering).',
      'Aggressive flow fades while price holds (absorption, not covering).',
      'Cross-venue OI moves opposite to the primary venue.'
    ]
  },
  market_absorption: {
    required: ['aggressor-flow coverage', 'sequence-correct L2 depth', 'price response window'],
    alternatives: [
      'Two-sided turnover / iceberg execution rather than genuine absorption.',
      'Depth exists but the spread widened; no liquidity replenishment occurred.',
      'Single-venue thin book noise that other venues do not confirm.'
    ],
    invalidation: [
      'Price subsequently breaks in the direction of aggressive flow.',
      'Depth is unavailable or the order-book sequence is incomplete.',
      'Aggressive flow is small relative to the venue depth baseline.'
    ]
  },
  price_oi_delta_divergence: {
    required: ['synchronised price window', 'base-unit OI delta', 'aggressor-flow coverage'],
    alternatives: [
      'CVD coverage window is short or venue selection biased.',
      'OI changed through price revaluation rather than position change.',
      'The apparent divergence disappears once the flow window is extended.'
    ],
    invalidation: [
      'The next window shows price and flow aligned again.',
      'Extending the CVD window removes the divergence.',
      'OI and flow come from different, non-aligned venues.'
    ]
  }
};

export interface SignalRuleOptions {
  /** Consecutive OI steps combined into one evaluation window. 1 is the original single-step rule. */
  windowSteps?: number;
  /**
   * Replace the fixed 0.08% price / 0.05% OI materiality thresholds with this market's own
   * q-quantile of |move| over prior windows. null keeps the fixed thresholds.
   */
  adaptive?: { quantile: number; lookbackWindows: number; minHistory: number } | null;
  /** Minimum |buy − sell| / (buy + sell) of the window's complete flow, in percent. 0 keeps the sign-only rule. */
  minFlowImbalancePct?: number;
  /** Number of most recent signals returned, newest first. */
  limit?: number;
}

/** Fixed-threshold single-step defaults; V3 uses a same-duration absorption baseline. */
export const DEFAULT_SIGNAL_RULES: Required<SignalRuleOptions> = { windowSteps: 1, adaptive: null, minFlowImbalancePct: 0, limit: 80 };

function quantileOf(values: number[], q: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * q, lo = Math.floor(position), hi = Math.ceil(position);
  return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo);
}

function signalRules(options: SignalRuleOptions): Required<SignalRuleOptions> {
  const rules = { ...DEFAULT_SIGNAL_RULES, ...options };
  if (!Number.isInteger(rules.windowSteps) || rules.windowSteps < 1) throw new Error('windowSteps must be a positive integer');
  if (!Number.isFinite(rules.minFlowImbalancePct) || rules.minFlowImbalancePct < 0 || rules.minFlowImbalancePct > 100) throw new Error('minFlowImbalancePct must be between 0 and 100');
  if (!(rules.limit >= 1)) throw new Error('limit must be at least 1');
  const adaptive = rules.adaptive;
  if (adaptive && (!(adaptive.quantile > 0 && adaptive.quantile < 1) || !Number.isInteger(adaptive.lookbackWindows) || adaptive.lookbackWindows < 1 || !Number.isInteger(adaptive.minHistory) || adaptive.minHistory < 1 || adaptive.minHistory > adaptive.lookbackWindows)) {
    throw new Error('adaptive needs 0 < quantile < 1 and integer 1 <= minHistory <= lookbackWindows');
  }
  return rules;
}

export function detectPositionFlowSignals(candles: CandlePoint[], oiDelta: OiDeltaPoint[], volumeFlow: VolumeFlowPoint[], now = Date.now(), options: SignalRuleOptions = {}): PositionFlowSignal[] {
  const { windowSteps: steps, adaptive, minFlowImbalancePct: minImbalance, limit } = signalRules(options);
  const candleByTime = new Map(candles.map((candle) => [candle.time, candle]));
  const candleMs = candles.length > 1 ? candles[1].time - candles[0].time : 0;
  const signals: PositionFlowSignal[] = [];
  // |price %| and |OI %| of every earlier evaluated window, for the adaptive thresholds.
  const priceHistory: number[] = [], oiHistory: number[] = [];
  // OI delta point `i` covers (oi[i-1].time, oi[i].time]. Truly synchronised price is the candle
  // whose close falls exactly on the OI timestamp (start = oi.time - candleMs), and the aggressor
  // flow is the bucket range in between. This prevents 1m price/CVD being paired with a 5m OI
  // delta and prevents the bar that STARTS at the snapshot from leaking forward data.
  for (let oiIndex = steps; candleMs > 0 && oiIndex < oiDelta.length; oiIndex++) {
    const oi = oiDelta[oiIndex], previousOi = oiDelta[oiIndex - steps];
    const windowMs = oi.time - previousOi.time;
    if (!(windowMs > 0)) continue;
    const candle = candleByTime.get(oi.time - candleMs);
    const previous = candleByTime.get(previousOi.time - candleMs);
    if (!candle || !previous || !previous.close) continue;
    const priceChangePct = (candle.close - previous.close) / previous.close * 100;
    // Flow anomaly baseline also uses only buckets BEFORE the OI window.
    const priorBuckets = volumeFlow.filter(point => point.time < previousOi.time && point.complete);
    const priorByTime = new Map(priorBuckets.map(point => [point.time, point]));
    const priorFlow = priorBuckets.slice(-60).flatMap(point => {
      const start = point.time + candleMs - windowMs;
      let total = 0;
      for (let time = start; time <= point.time; time += candleMs) {
        const bucket = priorByTime.get(time);
        if (!bucket) return [];
        total += bucket.deltaNotional;
      }
      return [Math.abs(total)];
    });
    const medianAbsFlow = priorFlow.length >= 20 ? median(priorFlow) : null;
    const flowPoints = volumeFlow.filter((point) => point.time >= previousOi.time && point.time < oi.time);
    // Only COMPLETE buckets may certify coverage or contribute to the window delta. The first/last
    // buckets of the returned 1000-trade tape are truncated by the API limit and are ignored here.
    const completeFlowPoints = flowPoints.filter((point) => point.complete);
    const flowDelta = completeFlowPoints.length ? completeFlowPoints.reduce((sum, point) => sum + point.deltaNotional, 0) : null;
    const flowGross = completeFlowPoints.reduce((sum, point) => sum + point.buyNotional + point.sellNotional, 0);
    const flowImbalancePct = flowDelta != null && flowGross > 0 ? flowDelta / flowGross * 100 : null;
    const expectedWindowBars = candleMs > 0 ? Math.max(1, Math.round(windowMs / candleMs)) : 1;
    const flowCoveragePct = expectedWindowBars ? Math.min(100, completeFlowPoints.length / expectedWindowBars * 100) : null;
    const flowUsable = flowCoveragePct != null && flowCoveragePct >= FLOW_COVERAGE_MIN_PCT;
    // A single step keeps the venue's own delta and spike score; wider windows span several OI steps.
    const windowPoints = oiDelta.slice(oiIndex - steps + 1, oiIndex + 1);
    const oiDeltaBase = steps === 1 ? oi.deltaBase : oi.baseValue - previousOi.baseValue;
    const oiPctBase = steps === 1 ? oi.pctBase : previousOi.baseValue ? oiDeltaBase / previousOi.baseValue * 100 : 0;
    const oiSpike = windowPoints.some((point) => point.spike);
    const oiScore = windowPoints.reduce((best, point) => Math.abs(point.robustScore) > Math.abs(best) ? point.robustScore : best, 0);
    // Adaptive materiality: a move must exceed this market's own q-quantile of PRIOR window moves.
    // Windows without enough prior history produce no label rather than falling back to fixed values.
    const priorPrice = priceHistory.slice(-(adaptive?.lookbackWindows ?? 0));
    const priorOi = oiHistory.slice(-(adaptive?.lookbackWindows ?? 0));
    priceHistory.push(Math.abs(priceChangePct));
    oiHistory.push(Math.abs(oiPctBase));
    if (adaptive && priorPrice.length < adaptive.minHistory) continue;
    const priceThreshold = adaptive ? quantileOf(priorPrice, adaptive.quantile) : 0.08;
    const oiThreshold = adaptive ? quantileOf(priorOi, adaptive.quantile) : 0.05;
    const oiMeaningful = adaptive ? Math.abs(oiPctBase) > oiThreshold : Math.abs(oiPctBase) >= oiThreshold || oiSpike;
    // With a minimum imbalance, flow must actively confirm the direction; at 0 the original rule
    // (missing flow allowed, then withheld by the coverage gate) is kept unchanged.
    const flowUp = minImbalance > 0 ? flowImbalancePct != null && flowImbalancePct >= minImbalance : flowDelta == null || flowDelta >= 0;
    const flowDown = minImbalance > 0 ? flowImbalancePct != null && flowImbalancePct <= -minImbalance : flowDelta == null || flowDelta <= 0;
    let type: PositionSignalType | null = null;
    if (oiMeaningful && oiDeltaBase > 0 && priceChangePct > priceThreshold && flowUp) type = 'potential_long_buildup';
    else if (oiMeaningful && oiDeltaBase > 0 && priceChangePct < -priceThreshold && flowDown) type = 'potential_short_buildup';
    else if (oiMeaningful && oiDeltaBase < 0 && priceChangePct < -priceThreshold && flowDown) type = 'potential_long_liquidation';
    else if (oiMeaningful && oiDeltaBase < 0 && priceChangePct > priceThreshold && flowUp) type = 'potential_short_covering';
    // "Flat" price for absorption is the market's median prior move when adaptive; the materiality
    // quantile would call almost every window flat. A zero flow baseline can never certify a surge.
    else if (flowDelta != null && medianAbsFlow != null && medianAbsFlow > 0 && Math.abs(flowDelta) >= medianAbsFlow * 2.5 && Math.abs(priceChangePct) < (adaptive ? quantileOf(priorPrice, 0.5) : priceThreshold)) type = 'market_absorption';
    else if (oiMeaningful && flowDelta != null && Math.sign(priceChangePct) !== Math.sign(flowDelta)) type = 'price_oi_delta_divergence';
    if (!type) continue;
    const evidenceSpec = SIGNAL_EVIDENCE[type];
    // Evidence gates: a pattern with missing required data is recorded but explicitly WITHHELD.
    // It must never be counted as a directional inference or a hit in the reliability table.
    const missing: string[] = [];
    if (!flowUsable) missing.push(`complete aggressor-flow buckets ${completeFlowPoints.length}/${expectedWindowBars} (${Math.round(flowCoveragePct ?? 0)}% < ${FLOW_COVERAGE_MIN_PCT}%; partial window-edge buckets ignored)`);
    if (type === 'potential_long_liquidation') missing.push('no per-event liquidation data (only a partial Binance snapshot feed is available)');
    if (type === 'market_absorption') missing.push('no sequence-correct L2 depth data (only REST best bid/ask)');
    const status = missing.length ? 'withheld' as const : 'hypothesis' as const;
    const flowAligned = flowDelta == null ? false : Math.sign(flowDelta) === Math.sign(priceChangePct);
    const confidence = Math.round(Math.min(92, 42 + Math.min(24, Math.abs(oiScore) * 5) + Math.min(16, Math.abs(priceChangePct) * 18) + (flowAligned ? 10 : 0)));
    const observed = [`Price ${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(3)}%`, `OI Δ ${oiDeltaBase >= 0 ? '+' : ''}${oiDeltaBase.toFixed(3)} base (${oiPctBase.toFixed(3)}%)`];
    if (flowDelta != null) observed.push(`Volume Δ ${flowDelta >= 0 ? '+' : ''}${flowDelta.toFixed(2)} USDT${flowImbalancePct != null ? ` (imbalance ${flowImbalancePct.toFixed(1)}%)` : ''}`);
    const evidence = [oiSpike ? `OI delta is a robust spike (${oiScore.toFixed(2)} MAD score)` : oiMeaningful ? 'OI moved beyond the configured materiality threshold' : 'OI materiality threshold not exceeded', flowAligned ? 'Aggressive flow aligns with price direction' : 'Aggressive flow does not align with price direction'];
    if (type === 'market_absorption') evidence.push('Window flow exceeds 2.5x the median absolute flow of complete prior windows of the SAME duration; price remains below the flat-price threshold');
    if (adaptive) evidence.push(`Prior ${priorPrice.length} windows: ${Math.round(adaptive.quantile * 100)}th percentile thresholds price=${priceThreshold.toFixed(3)}%, OI=${oiThreshold.toFixed(3)}%; price passed=${Math.abs(priceChangePct) > priceThreshold}, OI passed=${Math.abs(oiPctBase) > oiThreshold}`);
    if (steps > 1) evidence.push(`Window spans ${steps} OI steps (${Math.round(windowMs / 60_000)}m)`);
    signals.push({
      id: `${type}:${oi.time}`, time: oi.time, type, label: SIGNAL_LABELS[type], status,
      confidence, confidenceBasis: 'heuristic-rule-uncalibrated',
      priceChangePct, oiDeltaBase, oiDeltaPct: oiPctBase, volumeDeltaUsd: flowDelta,
      observed,
      evidence,
      counterevidence: [flowDelta == null ? 'Aggressor-flow coverage is unavailable for this historical bar' : !flowAligned ? 'Aggressive flow does not confirm price direction' : 'Public data cannot identify opening versus closing counterparties'],
      alternatives: evidenceSpec.alternatives,
      invalidation: evidenceSpec.invalidation,
      missing,
      coverage: { expectedWindowBars, flowBars: completeFlowPoints.length, flowCoveragePct, depth: 'unavailable', liquidationEvents: 'unavailable' },
      withheldReason: missing.length ? missing.join('; ') : null,
      freshness: isFresh(oi.time, 15 * 60_000, now) ? 'live' : 'stale',
      inferenceNotice: 'Probabilistic classification only; long/short opening or liquidation is not directly observed. Confidence is a heuristic rule score, not a calibrated probability.'
    });
  }
  return signals.slice(-limit).reverse();
}

function expectedDirection(type: PositionSignalType): number | null {
  if (type === 'potential_long_buildup' || type === 'potential_short_covering') return 1;
  if (type === 'potential_short_buildup' || type === 'potential_long_liquidation') return -1;
  return null;
}

function forwardOutcome(candles: CandlePoint[], index: number, horizonBars: number, asOf = Date.now()): number | null {
  // Enter at the bar open at/after the signal timestamp, never at that bar's future close. Exit at
  // the close of the (horizonBars-1)-th following bar so exposure equals exactly horizonBars bars.
  return researchWindow(candles, index, horizonBars, { end: asOf })?.priceReturnPct ?? null;
}

export function backtestPositionSignals(signals: PositionFlowSignal[], candles: CandlePoint[], horizonBars = 3, asOf = Date.now()): BacktestResult[] {
  if (!Number.isInteger(horizonBars) || horizonBars < 1) throw new Error('horizonBars must be a positive integer');
  const candleIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  const types = [...new Set(signals.map((signal) => signal.type))];
  return types.map((type) => {
    const all = signals.filter((signal) => signal.type === type);
    const hypothesized = all.filter((signal) => signal.status === 'hypothesis');
    const direction = expectedDirection(type);
    const resolved = hypothesized.flatMap((signal) => {
      // Exact candle only: a nearest-candle fallback could pick a bar BEFORE the signal time.
      const index = candleIndex.get(signal.time);
      if (index == null) return [];
      const window = researchWindow(candles, index, horizonBars, { availableAt: signal.time, end: asOf });
      if (!window) return [];
      const ledger = direction == null ? null : computeLedger({ side: direction === 1 ? 'long' : 'short', quantity: 1, entryPrice: window.entryPrice, exitPrice: window.exitPrice, feeBpsPerSide: 5, slippageBpsPerSide: 1 });
      return [{ time: signal.time, value: window.priceReturnPct, netBeforeFunding: ledger?.notionalReturnPct ?? null }];
    });
    const hits = direction == null ? [] : resolved.filter((outcome) => Math.sign(outcome.value) === direction);
    const hitRate = direction == null || !resolved.length ? null : hits.length / resolved.length * 100;
    // Unconditional baseline over the same fetched window: what a coin-flip-with-window-drift
    // rule would have scored, so the signal hit rate is never read as an edge on its own.
    const baselineOutcomes = direction == null ? [] : candles.flatMap((_, index) => {
      const value = forwardOutcome(candles, index, horizonBars, asOf);
      return value == null ? [] : [value];
    });
    const baselineHitRate = direction == null || !baselineOutcomes.length ? null : baselineOutcomes.filter((value) => Math.sign(value) === direction).length / baselineOutcomes.length * 100;
    const liftPct = hitRate != null && baselineHitRate != null ? hitRate - baselineHitRate : null;
    // Chronological holdout: last 30% of resolved signals by event time (minimum 3 samples).
    const ordered = [...resolved].sort((a, b) => a.time - b.time);
    // At least 10 resolved samples before any holdout rate is displayed; 1-2 samples are noise.
    const holdoutCount = ordered.length >= 10 ? Math.max(1, Math.round(ordered.length * 0.3)) : 0;
    const holdoutResolved = holdoutCount ? ordered.slice(-holdoutCount) : [];
    const holdoutStart = holdoutResolved[0]?.time ?? null;
    const holdoutHits = direction == null ? [] : holdoutResolved.filter((outcome) => Math.sign(outcome.value) === direction);
    const holdout = holdoutStart == null ? null : {
      samples: hypothesized.filter((signal) => signal.time >= holdoutStart).length,
      resolvedSamples: holdoutResolved.length,
      hitRate: direction == null || !holdoutResolved.length ? null : holdoutHits.length / holdoutResolved.length * 100
    };
    const edgeStatement = direction == null
      ? 'Descriptive structure only; no directional edge is defined or claimed.'
      : hypothesized.length === 0
        ? 'All observations were withheld by evidence gates; no reliability claim is made.'
        : resolved.length < 20
          ? `Low resolved sample (${resolved.length}); descriptive only, not a validated edge.`
          : 'In-sample descriptive gross directional comparison against a baseline; windows overlap, chronological holdout is not true out-of-sample. Separate ledger scenario includes assumed fees/slippage but excludes funding and account capital constraints.';
    const net = resolved.flatMap(outcome => outcome.netBeforeFunding == null ? [] : [outcome.netBeforeFunding]);
    return {
      type, label: SIGNAL_LABELS[type], samples: hypothesized.length, resolvedSamples: resolved.length,
      withheldSamples: all.length - hypothesized.length,
      hitRate, averageForwardReturnPct: resolved.length ? resolved.reduce((sum, outcome) => sum + outcome.value, 0) / resolved.length : null,
      baselineHitRate, liftPct, holdout,
      horizonBars,
      execution: { version: 'nox-ledger-v1', ruleVersion: 'position-flow-v3', feeBpsPerSide: 5, slippageBpsPerSide: 1, funding: 'unavailable', samples: net.length,
        averageNetBeforeFundingPct: net.length ? net.reduce((sum, value) => sum + value, 0) / net.length : null,
        positiveAfterCostsPct: net.length ? net.filter(value => value > 0).length / net.length * 100 : null,
        basis: 'Hypothetical fixed-base linear position, next-bar-open entry, completed contiguous bars only. Costs are assumptions, not venue/account fees. Funding, latency, capital allocation and mark-to-market drawdown are NOT included; not an account return.' },
      edgeStatement,
      caveat: resolved.length < 20 ? 'Low sample size; descriptive only, not statistically reliable. Overlapping forward windows are not independent.' : 'Gross hit rate excludes costs. Ledger scenario is before funding, with assumed costs; overlapping samples, unmodeled latency and regime changes prevent a validated edge claim.'
    };
  });
}


/**
 * A series whose last candle is older than three intervals (and at least 15 minutes) is
 * stale: signals must be withheld rather than computed on an old window.
 */
export function isSeriesStale(lastCandleTime: number | null | undefined, interval: string, now = Date.now()): boolean {
  if (!lastCandleTime) return true;
  const value = Number(interval.slice(0, -1));
  const step = value * (interval.endsWith('m') ? 60_000 : 3_600_000);
  return now - lastCandleTime > Math.max(3 * step, 15 * 60_000);
}
