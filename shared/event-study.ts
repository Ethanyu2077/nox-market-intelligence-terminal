import type { RegimeWindow } from "./regime-v2.ts";

export interface StudyRow {
  id: string;
  eventId: string;
  projectId: string;
  marketKey: string;
  interval: RegimeWindow;
  label: string;
  decisionTime: number;
  horizonMinutes: number;
  status:
    | "suppressed"
    | "overlap-excluded"
    | "pending"
    | "missing-entry"
    | "incomplete-path"
    | "complete";
  priceReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  directionalScenarioPct: number | null;
  entryPrice: number | null;
  entryTime: number | null;
  samples: number;
  largestGapMs: number | null;
  inputIds: string[];
  missing: string[];
  evidenceQuality: number;
  flowConcentration: number | null;
}
export interface StudyResponse {
  methodology: "nox.event-study.v1";
  asOf: number;
  horizonMinutes: number;
  rows: StudyRow[];
  coverage: {
    candidates: number;
    overlapExcluded: number;
    suppressed: number;
    pending: number;
    completeVenues: number;
    completeEventClusters: number;
    eventClusters: number;
  };
  statistics: {
    sampleSize: number;
    medianReturnPct: number | null;
    q10Pct: number | null;
    q90Pct: number | null;
    positivePriceFrequency: number | null;
    medianMfePct: number | null;
    medianMaePct: number | null;
    observedUtcDays: number;
    confidenceInterval: null;
  };
  cohorts: {
    label: string;
    eventClusters: number;
    medianReturnPct: number | null;
  }[];
  limitations: string[];
}
