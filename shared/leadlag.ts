/** Cross-venue lead-lag research types. Descriptive statistics only: never a trade signal. */
export interface PriceSample {
  venue: string;
  /** Exchange event time. */
  time: number;
  /** Local receive time; defaults to `time` when the venue provides no separate clock. */
  receivedAt?: number;
  /** When the value became usable locally (ingest + parse). */
  availableAt: number;
  price: number;
}

export interface LeadLagInput {
  venueA: string;
  venueB: string;
  samplesA: PriceSample[];
  samplesB: PriceSample[];
}

export interface LeadLagOptions {
  windowMs: number;
  horizonMs: number;
  maxLags: number;
  lagStepMs: number;
  maxDelayMs: number;
  minSamples: number;
  costBpsPerSide: number;
  bootstrapRounds: number;
  folds: number;
}

export interface LagScore {
  lagMs: number;
  /** Correlation on training pairs only; null when not enough pairs. */
  correlation: number | null;
  samples: number;
  /** Distinct definition marker so a positive lag is never a copy of lag 0. */
  aWindowEnd: number | null;
  bWindowStart: number | null;
}

export interface Baseline { name: string; samples: number; hitRate: number | null; meanNetPct: number | null }
export interface Uncertainty { hitRate: [number, number] | null; meanNetPct: [number, number] | null; blockSize: number }

export interface FoldResult {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  /** Training pairs removed because their outcome would overlap the test window. */
  purgedTrain: number;
  trainSamples: number;
  testSamples: number;
  /** Lag selected on this fold's training data only. */
  selectedLagMs: number | null;
  hitRate: number | null;
  meanNetPct: number | null;
}

export interface LeadLagReport {
  generatedAt: number;
  pair: string;
  options: LeadLagOptions;
  timeSemantics: {
    decisionUses: 'availableAt <= decision time';
    outcomeRequires: 'time > decision && availableAt > decision';
    lagDirection: 'A leads B for lag >= 0; negative lags are not evaluated (they would leak)';
  };
  availability: Array<{ venue: string; samples: number; medianDelayMs: number | null; p95DelayMs: number | null; excludedDelayed: number }>;
  coverage: {
    totalDecisions: number;
    paired: number;
    excludedNoFuture: number;
    excludedNoPrior: number;
    excludedDelayed: number;
    effectiveSamples: number | null;
  };
  lags: LagScore[];
  folds: FoldResult[];
  outOfSample: { samples: number; hitRate: number | null; meanNetPct: number | null; uncertainty: Uncertainty };
  baselines: Baseline[];
  sensitivity: Array<{ windowMs: number; selectedLagMs: number | null; oosHitRate: number | null }>;
  multipleTesting: { lagsTested: number; bonferroniAlpha: number; note: string };
  verdict: 'insufficient' | 'descriptive' | 'promising-not-tradable';
  notes: string[];
}
