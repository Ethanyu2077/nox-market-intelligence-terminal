import type { L2BucketMetric, L2Snapshot } from '../../shared/l2.ts';
import type { MarketProject } from '../../shared/types.ts';
import type { HistoryEvent } from '../../shared/history.ts';
import type { HistoryStore } from '../history-store.ts';
import { acquireL2 } from './feed.ts';

/**
 * Project-level L2 collector.
 *
 * Only projects in `Active` collection mode with streaming enabled are collected; the feed
 * is reference-counted and kept open while the project stays active. Samples are aggregated
 * into five-minute buckets and appended to the existing history journal (kind `l2`), so no
 * separate storage system is introduced.
 *
 * Depth change and "withdrawal" are NET values: without matched aggressor trades we cannot
 * separate fills from cancellations, and the payload says so explicitly.
 */

const VENUES = new Set(['binance', 'bybit', 'okx']);
const MAX_PENDING_BUCKETS = 512;
const INTEGRITY_RANK: Record<L2Snapshot['integrity'], number> = { ok: 0, 'checksum-unchecked': 1, 'checksum-failed': 2, gap: 3, unknown: 4 };

type BucketSample = Pick<L2Snapshot, 'state' | 'verified' | 'integrity' | 'epoch' | 'sequence' | 'gaps' | 'resyncs' |
  'lastMessageAt' | 'spreadBps' | 'bidDepthUsd' | 'askDepthUsd' | 'imbalancePct'>;

function bucketSample({state, verified, integrity, epoch, sequence, gaps, resyncs, lastMessageAt, spreadBps, bidDepthUsd, askDepthUsd, imbalancePct}: L2Snapshot): BucketSample {
  return {state, verified, integrity, epoch, sequence, gaps, resyncs, lastMessageAt, spreadBps, bidDepthUsd, askDepthUsd, imbalancePct};
}

