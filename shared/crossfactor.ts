/** Multi-factor cross-exchange evidence. Descriptive only; never a trade instruction. */
export type CrossFactorId = 'oi_level' | 'oi_delta' | 'spot_volume_delta' | 'perp_volume_delta' | 'cvd_divergence' | 'funding_basis' | 'depth_change';

export interface FactorSample {
  venue: string;
  factor: CrossFactorId;
  /** Exchange event time. */
  time: number;
  /** When the value became usable locally (decision cutoff). */
  availableAt: number;
  /** Null means unavailable and must never be coerced to zero. */
  value: number | null;
  unit: string;
  coveragePct: number;
}

/** One directional lead test: `from` leading `to` by `lagMs`. */
export interface DirectionResult {
  from: string;
  to: string;
  lagMs: number;
  correlation: number | null;
  samples: number;
  /** True when this direction is the stronger of the two. */
  selected: boolean;
}

export interface FactorPair {
  venues: [string, string];
  directions: DirectionResult[];
  leader: string | null;
  follower: string | null;
  lagMs: number | null;
  correlation: number | null;
  samples: number;
  verdict: 'insufficient' | 'descriptive';
}

export interface FactorEvidence {
  factor: CrossFactorId;
  unit: string;
  comparable: boolean;
  reasons: string[];
  venues: Array<{ venue: string; samples: number; coveragePct: number; gaps: number; latest: number | null }>;
  /** Both directions are always reported; the leader is never inferred from a sign. */
  directions: DirectionResult[];
  /** Every valid venue combination, each tested in both directions. */
  pairs: FactorPair[];
  transform: 'relative' | 'difference';
  dataWindow: { start: number | null; end: number | null; bucketMs: number };
  /** True when the journal scan hit its limit or a cursor remains. */
  partial: boolean;
  missingWindows: number;
  excludedSamples: number;
  hypothesesTested: number;
  bonferroniAlpha: number;
  leader: string | null;
  follower: string | null;
  lagMs: number | null;
  correlation: number | null;
  samples: number;
  counterEvidence: string[];
  verdict: 'unavailable' | 'insufficient' | 'descriptive';
  notes: string[];
}
