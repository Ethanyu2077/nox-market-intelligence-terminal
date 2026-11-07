export type DepthVenue = 'binance' | 'aster';

export interface OrderBookLevel {
  price: number;
  quantity: number;
  notional: number;
}

/** A single REST depth snapshot. Never presented as a sequenced L2 book. */
export interface OrderBookSnapshot {
  exchange: DepthVenue;
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadBps: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalancePct: number | null;
  lastUpdateId: number | null;
  eventTime: number;
  fetchedAt: number;
  quality: 'live' | 'stale';
  source: string;
  limitations: string[];
}