export function aggregateBucket(projectId: string, venue: L2BucketMetric['venue'], symbol: string, samples: BucketSample[], bucketMs: number, bucketStart: number, intervalMs: number, receivedAt: number, staleSkipped = 0, incomplete = false): L2BucketMetric {
  const first = samples[0], last = samples[samples.length - 1];
  const mean = (pick: (row: BucketSample) => number | null): number | null => {
    const values = samples.map(pick).filter((value): value is number => value != null && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const depthChange = (pick: (row: BucketSample) => number): number | null => {
    if (!first || !last) return null;
    const start = pick(first), end = pick(last);
    return start > 0 ? (end - start) / start * 100 : null;
  };
  const bidChange = depthChange((row) => row.bidDepthUsd);
  const askChange = depthChange((row) => row.askDepthUsd);
  const withdrawal = bidChange == null || askChange == null ? null : -(bidChange + askChange) / 2;
  const reasons: string[] = [];
  if (samples.some((row) => row.state !== 'live')) reasons.push('non-live-state');
  if (samples.some((row) => !row.verified)) reasons.push('unverified-book');
  if (samples.some((row) => row.integrity !== 'ok')) reasons.push('integrity-not-ok');
  const coveragePct = Math.min(100, samples.length / Math.max(1, Math.round(bucketMs / intervalMs)) * 100);
  if (coveragePct < 80) reasons.push('low-coverage');
  if (staleSkipped > 0) reasons.push('stale-sequence-skipped');
  const epochs = [...new Set(samples.map((row) => row.epoch))];
  if (epochs.length > 1) reasons.push('epoch-change');
  if (incomplete) reasons.push('incomplete-bucket');
  let maxGap: number | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const gap = samples[index].lastMessageAt != null && samples[index - 1].lastMessageAt != null ? (samples[index].lastMessageAt as number) - (samples[index - 1].lastMessageAt as number) : null;
    if (gap != null) maxGap = maxGap == null ? gap : Math.max(maxGap, gap);
  }
  return {
    projectId,
    venue,
    symbol,
    bucketMs,
    bucketStart,
    samples: samples.length,
    expectedSamples: Math.max(1, Math.round(bucketMs / intervalMs)),
    coveragePct,
    spreadBps: mean((row) => row.spreadBps),
    bidDepthUsd: mean((row) => row.bidDepthUsd),
    askDepthUsd: mean((row) => row.askDepthUsd),
    imbalancePct: mean((row) => row.imbalancePct),
    bidDepthChangePct: bidChange,
    askDepthChangePct: askChange,
    liquidityWithdrawalPct: withdrawal,
    attribution: 'net-of-fills-not-separated',
    researchUsable: reasons.length === 0,
    exclusionReasons: reasons,
    maxSampleGapMs: maxGap,
    staleSkipped,
    epochs,
    epochChanges: Math.max(0, epochs.length - 1),
    integrity: samples.reduce<L2Snapshot['integrity']>((worst, row) => INTEGRITY_RANK[row.integrity] > INTEGRITY_RANK[worst] ? row.integrity : worst, 'ok'),
    verified: samples.every((row) => row.verified),
    sequenceLast: last?.sequence.last ?? null,
    gapsDelta: Math.max(0, (last?.gaps ?? 0) - (first?.gaps ?? 0)),
    resyncsDelta: Math.max(0, (last?.resyncs ?? 0) - (first?.resyncs ?? 0)),
    eventTime: bucketStart + bucketMs - 1,
    receivedAt,
  };
}

interface BucketState { start: number; samples: BucketSample[]; staleSkipped: number }
interface FeedHandle { release: () => void; snapshot: () => L2Snapshot }

export interface L2CollectorDeps {
  acquire?: (venue: L2BucketMetric['venue'], symbol: string) => FeedHandle;
  append?: (event: HistoryEvent) => Promise<void>;
  intervalMs?: number;
  buckets?: number[];
}

export class L2Collector {
  private timer: NodeJS.Timeout | null = null;
  private feeds = new Map<string, FeedHandle>();
  private buckets = new Map<string, BucketState>();
  private lastSequence = new Map<string, { epoch: number; last: number }>();
  private pending = new Map<string, HistoryEvent>();
  private draining?: Promise<void>;
  private writingId?: string;
  private droppedBuckets = 0;
  private sampled = 0;
  private writes = 0;
  private writeFailures = 0;
  private lastPersistAt: number | null = null;
  private readonly acquire: NonNullable<L2CollectorDeps['acquire']>;
  private readonly append: NonNullable<L2CollectorDeps['append']>;
  private readonly intervalMs: number;
  private readonly bucketSizes: number[];

  constructor(private projects: () => MarketProject[], history: HistoryStore, deps: L2CollectorDeps = {}) {
    this.intervalMs = deps.intervalMs ?? 1_000;
    // Only 5m buckets are persisted; 1s/5s depth stays in memory for live views.
    this.bucketSizes = deps.buckets ?? [300_000];
    this.acquire = deps.acquire ?? ((venue, symbol) => {
      const handle = acquireL2(venue, symbol);
      return { release: handle.release, snapshot: () => handle.feed.snapshot() };
    });
    this.append = deps.append ?? ((event) => history.append(event));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Persist every open bucket as an audit-only (research-unusable) record. */
  async flush(now = Date.now()): Promise<void> {
    for (const [bucketKey, bucket] of [...this.buckets.entries()]) {
      const bucketMs = Number(bucketKey.split(':').at(-1));
      this.queueBucket(bucketKey.split(':').slice(0, -1).join(':'), bucket, bucketMs, now, true);
      this.buckets.delete(bucketKey);
    }
    await this.drain(now);
  }

  private queueBucket(key: string, bucket: BucketState, bucketMs: number, now: number, incomplete: boolean) {
    const [projectId, venue, symbol] = key.split(':');
    const metric = aggregateBucket(projectId, venue as L2BucketMetric['venue'], symbol, bucket.samples, bucketMs, bucket.start, this.intervalMs, now, bucket.staleSkipped, incomplete);
    const id = `l2_${projectId}_${venue}_${symbol}_${bucketMs}_${bucket.start}`;
    if (this.pending.has(id)) return;
    if (this.pending.size >= MAX_PENDING_BUCKETS) {
      // Keep the most recent completed buckets during a long write outage.
      for (const oldest of this.pending.keys()) {
        if (oldest === this.writingId) continue;
        this.pending.delete(oldest);
        this.droppedBuckets++;
        break;
      }
    }
    this.pending.set(id, {
      id, kind: 'l2', marketKey: `${venue}:perpetual:${symbol}`, projectId,
      eventTime: metric.eventTime, ingestTime: metric.receivedAt,
      source: `l2:${venue}`, quality: metric.researchUsable ? 'verified' : 'unverified', payload: metric,
    });
  }

  private drain(now: number): Promise<void> {
    if (this.draining) return this.draining;
    if (!this.pending.size) return Promise.resolve();
    this.draining = this.persistPending(now).finally(() => {
      this.draining = undefined;
      this.writingId = undefined;
    });
    return this.draining;
  }

  private async persistPending(now: number) {
    for (const event of this.pending.values()) {
      this.writingId = event.id;
      try { await this.append(event); }
      catch (error) {
        this.writeFailures++;
        throw error; // One failed attempt per tick; retry the same compact, immutable event.
      }
      this.pending.delete(event.id);
      this.writes++;
      this.lastPersistAt = now;
    }
  }

  /** Collector health for operations: sampling, writes, retries and open buckets. */
  /** Current per-feed evidence used by Data Health (read-only). */
  feedSnapshots() {
    return [...this.feeds.entries()].map(([key, handle]) => {
      const snapshot = handle.snapshot();
      return {
        venue: key.split(':')[1] ?? '', symbol: key.split(':')[2] ?? '',
        state: snapshot.state, sequence: snapshot.sequence.last, epoch: snapshot.epoch,
        verified: snapshot.verified, integrity: snapshot.integrity,
        gaps: snapshot.gaps, resyncs: snapshot.resyncs, lastMessageAt: snapshot.lastMessageAt,
      };
    });
  }

  health() {
    return {
      sampled: this.sampled,
      writes: this.writes,
      writeFailures: this.writeFailures,
      pendingBuckets: this.buckets.size,
      pendingRetries: this.pending.size,
      maxPendingBuckets: MAX_PENDING_BUCKETS,
      droppedBuckets: this.droppedBuckets,
      lastPersistAt: this.lastPersistAt,
      activeFeeds: this.feeds.size,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const handle of this.feeds.values()) handle.release();
    this.feeds.clear();
    this.buckets.clear();
    this.lastSequence.clear();
  }

  /** One sampling tick; exported for tests with an explicit clock. */
  async tick(now = Date.now()): Promise<void> {
    const active = this.projects().filter((project) => !project.archived && project.monitoring.streamingEnabled && project.monitoring.collectionMode === 'active');
    const wanted = new Set<string>();

    for (const project of active) {
      for (const market of project.markets) {
        if (market.marketType !== 'perpetual' || !VENUES.has(market.exchange)) continue;
        const key = `${project.id}:${market.exchange}:${market.symbol}`;
        wanted.add(key);
        let feed = this.feeds.get(key);
        if (!feed) {
          feed = this.acquire(market.exchange as L2BucketMetric['venue'], market.symbol);
          this.feeds.set(key, feed);
        }
        let snapshot: L2Snapshot;
        try { snapshot = feed.snapshot(); } catch { continue; }
        if (snapshot.state === 'unavailable' || snapshot.sequence.last == null) continue;
        // Never reuse an unchanged book as a fresh observation.
        const previous = this.lastSequence.get(key);
        // A new epoch means the book was rebuilt: sequence ids from the old epoch must not
        // be compared with the new one.
        const advanced = previous == null || previous.epoch !== snapshot.epoch || snapshot.sequence.last > previous.last;
        if (advanced) this.lastSequence.set(key, { epoch: snapshot.epoch, last: snapshot.sequence.last });
        for (const bucketMs of this.bucketSizes) {
          const bucketKey = `${key}:${bucketMs}`;
          let bucket = this.buckets.get(bucketKey);
          const start = Math.floor(now / bucketMs) * bucketMs;
          if (!bucket || bucket.start !== start) {
            if (bucket && bucket.samples.length) this.queueBucket(key, bucket, bucketMs, now, false);
            bucket = { start, samples: [], staleSkipped: 0 };
            this.buckets.set(bucketKey, bucket);
          }
          if (advanced) {
            const capacity = Math.max(1, Math.round(bucketMs / this.intervalMs));
            if (bucket.samples.length >= capacity) bucket.samples.shift();
            bucket.samples.push(bucketSample(snapshot));
            this.sampled += 1;
          }
          else bucket.staleSkipped += 1;
        }
      }
    }

    // Release feeds for projects/markets that stopped being active.
    for (const [key, feed] of this.feeds) {
      if (!wanted.has(key)) {
        feed.release();
        this.feeds.delete(key);
        this.lastSequence.delete(key);
        for (const [bucketKey, bucket] of [...this.buckets.entries()]) {
          if (!bucketKey.startsWith(`${key}:`)) continue;
          const bucketMs = Number(bucketKey.split(':').at(-1));
          this.queueBucket(key, bucket, bucketMs, now, true);
          this.buckets.delete(bucketKey);
        }
      }
    }

    // Sampling continues while a previous append is blocked, with only one writer.
    if (!this.draining) await this.drain(now).catch(() => undefined);
  }
}
