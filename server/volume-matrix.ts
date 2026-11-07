import type { ExchangeId, MarketProject, ProjectMarket, Quality, VenueMarketSnapshot } from '../shared/types.ts';
import type { KrwVolumeBlock, VenueVolumeLeg, VenueVolumeRow, VolumeMatrixResponse } from '../shared/volume.ts';
import { marketSnapshot } from './exchanges.ts';
import { koreanSpot } from './korean-spot.ts';
import type { KoreanSpotSnapshot, KoreanVenue } from '../shared/korean-spot.ts';

// Per-venue 24h spot turnover. Binance Spot uses the public data-api host by default because
// api.binance.com is geo/network blocked on some links; override with BINANCE_SPOT_REST_BASE.
const BINANCE_SPOT = process.env.BINANCE_SPOT_REST_BASE ?? 'https://data-api.binance.vision';
const TIMEOUT = 10_000;
const CACHE_MS = 15_000;
const USER_AGENT = 'NOX-Market-Intelligence/0.2';
const NOW_TOLERANCE = 5_000;
const STALE_MS = 60_000;

const QUALITY_RANK: Record<Quality, number> = { live: 0, partial: 1, stale: 2, unavailable: 3 };
const worse = (a: Quality, b: Quality): Quality => QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;

type Json = Record<string, unknown>;
const row = (value: unknown): Json => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(row) : [];
function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function textValue(value: unknown): string { return value == null ? '' : String(value); }

/** Venue-specific spot endpoints. Only USDT-quoted markets are requested. */
export function spotVolumeUrl(exchange: ExchangeId, market: ProjectMarket): string | null {
  const symbol = encodeURIComponent(market.symbol);
  switch (exchange) {
    case 'binance': return `${BINANCE_SPOT}/api/v3/ticker/24hr?symbol=${symbol}`;
    case 'bybit': return `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`;
    case 'okx': return `https://www.okx.com/api/v5/market/ticker?instId=${symbol}`;
    case 'bitget': return `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`;
    case 'gate': return `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}`;
    case 'kucoin': return `https://api.kucoin.com/api/v1/market/stats?symbol=${symbol}`;
    case 'mexc': return `https://api.mexc.com/api/v3/ticker/24hr?symbol=${symbol}`;
    default: return null;
  }
}

function legQuality(eventTime: number | null, fetchedAt: number, hasPrice: boolean, hasQuoteVolume: boolean): Quality {
  if (!hasPrice || !hasQuoteVolume) return 'partial';
  if (eventTime == null) return 'partial';
  if (eventTime > fetchedAt + NOW_TOLERANCE || fetchedAt - eventTime > STALE_MS) return 'stale';
  return 'live';
}

function spotLeg(
  market: ProjectMarket,
  fetchedAt: number,
  values: { symbol: string; price: number | null; base: number | null; quote: number | null; eventTime: number | null; source: string },
): VenueVolumeLeg {
  if (values.symbol && values.symbol !== market.symbol) throw new Error(`${market.exchange} spot identity mismatch: expected ${market.symbol}, received ${values.symbol}`);
  const isUsdt = market.quote === 'USDT';
  const volume24hUsd = isUsdt ? values.quote : null;
  const unavailable: string[] = [];
  if (values.price == null) unavailable.push('price');
  if (values.base == null) unavailable.push('volume24hBase');
  if (values.quote == null) unavailable.push('volume24hQuote');
  if (!isUsdt) unavailable.push('volume24hUsd (non-USDT quote; no FX conversion)');
  if (values.eventTime == null) unavailable.push('eventTime (venue ticker has no source timestamp)');
  return {
    exchange: market.exchange,
    marketType: 'spot',
    symbols: [market.symbol],
    quote: market.quote,
    price: values.price,
    volume24hBase: values.base,
    volume24hQuote: values.quote,
    volume24hUsd,
    eventTime: values.eventTime,
    fetchedAt,
    quality: legQuality(values.eventTime, fetchedAt, values.price != null, values.quote != null),
    source: values.source,
    unavailable,
  };
}

