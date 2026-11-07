/** Continuous L2 order book types. REST snapshots in shared/orderbook.ts stay separate. */
export type L2Venue = 'binance' | 'bybit' | 'okx';
export type L2State = 'connecting' | 'syncing' | 'live' | 'resyncing' | 'stale' | 'unavailable';

export interface L2Level { price: number; quantity: number; notional: number }

export interface L2Sequence { first: number | null; last: number | null; previous: number | null }

export interface L2Metrics {
  time: number;
  midPrice: number | null;
  spreadBps: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalancePct: number | null;
  /** Positive = depth withdrawn versus the previous metric sample. */
  bidWithdrawalPct: number | null;
  askWithdrawalPct: number | null;
}

export interface L2Snapshot {
  venue: L2Venue;
  symbol: string;
  state: L2State;
  sequence: L2Sequence;
  bids: L2Level[];
  asks: L2Level[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadBps: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalancePct: number | null;
  eventTime: number;
  syncedAt: number | null;
  lastMessageAt: number | null;
  gaps: number;
  resyncs: number;
  integrity: 'ok' | 'gap' | 'checksum-failed' | 'checksum-unchecked' | 'unknown';
  /** True only when completeness is confirmed (sequence valid and, for OKX, checksum matched). */
  verified: boolean;
  lastValidUpdate: number | null;
  limitations: string[];
}

/** Minimal REST snapshot shape shared by the three venues. */
export interface L2RestSnapshot {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  sequence: { first: number | null; last: number };
  eventTime: number;
}

/** Aggregated L2 metrics persisted by the project-level collector. */
export interface L2BucketMetric {
  projectId: string;
  venue: L2Venue;
  symbol: string;
  bucketMs: number;
  bucketStart: number;
  samples: number;
  expectedSamples: number;
  coveragePct: number;
  spreadBps: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  imbalancePct: number | null;
  /** Net depth change across the bucket; fills are not separated from cancellations. */
  bidDepthChangePct: number | null;
  askDepthChangePct: number | null;
  /** Positive = net depth withdrawn. Attribution is net-of-fills-unknown. */
  liquidityWithdrawalPct: number | null;
  attribution: 'net-of-fills-not-separated';
  integrity: L2Snapshot['integrity'];
  verified: boolean;
  sequenceLast: number | null;
  gapsDelta: number;
  resyncsDelta: number;
  eventTime: number;
  receivedAt: number;
}
