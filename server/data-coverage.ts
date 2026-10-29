import type { HistoryStore } from './history-store.ts';
import type { MarketProject } from '../shared/types.ts';
import type { CoverageKind, CoverageKindReport, DataCoverageResponse } from '../shared/coverage.ts';

export interface CoverageSample { eventTime: number; ingestTime: number }

const KINDS: CoverageKind[] = ['snapshot', 'volume', 'alignment', 'trade'];
const REQUIRED: CoverageKind[] = ['snapshot', 'volume', 'alignment'];
const CADENCE: Record<'active' | 'standard' | 'paused', number | null> = { active: 30_000, standard: 300_000, paused: null };

/**
 * Operational coverage, not research quality: it answers "is the local pipeline actually
 * accumulating these event streams?" Sampling is newest-N, so counts are labelled sampledEvents.
 */
export function summarizeDataCoverage(
  projectId: string,
  mode: 'active' | 'standard' | 'paused',
  samples: Partial<Record<CoverageKind, CoverageSample[]>>,
  now = Date.now(),
): DataCoverageResponse {
  const expectedCadenceMs = CADENCE[mode];
  const kinds: CoverageKindReport[] = KINDS.map((kind) => {
    const events = [...(samples[kind] ?? [])].filter((event) => Number.isFinite(event.eventTime) && Number.isFinite(event.ingestTime)).sort((a, b) => a.ingestTime - b.ingestTime);
    if (!events.length) {
      return { kind, sampledEvents: 0, from: null, to: null, lastIngestAt: null, lastIngestAgeMs: null, largestIngestGapMs: null, gaps: 0, state: 'empty', note: 'no sampled record of this kind yet' };
    }
    const lastIngestAt = events[events.length - 1].ingestTime;
    const lastIngestAgeMs = Math.max(0, now - lastIngestAt);
    let largestIngestGapMs = 0, gaps = 0;
    if (expectedCadenceMs != null) {
      for (let index = 1; index < events.length; index++) {
        const gap = events[index].ingestTime - events[index - 1].ingestTime;
        if (gap > largestIngestGapMs) largestIngestGapMs = gap;
        if (gap > expectedCadenceMs * 2.5) gaps += 1;
      }
    }
    const stale = expectedCadenceMs != null && lastIngestAgeMs > expectedCadenceMs * 3;
    const state = stale ? 'stale' : gaps > 0 || expectedCadenceMs == null ? 'partial' : 'live';
    const note = kind === 'trade'
      ? 'event-driven trade tape; sampled newest records, not a full count'
      : expectedCadenceMs == null ? 'collection paused; age is informational only' : `expected collector cadence ~${Math.round(expectedCadenceMs / 1000)}s`;
    return { kind, sampledEvents: events.length, from: events[0].eventTime, to: events[events.length - 1].eventTime, lastIngestAt, lastIngestAgeMs, largestIngestGapMs: largestIngestGapMs || null, gaps, state, note };
  });
  const requiredMissing = REQUIRED.filter((kind) => (samples[kind] ?? []).length === 0);
  const notes: string[] = [];
  if (requiredMissing.length) notes.push(`missing required local streams: ${requiredMissing.join(', ')}`);
  if (mode === 'paused') notes.push('collection is paused; coverage ages will grow');
  if (kinds.some((kind) => kind.state === 'stale')) notes.push('at least one stream is stale relative to its expected cadence');
  return {
    projectId,
    generatedAt: now,
    mode,
    expectedCadenceMs,
    kinds,
    summary: { requiredMissing, notes },
    methodology: [
      'Sampled counts use the newest records read from the local journal (limit applies); they are not lifetime totals.',
      'Gaps are measured between consecutive ingest times against 2.5x the collector cadence; a gap means sampling continuity is unverified, not that the market had no data.',
      'States describe local accumulation health only; they do not validate source correctness, research quality or forward performance.',
      'Trade tape is event-driven and therefore has no fixed cadence; its state is based on gaps against the collector cadence.',
    ],
  };
}

export async function projectDataCoverage(history: HistoryStore, project: MarketProject, asOf = Date.now(), limit = 5000): Promise<DataCoverageResponse> {
  const mode = project.archived || !project.monitoring.streamingEnabled ? 'paused' : project.monitoring.collectionMode ?? 'standard';
  const samples: Partial<Record<CoverageKind, CoverageSample[]>> = {};
  const results = await Promise.allSettled(KINDS.map((kind) => history.read(project.id, kind, asOf, limit)));
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    samples[KINDS[index]] = result.value.map((event) => ({ eventTime: event.eventTime, ingestTime: event.ingestTime }));
  });
  return summarizeDataCoverage(project.id, mode, samples, asOf);
}
