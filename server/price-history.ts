import path from 'node:path';
import { statfsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { StrengthPoint } from '../shared/strength-history.ts';
import { performance, type WatchOverview, type WatchRow } from '../shared/watch-overview.ts';

const MINUTE = 60_000, DAY = 1440 * MINUTE;
const MAX_MARKETS = 128, MAX_PENDING_BLOCKS = 512;
const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE;
type Point = Pick<StrengthPoint, 't' | 'p'>;
type Block = { market: string; minute: number; seconds: Map<number, Point> };

function extrema(points: Point[]): Point[] {
  let low = points[0], high = low;
  for (const point of points) {
    if (point.p < low.p) low = point;
    if (point.p > high.p) high = point;
  }
  return [points[0], low, high, points[points.length - 1]];
}

// Each record holds the exchange time within the minute and the original double price.
// A fixed four-record summary allows long windows to read 40 bytes per minute.
function pack(points: Point[], minute: number) {
  const records = [...extrema(points), ...points];
  const bytes = Buffer.allocUnsafe(records.length * 10);
  records.forEach(({t, p}, i) => {
    bytes.writeUInt16LE(t - minute, i * 10);
    bytes.writeDoubleLE(p, i * 10 + 2);
  });
  return bytes;
}

function unpack(bytes: Uint8Array, minute: number, summary: boolean): Point[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points: Point[] = [];
  for (let i = summary ? 0 : 40; i + 10 <= buffer.length; i += 10)
    points.push({ t: minute + buffer.readUInt16LE(i), p: buffer.readDoubleLE(i + 2) });
  return points;
}

function setSecond(seconds: Map<number, Point>, point: Point) {
  const key = Math.floor(point.t / 1000);
  if ((seconds.get(key)?.t ?? 0) <= point.t) seconds.set(key, point);
}

export function samplePrices(input: Iterable<Point>, from: number, to: number, bucketMs: number) {
  const buckets = new Map<number, Point[]>();
  for (const point of input) {
    if (point.t < from || point.t > to) continue;
    const id = Math.floor((point.t - from) / bucketMs);
    const bucket = buckets.get(id);
    if (!bucket) { buckets.set(id, [point, point, point, point]); continue; }
    if (point.t < bucket[0].t) bucket[0] = point;
    if (point.p < bucket[1].p) bucket[1] = point;
    if (point.p > bucket[2].p) bucket[2] = point;
    if (point.t >= bucket[3].t) bucket[3] = point;
  }
  return [...new Map([...buckets.values()].flat().map(point => [point.t, point])).values()].sort((a,b) => a.t-b.t);
}

/** One bounded archive across markets. Tick callbacks only touch bounded memory. */
export class PriceHistory {
  private db?: DatabaseSync;
  private pending = new Map<string, Block>();
  private last = new Map<string, { latest: Point; savedAt: number }>();
  private maxPages = 0;
  private timer?: NodeJS.Timeout;
  private error: string | null = null;
  private transactions = 0;
  private lastPrune = 0;
  constructor(private directory: string, private maxBytes = 32 * 1024 ** 2) {
    this.connect();
  }
  private connect() {
    if (this.db) return this.db;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path.join(this.directory, 'strength-prices.sqlite'));
      const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
      this.maxPages = Math.max(16, Math.floor(this.maxBytes / pageSize));
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA max_page_count=${this.maxPages};
        CREATE TABLE IF NOT EXISTS prices (market TEXT NOT NULL, minute INTEGER NOT NULL, points BLOB NOT NULL, PRIMARY KEY(market,minute));
        CREATE INDEX IF NOT EXISTS prices_expiry ON prices(minute);`);
      this.db = db;
      this.error = null;
      return db;
    } catch (error) {
      db?.close();
      this.error = error instanceof Error ? error.message : 'Price history unavailable';
    }
  }
  start() {
    this.flush();
    this.timer ??= setInterval(() => this.flush(), MINUTE);
    this.timer.unref();
  }
  record(market: string, p: number, t: number, now = Date.now()) {
    if (!market || market.length > 256 || !Number.isFinite(p) || p <= 0 || !Number.isSafeInteger(t) || t <= 0 ||
        t < now - MINUTE || t > now + 5_000) return;
    const state = this.last.get(market);
    const prior = state?.latest;
    if (prior && t === prior.t && p === prior.p) return;
    const point = {t, p};
    if (prior && t < prior.t) {
      // Late prints can fill an earlier second without rewinding the current quote.
      this.enqueue(market, point);
      return;
    }
    if (!state && this.last.size >= MAX_MARKETS) this.last.delete(this.last.keys().next().value!);
    if (state && prior?.p === p && t - state.savedAt < MINUTE) {
      state.latest = point;
      return;
    }
    if (prior && prior.p !== p && t - prior.t < DAY) this.enqueue(market, prior);
    this.enqueue(market, point);
    this.last.set(market, {latest: point, savedAt: t});
  }
  private enqueue(market: string, point: Point) {
    const minute = floorMinute(point.t);
    const key = minute + ':' + market;
    let block = this.pending.get(key);
    if (!block) {
      if (this.pending.size >= MAX_PENDING_BLOCKS) this.pending.delete(this.pending.keys().next().value!);
      block = {market, minute, seconds: new Map()}; this.pending.set(key, block);
    }
    setSecond(block.seconds, point);
  }
  flush(now = Date.now()) {
    const db = this.connect();
    if (!db) return;
    const cutoff = floorMinute(now - DAY);
    try {
      // Clock-driven removal also expires quiet or delisted markets.
      if (this.lastPrune <= now - MINUTE) {
        db.prepare('DELETE FROM prices WHERE minute < ?').run(cutoff);
        this.lastPrune = now;
        for (const [key, point] of this.last) if (point.latest.t < now - DAY) this.last.delete(key);
      }
      if (!this.pending.size) { this.error = null; return; }
      const get = db.prepare('SELECT points FROM prices WHERE market=? AND minute=?');
      const put = db.prepare('INSERT INTO prices VALUES (?,?,?) ON CONFLICT(market,minute) DO UPDATE SET points=excluded.points');
      let saved = 0;
      // If the file reaches its page cap, remove the oldest blocks in a separate
      // committed transaction before retrying. SQLITE_FULL can roll back the batch.
      const blocks = [...this.pending.values()].filter(block => block.minute >= cutoff).sort((a,b) => a.minute-b.minute);
      let start = 0;
      for (;;) {
        try {
          saved = 0;
          db.exec('BEGIN IMMEDIATE');
          for (let i = start; i < blocks.length; i++) {
            const {market, minute, seconds} = blocks[i];
            const old = get.get(market, minute)?.points as Uint8Array | undefined;
            const merged = new Map<number, Point>();
            if (old) for (const point of unpack(old, minute, false)) setSecond(merged, point);
            for (const point of seconds.values()) setSecond(merged, point);
            const packed = pack([...merged.values()].sort((a,b) => a.t-b.t), minute);
            if (!old || !packed.equals(old)) { put.run(market, minute, packed); saved++; }
          }
          db.exec('COMMIT');
          break;
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          if ((error as {errcode?:number}).errcode !== 13) throw error;
          // An underlying full volume must not trigger destructive quota eviction.
          // SQLite rolled back this batch, so include an upper estimate of its new pages.
          const pageCount = Number(db.prepare('PRAGMA page_count').get()!.page_count);
          const batchPages = Math.ceil((blocks.length - start) / 3) + 2;
          if (pageCount + batchPages < this.maxPages) throw error;
          const space = statfsSync(this.directory);
          if (space.bavail * space.bsize < 2 * 1024 ** 2) throw error;
          const result = db.prepare('DELETE FROM prices WHERE rowid IN (SELECT rowid FROM prices ORDER BY minute LIMIT 128)').run();
          if (!result.changes) {
            if (blocks.length - start <= 1) throw error;
            start += Math.max(1, Math.floor((blocks.length-start) / 4));
          }
        }
      }
      this.pending.clear();
      if (saved) this.transactions++;
      this.error = null;
    } catch (error) { this.error = error instanceof Error ? error.message : 'Price history write failed'; }
  }
  read(market: string, from: number, to: number, bucketMs: number): Point[] {
    from = Math.max(from, to - DAY);
    const summary = bucketMs >= MINUTE;
    const points = new Map<number, Point>();
    try {
      const select = this.db?.prepare('SELECT minute,' + (summary ? 'substr(points,1,40)' : 'points') +
        ' AS bytes FROM prices WHERE market=? AND minute BETWEEN ? AND ? ORDER BY minute');
      if (select) for (const row of select.iterate(market, floorMinute(from), floorMinute(to)))
        for (const point of unpack(row.bytes as Uint8Array, Number(row.minute), summary)) setSecond(points, point);
    } catch (error) { this.error = error instanceof Error ? error.message : 'Price history read failed'; }
    for (const block of this.pending.values()) if (block.market === market && block.minute >= floorMinute(from) && block.minute <= to)
      for (const point of block.seconds.values()) setSecond(points, point);
    const latest = this.last.get(market);
    if (latest) setSecond(points, latest.latest);
    return samplePrices(points.values(), from, to, bucketMs);
  }
  status() {
    let bytes: number | null = null;
    try { bytes = statSync(path.join(this.directory, 'strength-prices.sqlite')).size; } catch { /* Missing until storage is available. */ }
    return { bytes, maxBytes: this.maxBytes, retentionMs: DAY, transactions: this.transactions, pendingMinutes: this.pending.size, error: this.error };
  }
  close(now = Date.now()) {
    clearInterval(this.timer);
    for (const [market, {latest, savedAt}] of this.last)
      if (latest.t > savedAt) this.enqueue(market, latest);
    this.flush(now);
    this.db?.close();
  }
}

export const snapshotPrices = new WeakMap<WatchRow, Point[]>();

export function withStoredPrices(overview: WatchOverview, store: PriceHistory, now: number, minutes: number, ids: string[], benchmark?: string) {
  const defaults = () => overview.rows.map(row => ({id: row.projectId, value: performance(row.candles, overview.end, minutes) ?? -Infinity}))
    .sort((a,b) => b.value - a.value).map(row => row.id);
  const selected = new Set((ids.length ? ids : defaults()).slice(0, 4));
  const from = now - minutes * MINUTE;
  const width = Math.max(1_000, Math.ceil(minutes * MINUTE / 240_000) * 1000);
  const enrich = (row: WatchRow): WatchRow => {
    const key = [row.venue, row.marketType, row.symbol].join(':');
    const recent = store.read(key, from - 5 * MINUTE, now, width);
    const samples = new Map<number, Point>();
    for (const sample of snapshotPrices.get(row) ?? []) setSecond(samples, sample);
    for (const sample of recent) setSecond(samples, sample);
    let baseline: Point | undefined;
    for (const point of samples.values()) {
      if (point.t < from && point.t >= from - 5 * MINUTE && (!baseline || point.t > baseline.t)) baseline = point;
    }
    const priceHistory = samplePrices(samples.values(), from, now, width);
    if (baseline) priceHistory.unshift(baseline);
    return {...row, priceHistory};
  };
  return {...overview, rows: overview.rows.map(row => selected.has(row.projectId) ? enrich(row) : row),
    benchmarks: overview.benchmarks.map(row => row.projectId === benchmark ? enrich(row) : row)};
}
