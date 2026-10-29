import type { HistoryStore } from './history-store.ts';
import type { AlignmentHistoryResponse, AlignmentSnapshotRecord, TimeframeAlignmentState } from '../shared/timeframe.ts';

const STATES: TimeframeAlignmentState[] = ['aligned-bullish', 'aligned-bearish', 'conflict', 'mixed', 'insufficient'];

function emptyCounts(): Record<TimeframeAlignmentState, number> {
  return { 'aligned-bullish': 0, 'aligned-bearish': 0, conflict: 0, mixed: 0, insufficient: 0 };
}

/** Alignment claims are persisted so a researcher can audit when the system allowed/refused a judgment. */
export function summarizeAlignmentHistory(projectId: string, records: AlignmentSnapshotRecord[], now = Date.now(), limit = 50): AlignmentHistoryResponse {
  const ordered = [...records].filter((record) => STATES.includes(record.state)).sort((a, b) => a.time - b.time);
  const counts = emptyCounts();
  for (const record of ordered) counts[record.state] += 1;
  const allowedPoints = ordered.filter((record) => record.directionalClaimAllowed).length;
  let lastChange: AlignmentHistoryResponse['lastChange'] = { from: null, to: ordered.at(-1)?.state ?? null, at: ordered.at(-1)?.time ?? null };
  for (let index = ordered.length - 1; index > 0; index--) {
    if (ordered[index].state !== ordered[index - 1].state) {
      lastChange = { from: ordered[index - 1].state, to: ordered[index].state, at: ordered[index].time };
      break;
    }
  }
  return {
    projectId,
    generatedAt: now,
    status: ordered.length >= 2 ? 'available' : 'insufficient-history',
    points: ordered.length,
    from: ordered[0]?.time ?? null,
    to: ordered.at(-1)?.time ?? null,
    counts,
    allowedPoints,
    allowedSharePct: ordered.length ? allowedPoints / ordered.length * 100 : null,
    lastChange,
    records: [...ordered].reverse().slice(0, Math.max(1, Math.min(limit, 200))),
    outcomeStudy: { state: 'not-evaluated', reason: 'Forward-return/baseline statistics for alignment claims require a dedicated event study with ingest-time cutoffs, costs and out-of-sample splits. This endpoint only records claim history.' },
    methodology: [
      'Each record is the alignment response persisted by the collector at its sampling cadence (Active 30s / Standard 5m; first tick recorded immediately).',
      'Counts describe how often the system allowed or refused a directional claim — not predictive performance.',
      'No outcome/hit-rate statistics are shown here; computing them without ingest-time cutoffs and costs would leak future data.',
      'Records are stored in the local history journal under kind=alignment and can be replayed with asOf.',
    ],
  };
}

interface StoredAlignmentPayload {
  generatedAt?: number;
  alignment?: { state?: unknown; directionalClaimAllowed?: unknown; validTimeframes?: unknown };
  observations?: Array<{ interval?: unknown; state?: unknown }>;
}

export function alignmentRecordFromPayload(time: number, payload: unknown, availableAt: number | null = null): AlignmentSnapshotRecord | null {
  if (payload == null || typeof payload !== 'object') return null;
  const value = payload as StoredAlignmentPayload;
  const state = value.alignment?.state;
  if (typeof state !== 'string' || !STATES.includes(state as TimeframeAlignmentState)) return null;
  const observations = (Array.isArray(value.observations) ? value.observations : [])
    .filter((observation) => typeof observation?.interval === 'string' && typeof observation?.state === 'string')
    .map((observation) => ({ interval: observation.interval as AlignmentSnapshotRecord['observations'][number]['interval'], state: observation.state as AlignmentSnapshotRecord['observations'][number]['state'] }));
  return {
    time: Number.isFinite(value.generatedAt) ? value.generatedAt! : time,
    availableAt: availableAt != null && Number.isFinite(availableAt) ? availableAt : null,
    state: state as TimeframeAlignmentState,
    directionalClaimAllowed: value.alignment?.directionalClaimAllowed === true,
    validTimeframes: typeof value.alignment?.validTimeframes === 'number' ? value.alignment.validTimeframes : observations.filter((observation) => observation.state !== 'insufficient').length,
    observations,
  };
}

export async function alignmentHistory(history: HistoryStore, projectId: string, asOf = Date.now(), limit = 500): Promise<AlignmentHistoryResponse> {
  const events = await history.read(projectId, 'alignment', asOf, limit);
  const records = events.flatMap((event) => {
    const record = alignmentRecordFromPayload(event.eventTime, event.payload, event.ingestTime);
    return record ? [record] : [];
  });
  return summarizeAlignmentHistory(projectId, records, asOf, 50);
}
