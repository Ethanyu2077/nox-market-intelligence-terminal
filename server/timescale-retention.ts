import type { PoolClient } from 'pg';
import { storageLimit } from './storage-limits.ts';

const DAY = 86_400_000;
const RECHECK_MS = 60_000;
type Client = Pick<PoolClient, 'query'>;
type Chunk = { end: Date; bytes: string | number };
export class TimescaleWritesPaused extends Error {}
export class HistoryBatchTooLarge extends Error {}

function sizeBytes(value: unknown) {
  const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid history size');
  return size;
}

// The JSON lookup also works on databases initialized before the retention column existed.
// The hypertable size includes indexes and TOAST; unrelated operator databases and WAL
// are outside the application history budget.
const inspect = `SELECT hypertable_size('nox_history_events') AS bytes, now() AS clock,
  (to_jsonb(m)->>'retained_from')::timestamptz AS floor, to_jsonb(m) ? 'retained_from' AS has_floor,
  EXISTS (SELECT 1 FROM show_chunks('nox_history_events', older_than => now() - make_interval(days => $1))) AS expired
  FROM nox_history_storage_meta m WHERE singleton`;
const closedChunks = `SELECT c.range_end AS end, s.total_bytes AS bytes
  FROM chunks_detailed_size('nox_history_events') s
  JOIN timescaledb_information.chunks c USING (chunk_schema, chunk_name)
  WHERE c.range_end <= $1::timestamptz ORDER BY c.range_end`;

/** Oldest complete time chunks go first. A chunk spanning the present is never selected. */
export function reclamationCutoff(chunks: Chunk[], total: number, maximum: number, ageFloor: number) {
  const underPressure = total >= maximum * 0.9;
  let cutoff: number | null = null;
  for (const chunk of chunks) {
    if (!(chunk.end instanceof Date) || !Number.isFinite(chunk.end.getTime())) throw new Error('Invalid history chunk boundary');
    const end = chunk.end.getTime(), bytes = sizeBytes(chunk.bytes);
    if (end > ageFloor && (!underPressure || total <= maximum * 0.8)) break;
    total -= bytes;
    cutoff = end;
  }
  return cutoff;
}

export class TimescaleRetention {
  readonly days = Math.min(36_500, storageLimit('NOX_TIMESCALE_RETENTION_DAYS', 90));
  readonly maxBytes = storageLimit('NOX_TIMESCALE_MAX_BYTES', 4 * 1024 ** 3);
  // Limit outstanding unmeasured writes and bound the size of a normal replay batch.
  readonly batchBytes = Math.max(1, Math.min(1024 ** 2, Math.floor(this.maxBytes / 64)));
  private readonly checkBytes = Math.max(1, Math.min(8 * 1024 ** 2, Math.floor(this.maxBytes / 32)));
  private checkedAt = 0;
  private identity: string | null = null;
  private measured = 0;
  private unmeasured = 0;
  private floor = -Infinity;
  private paused: string | null = null;

  status() {
    return { days: this.days, maxBytes: this.maxBytes, measuredBytes: this.checkedAt ? this.measured : null,
      retainedFrom: Number.isFinite(this.floor) ? this.floor : null, checkedAt: this.checkedAt || null, paused: this.paused };
  }
  expired(eventTime: number) { return eventTime < this.floor; }

  async check(client: Client, identity: string, allowChunkRemoval = true, reserve = 0) {
    const started = Date.now();
    if (!reserve && identity === this.identity && this.checkedAt && started - this.checkedAt < RECHECK_MS && this.unmeasured < this.checkBytes) {
      if (this.paused) throw new TimescaleWritesPaused(this.paused);
      return;
    }
    if (identity !== this.identity) {
      this.identity = identity;
      this.floor = -Infinity;
    }
    try {
      const { rows: [row] } = await client.query(inspect, [this.days]);
      if (!(row?.clock instanceof Date) || !Number.isFinite(row.clock.getTime()) ||
          (row.floor != null && (!(row.floor instanceof Date) || !Number.isFinite(row.floor.getTime()))))
        throw new Error('Could not measure history hypertable');
      this.measured = sizeBytes(row.bytes);
      const ageFloor = row.clock.getTime() - this.days * DAY;
      this.floor = Math.max(ageFloor, row.floor?.getTime() ?? -Infinity);
      // Account for a large incoming batch only after a fresh physical measurement
      // confirms it will not fit. Replays of duplicates often use less space than estimated.
      const pressureBytes = this.measured + reserve > this.maxBytes ? this.measured + reserve : this.measured;
      if (allowChunkRemoval && (row.expired || pressureBytes >= this.maxBytes * 0.9)) {
        const result = await client.query<Chunk>(closedChunks, [row.clock]);
        const cutoff = reclamationCutoff(result.rows, pressureBytes, this.maxBytes, ageFloor);
        if (cutoff !== null) {
          // Keep the floor and chunk deletion in the same transaction so a crash or
          // an old pending journal cannot bring pressure-evicted data back on restart.
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL lock_timeout = '2s'");
            if (!row.has_floor) {
              await client.query('ALTER TABLE nox_history_storage_meta ADD COLUMN IF NOT EXISTS retained_from timestamptz');
            }
            await client.query("SELECT drop_chunks('nox_history_events', older_than => $1::timestamptz)", [new Date(cutoff)]);
            await client.query('UPDATE nox_history_storage_meta SET retained_from = GREATEST(retained_from, $1::timestamptz) WHERE singleton', [new Date(cutoff)]);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          }
          this.floor = Math.max(this.floor, cutoff);
          const size = (await client.query("SELECT hypertable_size('nox_history_events') AS bytes")).rows[0]?.bytes;
          this.measured = sizeBytes(size);
        }
      }
      this.paused = this.measured >= this.maxBytes * 0.9 ? 'History chunk budget reached; waiting for a closed chunk' : null;
    } catch {
      this.paused = 'History quota could not be verified; replication paused';
    }
    this.checkedAt = started;
    this.unmeasured = 0;
    if (this.paused) throw new TimescaleWritesPaused(this.paused);
  }
  /** Returns true when the caller must filter the batch again against an advanced floor. */
  async admitBatch(client: Client, identity: string, bytes: number, rows: number, allowChunkRemoval = true) {
    const estimate = sizeBytes(bytes) + sizeBytes(rows) * 512;
    if (this.measured + this.unmeasured + estimate <= this.maxBytes) return false;
    if (estimate > this.maxBytes) throw new HistoryBatchTooLarge('History row and index estimate exceeds the entire database history budget');
    const floor = this.floor;
    await this.check(client, identity, allowChunkRemoval, estimate);
    // If this batch contains the reclaimed history, the caller must first omit
    // those records. Otherwise a reinsert could recreate a freshly dropped chunk.
    if (this.measured + estimate <= this.maxBytes) return floor < this.floor;
    this.paused = 'Journal batch exceeds remaining history budget; replication paused';
    throw new TimescaleWritesPaused(this.paused);
  }
  recordBatch(bytes: number, rows: number) { this.unmeasured += bytes + rows * 512; }
}
