import type { ResearchQuality, ResearchQualityState } from '../shared/research-quality.ts';

export const RESEARCH_QUALITY_DEFAULTS = { minSamples: 30, minCoveragePct: 60 } as const;

/**
 * Research quality gate. COMPLETE requires a complete (non-truncated) history scan,
 * enough samples, sufficient coverage and no known missing windows. The factor maths is
 * untouched; this only decides whether a conclusion may be presented as complete.
 */
export function assessResearchQuality(input: {
  scannedRecords: number;
  samples: number;
  coveragePct: number | null;
  truncated: boolean;
  missingWindows?: number;
  dataAvailable?: boolean;
}, thresholds: { minSamples: number; minCoveragePct: number } = RESEARCH_QUALITY_DEFAULTS): ResearchQuality {
  const reasons: string[] = [];
  if (input.dataAvailable === false) return { state: 'NOT VERIFIED', reasons: ['data source unavailable'], thresholds };
  if (input.scannedRecords === 0) return { state: 'NOT VERIFIED', reasons: ['no historical records scanned'], thresholds };
  if (input.samples < thresholds.minSamples) reasons.push(`samples ${input.samples} < ${thresholds.minSamples}`);
  if (input.coveragePct != null && input.coveragePct < thresholds.minCoveragePct) reasons.push(`coverage ${input.coveragePct.toFixed(1)}% < ${thresholds.minCoveragePct}%`);
  if (input.truncated) reasons.push('history scan truncated');
  if ((input.missingWindows ?? 0) > 0) reasons.push(`${input.missingWindows} missing windows`);
  let state: ResearchQualityState;
  if (input.samples < thresholds.minSamples || (input.coveragePct ?? 0) < thresholds.minCoveragePct) state = 'INSUFFICIENT';
  else if (input.truncated || (input.missingWindows ?? 0) > 0) state = 'PARTIAL';
  else state = 'COMPLETE';
  return { state, reasons, thresholds };
}
