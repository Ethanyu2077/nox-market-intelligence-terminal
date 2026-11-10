/**
 * Top-of-book depth snapshots for venues with a Binance-compatible depth endpoint.
 *
 * This is deliberately NOT called "L2": a REST depth snapshot has no sequence continuity,
 * so it cannot prove that no update was missed between two reads, and it cannot show
 * hidden/iceberg liquidity. Every consumer must keep that limitation visible.
 */

import type { DepthVenue, OrderBookLevel, OrderBookSnapshot } from '../shared/orderbook.ts';
import { venueBreakers } from './venue-health.ts';
import { binanceGovernor } from './binance-governor.ts';
import { MarketCache } from './market-cache.ts';

export type { DepthVenue, OrderBookLevel, OrderBookSnapshot } from '../shared/orderbook.ts';

const ENDPOINTS: Record<DepthVenue, string> = {
  binance: process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com',
  aster: process.env.ASTER_REST_BASE ?? 'https://fapi.asterdex.com',
};

const REQUEST_TIMEOUT = 8_000;
const CACHE_TTL = 4_000;
const LIMITATIONS = [
  'REST depth snapshot at a single moment; the venue book can change before it is rendered.',
  'Not a sequenced L2 feed: missed updates cannot be detected, and hidden/iceberg size is never observable.',
  'USD depth is price × resting base quantity per level, not the executable size of a large order.',
];

type RawLevel = [string, string];

export function parseDepth(exchange: DepthVenue, symbol: string, payload: unknown, now: number): OrderBookSnapshot {
  const body = (payload ?? {}) as { bids?: unknown; asks?: unknown; lastUpdateId?: unknown; E?: unknown; T?: unknown };
  const levels = (raw: unknown): OrderBookLevel[] => {
    if (!Array.isArray(raw)) return [];
    const rows: OrderBookLevel[] = [];
    for (const entry of raw) {
      if (!Array.isArray(entry)) continue;
      const [priceRaw, quantityRaw] = entry as RawLevel;
      const price = Number(priceRaw);
      const quantity = Number(quantityRaw);
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) continue;
      rows.push({ price, quantity, notional: price * quantity });
    }
    return rows;
  };
  const bids = levels(body.bids).sort((a, b) => b.price - a.price);
  const asks = levels(body.asks).sort((a, b) => a.price - b.price);
  const bidDepthUsd = bids.reduce((total, level) => total + level.notional, 0);
  const askDepthUsd = asks.reduce((total, level) => total + level.notional, 0);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid != null && bestAsk != null && bestAsk >= bestBid ? (bestBid + bestAsk) / 2 : null;
  const eventTime = Number(body.E ?? body.T ?? now);
  const age = now - (Number.isFinite(eventTime) ? eventTime : now);
  return {
    exchange,
    symbol: symbol.toUpperCase(),
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice: mid,
    spreadBps: bestBid != null && bestAsk != null && mid ? (bestAsk - bestBid) / mid * 10_000 : null,
    bidDepthUsd,
    askDepthUsd,
    imbalancePct: bidDepthUsd + askDepthUsd > 0 ? (bidDepthUsd - askDepthUsd) / (bidDepthUsd + askDepthUsd) * 100 : null,
    lastUpdateId: Number.isFinite(Number(body.lastUpdateId)) ? Number(body.lastUpdateId) : null,
    eventTime: Number.isFinite(eventTime) ? eventTime : now,
    fetchedAt: now,
    quality: age <= 15_000 ? 'live' : 'stale',
    source: `${exchange} public depth REST (Binance-compatible)`,
    limitations: [...LIMITATIONS],
  };
}

const cache = new MarketCache(null, 10_000);
const transportCaches = new WeakMap<typeof fetch, MarketCache>();

export function closeDepthCache() { cache.close(); }


export function isDepthVenue(exchange: string): exchange is DepthVenue {
  return exchange === 'binance' || exchange === 'aster';
}

export async function orderBookSnapshot(exchange: string, symbol: string, limit = 20, transport: typeof fetch = fetch): Promise<OrderBookSnapshot> {
  if (!isDepthVenue(exchange)) throw new Error(`${exchange} has no verified depth adapter`);
  const depthLimit = Math.min(50, Math.max(5, Math.trunc(limit)));
  const key = `${exchange}:${symbol.toUpperCase()}:${depthLimit}`;
  let selectedCache = cache;
  if (transport !== fetch) {
    selectedCache = transportCaches.get(transport) ?? new MarketCache(null, 10_000);
    transportCaches.set(transport, selectedCache);
  }
  const load = async () => {
    if (!venueBreakers.allow(exchange, 'depth')) throw new Error(`${exchange} depth is in an open-circuit cooldown`);
    try {
      const url = `${ENDPOINTS[exchange]}/fapi/v1/depth?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${depthLimit}`;
      let payload: unknown;
      if (exchange === 'binance' && transport === fetch) payload = await binanceGovernor.json(url);
      else {
        const response = await transport(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT), headers: { 'User-Agent': 'NOX-Market-Intelligence/0.2' } });
        if (!response.ok) throw new Error(`${exchange} depth HTTP ${response.status}`);
        payload = await response.json();
      }
      const parsed = parseDepth(exchange, symbol, payload, Date.now());
      venueBreakers.success(exchange, 'depth');
      return parsed;
    } catch (error) {
      venueBreakers.failure(exchange, error instanceof Error ? error.message : 'depth failed', 'depth');
      throw error;
    }
  };
  const { value, stale } = await selectedCache.get(key, { ttlMs: CACHE_TTL, timeoutMs: REQUEST_TIMEOUT, load });
  return stale && value.quality === 'live' ? { ...value, quality: 'stale' } : value;
}
