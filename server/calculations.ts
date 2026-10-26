import type { BacktestResult, CandlePoint, CvdPoint, LinePoint, OiDeltaPoint, PositionFlowSignal, PositionSignalType, VolumeFlowPoint } from '../shared/types.ts';

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
  const ordered = [...trades].sort((a, b) => a.T - b.T || a.a - b.a);
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
  return [...buckets.entries()].map(([time, bucket]) => {
    cumulative += bucket.delta;
    return { time, value: cumulative, delta: bucket.delta, buyNotional: bucket.buy, sellNotional: bucket.sell };
  });
}

export function openInterestUsd(baseQuantity: number, markPrice: number): number {
  return baseQuantity * markPrice;
}

export function fundingCountdown(nextFundingTime: number, now = Date.now()): number {
  return Math.max(0, nextFundingTime - now);
}

export function isFresh(eventTime: number, maxAgeMs: number, now = Date.now()): boolean {
  return now - eventTime <= maxAgeMs;
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
    const usdValue = usdByTime.get(point.time) ?? 0;
    const previousUsd = usdByTime.get(previous.time) ?? 0;
    const deltaBase = point.value - previous.value;
    const deltaUsd = usdValue - previousUsd;
    return {
      time: point.time,
      value: deltaBase,
      baseValue: point.value,
      usdValue,
      deltaBase,
      deltaUsd,
      pctBase: previous.value ? deltaBase / previous.value * 100 : 0,
      pctUsd: previousUsd ? deltaUsd / previousUsd * 100 : 0
    };
  });
  const center = median(raw.map((point) => point.deltaBase));
  const mad = median(raw.map((point) => Math.abs(point.deltaBase - center))) || 1;
  return raw.map((point) => {
    const robustScore = 0.6745 * (point.deltaBase - center) / mad;
    return { ...point, robustScore, spike: Math.abs(robustScore) >= 3.5 };
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
      deltaChangePct: previous && Math.sign(previous) === Math.sign(point.delta) ? (point.delta - previous) / Math.abs(previous) * 100 : null
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

function nearestCandle(candles: CandlePoint[], time: number): CandlePoint | undefined {
  return candles.reduce<CandlePoint | undefined>((best, candle) => !best || Math.abs(candle.time - time) < Math.abs(best.time - time) ? candle : best, undefined);
}

export function detectPositionFlowSignals(candles: CandlePoint[], oiDelta: OiDeltaPoint[], volumeFlow: VolumeFlowPoint[], now = Date.now()): PositionFlowSignal[] {
  const candleIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  const flowByTime = new Map(volumeFlow.map((point) => [point.time, point]));
  const medianAbsFlow = median(volumeFlow.map((point) => Math.abs(point.deltaNotional))) || 1;
  const signals: PositionFlowSignal[] = [];
  for (const oi of oiDelta) {
    const candle = nearestCandle(candles, oi.time);
    if (!candle) continue;
    const index = candleIndex.get(candle.time) ?? -1;
    const previous = candles[index - 1];
    if (!previous) continue;
    const priceChangePct = previous.close ? (candle.close - previous.close) / previous.close * 100 : 0;
    const flow = flowByTime.get(candle.time) ?? null;
    const flowDelta = flow?.deltaNotional ?? null;
    const priceThreshold = 0.08;
    const oiMeaningful = Math.abs(oi.pctBase) >= 0.05 || oi.spike;
    let type: PositionSignalType | null = null;
    if (oiMeaningful && oi.deltaBase > 0 && priceChangePct > priceThreshold && (flowDelta == null || flowDelta >= 0)) type = 'potential_long_buildup';
    else if (oiMeaningful && oi.deltaBase > 0 && priceChangePct < -priceThreshold && (flowDelta == null || flowDelta <= 0)) type = 'potential_short_buildup';
    else if (oiMeaningful && oi.deltaBase < 0 && priceChangePct < -priceThreshold && (flowDelta == null || flowDelta <= 0)) type = 'potential_long_liquidation';
    else if (oiMeaningful && oi.deltaBase < 0 && priceChangePct > priceThreshold && (flowDelta == null || flowDelta >= 0)) type = 'potential_short_covering';
    else if (flow && Math.abs(flowDelta ?? 0) >= medianAbsFlow * 2.5 && Math.abs(priceChangePct) < priceThreshold) type = 'market_absorption';
    else if (oiMeaningful && flowDelta != null && Math.sign(priceChangePct) !== Math.sign(flowDelta)) type = 'price_oi_delta_divergence';
    if (!type) continue;
    const flowAligned = flowDelta == null ? false : Math.sign(flowDelta) === Math.sign(priceChangePct);
    const confidence = Math.round(Math.min(92, 42 + Math.min(24, Math.abs(oi.robustScore) * 5) + Math.min(16, Math.abs(priceChangePct) * 18) + (flowAligned ? 10 : 0)));
    const observed = [`Price ${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(3)}%`, `OI Δ ${oi.deltaBase >= 0 ? '+' : ''}${oi.deltaBase.toFixed(3)} base (${oi.pctBase.toFixed(3)}%)`];
    if (flowDelta != null) observed.push(`Volume Δ ${flowDelta >= 0 ? '+' : ''}${flowDelta.toFixed(2)} USDT`);
    signals.push({
      id: `${type}:${oi.time}`, time: oi.time, type, label: SIGNAL_LABELS[type], confidence,
      priceChangePct, oiDeltaBase: oi.deltaBase, oiDeltaPct: oi.pctBase, volumeDeltaUsd: flowDelta,
      observed,
      evidence: [oi.spike ? `OI delta is a robust spike (${oi.robustScore.toFixed(2)} MAD score)` : 'OI moved beyond the configured materiality threshold', flowAligned ? 'Aggressive flow aligns with price direction' : 'Price and OI relationship matches the pattern rule'],
      counterevidence: [flowDelta == null ? 'Aggressor-flow coverage is unavailable for this historical bar' : !flowAligned ? 'Aggressive flow does not confirm price direction' : 'Public data cannot identify opening versus closing counterparties'],
      freshness: isFresh(oi.time, 15 * 60_000, now) ? 'live' : 'stale',
      inferenceNotice: 'Probabilistic classification only; long/short opening or liquidation is not directly observed.'
    });
  }
  return signals.slice(-80).reverse();
}

function expectedDirection(type: PositionSignalType): number | null {
  if (type === 'potential_long_buildup' || type === 'potential_short_covering') return 1;
  if (type === 'potential_short_buildup' || type === 'potential_long_liquidation') return -1;
  return null;
}

export function backtestPositionSignals(signals: PositionFlowSignal[], candles: CandlePoint[], horizonBars = 3): BacktestResult[] {
  const candleIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  const types = [...new Set(signals.map((signal) => signal.type))];
  return types.map((type) => {
    const matches = signals.filter((signal) => signal.type === type);
    const outcomes = matches.flatMap((signal) => {
      const index = candleIndex.get(nearestCandle(candles, signal.time)?.time ?? -1);
      if (index == null || !candles[index + horizonBars]) return [];
      return [(candles[index + horizonBars].close - candles[index].close) / candles[index].close * 100];
    });
    const direction = expectedDirection(type);
    const hits = direction == null ? [] : outcomes.filter((value) => Math.sign(value) === direction);
    return {
      type, label: SIGNAL_LABELS[type], samples: matches.length, resolvedSamples: outcomes.length,
      hitRate: direction == null || !outcomes.length ? null : hits.length / outcomes.length * 100,
      averageForwardReturnPct: outcomes.length ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length : null,
      horizonBars,
      caveat: outcomes.length < 20 ? 'Low sample size; descriptive only, not statistically reliable.' : 'Historical association only; fees, slippage and regime changes are excluded.'
    };
  });
}
