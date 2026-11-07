import type {
  AggregatedMarketSnapshot, CrossExchangeInsight, ExchangeCapabilities, ExchangeContributionSummary, ExchangeId, Instrument,
  ProjectDiscoveryResult, ProjectMarket, ProjectVenueResponse, VenueMarketSnapshot
} from '../shared/types.ts';
import { getInstruments as getBinanceFutures, getSpotInstruments as getBinanceSpot, overview as getBinanceOverview } from './binance.ts';
import { getInstruments as getAsterFutures, overview as getAsterOverview } from './aster.ts';
import { resolveDexPaprikaIdentity } from './dexpaprika.ts';
import {koreanSpot,koreanBaseSymbol} from './korean-spot.ts';
import { ccxtInstruments, ccxtSnapshot } from './ccxt/adapter.ts';
import { CCXT_LABELS, enabledCcxtVenues, isCcxtVenue, resolveCcxtConfig } from './ccxt/config.ts';
import { CCXT_EXCHANGE_IDS } from '../shared/types.ts';
import { venueBreakers } from './venue-health.ts';

const TIMEOUT = 10_000;
const CACHE_MS = 30 * 60_000;
type Json = Record<string, unknown>;

const nativeCapabilityRows: Array<Omit<ExchangeCapabilities, 'transport' | 'enabled'>> = [
  ...(['upbit','bithumb'] as const).map(exchange=>({exchange,label:exchange==='upbit'?'Upbit KRW Spot':'Bithumb KRW Spot',restDiscovery:true,restSnapshot:true,websocketTrades:false,websocketTicker:false,websocketOrderBook:false,historicalSeries:false,openInterest:false,funding:false,liquidations:false,notes:['KRW spot REST snapshots; quote units stay KRW and are excluded from USDT derivatives aggregation.']})),
  { exchange: 'binance', label: 'Binance', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: true, openInterest: true, funding: true, liquidations: false, notes: ['Native aggregate-trade stream and historical analytics are active.', 'Order-book sequence engine is scheduled for Phase 2.'] },
  { exchange: 'bitget', label: 'Bitget', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['Public futures trade/ticker stream is normalized and deduplicated.'] },
  { exchange: 'bybit', label: 'Bybit', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['Public linear trade/ticker stream is normalized and deduplicated.'] },
  { exchange: 'okx', label: 'OKX', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['OI base quantity uses venue-reported oiCcy, not raw contract count.'] },
  { exchange: 'gate', label: 'Gate', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['Contract counts are normalized with quanto_multiplier.'] },
  { exchange: 'kucoin', label: 'KuCoin', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['Public token-based futures stream is negotiated server-side.'] },
  { exchange: 'mexc', label: 'MEXC', restDiscovery: true, restSnapshot: true, websocketTrades: true, websocketTicker: true, websocketOrderBook: false, historicalSeries: false, openInterest: true, funding: true, liquidations: false, notes: ['Public futures REST and deal/ticker streams are enabled.', 'Contract detail is cached to respect the documented low discovery rate limit.', 'Unsupported metrics remain unavailable.'] },
  { exchange: 'aster', label: 'Aster', restDiscovery: true, restSnapshot: true, websocketTrades: false, websocketTicker: false, websocketOrderBook: false, historicalSeries: true, openInterest: true, funding: true, liquidations: false, notes: ['Binance-compatible USDⓈ-M REST; asterdex does not expose openInterestHist, so OI history is unavailable (not zero).', 'Candles and aggressor trades are available; OI-dependent labels are withheld.', 'No verified public WebSocket adapter: quotes and flow are REST-polled and labelled as such.'] }
];

const ccxtConfig = resolveCcxtConfig();

function capabilityRows(): ExchangeCapabilities[] {
  const native = nativeCapabilityRows.map((row) => ({ ...row, transport: 'native' as const, enabled: true, notes: [...row.notes] }));
  const enabled = new Set(enabledCcxtVenues(ccxtConfig));
  const ccxt = CCXT_EXCHANGE_IDS.map<ExchangeCapabilities>((exchange) => ({
    exchange,
    label: CCXT_LABELS[exchange],
    restDiscovery: true,
    restSnapshot: true,
    websocketTrades: false,
    websocketTicker: false,
    websocketOrderBook: false,
    historicalSeries: false,
    openInterest: true,
    funding: true,
    liquidations: false,
    transport: 'ccxt',
    enabled: enabled.has(exchange),
    notes: [
      'USDT perpetual quotes via the CCXT unified adapter (server-side).',
      'No aggressor-side tape, CVD or WebSocket: those rows stay unavailable rather than estimated.',
      'Open-interest units are normalised from the venue contract size; USD value is preferred when reported.',
    ],
  }));
  return [...native, ...ccxt];
}

export function exchangeCapabilities() { return capabilityRows(); }

/** Venues that should appear in discovery / selectors for this process. */
export function activeExchangeIds(): ExchangeId[] {
  return capabilityRows().filter((row) => row.enabled).map((row) => row.exchange);
}


