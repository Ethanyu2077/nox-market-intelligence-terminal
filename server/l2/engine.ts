import type { L2Level, L2Metrics, L2RestSnapshot, L2Sequence, L2Snapshot, L2State, L2Venue } from '../../shared/l2.ts';

/**
 * Sequence-validated L2 book.
 *
 * Venue rules (verified against public venue docs and live frames):
 *  - Binance USDⓈ-M: snapshot `lastUpdateId`; deltas carry `U` (first), `u` (final) and
 *    `pu` (previous final). The first delta must straddle `lastUpdateId`
 *    (`U <= last+1 <= u`); afterwards `pu` must equal the previous `u`.
 *  - Bybit v5: `u` is monotonic but not contiguous (`seq` is a cross-stream counter), so
 *    only ordering is validated; a `type:"snapshot"` message rebuilds the book.
 *  - OKX books: `prevSeqId` must equal the last `seqId`; frames with a `checksum` are
 *    validated with CRC32 over the top 25 levels after applying the change.
 *
 * `state: 'live'` only means "streaming"; `verified` is true only when integrity is
 * actually confirmed. A book is never patched across a gap.
 */

const DEPTH_WINDOW_BPS = 25;
const LEVEL_LIMIT = 50;
// The largest requested bootstrap contains 1,000 levels per side. Rebuild from the
// venue if incremental updates accumulate too many old prices outside that snapshot.
const MAX_BOOK_LEVELS = 4096;
const LIMITATIONS = [
  'Continuous book is rebuilt from a REST snapshot plus deltas; a detected gap forces a full resync.',
  'Bybit publishes monotonic but non-contiguous update ids, so gaps are not inferable from them; reconnect/resync is the integrity mechanism.',
  'Hidden/iceberg liquidity is never observable, and depth is not executable size for a large order.',
];

export type DeltaResult = {
  applied: boolean;
  reason: 'ok' | 'stale' | 'gap' | 'duplicate' | 'not-synced' | 'checksum' | 'depth-limit';
  expected?: number | null;
  received?: number | null;
};

export interface L2Delta {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  first: number | null;
  last: number;
  previous: number | null;
  /** Binance previous final update id. */
  previousLast?: number | null;
  /** OKX checksum for the book after this update. */
  checksum?: number | null;
  eventTime: number;
}

export class L2Book {
  state: L2State = 'connecting';
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  /** Raw strings are required for the OKX checksum (formatting is part of the payload). */
  private bidText = new Map<number, [string, string]>();
  private askText = new Map<number, [string, string]>();
  private sequence: L2Sequence = { first: null, last: null, previous: null };
  private gaps = 0;
  private resyncs = 0;
  private syncedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastValidUpdate: number | null = null;
  private epoch = 0;
  private eventTime = 0;
  private needStraddle = false;
  private lastPu: number | null = null;
  private checksumState: 'ok' | 'failed' | 'unchecked' | 'not-applicable' = 'not-applicable';
  private history: L2Metrics[] = [];
  private lastMetric: L2Metrics | null = null;

  constructor(readonly venue: L2Venue, readonly symbol: string, private now: () => number = Date.now) {
    if (venue === 'okx') this.checksumState = 'unchecked';
  }

  markConnecting(): void { if (this.state !== 'live') this.state = 'connecting'; }

  markResyncing(): void {
    this.state = 'resyncing';
    this.resyncs += 1;
  }

  markStale(): void {
    if (this.state === 'live') this.state = 'stale';
  }

  get lastMessageTime(): number | null { return this.lastMessageAt; }

  applySnapshot(snapshot: L2RestSnapshot, now = this.now()): boolean {
    if (snapshot.bids.length > MAX_BOOK_LEVELS || snapshot.asks.length > MAX_BOOK_LEVELS) {
      this.markResyncing();
      return false;
    }
    this.bids = toMap(snapshot.bids);
    this.asks = toMap(snapshot.asks);
    if (this.venue === 'okx') {
      this.bidText = toTextMap(snapshot.bids);
      this.askText = toTextMap(snapshot.asks);
    }
    this.sequence = { first: snapshot.sequence.first ?? null, last: snapshot.sequence.last, previous: null };
    this.eventTime = snapshot.eventTime;
    this.syncedAt = now;
    this.lastMessageAt = now;
    this.lastValidUpdate = snapshot.sequence.last;
    this.epoch += 1;
    this.needStraddle = this.venue === 'binance';
    this.lastPu = null;
    if (this.venue === 'okx') this.checksumState = 'unchecked';
    this.state = 'live';
    return true;
  }

