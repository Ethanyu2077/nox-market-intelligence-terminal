/** Multi-factor cross-exchange evidence. Descriptive only; never a trade instruction. */
export type CrossFactorId = 'oi_change' | 'spot_volume_delta' | 'perp_volume_delta' | 'cvd_divergence' | 'funding_basis' | 'depth_change';

export interface FactorSample {
  venue: string;
  factor: CrossFactorId;
  time: number;
  availableAt: number;
  /** Null means unavailable and must never be coerced to zero. */
  value: number | null;
  unit: string;
  coveragePct: number;
}

export interface FactorEvidence {
  factor: CrossFactorId;
  unit: string;
  comparable: boolean;
  reasons: string[];
  venues: Array<{ venue: string; samples: number; coveragePct: number; latest: number | null }>;
  leader: string | null;
  follower: string | null;
  lagMs: number | null;
  correlation: number | null;
  samples: number;
  counterEvidence: string[];
  verdict: 'unavailable' | 'insufficient' | 'descriptive';
  notes: string[];
}
