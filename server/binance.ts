import WebSocket from 'ws';
import { aggregateCvd, backtestPositionSignals, computeOiDeltas, computeVolumeFlow, detectPositionFlowSignals, openInterestUsd, type RawAggTrade } from './calculations.ts';
import type { Instrument, MarketSeries, Overview, ProjectDiscoveryResult, ProjectMarket, ScannerRow } from '../shared/types.ts';

const REST = process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com';
const SPOT_REST = process.env.BINANCE_SPOT_REST_BASE ?? 'https://api.binance.com';
const WS = process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com';
const requestTimeout = 9_000;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${REST}${path}`, { signal: AbortSignal.timeout(requestTimeout) });
  if (!response.ok) throw new Error(`Binance ${response.status}: ${path}`);
  return response.json() as Promise<T>;
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
  const signals = detectPositionFlowSignals(candles, oiDelta, volumeFlow);
  return {
    symbol: encoded, interval, candles,
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
        classificationRule: 'Price direction + base-unit OI delta + synchronised aggressive flow; labels are probabilistic hypotheses, never observed position changes.',
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

export function openMarketStream(symbol: string, onEvent: (payload: unknown) => void, onState: (state: string, detail?: string) => void) {
  let socket: WebSocket | undefined; let stopped = false; let retry = 1_000; let timer: NodeJS.Timeout; let quietTimer: NodeJS.Timeout; let pollTimer: NodeJS.Timeout; let receivedFrame = false;
  const lower = symbol.toLowerCase();
  const stopFallback = () => clearInterval(pollTimer);
  const pollFallback = async () => {
    try {
      const encoded = encodeURIComponent(symbol.toUpperCase());
      const [ticker, premium] = await Promise.all([getJson<Ticker>(`/fapi/v1/ticker/24hr?symbol=${encoded}`), getJson<Premium>(`/fapi/v1/premiumIndex?symbol=${encoded}`)]);
      onEvent({ stream: `${lower}@ticker`, transport: 'rest-fallback', data: { e: '24hrTicker', E: Number(ticker.closeTime), c: ticker.lastPrice, P: ticker.priceChangePercent, v: ticker.volume, q: ticker.quoteVolume } });
      onEvent({ stream: `${lower}@markPrice@1s`, transport: 'rest-fallback', data: { e: 'markPriceUpdate', E: premium.time, p: premium.markPrice, r: premium.lastFundingRate, T: premium.nextFundingTime } });
    } catch (error) { onState('stale', error instanceof Error ? error.message : 'REST fallback failed'); }
  };
  const startFallback = () => {
    if (pollTimer) return;
    onState('degraded', 'WebSocket connected without frames; using 3s REST fallback');
    void pollFallback(); pollTimer = setInterval(pollFallback, 3_000);
  };
  const connect = () => {
    receivedFrame = false; onState('connecting');
    socket = new WebSocket(`${WS}/stream?streams=${lower}@aggTrade/${lower}@markPrice@1s/${lower}@ticker`);
    socket.on('open', () => { retry = 1_000; quietTimer = setTimeout(startFallback, 5_000); });
    socket.on('message', (raw) => {
      if (!receivedFrame) { receivedFrame = true; clearTimeout(quietTimer); stopFallback(); onState('live'); }
      try { onEvent(JSON.parse(raw.toString())); } catch { onState('degraded', 'Invalid upstream payload'); }
    });
    socket.on('error', (error) => onState('degraded', error.message));
    socket.on('close', () => {
      if (stopped) return;
      clearTimeout(quietTimer); stopFallback();
      onState('stale', `Reconnecting in ${Math.round(retry / 1000)}s`);
      timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 30_000);
    });
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(quietTimer); stopFallback(); socket?.close(); };
}
