import { aggregateCvd, backtestPositionSignals, computeOiDeltas, computeVolumeFlow, detectPositionFlowSignals, isSeriesStale, openInterestUsd, type RawAggTrade } from './calculations.ts';
import type { Instrument, MarketSeries, Overview } from '../shared/types.ts';
import { openMarketStream } from './binance.ts';

/**
 * Aster (asterdex) USDⓈ-M perpetual adapter.
 *
 * Aster exposes a Binance-compatible public REST surface (fapi.asterdex.com), so the
 * request/response shapes match the Binance adapter. Its own public streams supply ticker,
 * mark, trades and native candles. Historical OI is empty because Aster has no
 * `/futures/data/openInterestHist` endpoint.
 */

const REST = process.env.ASTER_REST_BASE ?? 'https://fapi.asterdex.com';
const TIMEOUT = 9_000;

export type AsterTransport = (url: string, init?: RequestInit) => Promise<Response>;

export function asterWsBase() {
  return (process.env.ASTER_WS_BASE ?? 'wss://fstream.asterdex.com').replace(/\/+$/, '');
}

export function openAsterMarketStream(symbol: string, onEvent: (payload: unknown) => void, onState: (state: string, detail?: string) => void) {
  return openMarketStream(symbol, payload => {
    if (payload && typeof payload === 'object') onEvent({ ...payload, exchange: 'aster' });
  }, onState, { wsBase: asterWsBase(), json: getJson, venueLabel: 'Aster' });
}