/** Pure venue payload → leg. Exported for fixture tests; throws on identity mismatch. */
export function normalizeSpotVolume(exchange: ExchangeId, market: ProjectMarket, payload: unknown, fetchedAt = Date.now()): VenueVolumeLeg {
  if (exchange === 'binance') {
    const value = row(payload);
    return spotLeg(market, fetchedAt, { symbol: textValue(value.symbol), price: num(value.lastPrice), base: num(value.volume), quote: num(value.quoteVolume), eventTime: num(value.closeTime), source: 'Binance Spot public REST (24h ticker)' });
  }
  if (exchange === 'bybit') {
    const value = rows((row(payload).result as Json | undefined)?.list).at(0) ?? {};
    return spotLeg(market, fetchedAt, { symbol: textValue(value.symbol), price: num(value.lastPrice), base: num(value.volume24h), quote: num(value.turnover24h), eventTime: num(row(payload).time), source: 'Bybit V5 spot ticker' });
  }
  if (exchange === 'okx') {
    const value = rows(row(payload).data).at(0) ?? {};
    // OKX SPOT: vol24h is base quantity, volCcy24h is quote notional (opposite of SWAP).
    return spotLeg(market, fetchedAt, { symbol: textValue(value.instId), price: num(value.last), base: num(value.vol24h), quote: num(value.volCcy24h), eventTime: num(value.ts), source: 'OKX V5 spot ticker' });
  }
  if (exchange === 'bitget') {
    const value = rows(row(payload).data).at(0) ?? {};
    return spotLeg(market, fetchedAt, { symbol: textValue(value.symbol), price: num(value.lastPr), base: num(value.baseVolume), quote: num(value.quoteVolume ?? value.usdtVolume), eventTime: num(value.ts), source: 'Bitget V2 spot ticker' });
  }
  if (exchange === 'gate') {
    const value = rows(payload).at(0) ?? {};
    return spotLeg(market, fetchedAt, { symbol: textValue(value.currency_pair), price: num(value.last), base: num(value.base_volume), quote: num(value.quote_volume), eventTime: null, source: 'Gate API v4 spot ticker (no source timestamp)' });
  }
  if (exchange === 'kucoin') {
    const value = row(row(payload).data);
    return spotLeg(market, fetchedAt, { symbol: textValue(value.symbol), price: num(value.last), base: num(value.vol), quote: num(value.volValue), eventTime: num(value.time), source: 'KuCoin spot 24h market stats' });
  }
  if (exchange === 'mexc') {
    const value = row(payload);
    return spotLeg(market, fetchedAt, { symbol: textValue(value.symbol), price: num(value.lastPrice), base: num(value.volume), quote: num(value.quoteVolume), eventTime: num(value.closeTime), source: 'MEXC Spot public 24h ticker' });
  }
  throw new Error(`${exchange} has no verified USDT spot volume adapter (KRW spot stays in the Korean panel)`);
}

async function fetchSpotVolume(market: ProjectMarket, fetchImpl: typeof fetch): Promise<VenueVolumeLeg> {
  const url = spotVolumeUrl(market.exchange, market);
  if (!url) throw new Error(`${market.exchange} has no verified USDT spot volume adapter (KRW spot stays in the Korean panel)`);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json', 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${market.exchange} spot HTTP ${response.status}`);
  return normalizeSpotVolume(market.exchange, market, await response.json(), Date.now());
}

/** KRW spot leg: amounts stay in KRW and are never converted to USD. */
export function krwLegFromSnapshot(snapshot: KoreanSpotSnapshot): VenueVolumeLeg {
  const unavailable: string[] = [];
  if (snapshot.priceKrw == null) unavailable.push('price');
  if (snapshot.volume24hBase == null) unavailable.push('volume24hBase');
  if (snapshot.turnover24hKrw == null) unavailable.push('turnover24hKrw');
  unavailable.push('volume24hUsd (KRW quote; no FX conversion)');
  if (snapshot.sourceTime == null) unavailable.push('sourceTime (venue timestamp rejected or missing)');
  return {
    exchange: snapshot.market.exchange,
    marketType: 'spot',
    symbols: [snapshot.market.symbol],
    quote: 'KRW',
    price: snapshot.priceKrw,
    volume24hBase: snapshot.volume24hBase,
    volume24hQuote: snapshot.turnover24hKrw,
    // KRW is intentionally not converted: no reliable timestamped FX source is configured.
    volume24hUsd: null,
    eventTime: snapshot.sourceTime ?? snapshot.lastTradeTime ?? null,
    fetchedAt: snapshot.fetchedAt,
    quality: snapshot.quality,
    source: snapshot.source,
    unavailable,
  };
}