async function json<T>(url: string, timeoutMs = TIMEOUT): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'NOX-Market-Intelligence/0.2' } });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function number(value: unknown): number | null {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value: unknown) { return value == null ? '' : String(value); }
function pct(value: unknown, alreadyPercent = false) { const parsed = number(value); return parsed == null ? null : parsed * (alreadyPercent ? 1 : 100); }
function timestamp(value: unknown) {
  const parsed = number(value);
  if (parsed == null) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}
function spreadBps(bid: number | null, ask: number | null) {
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  return (ask - bid) / ((ask + bid) / 2) * 10_000;
}
export function normalizeContractQuantity(contracts: number | null, multiplier: number | null) {
  return contracts == null || multiplier == null ? null : contracts * multiplier;
}
function market(instrument: Instrument): ProjectMarket {
  return { id: instrument.id, exchange: instrument.venue, marketType: instrument.marketType, symbol: instrument.nativeSymbol, base: instrument.base, quote: instrument.quote, status: instrument.status };
}
function instrument(exchange: ExchangeId, marketType: 'spot' | 'perpetual', nativeSymbol: string, base: string, quote: string, status: string, options: Partial<Instrument> = {}): Instrument {
  return { id: `${exchange}:${marketType}:${nativeSymbol}`, venue: exchange, marketType, nativeSymbol, base, quote, settlement: quote, contractType: marketType === 'spot' ? 'SPOT' : 'PERPETUAL', status, tickSize: 0, stepSize: 0, ...options };
}

type CatalogLoader = () => Promise<Instrument[]>;
const catalogCache = new Map<ExchangeId, { at: number; value: Instrument[] }>();
async function cached(exchange: ExchangeId, loader: CatalogLoader) {
  const hit = catalogCache.get(exchange);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader(); catalogCache.set(exchange, { at: Date.now(), value }); return value;
}

async function binanceCatalog() { return [...await getBinanceFutures(), ...await getBinanceSpot()]; }
async function bybitCatalog() {
  const [linear, spot] = await Promise.all([
    json<Json>('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'),
    json<Json>('https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000')
  ]);
  const list = (payload: Json) => ((payload.result as Json)?.list as Json[] ?? []);
  return [
    ...list(linear).filter((r) => text(r.contractType).includes('Perpetual') && r.settleCoin === 'USDT' && r.status === 'Trading').map((r) => instrument('bybit', 'perpetual', text(r.symbol), text(r.baseCoin), text(r.quoteCoin), text(r.status))),
    ...list(spot).filter((r) => r.quoteCoin === 'USDT' && r.status === 'Trading').map((r) => instrument('bybit', 'spot', text(r.symbol), text(r.baseCoin), text(r.quoteCoin), text(r.status)))
  ];
}
async function okxCatalog() {
  const [swaps, spots] = await Promise.all([
    json<Json>('https://www.okx.com/api/v5/public/instruments?instType=SWAP'),
    json<Json>('https://www.okx.com/api/v5/public/instruments?instType=SPOT')
  ]);
  const rows = (p: Json) => (p.data as Json[] ?? []);
  return [
    ...rows(swaps).filter((r) => r.settleCcy === 'USDT' && r.state === 'live').map((r) => instrument('okx', 'perpetual', text(r.instId), text(r.ctValCcy || text(r.instId).split('-')[0]), 'USDT', text(r.state), { stepSize: number(r.lotSz) ?? 0, contractMultiplier: (number(r.ctVal) ?? 1) * (number(r.ctMult) ?? 1) })),
    ...rows(spots).filter((r) => r.quoteCcy === 'USDT' && r.state === 'live').map((r) => instrument('okx', 'spot', text(r.instId), text(r.baseCcy), text(r.quoteCcy), text(r.state), { tickSize: number(r.tickSz) ?? 0, stepSize: number(r.lotSz) ?? 0 }))
  ];
}
async function bitgetCatalog() {
  const [futures, spots] = await Promise.all([
    json<Json>('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES'),
    json<Json>('https://api.bitget.com/api/v2/spot/public/symbols')
  ]);
  const rows = (p: Json) => (p.data as Json[] ?? []);
  return [
    ...rows(futures).filter((r) => r.quoteCoin === 'USDT' && ['normal', 'listed'].includes(text(r.symbolStatus).toLowerCase())).map((r) => instrument('bitget', 'perpetual', text(r.symbol), text(r.baseCoin), text(r.quoteCoin), text(r.symbolStatus))),
    ...rows(spots).filter((r) => r.quoteCoin === 'USDT' && ['online', 'normal'].includes(text(r.status).toLowerCase())).map((r) => instrument('bitget', 'spot', text(r.symbol), text(r.baseCoin), text(r.quoteCoin), text(r.status)))
  ];
}
async function gateCatalog() {
  const [futures, spots] = await Promise.all([
    json<Json[]>('https://api.gateio.ws/api/v4/futures/usdt/contracts'),
    json<Json[]>('https://api.gateio.ws/api/v4/spot/currency_pairs')
  ]);
  return [
    ...futures.filter((r) => !r.in_delisting).map((r) => { const [base, quote] = text(r.name).split('_'); return instrument('gate', 'perpetual', text(r.name), base, quote, 'trading', { stepSize: number(r.order_size_min) ?? 0, contractMultiplier: number(r.quanto_multiplier) ?? 1 }); }),
    ...spots.filter((r) => r.quote === 'USDT' && r.trade_status === 'tradable').map((r) => instrument('gate', 'spot', text(r.id), text(r.base), text(r.quote), text(r.trade_status)))
  ];
}
async function kucoinCatalog() {
  const [futures, spots] = await Promise.all([
    json<Json>('https://api-futures.kucoin.com/api/v1/contracts/active'),
    json<Json>('https://api.kucoin.com/api/v2/symbols')
  ]);
  const rows = (p: Json) => (p.data as Json[] ?? []);
  return [
    ...rows(futures).filter((r) => r.quoteCurrency === 'USDT' && r.status === 'Open').map((r) => instrument('kucoin', 'perpetual', text(r.symbol), text(r.baseCurrency || r.rootSymbol), text(r.quoteCurrency), text(r.status), { stepSize: number(r.lotSize) ?? 0, contractMultiplier: number(r.multiplier) ?? 1 })),
    ...rows(spots).filter((r) => r.quoteCurrency === 'USDT' && r.enableTrading !== false).map((r) => instrument('kucoin', 'spot', text(r.symbol), text(r.baseCurrency), text(r.quoteCurrency), 'trading', { tickSize: number(r.priceIncrement) ?? 0, stepSize: number(r.baseIncrement) ?? 0 }))
  ];
}
async function asterCatalog() { return getAsterFutures().then(rows => rows); }

