import type { ExchangeId } from './types.ts';

/** Endpoint families are independent: one can be broken while another still works. */
export type DataFamily = 'discovery' | 'snapshot' | 'series' | 'depth' | 'flow' | 'liquidation';

export const DATA_FAMILIES: DataFamily[] = ['discovery', 'snapshot', 'series', 'depth', 'flow', 'liquidation'];

export type CoverageState = 'live' | 'degraded' | 'stale' | 'unavailable' | 'unknown';

export interface CapabilityCoverage {
  state: CoverageState;
  cooldownUntil: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

export interface CapabilityRow {
  venue: ExchangeId;
  family: DataFamily;
  supported: boolean;
  transport: 'native' | 'ccxt' | 'none';
  coverage: CapabilityCoverage;
  notes: string[];
}

export interface CapabilityRegistry {
  generatedAt: number;
  families: DataFamily[];
  rows: CapabilityRow[];
}
