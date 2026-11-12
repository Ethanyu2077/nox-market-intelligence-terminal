import type { ExchangeId } from './types.ts';

export type CoverageKind = 'snapshot' | 'volume' | 'alignment' | 'trade';

export interface CoverageKindReport {
  kind: CoverageKind;
  expectedCadenceMs: number | null;
  sampledEvents: number;
  from: number | null;
  to: number | null;
  lastIngestAt: number | null;
  lastIngestAgeMs: number | null;
  largestIngestGapMs: number | null;
  gaps: number;
  state: 'live' | 'partial' | 'stale' | 'empty' | 'disabled';
  note: string;
}

export interface DataCoverageResponse {
  projectId: string;
  generatedAt: number;
  mode: 'active' | 'standard' | 'paused';
  expectedCadenceMs: number | null;
  kinds: CoverageKindReport[];
  summary: { requiredMissing: CoverageKind[]; notes: string[] };
  methodology: string[];
}

export type VenueCoverageState = 'both' | 'spot-only' | 'perp-only' | 'missing';

export interface VenueCoverageVenue {
  exchange: ExchangeId;
  expectedSpot: boolean;
  expectedPerp: boolean;
  spotSamples: number;
  perpSamples: number;
  spotLastAt: number | null;
  perpLastAt: number | null;
  spotQuality: string | null;
  perpQuality: string | null;
  state: VenueCoverageState;
}

export interface VenueCoverageFailure {
  exchange: ExchangeId;
  marketType: 'spot' | 'perpetual';
  count: number;
  lastMessage: string;
  lastAt: number;
}

export interface VenueCoverageResponse {
  projectId: string;
  generatedAt: number;
  points: number;
  from: number | null;
  to: number | null;
  venues: VenueCoverageVenue[];
  failures: VenueCoverageFailure[];
  summary: { expectedVenues: number; venuesWithBothLegs: number; missingLegs: string[]; totalFailures: number };
  methodology: string[];
}