export function perpLegFromSnapshot(market: ProjectMarket, snapshot: VenueMarketSnapshot): VenueVolumeLeg {
  const isUsdt = market.quote === 'USDT';
  const unavailable: string[] = [];
  if (snapshot.price == null) unavailable.push('price');
  if (snapshot.volume24hBase == null) unavailable.push('volume24hBase');
  if (snapshot.volume24hUsd == null) unavailable.push('volume24hUsd');
  return {
    exchange: market.exchange,
    marketType: 'perpetual',
    symbols: [market.symbol],
    quote: market.quote,
    price: snapshot.price,
    volume24hBase: snapshot.volume24hBase,
    volume24hQuote: isUsdt ? snapshot.volume24hUsd : null,
    volume24hUsd: isUsdt ? snapshot.volume24hUsd : null,
    eventTime: snapshot.eventTime || null,
    fetchedAt: snapshot.fetchedAt,
    // Leg quality describes the turnover/price observation, not the whole snapshot: a perp
    // snapshot can be 'partial' because flow fields are missing while its 24h volume is live.
    quality: legQuality(snapshot.eventTime || null, snapshot.fetchedAt, snapshot.price != null, snapshot.volume24hUsd != null),
    source: snapshot.source,
    unavailable,
  };
}

function combineLegs(exchange: ExchangeId, marketType: 'spot' | 'perpetual', legs: VenueVolumeLeg[]): VenueVolumeLeg | null {
  if (!legs.length) return null;
  const sum = (key: 'volume24hBase' | 'volume24hQuote' | 'volume24hUsd') => legs.some((leg) => leg[key] != null) ? legs.reduce((total, leg) => total + (leg[key] ?? 0), 0) : null;
  const quotes = [...new Set(legs.map((leg) => leg.quote).filter((quote): quote is string => quote != null))];
  const singleQuote = quotes.length === 1;
  const eventTimes = legs.map((leg) => leg.eventTime).filter((time): time is number => time != null);
  const prices = legs.map((leg) => leg.price).filter((price): price is number => price != null);
  return {
    exchange,
    marketType,
    symbols: [...new Set(legs.flatMap((leg) => leg.symbols))],
    quote: singleQuote ? quotes[0] : quotes.length ? quotes.join(' + ') : null,
    price: prices.length ? prices.reduce((total, price) => total + price, 0) / prices.length : null,
    volume24hBase: sum('volume24hBase'),
    // Quote turnover is only additive inside one quote currency; mixed quotes stay null.
    volume24hQuote: singleQuote ? sum('volume24hQuote') : null,
    volume24hUsd: sum('volume24hUsd'),
    // Conservative staleness: the oldest event time decides freshness.
    eventTime: eventTimes.length ? Math.min(...eventTimes) : null,
    fetchedAt: Math.max(...legs.map((leg) => leg.fetchedAt)),
    quality: legs.map((leg) => leg.quality).reduce(worse, 'live'),
    source: [...new Set(legs.map((leg) => leg.source))].join('; '),
    unavailable: [...new Set(legs.flatMap((leg) => leg.unavailable))],
  };
}

