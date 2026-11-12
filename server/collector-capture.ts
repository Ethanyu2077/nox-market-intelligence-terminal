import type { HistoryEvent } from '../shared/history.ts';
import { historyCadenceMs, type CollectionMode } from '../shared/history-cadence.ts';
import type { ProjectMarket, VenueMarketSnapshot } from '../shared/types.ts';
import { flowKey } from './orderflow-calculations.ts';
import type { HistoryStore } from './history-store.ts';

type Mode = Exclude<CollectionMode, 'paused'>;
type SampleKind = 'alignment' | 'volume';
type SnapshotMark = { eventTime: number; ingestTime: number; quality: string; signature: string };

const windowStart = (now: number, cadence: number) => Math.floor(now / cadence) * cadence;
const RECOVERY_LOOKBACK_MS = 86_400_000;

function snapshotSignature(payload: unknown) {
  // JSONB can reorder object keys. Receipt time and the order of missing-field labels
  // can change on a retry even when the actual exchange observation is identical.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const snapshot = payload as Record<string, unknown>;
  const keys = Object.keys(snapshot).filter(key => key !== 'fetchedAt').sort();
  const unavailable = Array.isArray(snapshot.unavailable) ? [...snapshot.unavailable].sort() : snapshot.unavailable;
  return JSON.stringify(keys.map(key => [key, key === 'unavailable' ? unavailable : snapshot[key]]));
}

/** Per-project, single-collector sampling decisions. History itself supplies the restart marks. */
export class CollectorCapture {
  private snapshots = new Map<string, SnapshotMark | null>();
  private samples = new Map<SampleKind, number>();
  constructor(private projectId: string, private history: HistoryStore) {}

  retainMarkets(markets: ProjectMarket[]) {
    const selected = new Set(markets.map(flowKey));
    for (const key of this.snapshots.keys()) if (!selected.has(key)) this.snapshots.delete(key);
  }

  async snapshot(snapshot: VenueMarketSnapshot, mode: Mode, now: number) {
    const key = flowKey(snapshot);
    const start = windowStart(now, historyCadenceMs('snapshot', mode));
    let last = this.snapshots.get(key);
    if (last === undefined) {
      // A source can still return yesterday's quote after a restart. Include that
      // exact event time in the lookup to avoid counting a cached reply again.
      const recoverySince = now - RECOVERY_LOOKBACK_MS;
      const page = await this.history.page(this.projectId, {
        kind: 'snapshot', marketKey: key, from: Math.min(snapshot.eventTime, start), asOf: now, limit: 1,
        collectorRecoverySince: recoverySince,
      });
      const event = page.items[0];
      last = event ? { eventTime: event.eventTime, ingestTime: event.ingestTime, quality: event.quality,
        signature: snapshotSignature(event.payload) } : null;
      // A capped or retired local outbox cannot prove that an old quote was unseen.
      // Keep it as a comparison point, so its next real correction still gets saved.
      if (!last && snapshot.eventTime < start &&
          (page.collectorTailIncomplete || page.fallback || page.localScan && snapshot.eventTime < recoverySince)) {
        this.snapshots.set(key, { eventTime: snapshot.eventTime, ingestTime: -Infinity,
          quality: snapshot.quality, signature: snapshotSignature(snapshot) });
        return;
      }
      this.snapshots.set(key, last);
    }
    if (last && snapshot.eventTime < last.eventTime) return;
    const revision = last?.eventTime === snapshot.eventTime;
    if (last && !revision && last.ingestTime >= start && last.quality === snapshot.quality) return;
    const signature = snapshotSignature(snapshot);
    if (revision && signature === last?.signature) return;
    await this.history.append({
      id: `${this.projectId}:${key}:${now}`, kind: 'snapshot', marketKey: key,
      projectId: this.projectId, eventTime: snapshot.eventTime, ingestTime: now,
      source: snapshot.source, quality: snapshot.quality, payload: snapshot,
    });
    this.snapshots.set(key, { eventTime: snapshot.eventTime, ingestTime: now, quality: snapshot.quality, signature });
  }

  async periodic(kind: SampleKind, mode: Mode, now: number, observe: () => Promise<HistoryEvent | null>) {
    const start = windowStart(now, historyCadenceMs(kind, mode));
    let last = this.samples.get(kind);
    if (last === undefined) {
      const { items: [event] } = await this.history.page(this.projectId, {
        kind, from: start, asOf: now, limit: 1, collectorRecoverySince: start,
      });
      last = event?.ingestTime ?? -Infinity;
      this.samples.set(kind, last);
    }
    if (last >= start) return;
    const event = await observe();
    if (!event) return;
    await this.history.append(event);
    this.samples.set(kind, event.ingestTime);
  }
}
