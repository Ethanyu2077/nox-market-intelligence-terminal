import type { Instrument, ProjectMarket, VenueMarketSnapshot } from '../../shared/types.ts';
import type { CcxtExchangeId } from '../../shared/types.ts';
import { getCcxtExchange, getCcxtMarkets } from './client.ts';
import { resolveCcxtConfig, type CcxtConfig } from './config.ts';
import type { CcxtExchangeLike, CcxtFunding, CcxtMarket, CcxtOpenInterest, CcxtTicker } from './types.ts';

/**
 * CCXT normalisation.
 *
 * CCXT unifies field *names* but not their units: open interest is "amount" or "value"
 * depending on venue, and 24h volume may be base or quote. This adapter therefore:
 *  - prefers venue-reported USD value for OI and derives base quantity from it;
 *  - labels the source explicitly and marks the snapshot `partial` (no aggressor flow);
 *  - keeps every unknown field null instead of guessing zero.
 */

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function matchesType(market: CcxtMarket, type: ProjectMarket['marketType']): boolean {
  return type === 'spot' ? Boolean(market.spot) : Boolean(market.swap || market.future);
}

/** Resolve a NOX market (native symbol) to a CCXT market, preferring the same market type. */
export function resolveCcxtMarket(exchange: CcxtExchangeLike, market: { symbol: string; marketType: ProjectMarket['marketType']; base: string; quote: string }): CcxtMarket | null {
  const byId = exchange.markets_by_id?.[market.symbol];
  if (byId?.length) {
    const typed = byId.find((candidate) => matchesType(candidate, market.marketType));
    return typed ?? byId[0];
  }
  const unified = market.marketType === 'perpetual'
    ? [`${market.base}/${market.quote}:${market.quote}`, `${market.base}/${market.quote}`]
    : [`${market.base}/${market.quote}`];
  for (const symbol of unified) {
    const direct = exchange.markets?.[symbol];
    if (direct && matchesType(direct, market.marketType)) return direct;
  }
  // Last resort: scan the catalogue; some venues expose symbols without a settle suffix.
  for (const candidate of Object.values(exchange.markets ?? {})) {
    if (candidate.base === market.base && candidate.quote === market.quote && matchesType(candidate, market.marketType)) return candidate;
  }
  return null;
}

/** Only USDT-settled perpetuals are exposed: KRW/USD legs must not enter USDT aggregates. */
export function toInstrument(exchange: CcxtExchangeId, market: CcxtMarket): Instrument | null {
  if (!(market.swap || market.future) || market.inverse) return null;
  if (market.quote !== 'USDT' || market.active === false) return null;
  if (!market.base || !market.quote) return null;
  return {
    id: `${exchange}:perpetual:${market.id}`,
    venue: exchange,
    marketType: 'perpetual',
    nativeSymbol: market.id,
    base: market.base,
    quote: market.quote,
    settlement: market.settle ?? market.quote,
    contractType: 'PERPETUAL',
    status: 'trading',
    tickSize: 0,
    stepSize: 0,
    contractMultiplier: market.contractSize ?? undefined,
  };
}

