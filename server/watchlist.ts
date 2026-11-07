import type { MarketProject } from '../shared/types.ts';
import type { WatchlistQuote, WatchlistQuotesResponse } from '../shared/watchlist.ts';
import { priceSparkline } from './binance.ts';
import { priceSparkline as asterSparkline } from './aster.ts';
import { projectVenueSnapshots } from './exchanges.ts';

/**
 * Watchlist quotes.
 *
 * The old UI only loaded the selected project ("Load on select"), which made a price
 * watchlist useless: every other row was a dash. This route hydrates every active
 * project's primary feed with a short TTL cache, bounded concurrency and explicit
 * partial states. Missing values stay null; nothing is filled with zero.
 */

const TTL_MS = 12_000;
const MAX_PROJECTS = 12;
let cache: { at: number; signature: string; value: WatchlistQuotesResponse } | null = null;
let inFlight: Promise<WatchlistQuotesResponse> | null = null;

function signatureOf(projects: MarketProject[]): string {
  return projects.map((project) => `${project.id}:${project.primaryMarketId}:${project.updatedAt}`).join('|');
}

async function quoteFor(project: MarketProject, asOf: number): Promise<WatchlistQuote> {
  const primary = project.markets.find((market) => market.id === project.primaryMarketId)
    ?? project.markets.find((market) => market.marketType === 'perpetual')
    ?? project.markets[0];
  if (!primary) {
    return { projectId: project.id, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, spreadBps: null, eventTime: null, quality: 'error', exchange: null, symbol: null, sparkline: null, error: 'No market mapping' };
  }
  const [venues, sparkline] = await Promise.allSettled([
    projectVenueSnapshots([primary]),
    primary.marketType !== 'perpetual' ? Promise.resolve([])
      : primary.exchange === 'binance' ? priceSparkline(primary.symbol)
      : primary.exchange === 'aster' ? asterSparkline(primary.symbol)
      : Promise.resolve([]),
  ]);

  if (venues.status === 'rejected') {
    return {
      projectId: project.id, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, spreadBps: null,
      eventTime: null, quality: 'error', exchange: primary.exchange, symbol: primary.symbol, sparkline: null,
      error: venues.reason instanceof Error ? venues.reason.message : 'Snapshot unavailable',
    };
  }

  const snapshot = venues.value.snapshots[0] ?? null;
  if (!snapshot) {
    const failure = venues.value.failures[0];
    return {
      projectId: project.id, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, spreadBps: null,
      eventTime: null, quality: 'error', exchange: primary.exchange, symbol: primary.symbol, sparkline: null,
      error: failure?.message ?? 'No snapshot returned',
    };
  }

  const age = asOf - snapshot.eventTime;
  const quality: WatchlistQuote['quality'] = snapshot.quality === 'stale' || age > 5 * 60_000 ? 'stale' : snapshot.quality === 'partial' ? 'partial' : 'live';
  return {
    projectId: project.id,
    price: snapshot.price,
    change24hPct: snapshot.change24hPct,
    volume24hUsd: snapshot.volume24hUsd,
    oiUsd: snapshot.oiUsd,
    fundingRate: snapshot.fundingRate,
    spreadBps: null,
    eventTime: snapshot.eventTime,
    quality,
    exchange: snapshot.exchange,
    symbol: snapshot.symbol,
    sparkline: sparkline.status === 'fulfilled' && sparkline.value.length > 1 ? sparkline.value : null,
    error: null,
  };
}

export async function watchlistQuotes(projects: MarketProject[], now = Date.now()): Promise<WatchlistQuotesResponse> {
  const active = projects.filter((project) => !project.archived).slice(0, MAX_PROJECTS);
  const signature = signatureOf(active);
  if (cache && cache.signature === signature && now - cache.at < TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const settled = await Promise.allSettled(active.map((project) => quoteFor(project, now)));
    const items = settled.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : { projectId: active[index].id, price: null, change24hPct: null, volume24hUsd: null, oiUsd: null, fundingRate: null, spreadBps: null, eventTime: null, quality: 'error' as const, exchange: null, symbol: null, sparkline: null, error: 'Quote failed' });
    const value: WatchlistQuotesResponse = { asOf: Date.now(), ttlMs: TTL_MS, items };
    cache = { at: value.asOf, signature, value };
    return value;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** Exposed for tests: drop the cache between cases. */
export function resetWatchlistCache(): void {
  cache = null;
  inFlight = null;
}
