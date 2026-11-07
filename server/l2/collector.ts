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
 * into 1s / 5s / 1m buckets and appended to the existing history journal (kind `l2`), so no
 * separate storage system is introduced.
 *
 * Depth change and "withdrawal" are NET values: without matched aggressor trades we cannot
 * separate fills from cancellations, and the payload says so explicitly.
 */

const VENUES = new Set(['binance', 'bybit', 'okx']);
const INTEGRITY_RANK: Record<L2Snapshot['integrity'], number> = { ok: 0, 'checksum-unchecked': 1, 'checksum-failed': 2, gap: 3, unknown: 4 };

export function aggregateBucket(projectId: string, venue: L2BucketMetric['venue'], symbol: string, samples: L2Snapshot[], bucketMs: number, bucketStart: number, intervalMs: number, receivedAt: number): L2BucketMetric {
  const first = samples[0], last = samples[samples.length - 1];
  const mean = (pick: (row: L2Snapshot) => number | null): number | null => {
    const values = samples.map(pick).filter((value): value is number => value != null && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const depthChange = (pick: (row: L2Snapshot) => number): number | null => {
    if (!first || !last) return null;
    const start = pick(first), end = pick(last);
    return start > 0 ? (end - start) / start * 100 : null;
  };
  const bidChange = depthChange((row) => row.bidDepthUsd);
  const askChange = depthChange((row) => row.askDepthUsd);
  const withdrawal = bidChange == null || askChange == null ? null : -(bidChange + askChange) / 2;
  return {
    projectId,
    venue,
    symbol,
    bucketMs,
    bucketStart,
    samples: samples.length,
    expectedSamples: Math.max(1, Math.round(bucketMs / intervalMs)),
    coveragePct: Math.min(100, samples.length / Math.max(1, Math.round(bucketMs / intervalMs)) * 100),
    spreadBps: mean((row) => row.spreadBps),
    bidDepthUsd: mean((row) => row.bidDepthUsd),
    askDepthUsd: mean((row) => row.askDepthUsd),
    imbalancePct: mean((row) => row.imbalancePct),
    bidDepthChangePct: bidChange,
    askDepthChangePct: askChange,
    liquidityWithdrawalPct: withdrawal,
    attribution: 'net-of-fills-not-separated',
    integrity: samples.reduce<L2Snapshot['integrity']>((worst, row) => INTEGRITY_RANK[row.integrity] > INTEGRITY_RANK[worst] ? row.integrity : worst, 'ok'),
    verified: samples.every((row) => row.verified),
    sequenceLast: last?.sequence.last ?? null,
    gapsDelta: Math.max(0, (last?.gaps ?? 0) - (first?.gaps ?? 0)),
    resyncsDelta: Math.max(0, (last?.resyncs ?? 0) - (first?.resyncs ?? 0)),
    eventTime: bucketStart + bucketMs - 1,
    receivedAt,
  };
}

interface BucketState { start: number; samples: L2Snapshot[] }
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
  private readonly acquire: NonNullable<L2CollectorDeps['acquire']>;
  private readonly append: NonNullable<L2CollectorDeps['append']>;
  private readonly intervalMs: number;
  private readonly bucketSizes: number[];

  constructor(private projects: () => MarketProject[], history: HistoryStore, deps: L2CollectorDeps = {}) {
    this.intervalMs = deps.intervalMs ?? 1_000;
    this.bucketSizes = deps.buckets ?? [1_000, 5_000, 60_000];
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const handle of this.feeds.values()) handle.release();
    this.feeds.clear();
    this.buckets.clear();
  }

  /** One sampling tick; exported for tests with an explicit clock. */
  async tick(now = Date.now()): Promise<L2BucketMetric[]> {
    const active = this.projects().filter((project) => !project.archived && project.monitoring.streamingEnabled && project.monitoring.collectionMode === 'active');
    const wanted = new Set<string>();
    const persisted: L2BucketMetric[] = [];

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
        for (const bucketMs of this.bucketSizes) {
          const bucketKey = `${key}:${bucketMs}`;
          let bucket = this.buckets.get(bucketKey);
          const start = Math.floor(now / bucketMs) * bucketMs;
          if (!bucket || bucket.start !== start) {
            if (bucket && bucket.samples.length) persisted.push(aggregateBucket(project.id, market.exchange as L2BucketMetric['venue'], market.symbol, bucket.samples, bucketMs, bucket.start, this.intervalMs, now));
            bucket = { start, samples: [] };
            this.buckets.set(bucketKey, bucket);
          }
          bucket.samples = [...bucket.samples, snapshot].slice(-Math.round(bucketMs / this.intervalMs));
        }
      }
    }

    // Release feeds for projects/markets that stopped being active.
    for (const [key, feed] of this.feeds) {
      if (!wanted.has(key)) { feed.release(); this.feeds.delete(key); }
    }

    for (const metric of persisted) {
      await this.append({
        id: `l2_${metric.projectId}_${metric.venue}_${metric.symbol}_${metric.bucketMs}_${metric.bucketStart}`,
        kind: 'l2', marketKey: `${metric.venue}:perpetual:${metric.symbol}`, projectId: metric.projectId,
        eventTime: metric.eventTime, ingestTime: metric.receivedAt,
        source: `l2:${metric.venue}`, quality: metric.verified ? 'verified' : 'unverified', payload: metric,
      });
    }
    return persisted;
  }
}
