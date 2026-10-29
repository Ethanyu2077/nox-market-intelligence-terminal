import type { Quality } from './types.ts';

export type TimeframeInterval = '1m' | '5m' | '15m' | '1h' | '4h';
export const TIMEFRAME_INTERVALS: TimeframeInterval[] = ['1m', '5m', '15m', '1h', '4h'];

/** Heuristic price-move thresholds per interval (percent). Not calibrated; documented in methodology. */
export const TIMEFRAME_PRICE_THRESHOLDS_PCT: Record<TimeframeInterval, number> = { '1m': 0.08, '5m': 0.15, '15m': 0.3, '1h': 0.6, '4h': 1.2 };
/** A timeframe observation is only valid when flow covers at least this share of the OI window. */
export const TIMEFRAME_FLOW_COVERAGE_MIN_PCT = 80;

export type TimeframeState = 'bullish' | 'bearish' | 'mixed' | 'insufficient';

export interface TimeframeObservation {
  interval: TimeframeInterval;
  state: TimeframeState;
  priceChangePct: number | null;
  oiDeltaBase: number | null;
  oiDeltaPctBase: number | null;
  flowDeltaUsd: number | null;
  flowCoveragePct: number | null;
  windowFrom: number | null;
  windowTo: number | null;
  freshness: Quality;
  reasons: string[];
}

export type TimeframeAlignmentState = 'aligned-bullish' | 'aligned-bearish' | 'conflict' | 'mixed' | 'insufficient';

export interface TimeframeAlignment {
  state: TimeframeAlignmentState;
  directionalClaimAllowed: boolean;
  validTimeframes: number;
  alignedTimeframes: number;
  reasons: string[];
  invalidation: string[];
}

export interface TimeframeAlignmentResponse {
  projectId: string;
  symbol: string;
  generatedAt: number;
  observations: TimeframeObservation[];
  alignment: TimeframeAlignment;
  methodology: string[];
}

export interface AlignmentSnapshotRecord {
  time: number;
  /** Earliest time the claim was actually available (history ingest time / decision completion). */
  availableAt?: number | null;
  state: TimeframeAlignmentState;
  directionalClaimAllowed: boolean;
  validTimeframes: number;
  observations: Array<{ interval: TimeframeInterval; state: TimeframeState }>;
}

export interface AlignmentHistoryResponse {
  projectId: string;
  generatedAt: number;
  status: 'insufficient-history' | 'available';
  points: number;
  from: number | null;
  to: number | null;
  counts: Record<TimeframeAlignmentState, number>;
  allowedPoints: number;
  allowedSharePct: number | null;
  lastChange: { from: TimeframeAlignmentState | null; to: TimeframeAlignmentState | null; at: number | null };
  records: AlignmentSnapshotRecord[];
  /** Outcome/baseline statistics are deliberately not claimed until a dedicated study exists. */
  outcomeStudy: { state: 'not-evaluated'; reason: string };
  methodology: string[];
}

export interface AlignmentOutcomeRow {
  time: number;
  state: TimeframeAlignmentState;
  expectedDirection: 'up' | 'down' | null;
  entryTime: number | null;
  entryPrice: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  /** Raw price return (exit/entry - 1). */
  priceReturnPct: number | null;
  /** Direction-adjusted gross return: long = price return, short = -price return. */
  grossReturnPct: number | null;
  /** Direction-adjusted gross minus round-trip cost (percentage points). */
  netReturnPct: number | null;
  resolved: boolean;
  reason: string | null;
}

export interface AlignmentOutcomeResponse {
  projectId: string;
  symbol: string | null;
  generatedAt: number;
  horizonMinutes: number;
  costBps: number;
  minSample: number;
  status: 'insufficient-history' | 'insufficient-sample' | 'available';
  allowedEvents: number;
  resolvedSamples: number;
  censoredSamples: number;
  hitRate: number | null;
  averageNetReturnPct: number | null;
  baselineHitRate: number | null;
  baselineAverageNetReturnPct: number | null;
  liftPct: number | null;
  rows: AlignmentOutcomeRow[];
  methodology: string[];
}