/** Pure assembly of the venue matrix; no network. Exported for tests. */
function medianValue(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Heuristic flags, not proof of wash trading. They point a researcher at legs worth manual
 * inspection: stale/partial legs, turnover-vs-OI far from the covered-venue median, wide basis.
 */
function applyQualityFlags(rows: VenueVolumeRow[]): void {
  const turnovers = rows.map((row) => row.volumeOiTurnover).filter((value): value is number => value != null && value > 0);
  const median = medianValue(turnovers);
  for (const row of rows) {
    const flags: VenueVolumeRow['qualityFlags'] = [];
    // Mark CCXT-sourced turnover so a "live" quality flag is not read as full native coverage.
    if ([row.spot, row.perpetual].some((leg) => leg?.source.startsWith('CCXT'))) flags.push('ccxt-source');
    const qualities = [row.spot?.quality, row.perpetual?.quality];
    if (qualities.includes('stale')) flags.push('stale-leg');
    if (qualities.includes('partial')) flags.push('partial-leg');
    if (row.volumeOiTurnover != null && median != null && turnovers.length >= 2) {
      if (row.volumeOiTurnover > median * 3) flags.push('volume-oi-outlier-high');
      else if (row.volumeOiTurnover < median / 3) flags.push('volume-oi-outlier-low');
    }
    if (row.spotPerpBasisBps != null && Math.abs(row.spotPerpBasisBps) > 100) flags.push('wide-basis');
    row.qualityFlags = flags;
  }
}

export function buildVolumeMatrix(
  project: MarketProject,
  spotLegs: VenueVolumeLeg[],
  perpLegs: VenueVolumeLeg[],
  failures: VolumeMatrixResponse['failures'],
  asOf = Date.now(),
  perpMeta: Map<ExchangeId, { oiUsd: number | null; fundingRate: number | null; nextFundingTime: number | null }> = new Map(),
): VolumeMatrixResponse {
  const usdtSpotLegs = spotLegs.filter((leg) => leg.quote !== 'KRW');
  const krwSpotLegs = spotLegs.filter((leg) => leg.quote === 'KRW');
  const usdtFailures = failures.filter((failure) => failure.quote !== 'KRW');
  const exchanges: ExchangeId[] = [...new Set(project.markets.filter((market) => market.quote !== 'KRW').map((market) => market.exchange))];
  const rowsOut: VenueVolumeRow[] = exchanges.map((exchange) => {
    const spot = combineLegs(exchange, 'spot', usdtSpotLegs.filter((leg) => leg.exchange === exchange));
    const perpetual = combineLegs(exchange, 'perpetual', perpLegs.filter((leg) => leg.exchange === exchange));
    const spotUsd = spot?.volume24hUsd ?? null;
    const perpUsd = perpetual?.volume24hUsd ?? null;
    const qualities = [spot?.quality, perpetual?.quality].filter((quality): quality is Quality => quality != null);
    const meta = perpMeta.get(exchange);
    return {
      exchange,
      spot,
      perpetual,
      spotSharePct: null,
      perpetualSharePct: null,
      spotPerpVolumeRatio: spotUsd != null && perpUsd != null && perpUsd > 0 ? spotUsd / perpUsd : null,
      // Descriptive last-price basis only: thin books can make it unexecutable.
      spotPerpBasisBps: spot?.price != null && perpetual?.price != null && perpetual.price > 0 ? (spot.price - perpetual.price) / perpetual.price * 10_000 : null,
      volumeOiTurnover: perpUsd != null && meta?.oiUsd != null && meta.oiUsd > 0 ? perpUsd / meta.oiUsd : null,
      qualityFlags: [],
      oiUsd: meta?.oiUsd ?? null,
      fundingRate: meta?.fundingRate ?? null,
      nextFundingTime: meta?.nextFundingTime ?? null,
      freshness: qualities.length ? qualities.reduce(worse, 'live') : 'unavailable',
    };
  });
  const sum = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value != null);
    return present.length ? present.reduce((total, value) => total + value, 0) : null;
  };
  const spotTotal = sum(rowsOut.map((entry) => entry.spot?.volume24hUsd ?? null));
  const perpTotal = sum(rowsOut.map((entry) => entry.perpetual?.volume24hUsd ?? null));
  for (const entry of rowsOut) {
    const spotUsd = entry.spot?.volume24hUsd ?? null;
    const perpUsd = entry.perpetual?.volume24hUsd ?? null;
    entry.spotSharePct = spotUsd != null && spotTotal ? spotUsd / spotTotal * 100 : null;
    entry.perpetualSharePct = perpUsd != null && perpTotal ? perpUsd / perpTotal * 100 : null;
  }
  applyQualityFlags(rowsOut);
  const spotVenues = rowsOut.filter((entry) => entry.spot != null).length;
  const perpetualVenues = rowsOut.filter((entry) => entry.perpetual != null).length;
  const bothLegs = rowsOut.filter((entry) => entry.spot != null && entry.perpetual != null).length;
  const reasons: string[] = [];
  if (spotVenues === 0) reasons.push('no selected spot market produced a verified USDT volume leg');
  if (perpetualVenues === 0) reasons.push('no selected perpetual market produced a verified volume leg');
  if (spotVenues === 1) reasons.push('spot coverage is a single venue; this is context, not a cross-market view');
  if (perpetualVenues === 1) reasons.push('perpetual coverage is a single venue; this is context, not a cross-market view');
  if (rowsOut.some((entry) => entry.freshness === 'stale')) reasons.push('at least one leg is stale (>60s old or future-dated)');
  if (project.markets.some((market) => market.marketType === 'spot' && market.quote !== 'USDT')) reasons.push('non-USDT spot quotes are excluded from USDT totals (no FX conversion)');
  if (usdtFailures.length) reasons.push(`${usdtFailures.length} venue/leg request(s) failed and stay unavailable`);
  return {
    projectId: project.id,
    generatedAt: Date.now(),
    asOf,
    unit: 'quote-currency (USDT totals only)',
    rows: rowsOut,
    totals: { spotUsd: spotTotal, perpetualUsd: perpTotal, spotPerpRatio: spotTotal != null && perpTotal != null && perpTotal > 0 ? spotTotal / perpTotal : null },
    coverage: { requestedVenues: exchanges.length, spotVenues, perpetualVenues, bothLegsVenues: bothLegs },
    failures,
    claimGate: { state: spotVenues > 0 && perpetualVenues > 0 ? 'available' : 'restricted', reasons },
    krw: buildKrwBlock(project, krwSpotLegs, failures),
    methodology: [
      'Spot and perpetual turnover are reported in separate columns; the matrix never sums them into a single "volume".',
      'Only USDT-quoted markets contribute to USDT totals; USDC/FDUSD quotes stay in their own currency and KRW spot is reported in a separate KRW block (no FX conversion).',
      '24h venue counters are as-of snapshots with per-venue event/fetch times; they are rolling windows, not event-time-aligned bars, so minute-scale share changes require local trade collection.',
      'Shares are computed over selected, successfully covered venues only — never the global market.',
      'Missing legs and unavailable fields stay null; no zero substitution.',
      'Spot / perpetual ratio requires both legs on the same venue and the same quote currency.',
      'qualityFlags are heuristics (stale/partial legs, turnover-vs-OI outlier vs covered-venue median, wide basis); they are not proof of wash trading or market-maker activity.',
    ],
  };
}

