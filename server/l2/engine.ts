import type { L2Level, L2Metrics, L2RestSnapshot, L2Sequence, L2Snapshot, L2State, L2Venue } from '../../shared/l2.ts';

/**
 * Sequence-validated L2 book.
 *
 * Venue rules differ:
 *  - Binance: first `U` and final `u`. Drop `u < lastUpdateId`; a delta whose `U` is beyond
 *    `last+1` means updates were missed and the book must be rebuilt from a snapshot.
 *  - Bybit: update ids are monotonic but not contiguous, so only ordering is validated.
 *  - OKX: `prevSeqId` must equal the last applied `seqId`.
 *
 * Any gap moves the book to `resyncing` and refuses further deltas until a new snapshot
 * arrives. A book is never "patched" across a gap.
 */

const DEPTH_WINDOW_BPS = 25;
const LEVEL_LIMIT = 50;
const LIMITATIONS = [
  'Continuous book is rebuilt from a REST snapshot plus deltas; a detected gap forces a full resync.',
  'OKX checksum is not recomputed in this version; integrity relies on sequence ids.',
  'Hidden/iceberg liquidity is never observable, and depth is not executable size for a large order.',
];

export type DeltaResult = { applied: boolean; reason: 'ok' | 'stale' | 'gap' | 'duplicate' | 'not-synced'; expected?: number | null; received?: number | null };

export class L2Book {
  state: L2State = 'connecting';
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sequence: L2Sequence = { first: null, last: null, previous: null };
  private gaps = 0;
  private resyncs = 0;
  private syncedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private eventTime = 0;
  private history: L2Metrics[] = [];
  private lastMetric: L2Metrics | null = null;

  constructor(readonly venue: L2Venue, readonly symbol: string, private now: () => number = Date.now) {}

  markConnecting(): void { if (this.state !== 'live') this.state = 'connecting'; }

  /** A gap or disconnect invalidates the book until a fresh snapshot is applied. */
  markResyncing(): void {
    this.state = 'resyncing';
    this.resyncs += 1;
  }

  markStale(): void {
    if (this.state === 'live') this.state = 'stale';
  }

  applySnapshot(snapshot: L2RestSnapshot, now = this.now()): void {
    this.bids = toMap(snapshot.bids);
    this.asks = toMap(snapshot.asks);
    this.sequence = { first: snapshot.sequence.first ?? null, last: snapshot.sequence.last, previous: null };
    this.eventTime = snapshot.eventTime;
    this.syncedAt = now;
    this.lastMessageAt = now;
    this.state = 'live';
  }

  applyDelta(delta: { bids: Array<[string, string]>; asks: Array<[string, string]>; first: number | null; last: number; previous: number | null; eventTime: number }, now = this.now()): DeltaResult {
    if (this.state !== 'live' && this.state !== 'stale') return { applied: false, reason: 'not-synced' };
    const last = this.sequence.last;
    if (last == null) return { applied: false, reason: 'not-synced' };

    if (this.venue === 'binance') {
      if (delta.last < last) return { applied: false, reason: 'stale' };
      if (delta.first != null && delta.first > last + 1) {
        this.gaps += 1; this.markResyncing();
        return { applied: false, reason: 'gap', expected: last + 1, received: delta.first };
      }
    } else if (this.venue === 'bybit') {
      // Bybit publishes monotonic update ids (`u`) but no contiguous sequence: a larger
      // `u` is a valid newer book, not a gap. Integrity relies on reconnect + snapshot.
      if (delta.last === last) return { applied: false, reason: 'duplicate' };
      if (delta.last < last) return { applied: false, reason: 'stale' };
    } else {
      // OKX: prevSeqId must match the last applied seqId.
      if (delta.last === last) return { applied: false, reason: 'duplicate' };
      if (delta.previous != null && delta.previous !== last) {
        this.gaps += 1; this.markResyncing();
        return { applied: false, reason: 'gap', expected: last, received: delta.previous };
      }
    }

    const bidPrices = new Set(delta.bids.map(([price]) => Number(price)));
    for (const [price, quantity] of [...delta.bids, ...delta.asks]) {
      const key = Number(price);
      const value = Number(quantity);
      if (!Number.isFinite(key) || !Number.isFinite(value)) continue;
      if (value === 0) {
        this.bids.delete(key);
        this.asks.delete(key);
      } else if (bidPrices.has(key)) {
        this.bids.set(key, value);
        this.asks.delete(key);
      } else {
        this.asks.set(key, value);
        this.bids.delete(key);
      }
    }
    this.sequence = { first: delta.first, last: delta.last, previous: delta.previous };
    this.eventTime = delta.eventTime;
    this.lastMessageAt = now;
    if (this.state === 'stale') this.state = 'live';
    return { applied: true, reason: 'ok' };
  }

