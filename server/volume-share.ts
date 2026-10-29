import type { ExchangeId } from '../shared/types.ts';
import type { VenueVolumeRow, VolumeShareHistory, VolumeShareVenueDelta } from '../shared/volume.ts';
import type { HistoryStore } from './history-store.ts';

export interface VolumeRecord { asOf: number; rows: VenueVolumeRow[]; /** KRW rows are optional for backward compatibility with records written before the KRW block. */ krwRows?: VenueVolumeRow[] }

function validRows(value: unknown): value is VenueVolumeRow[] {
  return Array.isArray(value) && value.every((row) => row != null && typeof row === 'object' && typeof (row as { exchange?: unknown }).exchange === 'string');
}

export function isVolumeRecord(payload: unknown): payload is VolumeRecord {
  if (payload == null || typeof payload !== 'object') return false;
  const candidate = payload as { asOf?: unknown; rows?: unknown; krw?: { rows?: unknown } };
  if (typeof candidate.asOf !== 'number' || !Number.isFinite(candidate.asOf)) return false;
  if (!validRows(candidate.rows)) return false;
  if (candidate.krw != null) {
    if (typeof candidate.krw !== 'object') return false;
    if (candidate.krw.rows != null && !validRows(candidate.krw.rows)) return false;
  }
  return true;
}

function firstShare(rows: VenueVolumeRow[], key: 'spotSharePct' | 'perpetualSharePct'): number | null {
  for (const row of rows) { const value = row[key]; if (value != null) return value; }
  return null;
}
function lastShare(rows: VenueVolumeRow[], key: 'spotSharePct' | 'perpetualSharePct'): number | null {
  for (let index = rows.length - 1; index >= 0; index--) { const value = rows[index][key]; if (value != null) return value; }
  return null;
}

function venueDeltas(records: VolumeRecord[], rowsByRecord: VenueVolumeRow[][], canDelta: boolean): VolumeShareVenueDelta[] {
  const exchanges = new Set<ExchangeId>();
  for (const rows of rowsByRecord) for (const row of rows) exchanges.add(row.exchange);
  return [...exchanges].sort().map((exchange) => {
    const recordsForVenue = rowsByRecord.flatMap((rows) => {
      const row = rows.find((candidate) => candidate.exchange === exchange);
      return row ? [row] : [];
    });
    const firstSpot = firstShare(recordsForVenue, 'spotSharePct');
    const lastSpot = lastShare(recordsForVenue, 'spotSharePct');
    const firstPerpetual = firstShare(recordsForVenue, 'perpetualSharePct');
    const lastPerpetual = lastShare(recordsForVenue, 'perpetualSharePct');
    return {
      exchange,
      samples: recordsForVenue.length,
      firstSpotSharePct: firstSpot,
      lastSpotSharePct: lastSpot,
      deltaSpotSharePct: canDelta && firstSpot != null && lastSpot != null ? lastSpot - firstSpot : null,
      firstPerpetualSharePct: firstPerpetual,
      lastPerpetualSharePct: lastPerpetual,
      deltaPerpetualSharePct: canDelta && firstPerpetual != null && lastPerpetual != null ? lastPerpetual - firstPerpetual : null,
    };
  });
}

/**
 * Descriptive share migration across locally collected volume records. It is not a signal, not
 * event-time aligned, and requires at least two samples before any delta is reported.
 */
export function summarizeVolumeShareHistory(projectId: string, records: VolumeRecord[], now = Date.now()): VolumeShareHistory {
  const byTime = new Map<number, VolumeRecord>();
  for (const record of records) if (isVolumeRecord(record)) byTime.set(record.asOf, record);
  const ordered = [...byTime.values()].sort((a, b) => a.asOf - b.asOf);
  const points = ordered.length;
  const exchanges = new Set<ExchangeId>();
  for (const record of ordered) for (const row of record.rows) exchanges.add(row.exchange);
  const canDelta = ordered.length >= 2;
  const venues = venueDeltas(ordered, ordered.map((record) => record.rows), canDelta);
  const krwRowsByRecord = ordered.map((record) => record.krwRows ?? []);
  const krwVenues = venueDeltas(ordered, krwRowsByRecord, canDelta);
  return {
    projectId,
    generatedAt: now,
    status: points >= 2 ? 'available' : 'insufficient-history',
    points,
    from: ordered[0]?.asOf ?? null,
    to: ordered.at(-1)?.asOf ?? null,
    venues,
    krwVenues,
    methodology: [
      'Share deltas use locally collected per-venue volume records only; they describe selected covered venues, not the global market.',
      'Records are as-of 24h rolling counters, not event-time-aligned bars; sampling cadence depends on collection mode (Active 30s / Standard 5m).',
      'At least two records are required before any delta is shown; one sample is displayed as insufficient history.',
      'A share shift is context for further study (venue migration, listing/MM effects), not evidence of spot-led or leverage-led price discovery.',
    ],
  };
}

export async function volumeShareHistory(history: HistoryStore, projectId: string, asOf = Date.now(), limit = 500): Promise<VolumeShareHistory> {
  const events = await history.read(projectId, 'volume', asOf, limit);
  const records = events.flatMap((event) => { if (!isVolumeRecord(event.payload)) return []; const payload = event.payload as { asOf?: number; rows: VenueVolumeRow[]; krw?: { rows?: VenueVolumeRow[] } }; return [{ asOf: payload.asOf ?? event.eventTime, rows: payload.rows, krwRows: Array.isArray(payload.krw?.rows) ? payload.krw.rows : [] }]; });
  return summarizeVolumeShareHistory(projectId, records, asOf);
}