type KrwFetcher = (project: MarketProject) => Promise<{ items: KoreanSpotSnapshot[]; failures: Array<{ exchange: KoreanVenue; symbol: string; reason: string }> }>;
const defaultKrwFetcher: KrwFetcher = (project) => koreanSpot.project(project);

/**
 * Fetch only the spot legs (used by the collector so perpetual snapshots are not fetched twice).
 * KRW markets reuse the existing Upbit/Bithumb service (ticker + orderbook + rate-limit gates);
 * their amounts stay in KRW and never enter the USDT totals.
 */
export async function fetchSpotLegs(
  project: MarketProject,
  fetchImpl: typeof fetch = fetch,
  krwFetcher: KrwFetcher = defaultKrwFetcher,
): Promise<{ legs: VenueVolumeLeg[]; failures: VolumeMatrixResponse['failures'] }> {
  const markets = project.markets.filter((market) => market.marketType === 'spot');
  if (!markets.length) return { legs: [], failures: [] };
  const krwMarkets = markets.filter((market) => market.quote === 'KRW' && (market.exchange === 'upbit' || market.exchange === 'bithumb'));
  const directMarkets = markets.filter((market) => !krwMarkets.includes(market));
  const [directResults, krwResult] = await Promise.all([
    Promise.allSettled(directMarkets.map((market) => fetchSpotVolume(market, fetchImpl))),
    krwMarkets.length ? krwFetcher(project).catch((reason: unknown) => ({ items: [], failures: krwMarkets.map((market) => ({ exchange: market.exchange as KoreanVenue, symbol: market.symbol, reason: reason instanceof Error ? reason.message : 'KRW spot unavailable' })) })) : Promise.resolve({ items: [] as KoreanSpotSnapshot[], failures: [] as Array<{ exchange: KoreanVenue; symbol: string; reason: string }> }),
  ]);
  const legs: VenueVolumeLeg[] = [];
  const failures: VolumeMatrixResponse['failures'] = [];
  directResults.forEach((result, index) => {
    const market = directMarkets[index];
    if (result.status === 'fulfilled') legs.push(result.value);
    else failures.push({ exchange: market.exchange, marketType: 'spot', symbol: market.symbol, quote: market.quote, message: result.reason instanceof Error ? result.reason.message : 'spot volume unavailable' });
  });
  for (const snapshot of krwResult.items) legs.push(krwLegFromSnapshot(snapshot));
  for (const failure of krwResult.failures) failures.push({ exchange: failure.exchange, marketType: 'spot', symbol: failure.symbol, quote: 'KRW', message: failure.reason });
  return { legs, failures };
}

