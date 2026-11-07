/** Cross-venue lead-lag research types. Descriptive statistics only: never a trade signal. */
export interface PriceSample {
  venue: string;
  time: number;
  /** When this value actually became available to the terminal (ingest). */
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
}

export interface LagScore { lagMs: number; correlation: number | null; samples: number }
export interface Baseline { name: string; samples: number; hitRate: number | null; meanNetPct: number | null }
export interface Uncertainty { hitRate: [number, number] | null; meanNetPct: [number, number] | null }

export interface LeadLagReport {
  generatedAt: number;
  pair: string;
  options: LeadLagOptions;
  availability: Array<{ venue: string; samples: number; medianDelayMs: number | null; p95DelayMs: number | null; excludedDelayed: number }>;
  coverage: { trainSamples: number; holdoutSamples: number; excludedNoFuture: number; excludedNoPrior: number };
  lags: LagScore[];
  selectedLagMs: number | null;
  holdout: { samples: number; hitRate: number | null; meanNetPct: number | null; uncertainty: Uncertainty };
  baselines: Baseline[];
  sensitivity: Array<{ windowMs: number; selectedLagMs: number | null; holdoutHitRate: number | null }>;
  verdict: 'insufficient' | 'descriptive' | 'promising-not-tradable';
  notes: string[];
}