async function mexcCatalog() {
  // MEXC returns full ~1.5-2.3 MB catalogs; a 10s ceiling dropped the venue on slower links.
  const [futures, spots] = await Promise.all([
    json<Json>('https://contract.mexc.com/api/v1/contract/detail', 30_000),
    json<Json>('https://api.mexc.com/api/v3/exchangeInfo', 30_000)
  ]);
  const futureRows = futures.data as Json[] ?? [];
  const spotRows = spots.symbols as Json[] ?? [];
  return [
    ...futureRows.filter((r) => r.quoteCoin === 'USDT' && number(r.state) === 0).map((r) => instrument('mexc', 'perpetual', text(r.symbol), text(r.baseCoin), text(r.quoteCoin), 'trading', { stepSize: number(r.volUnit) ?? 0, contractMultiplier: number(r.contractSize) ?? 1 })),
    ...spotRows.filter((r) => r.quoteAsset === 'USDT' && ['1', 'ENABLED'].includes(text(r.status))).map((r) => instrument('mexc', 'spot', text(r.symbol), text(r.baseAsset), text(r.quoteAsset), text(r.status)))
  ];
}

const catalogs: Record<ExchangeId, CatalogLoader> = {
  binance: binanceCatalog, bitget: bitgetCatalog, bybit: bybitCatalog, okx: okxCatalog, gate: gateCatalog, kucoin: kucoinCatalog, mexc: mexcCatalog, aster: asterCatalog,
  upbit: () => koreanSpot.instruments('upbit'), bithumb: () => koreanSpot.instruments('bithumb'),
  htx: () => ccxtInstruments('htx'), bingx: () => ccxtInstruments('bingx'), phemex: () => ccxtInstruments('phemex'), bitfinex: () => ccxtInstruments('bitfinex'),
};
export async function getExchangeInstruments(exchange: ExchangeId) { return cached(exchange, catalogs[exchange]); }