/** KRW block: shares are computed inside the KRW venue set; USDT totals are untouched. */
export function buildKrwBlock(
  project: MarketProject,
  krwLegs: VenueVolumeLeg[],
  failures: VolumeMatrixResponse['failures'],
): KrwVolumeBlock {
  const exchanges: ExchangeId[] = [...new Set(project.markets.filter((market) => market.quote === 'KRW' && market.marketType === 'spot').map((market) => market.exchange))];
  const rowsOut: VenueVolumeRow[] = exchanges.map((exchange) => {
    const spot = combineLegs(exchange, 'spot', krwLegs.filter((leg) => leg.exchange === exchange));
    return {
      exchange, spot, perpetual: null, spotSharePct: null, perpetualSharePct: null, spotPerpVolumeRatio: null, spotPerpBasisBps: null,
      volumeOiTurnover: null, qualityFlags: [], oiUsd: null, fundingRate: null, nextFundingTime: null, freshness: spot?.quality ?? 'unavailable',
    };
  });
  const krwValues = rowsOut.map((entry) => entry.spot?.volume24hQuote ?? null).filter((value): value is number => value != null);
  const spotKrw = krwValues.length ? krwValues.reduce((total, value) => total + value, 0) : null;
  for (const entry of rowsOut) {
    const value = entry.spot?.volume24hQuote ?? null;
    entry.spotSharePct = value != null && spotKrw ? value / spotKrw * 100 : null;
  }
  for (const entry of rowsOut) {
    if (entry.freshness === 'stale') entry.qualityFlags.push('stale-leg');
    else if (entry.freshness === 'partial') entry.qualityFlags.push('partial-leg');
  }
  const krwFailures = failures.filter((failure) => failure.quote === 'KRW');
  const reasons: string[] = [];
  if (rowsOut.length === 0) reasons.push('no Upbit/Bithumb KRW spot market selected');
  if (rowsOut.filter((entry) => entry.spot != null).length === 1) reasons.push('KRW coverage is a single venue; this is context, not a cross-market view');
  if (rowsOut.some((entry) => entry.freshness === 'stale')) reasons.push('at least one KRW leg is stale');
  if (krwFailures.length) reasons.push(`${krwFailures.length} KRW request(s) failed and stay unavailable`);
  return {
    rows: rowsOut,
    totals: { spotKrw },
    coverage: { venues: rowsOut.filter((entry) => entry.spot != null).length },
    claimGate: { state: rowsOut.length > 0 && rowsOut.some((entry) => entry.spot != null) ? 'available' : 'restricted', reasons },
    methodology: [
      'KRW spot turnover stays in KRW; it is never converted to USD or added to USDT totals without a timestamped FX source.',
      'KRW shares are computed only across the selected Upbit/Bithumb venues, not the global KRW market.',
      'Upbit/Bithumb ticker timestamps can be KST-shifted or future-dated; rejected source times keep the leg partial and use fetch time only for display.',
      '24h counters are as-of venue snapshots, not event-time-aligned bars.',
    ],
  };
}

