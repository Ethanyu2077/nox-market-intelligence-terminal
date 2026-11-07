import type { ExchangeId, Quality } from './types.ts';
import type { FlowInterval, FlowVenue } from './orderflow.ts';

/** One venue/market-type turnover observation. Spot and perpetual legs are never summed together. */
export interface VenueVolumeLeg {
  exchange: ExchangeId;
  marketType: 'spot' | 'perpetual';
  /** Native symbols aggregated into this leg (a project may select several pairs on one venue). */
  symbols: string[];
  quote: string | null;
  price: number | null;
  volume24hBase: number | null;
  /** Venue-reported 24h turnover in the market's own quote currency. */
  volume24hQuote: number | null;
  /** USDT-equivalent turnover; null unless the quote is USDT (no implicit FX conversion). */
  volume24hUsd: number | null;
  eventTime: number | null;
  fetchedAt: number;
  quality: Quality;
  source: string;
  unavailable: string[];
}

export type VolumeQualityFlag =
  | 'stale-leg'
  | 'partial-leg'
  | 'volume-oi-outlier-high'
  | 'volume-oi-outlier-low'
  | 'wide-basis'
  /** Turnover came from the CCXT adapter: quote/volume are venue-reported, flow fields are not. */
  | 'ccxt-source';

export interface VenueVolumeRow {
  exchange: ExchangeId;
  spot: VenueVolumeLeg | null;
  perpetual: VenueVolumeLeg | null;
  /** Share of covered USDT-quoted spot turnover (selected venues only, not the global market). */
  spotSharePct: number | null;
  /** Share of covered USDT-quoted perpetual turnover (selected venues only). */
  perpetualSharePct: number | null;
  /** Spot / perpetual turnover; only when both legs are USDT-quoted and positive. */
  spotPerpVolumeRatio: number | null;
  /** (spot last - perp last) / perp last in bps; descriptive, not executable basis. */
  spotPerpBasisBps: number | null;
  /** Perpetual 24h turnover / OI notional; a crowding/turnover context metric, not a quality proof. */
  volumeOiTurnover: number | null;
  /** Heuristic flags only (stale/partial legs, turnover outlier vs covered-venue median, wide basis). */
  qualityFlags: VolumeQualityFlag[];
  oiUsd: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  freshness: Quality;
}

export interface VolumeMatrixResponse {
  projectId: string;
  generatedAt: number;
  /** Latest fetch time across the selected legs; rolling 24h counters are as-of, not bar-synchronised. */
  asOf: number;
  unit: 'quote-currency (USDT totals only)';
  rows: VenueVolumeRow[];
  totals: { spotUsd: number | null; perpetualUsd: number | null; spotPerpRatio: number | null };
  coverage: {
    requestedVenues: number;
    spotVenues: number;
    perpetualVenues: number;
    bothLegsVenues: number;
  };
  failures: Array<{ exchange: ExchangeId; marketType: 'spot' | 'perpetual'; symbol: string; quote: string | null; message: string }>;
  claimGate: { state: 'available' | 'restricted'; reasons: string[] };
  methodology: string[];
  /** KRW spot venues stay in their own block: no FX conversion and never mixed into USDT totals. */
  krw: KrwVolumeBlock;
}

export interface KrwVolumeBlock {
  rows: VenueVolumeRow[];
  totals: { spotKrw: number | null };
  coverage: { venues: number };
  claimGate: { state: 'available' | 'restricted'; reasons: string[] };
  methodology: string[];
}

export interface VolumeShareVenueDelta {
  exchange: ExchangeId;
  samples: number;
  firstSpotSharePct: number | null;
  lastSpotSharePct: number | null;
  deltaSpotSharePct: number | null;
  firstPerpetualSharePct: number | null;
  lastPerpetualSharePct: number | null;
  deltaPerpetualSharePct: number | null;
}

/** Summary of locally collected volume-matrix snapshots; descriptive share migration, not a signal. */
export interface VolumeShareHistory {
  projectId: string;
  generatedAt: number;
  status: 'insufficient-history' | 'available';
  points: number;
  from: number | null;
  to: number | null;
  venues: VolumeShareVenueDelta[];
  /** KRW venue share deltas computed inside the KRW set only (never mixed with USDT shares). */
  krwVenues: VolumeShareVenueDelta[];
  methodology: string[];
}

/** Event-time bucket from the locally collected trade tape (orderflow service). */
export interface VolumeBarBucket {
  time: number;
  volumeUsd: number | null;
  buyUsd: number | null;
  sellUsd: number | null;
  /** Base-asset quantity in the bucket (contract multipliers already applied). */
  base: number | null;
  buyBase: number | null;
  sellBase: number | null;
  /** Base-weighted average trade price inside the bucket. */
  vwap: number | null;
  high: number | null;
  low: number | null;
  maxTradeNotional: number | null;
  trades: number;
  complete: boolean;
}

export interface VolumeBarVenue {
  key: string;
  exchange: ExchangeId;
  marketType: 'spot' | 'perpetual';
  symbol: string;
  quote: string;
  state: FlowVenue['state'];
  transport: string;
  coverageFrom: number | null;
  coverageTo: number | null;
  lastTradeAt: number | null;
  gaps: number;
  retainedTrades: number;
  buckets: VolumeBarBucket[];
  completeBuckets: number;
  observedBuckets: number;
}

export interface VolumeBarAggregate {
  buckets: VolumeBarBucket[];
  completeBuckets: number;
  observedBuckets: number;
}

export interface VolumeBarsResponse {
  projectId: string;
  generatedAt: number;
  interval: FlowInterval;
  asOf: number;
  venues: VolumeBarVenue[];
  aggregates: Record<'spot' | 'perpetual', VolumeBarAggregate>;
  methodology: string[];
}
