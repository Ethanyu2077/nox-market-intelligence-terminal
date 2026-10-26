import type { HistoryEvent } from "./history.ts";
import type { FlowBucket } from "./orderflow.ts";
import type { ProjectMarket } from "./types.ts";

export const REGIME_WINDOWS = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
} as const;
export type RegimeWindow = keyof typeof REGIME_WINDOWS;
export interface VenueRegime {
  id: string;
  projectId: string;
  version: "nox.regime.v2";
  scope: "venue";
  marketKey: string;
  interval: RegimeWindow;
  windowStart: number;
  windowEnd: number;
  decisionTime: number;
  label: string;
  anomalyScore: number | null;
  evidenceQuality: {
    score: number;
    baselineSamples: number;
    essentialComplete: boolean;
  };
  historicalEdge: null;
  historicalEdgeNotice: string;
  inputSnapshotCount?: number;
  evidence: string[];
  contradictions: string[];
  missing: string[];
  metrics: {
    priceChangePct: number | null;
    oiChangePct: number | null;
    oiDeltaBase: number | null;
    oiFlowNotional: number | null;
    perpDelta: number | null;
    spotDelta: number | null;
    fundingRate: number | null;
  };
  input: {
    market: ProjectMarket;
    snapshots: HistoryEvent[];
    perpBuckets: FlowBucket[];
    spotBuckets: FlowBucket[];
    spotRequested: number;
    spotCovered: number;
    decisionTime: number;
    interval: RegimeWindow;
  };
}
export interface RegimeReport {
  id: string;
  projectId: string;
  version: "nox.regime.v2";
  scope: "aggregated";
  interval: RegimeWindow;
  windowStart: number;
  windowEnd: number;
  decisionTime: number;
  label: string;
  requestedVenues: number;
  coveredVenues: number;
  supporting: string[];
  contradicting: string[];
  missingVenues: string[];
  anomalyScore: number | null;
  evidenceQuality: number;
  historicalEdge: null;
  venues: VenueRegime[];
  flowAttribution: {
    marketKey: string;
    perpDelta: number | null;
    oiFlowNotional: number | null;
    absoluteFlowShare: number | null;
    oiExpansionShare: number | null;
    oiContractionShare: number | null;
  }[];
  aggregates: {
    perpDelta: number | null;
    oiFlowNotional: number | null;
    coveredPerpDelta: number | null;
    coveredOiFlowNotional: number | null;
    flowConcentration: number | null;
    spotDelta: number | null;
    spotRequested: number;
    spotCovered: number;
  };
  notice: string;
}
