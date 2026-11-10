export type ResearchQualityState = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'NOT VERIFIED';
export interface ResearchQuality {
  state: ResearchQualityState;
  reasons: string[];
  thresholds: { minSamples: number; minCoveragePct: number };
}