async function getJson<T>(path: string, transport: AsterTransport = fetch): Promise<T> {
  const response = await transport(`${REST}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`Aster ${response.status}: ${path.split('?')[0]}`);
  return response.json() as Promise<T>;
}

type ExchangeInfo = { symbols: Array<Record<string, unknown>> };
type Ticker = Record<string, string | number>;
type Premium = { symbol: string; markPrice: string; lastFundingRate: string; nextFundingTime: number; time: number };
type Oi = { openInterest: string; symbol: string; time: number };
type Book = { bidPrice: string; askPrice: string; time: number };

let instrumentCache: { at: number; value: Instrument[] } | null = null;

export async function getInstruments(transport: AsterTransport = fetch): Promise<Instrument[]> {
  if (instrumentCache && Date.now() - instrumentCache.at < 3_600_000) return instrumentCache.value;
  const info = await getJson<ExchangeInfo>('/fapi/v1/exchangeInfo', transport);
  const value = info.symbols
    .filter((raw) => raw.contractType === 'PERPETUAL' && raw.status === 'TRADING' && raw.quoteAsset === 'USDT')
    .map((raw) => {
      const filters = raw.filters as Array<Record<string, string>>;
      return {
        id: `aster:perpetual:${raw.symbol}`,
        venue: 'aster' as const,
        marketType: 'perpetual' as const,
        nativeSymbol: String(raw.symbol),
        base: String(raw.baseAsset),
        quote: String(raw.quoteAsset),
        settlement: String(raw.marginAsset ?? raw.quoteAsset),
        contractType: String(raw.contractType),
        status: String(raw.status),
        tickSize: Number(filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0),
        stepSize: Number(filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? 0),
        contractMultiplier: 1,
      } satisfies Instrument;
    });
  instrumentCache = { at: Date.now(), value };
  return value;
}

function intervalToMs(interval: string): number {
  const unit = interval.at(-1); const n = Number(interval.slice(0, -1));
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

/** 24h snapshot with mark price, funding, open interest and a CVD window where trades return. */
export async function overview(symbol: string, transport: AsterTransport = fetch): Promise<Overview> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const [ticker, premium, oi, book, trades] = await Promise.all([
    getJson<Ticker>(`/fapi/v1/ticker/24hr?symbol=${encoded}`, transport),
    getJson<Premium>(`/fapi/v1/premiumIndex?symbol=${encoded}`, transport),
    getJson<Oi>(`/fapi/v1/openInterest?symbol=${encoded}`, transport),
    getJson<Book>(`/fapi/v1/ticker/bookTicker?symbol=${encoded}`, transport).catch(() => null),
    getJson<RawAggTrade[]>(`/fapi/v1/aggTrades?symbol=${encoded}&limit=1000`, transport).catch(() => [] as RawAggTrade[]),
  ]);
  const cvd = trades.length ? aggregateCvd(trades, 60_000) : [];
  const oiBase = Number(oi.openInterest);
  const mark = Number(premium.markPrice);
  return {
    symbol: encoded,
    price: Number(ticker.lastPrice),
    markPrice: mark,
    change24hPct: Number(ticker.priceChangePercent),
    volume24hBase: Number(ticker.volume),
    volume24hUsd: Number(ticker.quoteVolume),
    oiBase,
    oiUsd: openInterestUsd(oiBase, mark),
    fundingRate: Number(premium.lastFundingRate),
    nextFundingTime: premium.nextFundingTime,
    cvdWindowDelta: cvd.at(-1)?.value ?? null,
    cvdWindowFrom: cvd[0]?.time ?? null,
    eventTime: Math.max(Number(ticker.closeTime), premium.time, oi.time),
    source: 'Aster USDⓈ-M public REST (Binance-compatible) + aggregate trades',
    quality: trades.length ? 'live' : 'partial',
    bid: book ? Number(book.bidPrice) : null,
    ask: book ? Number(book.askPrice) : null,
  };
}

/**
 * Candles + aggressor flow. OI history is unavailable on Aster, so `oiBase`/`oiUsd` are
 * empty and the position-flow engine has no OI window to assert against; it will withhold
 * labels instead of inventing deltas.
 */
export async function marketSeries(symbol: string, interval = '5m', limit = 120, transport: AsterTransport = fetch): Promise<MarketSeries> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const [klines, trades] = await Promise.all([
    getJson<Array<Array<string | number>>>(`/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=${limit}`, transport),
    getJson<RawAggTrade[]>(`/fapi/v1/aggTrades?symbol=${encoded}&limit=1000`, transport).catch(() => [] as RawAggTrade[]),
  ]);
  const candles = klines.map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volumeBase: Number(k[5]), volumeUsd: Number(k[7]) }));
  const cvd = aggregateCvd(trades, intervalToMs(interval));
  const oiDelta = computeOiDeltas([], []);
  const volumeFlow = computeVolumeFlow(cvd);
  // Stale windows must not generate fresh-looking structure claims.
  const stale = isSeriesStale(candles.at(-1)?.time, interval);
  const signals = stale ? [] : detectPositionFlowSignals(candles, oiDelta, volumeFlow);
  return {
    symbol: encoded,
    interval,
    candles,
    lastTradeId: trades.at(-1)?.a,
    oiBase: [],
    oiUsd: [],
    cvd,
    positionFlow: {
      requestedInterval: interval,
      oiInterval: interval,
      oiDelta,
      volumeFlow,
      signals,
      backtest: backtestPositionSignals(signals, candles, 3),
      methodology: {
        oiSpikeRule: 'Unavailable on Aster: the venue does not expose a historical open-interest endpoint.',
        volumeDeltaRule: 'Aggressor buy notional minus aggressor sell notional from the Aster buyer-maker flag.',
        classificationRule: `Price direction and synchronised aggressive flow; any label that needs an OI window is withheld rather than estimated.${stale ? ' Signals withheld: the returned window is stale.' : ''}`,
        evidenceGateRule: 'A label is asserted only when every required window exists. OI-dependent labels cannot pass on Aster.',
        reliabilityRule: 'Descriptive only; no calibrated win rate. No historical OI means no OI-based reliability claim.',
        oneMinuteOiNotice: null,
        forwardHorizonBars: 3,
      },
    },
    coverage: {
      candlesFrom: candles[0]?.time ?? null,
      cvdFrom: cvd[0]?.time ?? null,
      tradeCount: trades.length,
      cvdMethod: 'Σ(price × quantity × aggressor sign), reset at the returned window start',
      oiSource: 'Aster: no openInterestHist endpoint; OI history unavailable (not zero).',
    },
    eventTime: Date.now(),
    source: 'Aster USDⓈ-M REST',
  };
}

/** Lightweight close-price series for the watchlist sparkline. */
export async function priceSparkline(symbol: string, interval = '1h', limit = 24, transport: AsterTransport = fetch): Promise<number[]> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const klines = await getJson<Array<Array<string | number>>>(`/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=${limit}`, transport);
  return klines.map((k) => Number(k[4])).filter((value) => Number.isFinite(value));
}

/** 24h ticker for the watchlist (no OI/funding fan-out). */
export async function ticker(symbol: string, transport: AsterTransport = fetch): Promise<Ticker> {
  return getJson<Ticker>(`/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol.toUpperCase())}`, transport);
}