  applyDelta(delta: L2Delta, now = this.now()): DeltaResult {
    const last = this.sequence.last;
    if (last == null || !Number.isFinite(delta.last)) return { applied: false, reason: 'not-synced' };
    // While resyncing, deltas must not be applied at all: the feed buffers them and replays
    // after a fresh snapshot.
    if (this.state !== 'live' && this.state !== 'stale') return { applied: false, reason: 'not-synced' };

    if (this.venue === 'binance') {
      // Drop anything that cannot advance the snapshot.
      if (delta.last <= last) return { applied: false, reason: 'stale' };
      if (this.needStraddle) {
        const straddles = delta.first != null && delta.first <= last + 1 && delta.last >= last + 1;
        if (!straddles) {
          if (delta.last < last + 1) return { applied: false, reason: 'stale' };
          this.gaps += 1; this.markResyncing();
          return { applied: false, reason: 'gap', expected: last + 1, received: delta.first };
        }
        this.needStraddle = false;
      } else if (delta.previousLast != null && this.lastPu != null && delta.previousLast !== this.lastPu) {
        this.gaps += 1; this.markResyncing();
        return { applied: false, reason: 'gap', expected: this.lastPu, received: delta.previousLast };
      } else if (delta.first != null && delta.first > last + 1) {
        this.gaps += 1; this.markResyncing();
        return { applied: false, reason: 'gap', expected: last + 1, received: delta.first };
      }
    } else if (this.venue === 'bybit') {
      if (delta.last === last) return { applied: false, reason: 'duplicate' };
      if (delta.last < last) return { applied: false, reason: 'stale' };
    } else {
      // OKX: -1 marks a snapshot frame; it must be handled as a rebuild, never as a delta.
      if (delta.previous === -1) return { applied: false, reason: 'not-synced' };
      if (delta.last === last) return { applied: false, reason: 'duplicate' };
      if (delta.previous != null && delta.previous !== last) {
        this.gaps += 1; this.markResyncing();
        return { applied: false, reason: 'gap', expected: last, received: delta.previous };
      }
    }

    if (this.bids.size + delta.bids.length > MAX_BOOK_LEVELS || this.asks.size + delta.asks.length > MAX_BOOK_LEVELS) {
      this.markResyncing();
      return { applied: false, reason: 'depth-limit' };
    }
    this.applyLevels(delta.bids, delta.asks);
    this.sequence = { first: delta.first, last: delta.last, previous: delta.previous };
    this.eventTime = delta.eventTime;
    this.lastMessageAt = now;
    this.lastValidUpdate = delta.last;
    if (this.venue === 'binance') this.lastPu = delta.last;
    if (this.state === 'stale') this.state = 'live';

    if (this.venue === 'okx' && delta.checksum != null) {
      const expected = okxChecksum(this.bidText, this.askText);
      if (expected !== delta.checksum) {
        this.checksumState = 'failed';
        this.gaps += 1;
        this.markResyncing();
        return { applied: false, reason: 'checksum', expected, received: delta.checksum };
      }
      this.checksumState = 'ok';
    }
    return { applied: true, reason: 'ok' };
  }

  private applyLevels(bids: Array<[string, string]>, asks: Array<[string, string]>): void {
    const update = (raw: Array<[string, string]>, side: 'bid' | 'ask') => {
      for (const [price, quantity] of raw) {
        const key = Number(price);
        const value = Number(quantity);
        if (!Number.isFinite(key) || !Number.isFinite(value)) continue;
        const numeric = side === 'bid' ? this.bids : this.asks;
        const text = side === 'bid' ? this.bidText : this.askText;
        if (value === 0) { numeric.delete(key); text.delete(key); continue; }
        numeric.set(key, value);
        if (this.venue === 'okx') text.set(key, [price, quantity]);
        (side === 'bid' ? this.asks : this.bids).delete(key);
        (side === 'bid' ? this.askText : this.bidText).delete(key);
      }
    };
    update(bids, 'bid');
    update(asks, 'ask');
  }