export function normalizeCcxtSnapshot(
  exchangeId: CcxtExchangeId,
  market: ProjectMarket,
  ticker: CcxtTicker,
  oi: CcxtOpenInterest | null,
  funding: CcxtFunding | null,
  now: number,
  options: { version?: string; contractSize?: number | null } = {},
): VenueMarketSnapshot {
  const price = positive(num(ticker.last)) ?? positive(num(ticker.close));
  const markPrice = positive(num(ticker.markPrice));
  const bid = positive(num(ticker.bid));
  const ask = positive(num(ticker.ask));
  const baseVolume = num(ticker.baseVolume);
  const quoteVolume = num(ticker.quoteVolume);
  const volume24hBase = baseVolume;
  // Venues that only report base volume: derive notional from the last price and say so
  // in the source label; never present a derived number as a venue-reported one.
  const volume24hUsd = quoteVolume ?? (baseVolume != null && price != null ? baseVolume * price : null);

  const contractSize = market.marketType === 'perpetual' ? (num(options.contractSize) ?? 1) : 1;
  const amount = num(oi?.openInterestAmount);
  const reportedValue = num(oi?.openInterestValue);
  const referencePrice = markPrice ?? price;
  // Some venues report only USD OI. Deriving base quantity from value / price keeps the
  // base-unit column comparable, and the source label states that it was derived.
  const derivedBase = amount == null && reportedValue != null && referencePrice != null && referencePrice > 0 ? reportedValue / referencePrice : null;
  const oiBase = amount != null ? amount * contractSize : derivedBase;
  const oiUsd = reportedValue ?? (oiBase != null && referencePrice != null ? oiBase * referencePrice : null);

  const rate = num(funding?.fundingRate);
  const nextFundingTime = num(funding?.nextFundingTimestamp) ?? num(funding?.fundingTimestamp);
  const eventTime = num(ticker.timestamp) ?? now;
  const spreadBps = bid != null && ask != null && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 10_000 : null;

  const snapshot: VenueMarketSnapshot = {
    exchange: exchangeId,
    symbol: market.symbol,
    marketType: market.marketType,
    price,
    markPrice,
    change24hPct: num(ticker.percentage),
    volume24hBase,
    volume24hUsd,
    takerBuyVolumeUsd: null,
    takerSellVolumeUsd: null,
    volumeDeltaUsd: null,
    cvd: null,
    oiBase,
    oiUsd,
    oiDeltaBase: null,
    oiDeltaUsd: null,
    fundingRate: rate,
    nextFundingTime,
    bid,
    ask,
    spreadBps,
    eventTime,
    fetchedAt: now,
    // CCXT has no verified aggressor-side aggregation and OI units vary by venue, so a
    // CCXT row can never be 'live' even when the ticker timestamp is current.
    quality: price == null ? 'unavailable' : 'partial',
    source: `CCXT ${exchangeId}${options.version ? ` v${String(options.version).replace(/^v/i, '')}` : ''}${quoteVolume == null && volume24hUsd != null ? ' (volume derived from base × last)' : ''}${derivedBase != null ? ' (OI base derived from USD value)' : ''}`,
    unavailable: [],
  };
  snapshot.unavailable = ['takerBuyVolumeUsd', 'takerSellVolumeUsd', 'volumeDeltaUsd', 'cvd', 'oiDeltaBase', 'oiDeltaUsd', 'fundingRate', 'oiUsd']
    .filter((key) => snapshot[key as keyof VenueMarketSnapshot] == null);
  return snapshot;
}

export async function ccxtSnapshot(market: ProjectMarket, config: CcxtConfig = resolveCcxtConfig(), injected?: CcxtExchangeLike): Promise<VenueMarketSnapshot> {
  if (!config.enabled) throw new Error('CCXT is disabled');
  const exchangeId = market.exchange as CcxtExchangeId;
  const exchange = injected ?? await getCcxtExchange(exchangeId, config);
  const resolved = resolveCcxtMarket(exchange, market);
  if (!resolved) throw new Error(`CCXT ${exchangeId} has no ${market.marketType} market for ${market.symbol}`);
  const derivatives = market.marketType === 'perpetual';
  const timestamp = Date.now();
  const [ticker, oi, funding] = await Promise.all([
    exchange.fetchTicker(resolved.symbol),
    derivatives && exchange.fetchOpenInterest ? exchange.fetchOpenInterest(resolved.symbol).catch(() => null) : Promise.resolve(null),
    derivatives && exchange.fetchFundingRate ? exchange.fetchFundingRate(resolved.symbol).catch(() => null) : Promise.resolve(null),
  ]);
  // `contractSize` comes from the resolved market so OI contracts normalise to base units.
  return normalizeCcxtSnapshot(exchangeId, market, ticker, oi, funding, timestamp, { version: exchange.version, contractSize: resolved.contractSize });
}

export async function ccxtInstruments(exchangeId: CcxtExchangeId, config: CcxtConfig = resolveCcxtConfig(), injected?: CcxtExchangeLike): Promise<Instrument[]> {
  // Injected exchanges are only used by tests; production always loads through the pool.
  const markets = injected ? await injected.loadMarkets() : await getCcxtMarkets(exchangeId, config);
  const rows: Instrument[] = [];
  for (const market of Object.values(markets)) {
    const instrument = toInstrument(exchangeId, market);
    if (instrument) rows.push(instrument);
  }
  return rows.sort((a, b) => a.nativeSymbol.localeCompare(b.nativeSymbol));
}

/** Exposed for tests: the OI unit decision in one place. */
export function normalizeOpenInterest(amount: number | null, value: number | null, contractSize: number | null, mark: number | null): { oiBase: number | null; oiUsd: number | null } {
  const multiplier = contractSize ?? 1;
  const oiBase = amount != null ? amount * multiplier : null;
  return { oiBase, oiUsd: value ?? (oiBase != null && mark != null ? oiBase * mark : null) };
}