function isContractAddress(query: string) { return /^0x[a-fA-F0-9]{40}$/.test(query) || /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(query); }
async function resolveIdentity(raw: string) {
  const query = raw.trim(); const contract = isContractAddress(query);
  if (!contract) return { symbol: koreanBaseSymbol(query)??query.toUpperCase().replace(/[^A-Z0-9]/g, ''), name: null as string | null, network: null as string | null, contract: false };
  try { const token = await resolveDexPaprikaIdentity(query); return { ...token, contract: true }; }
  catch {
    const response = await json<Json>(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(query)}`);
    const pairs = response.pairs as Json[] ?? [];
    const pair = pairs.find((row) => text((row.baseToken as Json)?.address).toLowerCase() === query.toLowerCase()) ?? pairs[0];
    const token = pair?.baseToken as Json | undefined;
    if (!token?.symbol) throw new Error('Contract address was not resolved to a token identity');
    return { symbol: text(token.symbol).toUpperCase(), name: text(token.name) || null, network: text(pair.chainId) || null, contract: true };
  }
}

export async function discoverAcrossExchanges(rawQuery: string): Promise<ProjectDiscoveryResult> {
  const identity = await resolveIdentity(rawQuery);
  const active = new Set(activeExchangeIds());
  const results = await Promise.allSettled((Object.keys(catalogs) as ExchangeId[]).filter((exchange) => active.has(exchange)).map(async (exchange) => ({ exchange, rows: await getExchangeInstruments(exchange) })));
  const markets: ProjectMarket[] = []; const warnings: string[] = [];
  for (const result of results) {
    if (result.status === 'rejected') { warnings.push(`One exchange catalog was unavailable: ${result.reason instanceof Error ? result.reason.message : 'unknown error'}.`); continue; }
    markets.push(...result.value.rows.filter((row) => row.base.toUpperCase() === identity.symbol).map(market));
  }
  markets.sort((a, b) => a.exchange.localeCompare(b.exchange) || (a.marketType === b.marketType ? a.quote.localeCompare(b.quote) : a.marketType === 'perpetual' ? -1 : 1));
  if (!markets.length) warnings.push(`No supported market matched ${identity.symbol} across the enabled exchanges.`);
  if(koreanBaseSymbol(rawQuery)&&!markets.some(m=>m.quote==='KRW'))warnings.push(`No KRW spot market for ${identity.symbol} was returned by Upbit or Bithumb.`);
  warnings.push(identity.contract ? 'Contract identity is resolved with DexPaprika cross-chain search (DexScreener fallback); confirm network and centralized-exchange listings before saving.' : 'Symbol matches can represent unrelated tokens; confirm each venue and pair before saving.');
  return { query: rawQuery.trim(), identity: { symbol: identity.symbol, name: identity.name, contractAddress: identity.contract ? rawQuery.trim() : null, network: identity.network, source: identity.contract ? 'contract' : 'symbol' }, markets, warnings };
}

function unavailableSnapshot(exchange: ExchangeId, market: ProjectMarket, source: string, values: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  const bid = values.bid ?? null, ask = values.ask ?? null;
  const base: VenueMarketSnapshot = { exchange, symbol: market.symbol, marketType: market.marketType, price: null, markPrice: null, change24hPct: null, volume24hBase: null, volume24hUsd: null, takerBuyVolumeUsd: null, takerSellVolumeUsd: null, volumeDeltaUsd: null, cvd: null, oiBase: null, oiUsd: null, oiDeltaBase: null, oiDeltaUsd: null, fundingRate: null, nextFundingTime: null, bid, ask, spreadBps: spreadBps(bid, ask), eventTime: Date.now(), fetchedAt: Date.now(), quality: 'partial', source, unavailable: [] };
  const result = { ...base, ...values };
  result.unavailable = ['takerBuyVolumeUsd', 'takerSellVolumeUsd', 'volumeDeltaUsd', 'cvd', 'oiDeltaBase', 'oiDeltaUsd'].filter((key) => result[key as keyof VenueMarketSnapshot] == null);
  return result;
}

async function nativeSnapshot(market: ProjectMarket): Promise<VenueMarketSnapshot> {
  if (market.exchange === 'binance') {
    const row = await getBinanceOverview(market.symbol);
    return unavailableSnapshot('binance', market, row.source, { price: row.price, markPrice: row.markPrice, change24hPct: row.change24hPct, volume24hBase: row.volume24hBase, volume24hUsd: row.volume24hUsd, cvd: row.cvdWindowDelta, oiBase: row.oiBase, oiUsd: row.oiUsd, fundingRate: row.fundingRate, nextFundingTime: row.nextFundingTime, eventTime: row.eventTime, quality: row.quality });
  }
  if (market.exchange === 'bybit') {
    const p = await json<Json>(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(market.symbol)}`); const r = (((p.result as Json)?.list as Json[]) ?? [])[0]; if (!r) throw new Error('Bybit ticker unavailable');
    return unavailableSnapshot('bybit', market, 'Bybit V5 linear ticker', { price: number(r.lastPrice), markPrice: number(r.markPrice), change24hPct: pct(r.price24hPcnt), volume24hBase: number(r.volume24h), volume24hUsd: number(r.turnover24h), oiBase: number(r.openInterest), oiUsd: number(r.openInterestValue), fundingRate: number(r.fundingRate), nextFundingTime: timestamp(r.nextFundingTime), bid: number(r.bid1Price), ask: number(r.ask1Price), eventTime: timestamp(p.time) ?? Date.now() });
  }
  if (market.exchange === 'bitget') {
    const [ticker, oi] = await Promise.all([json<Json>(`https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=${encodeURIComponent(market.symbol)}`), json<Json>(`https://api.bitget.com/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=${encodeURIComponent(market.symbol)}`)]); const r = (ticker.data as Json[] ?? [])[0]; const o = (oi.data as Json[] ?? [])[0] ?? {};
    return unavailableSnapshot('bitget', market, 'Bitget Mix public market API', { price: number(r?.lastPr), markPrice: number(r?.markPrice), change24hPct: pct(r?.change24h), volume24hBase: number(r?.baseVolume), volume24hUsd: number(r?.usdtVolume), oiBase: number(o.size ?? r?.holdingAmount), oiUsd: number(o.size ?? r?.holdingAmount) != null && number(r?.markPrice) != null ? number(o.size ?? r?.holdingAmount)! * number(r?.markPrice)! : null, fundingRate: number(r?.fundingRate), nextFundingTime: timestamp(r?.nextFundingTime), bid: number(r?.bidPr), ask: number(r?.askPr), eventTime: timestamp(ticker.requestTime) ?? Date.now() });
  }
  if (market.exchange === 'okx') {
    const id = encodeURIComponent(market.symbol); const [ticker, mark, oi, funding] = await Promise.all([json<Json>(`https://www.okx.com/api/v5/market/ticker?instId=${id}`), json<Json>(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${id}`), json<Json>(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${id}`), json<Json>(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`)]); const r = (ticker.data as Json[] ?? [])[0] ?? {}; const m = (mark.data as Json[] ?? [])[0] ?? {}; const o = (oi.data as Json[] ?? [])[0] ?? {}; const f = (funding.data as Json[] ?? [])[0] ?? {}; const last = number(r.last), open = number(r.open24h);
    const volumeBase = number(r.volCcy24h);
    return unavailableSnapshot('okx', market, 'OKX V5 public market API', { price: last, markPrice: number(m.markPx), change24hPct: last != null && open ? (last / open - 1) * 100 : null, volume24hBase: volumeBase, volume24hUsd: volumeBase != null && last != null ? volumeBase * last : null, oiBase: number(o.oiCcy), oiUsd: number(o.oiUsd), fundingRate: number(f.fundingRate), nextFundingTime: timestamp(f.nextFundingTime), bid: number(r.bidPx), ask: number(r.askPx), eventTime: timestamp(r.ts) ?? Date.now() });
  }
  if (market.exchange === 'gate') {
    const id = encodeURIComponent(market.symbol); const [contract, tickers] = await Promise.all([json<Json>(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${id}`), json<Json[]>(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${id}`)]); const r = tickers[0] ?? {}; const multiplier = number(contract.quanto_multiplier); const contracts = number(contract.position_size); const mark = number(contract.mark_price); const oiBase = normalizeContractQuantity(contracts, multiplier);
    return unavailableSnapshot('gate', market, 'Gate API v4 USDT futures', { price: number(r.last ?? contract.last_price), markPrice: mark, change24hPct: pct(r.change_percentage, true), volume24hBase: number(r.volume_24h_base), volume24hUsd: number(r.volume_24h_quote), oiBase, oiUsd: oiBase != null && mark != null ? oiBase * mark : null, fundingRate: number(contract.funding_rate), nextFundingTime: timestamp(contract.funding_next_apply), bid: number(r.highest_bid), ask: number(r.lowest_ask), eventTime: Date.now() });
  }
  if (market.exchange === 'kucoin') {
    const r = (await json<Json>(`https://api-futures.kucoin.com/api/v1/contracts/${encodeURIComponent(market.symbol)}`)).data as Json; const multiplier = number(r.multiplier); const contracts = number(r.openInterest); const price = number(r.lastTradePrice); const mark = number(r.markPrice); const oiBase = normalizeContractQuantity(contracts, multiplier);
    // KuCoin volumeOf24h is already BASE quantity (contracts x multiplier), so it must not be
    // multiplied again. nextFundingRateTime is a countdown duration; nextFundingRateDateTime is
    // the absolute venue time and is preferred.
    const fundingDuration = number(r.nextFundingRateTime);
    return unavailableSnapshot('kucoin', market, 'KuCoin Futures contract detail', { price, markPrice: mark, change24hPct: pct(r.priceChgPct), volume24hBase: number(r.volumeOf24h), volume24hUsd: number(r.turnoverOf24h), oiBase, oiUsd: oiBase != null && mark != null ? oiBase * mark : null, fundingRate: number(r.fundingFeeRate), nextFundingTime: timestamp(r.nextFundingRateDateTime) ?? (fundingDuration != null ? Date.now() + fundingDuration : null), eventTime: timestamp(r.lastTradeTime) ?? Date.now() });
  }
  if (market.exchange === 'aster') {
    const row = await getAsterOverview(market.symbol);
    return unavailableSnapshot('aster', market, row.source, { price: row.price, markPrice: row.markPrice, change24hPct: row.change24hPct, volume24hBase: row.volume24hBase, volume24hUsd: row.volume24hUsd, cvd: row.cvdWindowDelta, oiBase: row.oiBase, oiUsd: row.oiUsd, fundingRate: row.fundingRate, nextFundingTime: row.nextFundingTime, bid: row.bid ?? null, ask: row.ask ?? null, eventTime: row.eventTime, quality: row.quality });
  }
  if (market.exchange === 'mexc') {
    const p = await json<Json>(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(market.symbol)}`); const r = (Array.isArray(p.data) ? p.data[0] : p.data) as Json | undefined; if (!r) throw new Error(`MEXC ticker unavailable: ${text(p.message || p.code || 'empty response')}`); const details = await getExchangeInstruments('mexc'); const detail = details.find((i) => i.id === market.id); const contractSize = detail?.contractMultiplier ?? 1; const contracts = number(r.holdVol); const mark = number(r.fairPrice); const oiBase = normalizeContractQuantity(contracts, contractSize);
    return unavailableSnapshot('mexc', market, 'MEXC Contract public ticker', { price: number(r.lastPrice), markPrice: mark, change24hPct: pct(r.riseFallRate), volume24hBase: number(r.volume24) != null ? number(r.volume24)! * contractSize : null, volume24hUsd: number(r.amount24), oiBase, oiUsd: oiBase != null && mark != null ? oiBase * mark : null, fundingRate: number(r.fundingRate), nextFundingTime: timestamp(r.nextSettleTime), bid: number(r.bid1), ask: number(r.ask1), eventTime: timestamp(r.timestamp) ?? Date.now() });
  }
  // Never let an unknown venue fall through to a different exchange's endpoint.
  throw new Error(`${market.exchange} has no native snapshot adapter`);
}

/**
 * Snapshot routing.
 *
 * 1. KRW spot never enters the USDT path.
 * 2. CCXT-only venues are served by the unified adapter.
 * 3. Spot markets have no native snapshot adapter; CCXT fills them when enabled.
 * 4. A native venue is always tried first; CCXT is a labelled fallback, never a silent swap.
 */
/**
 * Short-lived in-flight/TTL cache. The watchlist, the project page, the AI evidence
 * builder and the volume matrix can all request the same venue within the same second;
 * without this they multiply upstream weight and trip exchange rate limits.
 */
const snapshotCache = new Map<string, { at: number; value: Promise<VenueMarketSnapshot> }>();
const SNAPSHOT_TTL_MS = 4_000;

export async function marketSnapshot(market: ProjectMarket): Promise<VenueMarketSnapshot> {
  const key = market.id;
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
  const value = snapshotUncached(market);
  snapshotCache.set(key, { at: Date.now(), value });
  if (snapshotCache.size > 500) { for (const [id, row] of snapshotCache) if (Date.now() - row.at > SNAPSHOT_TTL_MS * 4) snapshotCache.delete(id); }
  value.catch(() => { if (snapshotCache.get(key)?.value === value) snapshotCache.delete(key); });
  return value;
}

async function snapshotUncached(market: ProjectMarket): Promise<VenueMarketSnapshot> {
  if (market.exchange === 'upbit' || market.exchange === 'bithumb') throw new Error('KRW spot uses the independent korean-spot endpoint');
  if (isCcxtVenue(market.exchange, ccxtConfig)) return ccxtSnapshot(market, ccxtConfig);
  if (market.marketType === 'spot') {
    if (!ccxtConfig.spot) throw new Error('Spot snapshots require CCXT (NOX_CCXT_SPOT)');
    return ccxtSnapshot(market, ccxtConfig);
  }
  if (!venueBreakers.allow(market.exchange)) {
    throw new Error(`${market.exchange} is in an open-circuit cooldown after repeated failures; native request skipped`);
  }
  try {
    const snapshot = await nativeSnapshot(market);
    venueBreakers.success(market.exchange);
    return snapshot;
  } catch (error) {
    venueBreakers.failure(market.exchange, error instanceof Error ? error.message : 'native snapshot failed');
    if (!ccxtConfig.fallback) throw error;
    const reason = error instanceof Error ? error.message : 'native request failed';
    const fallback = await ccxtSnapshot(market, ccxtConfig).catch(() => null);
    if (!fallback) throw error;
    return {
      ...fallback,
      source: `${fallback.source} · fallback (native: ${reason.slice(0, 80)})`,
      quality: 'partial',
    };
  }
}

export function aggregateSnapshots(rows: VenueMarketSnapshot[], requested = rows.length): AggregatedMarketSnapshot {
  const usablePrice = rows.filter((r) => r.price != null); const priceWeight = usablePrice.reduce((sum, r) => sum + (r.volume24hUsd ?? 0), 0);
  const weighted = (key: 'price' | 'markPrice', source: VenueMarketSnapshot[], weightKey: 'volume24hUsd' | 'oiUsd') => { const valid = source.filter((r) => r[key] != null && r[weightKey] != null && r[weightKey]! > 0); const total = valid.reduce((sum, r) => sum + r[weightKey]!, 0); return total ? valid.reduce((sum, r) => sum + r[key]! * r[weightKey]!, 0) / total : null; };
  const oiRows = rows.filter((r) => r.oiUsd != null); const fundingRows = rows.filter((r) => r.fundingRate != null && r.oiUsd != null && r.oiUsd! > 0); const oiTotal = fundingRows.reduce((sum, r) => sum + r.oiUsd!, 0);
  const changeRows = rows.filter((r) => r.change24hPct != null && r.volume24hUsd != null && r.volume24hUsd! > 0); const changeWeight = changeRows.reduce((s, r) => s + r.volume24hUsd!, 0);
  return { exchange: 'aggregated', price: priceWeight ? weighted('price', usablePrice, 'volume24hUsd') : usablePrice.length ? usablePrice.reduce((s, r) => s + r.price!, 0) / usablePrice.length : null, markPrice: weighted('markPrice', rows, 'oiUsd'), change24hPct: changeWeight ? changeRows.reduce((s, r) => s + r.change24hPct! * r.volume24hUsd!, 0) / changeWeight : null, volume24hUsd: rows.some((r) => r.volume24hUsd != null) ? rows.reduce((s, r) => s + (r.volume24hUsd ?? 0), 0) : null, oiBase: rows.some((r) => r.oiBase != null) ? rows.reduce((s, r) => s + (r.oiBase ?? 0), 0) : null, oiUsd: oiRows.length ? oiRows.reduce((s, r) => s + r.oiUsd!, 0) : null, fundingRate: oiTotal ? fundingRows.reduce((s, r) => s + r.fundingRate! * r.oiUsd!, 0) / oiTotal : null, spreadBps: rows.some((r) => r.spreadBps != null) ? Math.min(...rows.flatMap((r) => r.spreadBps == null ? [] : [r.spreadBps])) : null, coverage: { requested, successful: rows.length, fresh: rows.filter((r) => Date.now() - r.fetchedAt < 30_000).length, venues: rows.map((r) => r.exchange) }, eventTime: rows.length ? Math.max(...rows.map((r) => r.eventTime)) : null, methodology: ['Price and 24h change are quote-volume weighted; prices are never summed.', 'Funding is open-interest-notional weighted; missing values are excluded, never replaced with zero.', 'OI and volume are summed only after venue contract-unit normalization.', 'Aggregate CVD is unavailable until compatible aggressor trades are time-aligned.'] };
}

export function computeExchangeContribution(rows: VenueMarketSnapshot[], selectedVenues = rows.length): ExchangeContributionSummary {
  const volumeRows = rows.filter((row) => row.volume24hUsd != null);
  const oiRows = rows.filter((row) => row.oiUsd != null);
  const depthRows: VenueMarketSnapshot[] = [];
  const volumeTotal = volumeRows.length ? volumeRows.reduce((sum, row) => sum + row.volume24hUsd!, 0) : null;
  const oiTotal = oiRows.length ? oiRows.reduce((sum, row) => sum + row.oiUsd!, 0) : null;
  const depthTotal = depthRows.length ? 0 : null;
  return {
    rows: rows.map((row) => ({
      exchange: row.exchange, symbol: row.symbol,
      volume24hUsd: row.volume24hUsd,
      volumeSharePct: row.volume24hUsd != null && volumeTotal ? row.volume24hUsd / volumeTotal * 100 : null,
      oiUsd: row.oiUsd,
      oiSharePct: row.oiUsd != null && oiTotal ? row.oiUsd / oiTotal * 100 : null,
      oiChange1hUsd: row.oiDeltaUsd,
      netAggressiveVolumeUsd: row.volumeDeltaUsd,
      bidDepthUsd: null, askDepthUsd: null, totalDepthUsd: null,
      depthSharePct: null,
      fundingRate: row.fundingRate,
      freshness: row.quality,
      eventTime: row.eventTime
    })).sort((a, b) => (b.volumeSharePct ?? -1) - (a.volumeSharePct ?? -1)),
    totals: { volume24hUsd: volumeTotal, oiUsd: oiTotal, totalDepthUsd: depthTotal },
    coverage: {
      selectedVenues,
      volumeVenues: volumeRows.length,
      oiVenues: oiRows.length,
      oiChange1hVenues: rows.filter((row) => row.oiDeltaUsd != null).length,
      aggressiveFlowVenues: rows.filter((row) => row.volumeDeltaUsd != null).length,
      depthVenues: depthRows.length
    },
    updatedAt: rows.length ? Math.max(...rows.map((row) => row.eventTime)) : null,
    methodology: [
      'Volume share uses each covered venue 24H USDT notional divided by total covered venue volume.',
      'OI share uses normalized USD open-interest notional divided by total covered venue OI.',
      'Percentages describe selected covered venues, not the entire global market.',
      'OI change, aggressive-flow and depth shares remain unavailable until time-aligned history and sequence-correct L2 books exist.'
    ]
  };
}

export function detectCrossExchangeInsights(rows: VenueMarketSnapshot[], contribution: ExchangeContributionSummary): CrossExchangeInsight[] {
  if (!rows.length) return [];
  const timestamp = Math.max(...rows.map((row) => row.eventTime));
  const freshness = rows.every((row) => Date.now() - row.fetchedAt < 60_000) ? 'live' : 'partial';
  const insights: CrossExchangeInsight[] = [];
  const topVolume = contribution.rows.find((row) => row.volumeSharePct != null);
  if (contribution.coverage.volumeVenues >= 2 && topVolume?.volumeSharePct != null && topVolume.volumeSharePct >= 45) insights.push({ id: `volume:${topVolume.exchange}:${timestamp}`, type: 'volume_concentration', label: 'Potential Volume Concentration', confidence: Math.min(92, Math.round(45 + topVolume.volumeSharePct / 2)), exchange: topVolume.exchange, observed: [`${topVolume.exchange.toUpperCase()} contributes ${topVolume.volumeSharePct.toFixed(1)}% of covered 24H volume`], evidence: [`Coverage ${contribution.coverage.volumeVenues}/${contribution.coverage.selectedVenues} selected perpetual venues`, `Covered volume ${volumeLabel(contribution.totals.volume24hUsd)}`], freshness, timestamp, inferenceNotice: 'Concentration is measured only across covered selected venues; it does not identify trader intent or manipulation.' });
  const topOi = [...contribution.rows].sort((a, b) => (b.oiSharePct ?? -1) - (a.oiSharePct ?? -1))[0];
  if (contribution.coverage.oiVenues >= 2 && topOi?.oiSharePct != null && topOi.oiSharePct >= 45) insights.push({ id: `oi:${topOi.exchange}:${timestamp}`, type: 'oi_concentration', label: 'Potential OI Concentration', confidence: Math.min(92, Math.round(45 + topOi.oiSharePct / 2)), exchange: topOi.exchange, observed: [`${topOi.exchange.toUpperCase()} contributes ${topOi.oiSharePct.toFixed(1)}% of covered OI notional`], evidence: [`Coverage ${contribution.coverage.oiVenues}/${contribution.coverage.selectedVenues} selected perpetual venues`, `Covered OI ${volumeLabel(contribution.totals.oiUsd)}`], freshness, timestamp, inferenceNotice: 'Open interest does not reveal whether positions are long or short, opening or closing.' });
  const fundingRows = rows.filter((row) => row.fundingRate != null).sort((a, b) => a.fundingRate! - b.fundingRate!);
  if (fundingRows.length >= 2) { const low = fundingRows[0], high = fundingRows.at(-1)!; const spread = high.fundingRate! - low.fundingRate!; if (spread >= 0.00005) insights.push({ id: `funding:${timestamp}`, type: 'funding_divergence', label: 'Funding Divergence', confidence: Math.min(90, Math.round(50 + spread * 100_000)), exchange: high.exchange, observed: [`${high.exchange.toUpperCase()} ${(high.fundingRate! * 100).toFixed(4)}% vs ${low.exchange.toUpperCase()} ${(low.fundingRate! * 100).toFixed(4)}%`], evidence: [`Funding spread ${(spread * 10_000).toFixed(2)} bps`, `${fundingRows.length}/${contribution.coverage.selectedVenues} venues covered`], freshness, timestamp, inferenceNotice: 'Venue funding intervals and calculation rules can differ; divergence is contextual, not a directional forecast.' }); }
  const priceRows = rows.filter((row) => row.price != null).sort((a, b) => a.price! - b.price!);
  if (priceRows.length >= 2) { const low = priceRows[0], high = priceRows.at(-1)!; const mid = (low.price! + high.price!) / 2; const dispersion = mid ? (high.price! - low.price!) / mid * 10_000 : 0; if (dispersion >= 5) insights.push({ id: `price:${timestamp}`, type: 'price_dispersion', label: 'Cross-Venue Price Dispersion', confidence: Math.min(88, Math.round(48 + dispersion)), exchange: high.exchange, observed: [`${dispersion.toFixed(2)} bps between ${low.exchange.toUpperCase()} and ${high.exchange.toUpperCase()}`], evidence: [`${priceRows.length}/${contribution.coverage.selectedVenues} venues covered`, 'Venue timestamps are freshness-checked but not guaranteed tick-identical'], freshness, timestamp, inferenceNotice: 'Displayed dispersion is observational and excludes executable depth, fees, latency and transfer constraints.' }); }
  return insights;
}

function volumeLabel(value: number | null) {
  if (value == null) return 'unavailable';
  return `$${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)}`;
}

const venueBundleCache = new Map<string, { at: number; value: Promise<ProjectVenueResponse> }>();
const VENUE_BUNDLE_TTL_MS = 5_000;

export async function projectVenueSnapshots(markets: ProjectMarket[]): Promise<ProjectVenueResponse> {
  const key = markets.map((market) => market.id).sort().join('|');
  const cached = venueBundleCache.get(key);
  if (cached && Date.now() - cached.at < VENUE_BUNDLE_TTL_MS) return cached.value;
  const value = venueBundleUncached(markets);
  venueBundleCache.set(key, { at: Date.now(), value });
  if (venueBundleCache.size > 200) { for (const [id, row] of venueBundleCache) if (Date.now() - row.at > VENUE_BUNDLE_TTL_MS * 4) venueBundleCache.delete(id); }
  value.catch(() => { if (venueBundleCache.get(key)?.value === value) venueBundleCache.delete(key); });
  return value;
}

async function venueBundleUncached(markets: ProjectMarket[]): Promise<ProjectVenueResponse> {
  const selected = markets.filter((m) => m.marketType === 'perpetual');
  const settled = await Promise.allSettled(selected.map(marketSnapshot)); const snapshots: VenueMarketSnapshot[] = []; const failures: ProjectVenueResponse['failures'] = [];
  settled.forEach((result, index) => result.status === 'fulfilled' ? snapshots.push(result.value) : failures.push({ exchange: selected[index].exchange, symbol: selected[index].symbol, message: result.reason instanceof Error ? result.reason.message : 'Snapshot unavailable' }));
  const contribution = computeExchangeContribution(snapshots, selected.length);
  return { snapshots, aggregate: aggregateSnapshots(snapshots, selected.length), contribution, insights: detectCrossExchangeInsights(snapshots, contribution), failures, capabilities: exchangeCapabilities() };
}