/** Assemble a volume record from already-fetched perpetual snapshots (no extra network calls). */
export function buildVolumeRecord(
  project: MarketProject,
  spotLegs: VenueVolumeLeg[],
  spotFailures: VolumeMatrixResponse['failures'],
  perpSnapshots: VenueMarketSnapshot[],
  perpFailures: VolumeMatrixResponse['failures'],
  asOf = Date.now(),
): VolumeMatrixResponse {
  const perpLegs: VenueVolumeLeg[] = [];
  const perpMeta = new Map<ExchangeId, { oiUsd: number | null; fundingRate: number | null; nextFundingTime: number | null }>();
  for (const market of project.markets.filter((candidate) => candidate.marketType === 'perpetual')) {
    const snapshot = perpSnapshots.find((candidate) => candidate.exchange === market.exchange && candidate.symbol === market.symbol);
    if (!snapshot) continue;
    perpLegs.push(perpLegFromSnapshot(market, snapshot));
    perpMeta.set(market.exchange, { oiUsd: snapshot.oiUsd, fundingRate: snapshot.fundingRate, nextFundingTime: snapshot.nextFundingTime });
  }
  return buildVolumeMatrix(project, spotLegs, perpLegs, [...spotFailures, ...perpFailures], asOf, perpMeta);
}

const cache = new Map<string, { until: number; value: VolumeMatrixResponse }>();
export function clearVolumeMatrixCache() { cache.clear(); }

/** Fetch spot + perpetual turnover for every selected market and assemble the venue matrix. */
export async function volumeMatrix(
  project: MarketProject,
  deps: { fetchImpl?: typeof fetch; perpFetcher?: (market: ProjectMarket) => Promise<VenueMarketSnapshot>; krwFetcher?: KrwFetcher; now?: number } = {},
): Promise<VolumeMatrixResponse> {
  const key = `${project.id}:${JSON.stringify(project.markets.map((market) => [market.exchange, market.marketType, market.symbol]))}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const perpFetcher = deps.perpFetcher ?? marketSnapshot;
  const perpMarkets = project.markets.filter((market) => market.marketType === 'perpetual');
  const [spotResult, perpResults] = await Promise.all([
    fetchSpotLegs(project, fetchImpl, deps.krwFetcher ?? defaultKrwFetcher),
    Promise.allSettled(perpMarkets.map((market) => perpFetcher(market))),
  ]);
  const failures: VolumeMatrixResponse['failures'] = [...spotResult.failures];
  const spotLegs: VenueVolumeLeg[] = [...spotResult.legs];
  const perpLegs: VenueVolumeLeg[] = [];
  perpResults.forEach((result, index) => {
    const market = perpMarkets[index];
    if (result.status === 'fulfilled') perpLegs.push(perpLegFromSnapshot(market, result.value));
    else failures.push({ exchange: market.exchange, marketType: 'perpetual', symbol: market.symbol, quote: market.quote, message: result.reason instanceof Error ? result.reason.message : 'perpetual volume unavailable' });
  });
  const asOf = deps.now ?? Date.now();
  // OI/funding are only meaningful on the perpetual leg; attach them to the matching row.
  const perpMeta = new Map<ExchangeId, { oiUsd: number | null; fundingRate: number | null; nextFundingTime: number | null }>();
  perpResults.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    perpMeta.set(perpMarkets[index].exchange, { oiUsd: result.value.oiUsd, fundingRate: result.value.fundingRate, nextFundingTime: result.value.nextFundingTime });
  });
  const matrix = buildVolumeMatrix(project, spotLegs, perpLegs, failures, asOf, perpMeta);
  cache.set(key, { until: Date.now() + CACHE_MS, value: matrix });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return matrix;
}
