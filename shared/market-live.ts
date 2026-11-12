import type { ExchangeId, MarketSeries, Overview } from './types.ts';

type PriceField = 'price' | 'markPrice' | 'change24hPct' | 'volume24hBase' | 'volume24hUsd' |
  'oiBase' | 'oiUsd' | 'fundingRate' | 'nextFundingTime';
export function hasMarketStream(exchange: string, marketType: string) {
  return ['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin'].includes(exchange) ||
    (marketType === 'perpetual' && (exchange === 'mexc' || exchange === 'aster'));
}
export type MarketQuote = Partial<Record<PriceField, { value: number; at: number }>>;
export type TapePrint = [id: number, time: number, signedNotional: number];
export type MarketConnection = 'connecting' | 'stale' | 'degraded' | 'live';
export interface MarketFrame {
  exchange: ExchangeId;
  symbol: string;
  marketType: 'spot' | 'perpetual';
  state: MarketConnection;
  quote: MarketQuote;
  trades: TapePrint[];
}

/** A REST snapshot and WS replay can overlap. Count each observed aggregate trade once. */
export function appendMarketTrades(series: MarketSeries, trades: TapePrint[], bucketMs: number): MarketSeries {
  const cvd = [...series.cvd];
  const volumeFlow = [...series.positionFlow.volumeFlow];
  let lastId = series.lastTradeId ?? -1, count = 0, latestTime = series.eventTime;
  for (const [id, at, notional] of trades) {
    if (id <= lastId || (series.lastTradeId == null && at <= series.eventTime)) continue;
    const time = Math.floor(at / bucketMs) * bucketMs;
    const last = cvd.at(-1);
    if (last && time < last.time) continue;
    const sameBucket = last?.time === time;
    const buyNotional = (sameBucket ? last.buyNotional : 0) + Math.max(notional, 0);
    const sellNotional = (sameBucket ? last.sellNotional : 0) + Math.max(-notional, 0);
    const delta = buyNotional - sellNotional;
    const point = { time, value: (last?.value ?? 0) + notional, delta, buyNotional, sellNotional, complete: false };
    if (sameBucket) cvd[cvd.length - 1] = point; else cvd.push(point);
    const volume = { time, value: delta, buyNotional, sellNotional, deltaNotional: delta,
      imbalancePct: delta / (buyNotional + sellNotional) * 100, deltaChangePct: null, complete: false };
    if (volumeFlow.at(-1)?.time === time) volumeFlow[volumeFlow.length - 1] = volume;
    else volumeFlow.push(volume);
    latestTime = Math.max(latestTime, at);
    lastId = id;
    count++;
  }
  return count ? { ...series, lastTradeId: lastId, eventTime: latestTime, cvd: cvd.slice(-120),
    positionFlow: { ...series.positionFlow, volumeFlow: volumeFlow.slice(-120) },
    coverage: { ...series.coverage, tradeCount: series.coverage.tradeCount + count } } : series;
}

export function applyMarketQuote(overview: Overview, quote: MarketQuote, baselineAt = overview.eventTime) {
  const next = {...overview};
  for (const field of Object.keys(quote) as PriceField[]) {
    const sample = quote[field];
    if (!sample || sample.at < baselineAt) continue;
    next[field] = sample.value;
    next.eventTime = Math.max(next.eventTime, sample.at);
  }
  return next;
}
