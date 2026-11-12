import { binanceMarketWsBase } from './binance-ws-url.ts';
import WebSocket from 'ws';
import { aggregateCvd, backtestPositionSignals, computeOiDeltas, computeVolumeFlow, detectPositionFlowSignals, isSeriesStale, openInterestUsd, type RawAggTrade } from './calculations.ts';
import type { Instrument, MarketSeries, Overview, ProjectDiscoveryResult, ProjectMarket, ScannerRow } from '../shared/types.ts';
import { BinanceCooldownError, binanceGovernor } from './binance-governor.ts';

const REST = process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com';
const SPOT_REST = process.env.BINANCE_SPOT_REST_BASE ?? 'https://api.binance.com';

const requestTimeout = 9_000;

async function getJson<T>(path: string): Promise<T> {
  // Single process-wide governor: dedupe, per-endpoint spacing, 418/429 cooldown.
  return binanceGovernor.json<T>(`${REST}${path}`);
}

async function getExternalJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeout) });
  if (!response.ok) throw new Error(`External discovery ${response.status}`);
  return response.json() as Promise<T>;
}

type ExchangeInfo = { symbols: Array<Record<string, unknown>> };
type Ticker = Record<string, string | number>;
type Premium = { symbol: string; markPrice: string; lastFundingRate: string; nextFundingTime: number; time: number };
type Oi = { openInterest: string; symbol: string; time: number };

let instrumentCache: { at: number; value: Instrument[] } | null = null;
export async function getInstruments(): Promise<Instrument[]> {
  if (instrumentCache && Date.now() - instrumentCache.at < 3_600_000) return instrumentCache.value;
  const info = await getJson<ExchangeInfo>('/fapi/v1/exchangeInfo');
  const value = info.symbols
    .filter((raw) => raw.contractType === 'PERPETUAL' && raw.status === 'TRADING' && raw.quoteAsset === 'USDT')
    .map((raw) => {
      const filters = raw.filters as Array<Record<string, string>>;
      return {
        id: `binance:perpetual:${raw.symbol}`,
        venue: 'binance' as const,
        marketType: 'perpetual' as const,
        nativeSymbol: String(raw.symbol), base: String(raw.baseAsset), quote: String(raw.quoteAsset),
        settlement: String(raw.marginAsset), contractType: String(raw.contractType), status: String(raw.status),
        tickSize: Number(filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0),
        stepSize: Number(filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? 0)
      };
    });
  instrumentCache = { at: Date.now(), value };
  return value;
}

let spotInstrumentCache: { at: number; value: Instrument[] } | null = null;
export async function getSpotInstruments(): Promise<Instrument[]> {
  if (spotInstrumentCache && Date.now() - spotInstrumentCache.at < 3_600_000) return spotInstrumentCache.value;
  const info = await getExternalJson<ExchangeInfo>(`${SPOT_REST}/api/v3/exchangeInfo`);
  const value = info.symbols
    .filter((raw) => raw.status === 'TRADING' && ['USDT', 'USDC', 'FDUSD'].includes(String(raw.quoteAsset)))
    .map((raw) => {
      const filters = raw.filters as Array<Record<string, string>>;
      return {
        id: `binance:spot:${raw.symbol}`,
        venue: 'binance' as const,
        marketType: 'spot' as const,
        nativeSymbol: String(raw.symbol), base: String(raw.baseAsset), quote: String(raw.quoteAsset),
        settlement: String(raw.quoteAsset), contractType: 'SPOT', status: String(raw.status),
        tickSize: Number(filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0),
        stepSize: Number(filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? 0)
      };
    });
  spotInstrumentCache = { at: Date.now(), value };
  return value;
}

function toProjectMarket(instrument: Instrument): ProjectMarket {
  return { id: instrument.id, exchange: 'binance', marketType: instrument.marketType, symbol: instrument.nativeSymbol, base: instrument.base, quote: instrument.quote, status: instrument.status };
}

function isContractAddress(query: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(query) || /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(query);
}

