import type { HistoryStore } from './history-store.ts';
import type { MarketProject } from '../shared/types.ts';
import type { VenueCoverageFailure, VenueCoverageResponse, VenueCoverageVenue } from '../shared/coverage.ts';
import type { VenueVolumeRow, VolumeMatrixResponse } from '../shared/volume.ts';
import { isVolumeRecord } from './volume-share.ts';

export interface VenueCoverageRecord {
  asOf: number;
  rows: VenueVolumeRow[];
  krwRows?: VenueVolumeRow[];
  failures?: VolumeMatrixResponse['failures'];
}

/**
 * Venue-level acquisition health from persisted volume records: did the selected exchange
 * actually return a spot/perpetual leg, how recently, at what quality, and how often it failed?
 * This is coverage evidence, not proof that the venue's data is correct.
 */
export function summarizeVenueCoverage(project: MarketProject, records: VenueCoverageRecord[], now = Date.now()): VenueCoverageResponse {
  const exchanges = [...new Set(project.markets.map((market) => market.exchange))];
  const venues = new Map(exchanges.map((exchange) => [exchange, {
    exchange,
    expectedSpot: project.markets.some((market) => market.exchange === exchange && market.marketType === 'spot'),
    expectedPerp: project.markets.some((market) => market.exchange === exchange && market.marketType === 'perpetual'),
    spotSamples: 0, perpSamples: 0,
    spotLastAt: null as number | null, perpLastAt: null as number | null,
    spotQuality: null as string | null, perpQuality: null as string | null,
    state: 'missing' as VenueCoverageVenue['state'],
  }]));
  const failures = new Map<string, VenueCoverageFailure>();
  const ordered = records.filter((record) => Number.isFinite(record.asOf)).sort((a, b) => a.asOf - b.asOf);
  for (const record of ordered) {
    const rows = [...record.rows, ...(record.krwRows ?? [])];
    for (const row of rows) {
      const venue = venues.get(row.exchange);
      if (!venue) continue;
      if (row.spot != null) { venue.spotSamples += 1; venue.spotLastAt = record.asOf; venue.spotQuality = row.spot.quality; }
      if (row.perpetual != null) { venue.perpSamples += 1; venue.perpLastAt = record.asOf; venue.perpQuality = row.perpetual.quality; }
    }
    for (const failure of record.failures ?? []) {
      const key = `${failure.exchange}:${failure.marketType}`;
      const current = failures.get(key);
      failures.set(key, { exchange: failure.exchange, marketType: failure.marketType, count: (current?.count ?? 0) + 1, lastMessage: failure.message, lastAt: record.asOf });
    }
  }
  const list = [...venues.values()].map((venue) => {
    const state: VenueCoverageVenue['state'] = venue.expectedSpot && venue.expectedPerp
      ? (venue.spotSamples > 0 && venue.perpSamples > 0 ? 'both' : venue.spotSamples > 0 ? 'spot-only' : venue.perpSamples > 0 ? 'perp-only' : 'missing')
      : venue.expectedSpot ? (venue.spotSamples > 0 ? 'spot-only' : 'missing')
        : (venue.perpSamples > 0 ? 'perp-only' : 'missing');
    return { ...venue, state };
  });
  const missingLegs = list.flatMap((venue) => [
    ...(venue.expectedSpot && venue.spotSamples === 0 ? [`${venue.exchange}:spot`] : []),
    ...(venue.expectedPerp && venue.perpSamples === 0 ? [`${venue.exchange}:perpetual`] : []),
  ]);
  return {
    projectId: project.id,
    generatedAt: now,
    points: ordered.length,
    from: ordered[0]?.asOf ?? null,
    to: ordered.at(-1)?.asOf ?? null,
    venues: list,
    failures: [...failures.values()],
    summary: { expectedVenues: list.length, venuesWithBothLegs: list.filter((venue) => venue.state === 'both').length, missingLegs, totalFailures: [...failures.values()].reduce((sum, failure) => sum + failure.count, 0) },
    methodology: [
      'Venue coverage is derived from persisted volume records (kind=volume), one point per collector tick; it is newest-N sampled, not a lifetime count.',
      'spotSamples/perpSamples count records where that leg existed; a missing leg is explicit (state=spot-only/perp-only/missing), never filled with zero volume.',
      'Failures are the per-leg request failures recorded in each volume record; absence of failures does not prove the venue is healthy.',
      'Quality is the last observed leg quality (live/partial/stale); this is acquisition coverage, not research quality or forward performance.',
    ],
  };
}

export async function venueCoverage(history: HistoryStore, project: MarketProject, asOf = Date.now(), limit = 500): Promise<VenueCoverageResponse> {
  const events = await history.read(project.id, 'volume', asOf, limit);
  const records = events.flatMap((event) => {
    if (!isVolumeRecord(event.payload)) return [];
    const payload = event.payload as { asOf?: number; rows: VenueVolumeRow[]; krw?: { rows?: VenueVolumeRow[] }; failures?: VolumeMatrixResponse['failures'] };
    return [{
      asOf: Number.isFinite(payload.asOf) ? payload.asOf! : event.eventTime,
      rows: payload.rows,
      krwRows: Array.isArray(payload.krw?.rows) ? payload.krw.rows : [],
      failures: Array.isArray(payload.failures) ? payload.failures : [],
    }];
  });
  return summarizeVenueCoverage(project, records, asOf);
}
