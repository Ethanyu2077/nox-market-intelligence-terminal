export type SampledHistoryKind = 'snapshot' | 'volume' | 'alignment';
export type CollectionMode = 'active' | 'standard' | 'paused';

export function historyCadenceMs(kind: SampledHistoryKind, mode: 'active' | 'standard'): number;
export function historyCadenceMs(kind: SampledHistoryKind, mode: CollectionMode): number | null;
export function historyCadenceMs(kind: SampledHistoryKind, mode: CollectionMode): number | null {
  if (mode === 'paused') return null;
  return mode === 'standard' || kind === 'volume' ? 300_000 : 60_000;
}