async function resolveContract(query: string) {
  type DexResponse = { pairs?: Array<{ chainId?: string; baseToken?: { address?: string; symbol?: string; name?: string } }> };
  const response = await getExternalJson<DexResponse>(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(query)}`);
  const exact = response.pairs?.find((pair) => pair.baseToken?.address?.toLowerCase() === query.toLowerCase()) ?? response.pairs?.[0];
  if (!exact?.baseToken?.symbol) throw new Error('Contract address was not resolved to a token identity');
  return { symbol: exact.baseToken.symbol.toUpperCase(), name: exact.baseToken.name ?? null, network: exact.chainId ?? null };
}

export async function discoverProjectMarkets(rawQuery: string): Promise<ProjectDiscoveryResult> {
  const query = rawQuery.trim();
  if (!query) throw new Error('Token symbol or contract address is required');
  const contract = isContractAddress(query);
  const resolved = contract ? await resolveContract(query) : { symbol: query.toUpperCase().replace(/[^A-Z0-9]/g, ''), name: null, network: null };
  const [futures, spot] = await Promise.all([getInstruments(), getSpotInstruments()]);
  const matches = [...futures, ...spot]
    .filter((instrument) => instrument.base.toUpperCase() === resolved.symbol)
    .sort((a, b) => a.marketType === b.marketType ? a.quote.localeCompare(b.quote) : a.marketType === 'perpetual' ? -1 : 1)
    .map(toProjectMarket);
  const warnings: string[] = [];
  if (!matches.length) warnings.push(`No supported Binance Spot or USDT-M perpetual market matched ${resolved.symbol}.`);
  if (contract) warnings.push('Contract identity is resolved through public DEX metadata; confirm the network, symbol and Binance markets before saving.');
  else warnings.push('Symbol matches can represent unrelated tokens; confirm the displayed base asset and trading pairs before saving.');
  return { query, identity: { symbol: resolved.symbol, name: resolved.name, contractAddress: contract ? query : null, network: resolved.network, source: contract ? 'contract' : 'symbol' }, markets: matches, warnings };
}

let scannerCache: { at: number; limit: number; value: ScannerRow[] } | null = null;
let scannerInFlight: Promise<ScannerRow[]> | null = null;
export async function scanner(limit = 24): Promise<ScannerRow[]> {
  if (scannerCache && scannerCache.limit >= limit && Date.now() - scannerCache.at < 15_000) return scannerCache.value.slice(0, limit);
  if (scannerInFlight) return (await scannerInFlight).slice(0, limit);
  scannerInFlight = buildScanner(Math.max(limit, 24));
  try {
    const value = await scannerInFlight;
    scannerCache = { at: Date.now(), limit: Math.max(limit, 24), value };
    return value.slice(0, limit);
  } finally { scannerInFlight = null; }
}

async function buildScanner(limit: number): Promise<ScannerRow[]> {
  const [instruments, tickers, premiums] = await Promise.all([
    getInstruments(), getJson<Ticker[]>('/fapi/v1/ticker/24hr'), getJson<Premium[]>('/fapi/v1/premiumIndex')
  ]);
  const allowed = new Map(instruments.map((i) => [i.nativeSymbol, i]));
  const premiumMap = new Map(premiums.map((p) => [p.symbol, p]));
  const top = tickers.filter((t) => allowed.has(String(t.symbol)))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, Math.min(limit, 40));
  const oiEntries = await Promise.all(top.map(async (t) => {
    try { return [String(t.symbol), await getJson<Oi>(`/fapi/v1/openInterest?symbol=${t.symbol}`)] as const; }
    catch { return [String(t.symbol), null] as const; }
  }));
  const oiMap = new Map(oiEntries);
  return top.map((t) => {
    const symbol = String(t.symbol); const price = Number(t.lastPrice); const oi = oiMap.get(symbol); const premium = premiumMap.get(symbol);
    return {
      symbol, base: allowed.get(symbol)!.base, price, change24hPct: Number(t.priceChangePercent),
      volume24hBase: Number(t.volume), volume24hUsd: Number(t.quoteVolume),
      oiBase: oi ? Number(oi.openInterest) : null,
      oiUsd: oi ? openInterestUsd(Number(oi.openInterest), price) : null,
      fundingRate: premium ? Number(premium.lastFundingRate) : null,
      nextFundingTime: premium?.nextFundingTime ?? null,
      high24h: Number(t.highPrice), low24h: Number(t.lowPrice), trades24h: Number(t.count),
      eventTime: Number(t.closeTime), quality: oi && premium ? 'live' : 'partial'
    };
  });
}

/** Lightweight close-price series for watchlist sparklines (no OI/trade fan-out). */
export async function priceSparkline(symbol: string, interval = '1h', limit = 24): Promise<number[]> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const klines = await getJson<Array<Array<string | number>>>(`/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=${limit}`);
  return klines.map((k) => Number(k[4])).filter((value) => Number.isFinite(value));
}

export async function marketSeries(symbol: string, interval = '5m', limit = 120): Promise<MarketSeries> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const oiInterval = interval === '1m' ? '5m' : interval;
  const [klines, oiHistory, trades] = await Promise.all([
    getJson<Array<Array<string | number>>>(`/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=${limit}`),
    getJson<Array<{ timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }>>(`/futures/data/openInterestHist?symbol=${encoded}&period=${oiInterval}&limit=${limit}`).catch(() => []),
    getJson<RawAggTrade[]>(`/fapi/v1/aggTrades?symbol=${encoded}&limit=1000`)
  ]);
  const candles = klines.map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volumeBase: Number(k[5]), volumeUsd: Number(k[7]) }));
  const cvd = aggregateCvd(trades, intervalToMs(interval));
  const oiBase = oiHistory.map((o) => ({ time: o.timestamp, value: Number(o.sumOpenInterest) }));
  const oiUsd = oiHistory.map((o) => ({ time: o.timestamp, value: Number(o.sumOpenInterestValue) }));
  const oiDelta = computeOiDeltas(oiBase, oiUsd);
  const volumeFlow = computeVolumeFlow(cvd);
  // Stale windows must not generate fresh-looking structure claims.
  const stale = isSeriesStale(candles.at(-1)?.time, interval);
  const signals = stale ? [] : detectPositionFlowSignals(candles, oiDelta, volumeFlow);
  return {
    symbol: encoded, interval, candles, lastTradeId: trades.at(-1)?.a,
    oiBase,
    oiUsd,
    cvd,
    positionFlow: {
      requestedInterval: interval,
      oiInterval,
      oiDelta,
      volumeFlow,
      signals,
      backtest: backtestPositionSignals(signals, candles, 3),
      methodology: {
        oiSpikeRule: 'Robust modified z-score using median absolute deviation; spike threshold |score| ≥ 3.5.',
        volumeDeltaRule: 'Aggressor buy notional minus aggressor sell notional from Binance buyer-maker flag.',
        classificationRule: `Price direction + base-unit OI delta + synchronised aggressive flow; labels are probabilistic hypotheses, never observed position changes.${stale ? ' Signals withheld: the returned window is stale.' : ''}`,
        evidenceGateRule: 'A label is asserted only when the OI window, closing-candle price window and >=80% aggressor-flow bucket coverage all exist. Liquidation labels additionally require per-event liquidation data and absorption labels require sequence-correct L2 depth; both are withheld in this version.',
        reliabilityRule: 'Gross direction is descriptive, compared with a same-window baseline and chronological holdout (not true out-of-sample). A separate unified-ledger scenario applies assumed 5bps fees and 1bps slippage per side; funding and account constraints unavailable. Completed contiguous outcomes only.',
        oneMinuteOiNotice: interval === '1m' ? 'Binance historical OI is available at 5m minimum; 1m price/flow panels use 1m data while OI panels retain authoritative 5m timestamps and OI windows are aligned to closing candles.' : null,
        forwardHorizonBars: 3
      }
    },
    coverage: { candlesFrom: candles[0]?.time ?? null, cvdFrom: cvd[0]?.time ?? null, tradeCount: trades.length, cvdMethod: 'Σ(price × quantity × aggressor sign), reset at returned window start', oiSource: `Binance openInterestHist ${oiInterval} sumOpenInterest / sumOpenInterestValue` },
    eventTime: Date.now(), source: 'Binance USDⓈ-M REST'
  };
}

export async function overview(symbol: string): Promise<Overview> {
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const [ticker, premium, oi, trades] = await Promise.all([
    getJson<Ticker>(`/fapi/v1/ticker/24hr?symbol=${encoded}`),
    getJson<Premium>(`/fapi/v1/premiumIndex?symbol=${encoded}`),
    getJson<Oi>(`/fapi/v1/openInterest?symbol=${encoded}`),
    getJson<RawAggTrade[]>(`/fapi/v1/aggTrades?symbol=${encoded}&limit=1000`)
  ]);
  const cvd = aggregateCvd(trades, 60_000); const oiBase = Number(oi.openInterest); const mark = Number(premium.markPrice);
  return { symbol: encoded, price: Number(ticker.lastPrice), markPrice: mark, change24hPct: Number(ticker.priceChangePercent), volume24hBase: Number(ticker.volume), volume24hUsd: Number(ticker.quoteVolume), oiBase, oiUsd: openInterestUsd(oiBase, mark), fundingRate: Number(premium.lastFundingRate), nextFundingTime: premium.nextFundingTime, cvdWindowDelta: cvd.at(-1)?.value ?? null, cvdWindowFrom: cvd[0]?.time ?? null, eventTime: Math.max(Number(ticker.closeTime), premium.time, oi.time), source: 'Binance USDⓈ-M public REST + aggregate trades', quality: 'live' };
}

function intervalToMs(interval: string) {
  const unit = interval.at(-1); const n = Number(interval.slice(0, -1));
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

type MarketSocket = Pick<WebSocket, 'readyState' | 'close' | 'terminate'> & {
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
};
const PRICE_SILENCE_MS = 5_000;
const SOCKET_SILENCE_MS = 15_000;
const FALLBACK_INTERVAL_MS = 3_000;

export function openMarketStream(symbol: string, onEvent: (payload: unknown) => void, onState: (state: string, detail?: string) => void,
  deps: { socket?: (url: string) => MarketSocket; json?: typeof getJson; wsBase?: string; venueLabel?: 'Aster' | 'Binance' } = {}) {
  const lower = encodeURIComponent(symbol.toLowerCase());
  const venue = deps.venueLabel ?? 'Binance';
  const encoded = encodeURIComponent(symbol.toUpperCase());
  const json = deps.json ?? getJson;
  let socket: MarketSocket | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let retry = 1_000;
  let stopped = false;
  let lastFrame = Date.now();
  let lastPrice = lastFrame;
  let live = false;
  let fallback = false;
  let generation = 0;
  const polling = new Set<'ticker' | 'premium'>();
  const nextPoll = { ticker: 0, premium: 0 };

  // Keep the two requests independent: a stalled funding endpoint must not delay price sampling.
  const poll = async (endpoint: 'ticker' | 'premium') => {
    if (polling.has(endpoint) || Date.now() < nextPoll[endpoint]) return;
    polling.add(endpoint);
    nextPoll[endpoint] = Date.now() + FALLBACK_INTERVAL_MS;
    const epoch = generation;
    const active = () => !stopped && fallback && epoch === generation;
    try {
      if (endpoint === 'ticker') {
        const ticker = await json<Ticker>(`/fapi/v1/ticker/24hr?symbol=${encoded}`);
        if (!active()) return;
        const price = Number(ticker.lastPrice), at = Number(ticker.closeTime);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(at) || at <= 0) throw new Error(`Invalid ${venue} REST ticker`);
        onEvent({ stream: `${lower}@ticker`, transport: 'rest-fallback', data: {
          e: '24hrTicker', E: at, c: ticker.lastPrice, P: ticker.priceChangePercent, v: ticker.volume, q: ticker.quoteVolume,
        } });
      } else {
        const premium = await json<Premium>(`/fapi/v1/premiumIndex?symbol=${encoded}`);
        if (!active()) return;
        onEvent({ stream: `${lower}@markPrice@1s`, transport: 'rest-fallback', data: {
          e: 'markPriceUpdate', E: premium.time, p: premium.markPrice, r: premium.lastFundingRate, T: premium.nextFundingTime,
        } });
      }
    } catch (error) {
      if (!active()) return;
      if (error instanceof BinanceCooldownError) nextPoll[endpoint] = Math.max(nextPoll[endpoint], Date.now() + error.retryAfterMs);
      if (endpoint === 'ticker') onState('stale', String(error));
    } finally {
      polling.delete(endpoint);
    }
  };

  const fallbackIfNeeded = () => {
    if (!fallback) {
      fallback = true;
      live = false;
      onState('degraded', `Waiting for WebSocket prices; using ${venue} REST quotes`);
    }
    void poll('ticker');
    void poll('premium');
  };
  const connect = () => {
    if (stopped) return;
    lastFrame = Date.now();
    if (!fallback) onState('connecting');
    const url = `${deps.wsBase ?? binanceMarketWsBase()}/stream?streams=${lower}@aggTrade/${lower}@markPrice@1s/${lower}@ticker`;
    const current = deps.socket ? deps.socket(url) : new WebSocket(url, { handshakeTimeout: SOCKET_SILENCE_MS });
    socket = current;
    current.on('message', raw => {
      if (stopped || current !== socket) return;
      try {
        const payload = JSON.parse(raw.toString());
        const data = payload?.data ?? payload;
        if (!data || typeof data !== 'object' || (data.s !== undefined && data.s !== symbol.toUpperCase())) return;
        lastFrame = Date.now();
        const trade = data.e === 'aggTrade' || data.e === 'trade';
        const price = Number(trade ? data.p : data.c);
        const at = Number(trade ? data.T ?? data.E : data.E);
        if (price > 0 && Number.isFinite(price) && Math.abs(lastFrame - at) <= PRICE_SILENCE_MS) {
          lastPrice = Math.max(lastPrice, Math.min(lastFrame, at));
          if (fallback) { fallback = false; generation++; }
          if (!live) { live = true; onState('live'); }
          retry = 1_000;
        }
        onEvent(payload);
      } catch {
        live = false;
        onState('degraded', 'Invalid upstream payload');
      }
    });
    current.on('error', error => {
      if (stopped || current !== socket) return;
      live = false;
      onState('degraded', error.message);
    });
    current.on('close', () => {
      if (stopped || current !== socket) return;
      socket = undefined;
      fallbackIfNeeded();
      reconnect = setTimeout(connect, retry);
      retry = Math.min(30_000, retry * 2);
    });
  };
  connect();
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (fallback || now - lastPrice >= PRICE_SILENCE_MS) fallbackIfNeeded();
    if (socket && socket.readyState < WebSocket.CLOSING && now - lastFrame >= SOCKET_SILENCE_MS) socket.terminate();
  }, 1_000);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(reconnect);
    socket?.close();
  };
}
