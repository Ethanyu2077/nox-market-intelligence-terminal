import type { MarketProject, ProjectMarket } from './types.ts';
import type { WatchlistQuote, WatchPriceTick } from './watchlist.ts';

type Market = Pick<ProjectMarket, 'exchange' | 'symbol' | 'marketType'> & { projectId: string; marketKey: string };
type BoardPrice = { marketKey: string; price: number; time: number; stale: boolean };
export type BoardPrices = ReadonlyMap<string, BoardPrice>;

export function boardMarkets(projects: readonly MarketProject[]): Market[] {
  const markets: Market[] = [];
  for (const project of projects) {
    if (project.archived || !project.monitoring.streamingEnabled || project.monitoring.collectionMode === 'paused') continue;
    const market = project.markets.find(m => m.id === project.primaryMarketId) ?? project.markets[0];
    if (!market) continue;
    const { exchange, marketType, symbol } = market;
    markets.push({ projectId: project.id, exchange, marketType, symbol, marketKey: [exchange, marketType, symbol].join(':') });
    if (markets.length === 12) break;
  }
  return markets;
}

export function updateBoardPrices(previous: BoardPrices, markets: readonly Market[], ticks: readonly WatchPriceTick[], now: number, connected = true): BoardPrices {
  const next = new Map<string, BoardPrice>();
  for (const market of markets) {
    const old = previous.get(market.projectId);
    let price = old?.marketKey === market.marketKey ? old : undefined;
    const tick = ticks.find(t => t.projectId === market.projectId && t.marketKey === market.marketKey);
    const at = tick?.priceAt;
    if (tick && !tick.stale && tick.price != null && Number.isFinite(tick.price) && tick.price > 0 &&
        at != null && Number.isFinite(at) && at > 0 && at <= now + 5_000 && (!price || at > price.time || (at === price.time && tick.price !== price.price))) {
      price = { marketKey: market.marketKey, price: tick.price, time: at, stale: false };
    }
    if (!price) continue;
    const stale = !connected || !!tick?.stale || now - price.time > 5_000;
    next.set(market.projectId, price.stale === stale ? price : { ...price, stale });
  }
  return next.size === previous.size && [...next].every(([id, point]) => point === previous.get(id)) ? previous : next;
}

/** Replace only the price; other metrics, including hourly sparkline closes, come from the venue snapshot. */
export function mergeBoardPrices(snapshots: readonly WatchlistQuote[], markets: readonly Market[], prices: BoardPrices): WatchlistQuote[] {
  const rows = new Map(snapshots.map(row => [row.projectId, row]));
  for (const market of markets) {
    const price = prices.get(market.projectId);
    const row = rows.get(market.projectId);
    const sameInstrument = row && row.exchange === market.exchange && row.symbol === market.symbol && row.marketType === market.marketType;
    if (row?.marketType && !sameInstrument) rows.delete(market.projectId);
    if (price?.marketKey !== market.marketKey) continue;
    if (sameInstrument && row.price != null && (row.eventTime ?? 0) >= price.time) continue;
    const base: WatchlistQuote = sameInstrument ? row : {
      projectId: market.projectId, exchange: market.exchange, marketType: market.marketType, symbol: market.symbol,
      change24hPct: null, price: null, volume24hUsd: null, oiUsd: null, fundingRate: null, spreadBps: null, sparkline: null,
      eventTime: null, quality: 'partial', error: null,
    };
    const quality = price.stale ? 'stale' : base.quality === 'live' ? 'live' : 'partial';
    rows.set(market.projectId, { ...base, price: price.price, eventTime: price.time, quality });
  }
  return [...rows.values()];
}