  metrics(now = this.now(), record = true): L2Metrics {
    const bids = sortedLevels(this.bids, 'desc');
    const asks = sortedLevels(this.asks, 'asc');
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null && bestAsk >= bestBid ? (bestBid + bestAsk) / 2 : null;
    const bidDepthUsd = depthWithin(bids, mid, DEPTH_WINDOW_BPS, 'bid');
    const askDepthUsd = depthWithin(asks, mid, DEPTH_WINDOW_BPS, 'ask');
    const total = bidDepthUsd + askDepthUsd;
    const previous = this.lastMetric;
    const metric: L2Metrics = {
      time: now,
      midPrice: mid,
      spreadBps: bestBid != null && bestAsk != null && mid ? (bestAsk - bestBid) / mid * 10_000 : null,
      bidDepthUsd,
      askDepthUsd,
      imbalancePct: total > 0 ? (bidDepthUsd - askDepthUsd) / total * 100 : null,
      bidWithdrawalPct: previous && previous.bidDepthUsd > 0 ? (previous.bidDepthUsd - bidDepthUsd) / previous.bidDepthUsd * 100 : null,
      askWithdrawalPct: previous && previous.askDepthUsd > 0 ? (previous.askDepthUsd - askDepthUsd) / previous.askDepthUsd * 100 : null,
    };
    if (record) {
      this.lastMetric = metric;
      this.history = [...this.history, metric].slice(-600);
    }
    return metric;
  }

  snapshot(now = this.now()): L2Snapshot {
    const bids = sortedLevels(this.bids, 'desc').slice(0, LEVEL_LIMIT);
    const asks = sortedLevels(this.asks, 'asc').slice(0, LEVEL_LIMIT);
    const metric = this.metrics(now, false);
    return {
      venue: this.venue,
      symbol: this.symbol,
      state: this.state,
      sequence: { ...this.sequence },
      bids,
      asks,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      midPrice: metric.midPrice,
      spreadBps: metric.spreadBps,
      bidDepthUsd: metric.bidDepthUsd,
      askDepthUsd: metric.askDepthUsd,
      imbalancePct: metric.imbalancePct,
      eventTime: this.eventTime,
      syncedAt: this.syncedAt,
      lastMessageAt: this.lastMessageAt,
      gaps: this.gaps,
      resyncs: this.resyncs,
      integrity: this.state === 'resyncing' ? 'gap' : this.venue === 'okx' ? 'checksum-unchecked' : 'ok',
      limitations: [...LIMITATIONS],
    };
  }

  metricHistory(): L2Metrics[] { return [...this.history]; }
}

function toMap(levels: Array<[string, string]>): Map<number, number> {
  const map = new Map<number, number>();
  for (const [price, quantity] of levels) {
    const p = Number(price); const q = Number(quantity);
    if (Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0) map.set(p, q);
  }
  return map;
}

function sortedLevels(map: Map<number, number>, direction: 'asc' | 'desc'): L2Level[] {
  return [...map.entries()]
    .sort((a, b) => direction === 'asc' ? a[0] - b[0] : b[0] - a[0])
    .map(([price, quantity]) => ({ price, quantity, notional: price * quantity }));
}

function depthWithin(levels: L2Level[], mid: number | null, bps: number, side: 'bid' | 'ask'): number {
  if (mid == null) return 0;
  const limit = mid * (side === 'bid' ? 1 - bps / 10_000 : 1 + bps / 10_000);
  let total = 0;
  for (const level of levels) {
    if (side === 'bid' ? level.price < limit : level.price > limit) break;
    total += level.notional;
  }
  return total;
}
