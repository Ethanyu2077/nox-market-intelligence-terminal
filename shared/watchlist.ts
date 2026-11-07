import type { ExchangeId } from './types.ts';

/** One hydrated watchlist row. Every field is nullable: missing data is never zero-filled. */
export interface WatchlistQuote {
  projectId: string;
  price: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  oiUsd: number | null;
  fundingRate: number | null;
  spreadBps: number | null;
  eventTime: number | null;
  quality: 'live' | 'partial' | 'stale' | 'error';
  exchange: ExchangeId | null;
  symbol: string | null;
  /** 24 hourly closes when the primary venue is Binance USDT-M. */
  sparkline: number[] | null;
  error: string | null;
}

export interface WatchlistQuotesResponse {
  asOf: number;
  ttlMs: number;
  items: WatchlistQuote[];
}