  metrics(now = this.now(), record = true): L2Metrics {
    const metric = this.measure(now, sortedLevels(this.bids, 'desc'), sortedLevels(this.asks, 'asc'));
    if (record) {
      this.lastMetric = metric;
      if (this.history.length >= 600) this.history.shift();
      this.history.push(metric);
    }
    return metric;
  }

  private measure(now: number, bids: L2Level[], asks: L2Level[]): L2Metrics {
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null && bestAsk >= bestBid ? (bestBid + bestAsk) / 2 : null;
    const bidDepthUsd = depthWithin(bids, mid, DEPTH_WINDOW_BPS, 'bid');
    const askDepthUsd = depthWithin(asks, mid, DEPTH_WINDOW_BPS, 'ask');
    const total = bidDepthUsd + askDepthUsd;
    const previous = this.lastMetric;
    return {
      time: now,
      midPrice: mid,
      spreadBps: bestBid != null && bestAsk != null && mid ? (bestAsk - bestBid) / mid * 10_000 : null,
      bidDepthUsd,
      askDepthUsd,
      imbalancePct: total > 0 ? (bidDepthUsd - askDepthUsd) / total * 100 : null,
      bidWithdrawalPct: previous && previous.bidDepthUsd > 0 ? (previous.bidDepthUsd - bidDepthUsd) / previous.bidDepthUsd * 100 : null,
      askWithdrawalPct: previous && previous.askDepthUsd > 0 ? (previous.askDepthUsd - askDepthUsd) / previous.askDepthUsd * 100 : null,
    };
  }

  snapshot(now = this.now()): L2Snapshot {
    const bids = sortedLevels(this.bids, 'desc');
    const asks = sortedLevels(this.asks, 'asc');
    const metric = this.measure(now, bids, asks);
    const integrity = this.integrity();
    return {
      venue: this.venue,
      symbol: this.symbol,
      state: this.state,
      sequence: { ...this.sequence },
      bids: bids.slice(0, LEVEL_LIMIT),
      asks: asks.slice(0, LEVEL_LIMIT),
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
      lastValidUpdate: this.lastValidUpdate,
      epoch: this.epoch,
      gaps: this.gaps,
      resyncs: this.resyncs,
      integrity,
      verified: this.verified(),
      limitations: [...LIMITATIONS],
    };
  }

  metricHistory(): L2Metrics[] { return [...this.history]; }

  private integrity(): L2Snapshot['integrity'] {
    if (this.venue === 'okx' && this.checksumState === 'failed') return 'checksum-failed';
    if (this.state === 'resyncing') return 'gap';
    if (this.venue === 'okx') return this.checksumState === 'ok' ? 'ok' : 'checksum-unchecked';
    return this.state === 'live' || this.state === 'stale' ? 'ok' : 'unknown';
  }

  private verified(): boolean {
    if (this.state !== 'live' || this.sequence.last == null) return false;
    if (this.venue === 'okx') return this.checksumState === 'ok';
    return true;
  }
}

/** OKX checksum: CRC32 over `bidPx:bidSz:askPx:askSz` for the top 25 levels, raw strings. */
export function okxChecksum(bids: Map<number, [string, string]>, asks: Map<number, [string, string]>): number {
  const sortedBids = [...bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 25).map(([, raw]) => raw);
  const sortedAsks = [...asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 25).map(([, raw]) => raw);
  const parts: string[] = [];
  for (let i = 0; i < Math.max(sortedBids.length, sortedAsks.length); i += 1) {
    const bid = sortedBids[i];
    const ask = sortedAsks[i];
    if (bid) parts.push(bid[0], bid[1]);
    if (ask) parts.push(ask[0], ask[1]);
  }
  return crc32(parts.join(':'));
}

let crcTable: number[] | null = null;
function crc32(text: string): number {
  if (!crcTable) {
    crcTable = new Array<number>(256).fill(0).map((_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < text.length; i += 1) {
    crc = (crcTable[(crc ^ text.charCodeAt(i)) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toTextMap(levels: Array<[string, string]>): Map<number, [string, string]> {
  const map = new Map<number, [string, string]>();
  for (const [price, quantity] of levels) {
    const key = Number(price);
    if (Number.isFinite(key) && Number(price) > 0 && Number(quantity) > 0) map.set(key, [price, quantity]);
  }
  return map;
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
