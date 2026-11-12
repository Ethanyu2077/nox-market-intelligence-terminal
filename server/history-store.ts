import {
  mkdir,
  readFile,
  rm,
  rename,
  statfs,
  writeFile,
} from "node:fs/promises";
import { historyLimits, JournalReaders, journalsToRetire, type StoredJournal } from "./history-retention.ts";
import { cleanupJournalPrefixTemp, reclaimJournalPrefix } from "./journal-prefix-reclaim.ts";
import { appendJournalBatch, IncompleteAppendTail } from "./journal-append.ts";
import { ArchiveSpaceError, archiveClosedJournals, cleanupAbandonedArchiveTemps, journalBytes, journalSegments, sealJournalForAppend, type JournalSegment } from "./journal-archive.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { HistoryBatchTooLarge, TimescaleRetention, TimescaleWritesPaused } from "./timescale-retention.ts";
import { storageLimit } from "./storage-limits.ts";
import { JOURNAL_APPEND_MAX_BYTES, JournalRecordError, parseJournalRecords } from "./journal-records.ts";
import type { MarketProject } from "../shared/types.ts";
export type { HistoryEvent } from "../shared/history.ts";
import type { HistoryEvent } from "../shared/history.ts";
import type {RegimeReport} from '../shared/regime-v2.ts';

const KINDS = ["trade", "liquidation", "snapshot", "regime", "volume", "alignment", "l2"] as const;
const COLLECTOR_RECOVERY_BYTES = 512 * 1024;
const isDailyJournal = (name: string) => /^\d{4}-\d{2}-\d{2}-[a-z0-9]+\.ndjson$/.test(name);
async function* completeTail(chunks: AsyncIterable<Buffer>) {
  let partial = true;
  for await (const chunk of chunks) {
    if (!partial) { yield chunk; continue; }
    const end = chunk.indexOf(10);
    if (end >= 0) { partial = false; yield chunk.subarray(end + 1); }
  }
}
function overlaps(file: JournalSegment, from: number, to: number, asOf: number) {
  return !(file.minTime !== undefined && file.minTime > to || file.maxTime !== undefined && file.maxTime < from ||
    isDailyJournal(file.name) && Date.parse(file.name.slice(0, 10)) > asOf);
}
type Link = {
  projectId: string;
  marketKey: string;
  from: number;
  to: number | null;
};
type Checkpoint = { offset: number; identity: string; birth?: number; rows: number };
type JournalRow = { event: HistoryEvent; offset: number; identity: string };
const REPLAY_BATCHES = 16;
const REPLAY_TURN_MS = 1_000;
class PartitionError extends Error {}
class JournalSourceError extends PartitionError {}
function safeCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,24}$/.test(code) ? code : "";
}
function checkpointFor(file: StoredJournal, saved: Record<string, Checkpoint>) {
  const checkpoint = saved[file.dbKey];
  if (checkpoint?.identity === file.identity &&
      // A mutable pathname can reuse an inode after restore. A legacy offset with
      // no birth time must be replayed before this generation can be retired.
      (checkpoint.birth === file.birth || file.key !== file.name && file.birth === undefined) &&
      Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= 0 && checkpoint.offset <= file.size)
    return checkpoint;
}
function resolveRotatedCheckpoints(
  files: (JournalSegment & { dbKey: string })[],
  saved: Record<string, Checkpoint>,
) {
  let resolved = saved;
  for (const file of files) {
    if (file.key === file.name || saved[file.dbKey]) continue;
    const plainKey = "history/" + file.name;
    const checkpoint = saved[plainKey];
    if (checkpoint?.identity !== file.identity) continue;
    if (resolved === saved) resolved = { ...saved };
    delete resolved[plainKey];
    // Older checkpoints identify the plain file by inode. If another generation
    // could own this offset, replay both idempotently from zero.
    const ambiguous = files.some(other => other.dbKey !== file.dbKey &&
      other.name === file.name && other.identity === file.identity &&
      (other.key === other.name || !saved[other.dbKey]));
    if (!ambiguous) resolved[file.dbKey] = checkpoint;
  }
  return resolved;
}
export interface HistoryQuery {
  source?:string;
  summarizeRegime?:boolean;
  regimeInterval?:string;
  priceOnly?:boolean;
  id?:string;
  kind: HistoryEvent["kind"];
  from?: number;
  to?: number;
  asOf?: number;
  marketKey?: string;
  limit?: number;
  cursor?: string;
  /** Collector restart hints may use a bounded tail of recent ingest-day journals. */
  collectorRecoverySince?: number;
  /** Cancel journal scans and active database reads on deadline or caller abort. */
  signal?: AbortSignal;
}
interface Position {
  time: number;
  id: string;
  asOf: number;
}
function decode(cursor?: string): Position | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as Position;
    if (
      !Number.isFinite(v.time) ||
      !Number.isFinite(v.asOf) ||
      typeof v.id !== "string" ||
      v.id.length > 500
    )
      throw new Error();
    return v;
  } catch {
    throw new Error("Invalid historical pagination cursor");
  }
}
const compare = (a: HistoryEvent, b: HistoryEvent) =>
  b.eventTime - a.eventTime ||
  Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));

/** Healthy TimescaleDB serves historical queries; partitioned journals are the retry buffer. */
export class HistoryStore {
  private queue = Promise.resolve();
  private batches = new Map<string, { lines: string[]; bytes: number; done: Promise<void> }>();
  private archiveWork?: Promise<void>;
  private measurementWork?: Promise<void>;
  private archiveTimer?: NodeJS.Timeout;
  private readonly limits = historyLimits();
  private readonly readers = new JournalReaders();
  private journalBytes = 0;
  private rawSizes = new Map<string,number>();
  private readonly segmentBytes: number;
  private freeBytes = 0;
  private stagingBytes = 0;
  private compressing?: JournalSegment;
  private queuedBytes = 0;
  private lastPressureCheck = -Infinity;
  private refusedRows = 0;
  private removedBytes = 0;
  private writeWarning: string | null = null;
  private retentionError: string | null = null;
  private archiveError: string | null = null;
  private timescaleRetention = new TimescaleRetention();
  private replicationPaused = false;
  private pool?: Pool;
  private checkpoints: Record<string, Checkpoint> = {};
  private syncWork?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private error: string | null = null;
  private connected = false;
  private readonly writes = {
    journalBatches: 0, journalRowsByKind: {} as Partial<Record<HistoryEvent["kind"], number>>,
    databaseInsertBatches: 0, databaseRowsInserted: 0, checkpointReplacements: 0,
  };
  private generation = 0;
  private replicatedGeneration = -1;
  private readonly lastAppend = new Map<HistoryEvent["kind"], number>();
  private links: Link[] = [];
  private publishedLinks?: Link[];
  private publishingLinks?: Promise<void>;
  private namespace: string;
  private databaseId: string | null = null;
  private verifiedDatabase = false;
  private nextPartition?: string;
  private catchupTimer?: NodeJS.Timeout;
  private closing = false;
  private capacity: {
    journalBytes: number;
    pendingBytes: number;
    acknowledgedFileBytes: number | null;
    byKind: Partial<Record<HistoryEvent["kind"], { journalBytes: number; pendingBytes: number }>>;
    freeBytes: number;
    warning: string | null;
    checkedAt: number;
  } | null = null;
  constructor(
    private directory: string,
    databaseUrl?: string,
    pool?: Pool,
  ) {
    const statementTimeout = Math.min(2_147_480_000, storageLimit("NOX_DB_STATEMENT_TIMEOUT_MS", 10_000));
    this.pool =
      pool ??
      (databaseUrl
        ? new Pool({
            connectionString: databaseUrl,
            max: 2,
            connectionTimeoutMillis: 3000,
            statement_timeout: statementTimeout,
            query_timeout: statementTimeout + 1_000,
          })
        : undefined);
    const workingSetBytes = this.pool ? this.limits.ackCacheBytes : this.limits.maxBytes;
    this.segmentBytes = Math.max(1, Math.min(64 * 1024 ** 2, Math.floor(workingSetBytes / 8)));
    this.namespace = createHash("sha256")
      .update(databaseUrl ?? (pool ? "injected" : "local"))
      .digest("hex")
      .slice(0, 16);
    this.pool?.on("error", () => {
      this.connected = false;
      this.verifiedDatabase = false;
      this.error = "Database connection lost";
    });
  }
  private get checkpointFile() {
    return path.join(
      this.directory,
      `history-checkpoints-${this.namespace}.json`,
    );
  }
  private get linksFile() {
    return path.join(this.directory, "project-market-links.json");
  }
  private async atomic(file: string, value: unknown) {
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    if (file === this.checkpointFile) this.writes.checkpointReplacements++;
  }
  private async load<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw e;
    }
  }
  async init() {
    const journalDir = path.join(this.directory, "history");
    await mkdir(journalDir, { recursive: true });
    await Promise.all([cleanupJournalPrefixTemp(journalDir), cleanupJournalPrefixTemp(this.directory)]);
    await cleanupAbandonedArchiveTemps(journalDir, name => isDailyJournal(name) && KINDS.some(kind => name.endsWith(`-${kind}.ndjson`)));
    const saved = await this.load<{
      databaseId: string | null;
      files: Record<string, Checkpoint>;
    }>(this.checkpointFile, { databaseId: null, files: {} });
    this.checkpoints = saved.files;
    this.databaseId = saved.databaseId;
    this.links = await this.load(this.linksFile, []);
    await this.measure();
    if (this.pool) await this.sync();
    await this.runRetentionMaintenance();
    this.timer = setInterval(() => {
      void this.sync();
      if (!this.measurementWork) {
        this.measurementWork = this.measure().then(() => {}, () => {})
          .finally(() => { this.measurementWork = undefined; });
      }
    }, 15_000);
    this.timer.unref();
    const archive = (maintain = false) => {
      if (this.archiveWork) return;
      this.archiveWork = (maintain ? this.runRetentionMaintenance().then(() => this.archive()) : this.archive())
        .then(() => { this.archiveError = null; })
        .catch(e => { this.archiveError = e instanceof ArchiveSpaceError ? e.message : "Cold journal maintenance failed; inspect storage"; })
        .finally(() => { this.archiveWork = undefined; });
    };
    archive();
    this.archiveTimer = setInterval(() => archive(true), 3_600_000);
    this.archiveTimer.unref();
  }
  async reconcileProjects(projects: MarketProject[], at = Date.now()) {
    const current = new Set(
      projects
        .filter((p) => !p.archived)
        .flatMap((p) =>
          p.markets.map(
            (m) => `${p.id}|${m.exchange}:${m.marketType}:${m.symbol}`,
          ),
        ),
    );
    const changed = await this.enqueue(async () => {
      const closed = new Set<Link>();
      const added = new Set(current);
      for (const link of this.links) {
        if (link.to !== null) continue;
        const key = `${link.projectId}|${link.marketKey}`;
        if (current.has(key)) added.delete(key);
        else closed.add(link);
      }
      if (!closed.size && !added.size) return false;
      const next = this.links.map(link => closed.has(link) ? { ...link, to: at } : link);
      for (const key of added) {
        const [projectId, marketKey] = key.split("|");
        next.push({projectId, marketKey, from: at, to: null});
      }
      await this.atomic(this.linksFile, next);
      this.links = next;
      return true;
    });
    // Shared events use membership intervals from the database. Publish an edit at
    // its source; a concurrent pass may already have captured the previous list.
    if (changed && this.pool) {
      const work = this.sync().then(() => {
        if (this.connected && this.publishedLinks !== this.links) return this.sync();
      });
      this.publishingLinks = work;
      try { await work; }
      finally { if (this.publishingLinks === work) this.publishingLinks = undefined; }
    }
  }
  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation);
    // A rejected append reports failure to its caller without breaking reads or subsequent batches.
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private refuse(rows: number, reason: string): never {
    this.refusedRows += rows;
    this.writeWarning = reason;
    throw new Error(reason);
  }
  private canFit(bytes: number) {
    return this.journalBytes + this.stagingBytes + bytes <= this.limits.maxBytes &&
      this.freeBytes - this.stagingBytes - bytes >= this.limits.reserveBytes;
  }
  private async runRetentionMaintenance() {
    try {
      await this.enqueue(() => this.enforceRetention(0));
      this.retentionError = null;
    } catch {
      // The last measured budget continues to gate writes; keep reads available during a cleanup failure.
      this.retentionError = "Journal retention failed; inspect storage";
    }
  }
  private async enforceRetention(incoming: number) {
    await this.readers.exclusive(async () => {
      const files = await this.files();
      await this.measureNow(files);
      const resolved = resolveRotatedCheckpoints(files, this.checkpoints);
      const identity = this.databaseId;
      const verified = () => this.verifiedDatabase && this.connected && this.databaseId === identity;
      // The compressor can be publishing either physical path of the same logical generation.
      const working = this.compressing;
      const available = (file: StoredJournal) => !(working?.name === file.name && working.identity === file.identity &&
        (working.birth === undefined || file.birth === undefined || working.birth === file.birth));
      const eligible = (file: StoredJournal) => available(file) && (!this.pool || verified() && checkpointFor(file,resolved)?.offset === file.size);
      const retire = journalsToRetire(files, eligible, this.limits, this.freeBytes, incoming + this.stagingBytes, Date.now(), verified());
      if (retire.length && this.pool) {
        // Forget offsets before unlink. A crash between these steps replays surviving rows idempotently.
        const retainedKeys = new Set(files.map(file => file.dbKey));
        for (const file of retire) retainedKeys.delete(file.dbKey);
        const remaining = Object.fromEntries(Object.entries(resolved).filter(([key]) => retainedKeys.has(key)));
        await this.atomic(this.checkpointFile, { databaseId: this.databaseId, files: remaining });
        this.checkpoints = remaining;
      }
      for (const file of retire) {
        if (this.pool && !verified()) break;
        // Remove secondary copies first: a crash leaves the authoritative sealed source.
        for (const name of [...(file.copies ?? []), file.file]) await rm(name, {force: true});
        this.journalBytes -= file.storedBytes;
        this.rawSizes.delete(file.file);
        this.removedBytes += file.storedBytes;
      }
      if (retire.length) {
        await this.measureNow();
        this.lastPressureCheck = -Infinity;
      }
      if (verified() && !this.canFit(incoming)) {
        // A legacy raw file can contain a large committed prefix and a small pending tail.
        // Recheck identity under the lock; rewriting a bounded suffix creates a fresh inode.
        const candidates = files.flatMap(file => {
          const saved = checkpointFor(file,resolved);
          return available(file) && file.key === file.name && saved && saved.offset > 0 && saved.offset < file.size
            ? [{file, saved}] : [];
        }).sort((a,b) => b.saved.offset - a.saved.offset);
        const scratch = Math.min(this.limits.maxBytes, this.freeBytes - this.limits.reserveBytes - this.stagingBytes - incoming);
        for (const {file,saved} of candidates) {
          const reclaimed = await reclaimJournalPrefix(file,saved,scratch,verified);
          if (!reclaimed) continue;
          this.removedBytes += reclaimed;
          await this.measureNow();
          this.lastPressureCheck = -Infinity;
          break;
        }
      }
      if (!this.canFit(0)) this.writeWarning = "History journal limit or disk reserve reached; persistence paused";
      else if (this.writeWarning === "History journal limit or disk reserve reached; persistence paused") this.writeWarning = null;
    });
  }
  private async seal(file: string) {
    await sealJournalForAppend(file, 1);
    this.rawSizes.delete(file);
    this.lastPressureCheck = -Infinity;
  }
  append(event: HistoryEvent) {
    if (
      !Number.isFinite(event.eventTime) ||
      !Number.isFinite(event.ingestTime) ||
      !KINDS.includes(event.kind)
    )
      return Promise.reject(new Error("Invalid history event"));
    const file = path.join(
      this.directory,
      "history",
      `${new Date(event.ingestTime).toISOString().slice(0, 10)}-${event.kind}.ndjson`,
    );
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limits.maxBytes || this.queuedBytes + bytes > Math.min(this.limits.maxBytes, JOURNAL_APPEND_MAX_BYTES)) {
      this.refusedRows++;
      this.writeWarning = "History journal append exceeds storage or in-flight byte limit";
      return Promise.reject(new Error(this.writeWarning));
    }
    this.queuedBytes += bytes;
    const current = this.batches.get(file);
    if (current && current.lines.length < 128 && current.bytes < 256 * 1024) {
      current.lines.push(line);
      current.bytes += bytes;
      return current.done;
    }
    // Share one write and acknowledgement across simultaneous events for the same partition.
    const ready = new Promise<void>(resolve => setImmediate(resolve));
    const batch = { lines: [line], bytes, done: Promise.resolve() };
    batch.done = this.enqueue(async () => {
      await ready;
      if (this.batches.get(file) === batch) this.batches.delete(file);
      try {
        // Seal by size as well as day: bursts within one UTC day can reclaim complete old segments.
        if (!this.pool && (this.rawSizes.get(file) ?? 0) > 0 && !this.canFit(batch.bytes)) await this.seal(file);
        if (!this.canFit(batch.bytes) && Date.now() - this.lastPressureCheck >= 1_000) {
          this.lastPressureCheck = Date.now();
          await this.enforceRetention(batch.bytes);
        }
        if (!this.canFit(batch.bytes))
          this.refuse(batch.lines.length, "History journal limit or disk reserve reached; persistence paused");
        const rawSize = this.rawSizes.get(file) ?? 0;
        if (rawSize > 0 && rawSize + batch.bytes > this.segmentBytes) await this.seal(file);
        const lines = batch.lines.join("");
        try { await appendJournalBatch(file, lines); }
        catch (error) {
          if (!(error instanceof IncompleteAppendTail)) throw error;
          // A torn tail is evidence. Keep its bytes and start new records in a separate generation.
          await this.seal(file);
          await appendJournalBatch(file, lines);
        }
        this.journalBytes += batch.bytes;
        this.rawSizes.set(file, (this.rawSizes.get(file) ?? 0) + batch.bytes);
        this.freeBytes -= batch.bytes;
        this.writeWarning = null;
        this.lastAppend.set(event.kind, ++this.generation);
        this.writes.journalBatches++;
        this.writes.journalRowsByKind[event.kind] = (this.writes.journalRowsByKind[event.kind] ?? 0) + batch.lines.length;
      } finally { this.queuedBytes -= batch.bytes; }
    });
    this.batches.set(file, batch);
    return batch.done;
  }
  private archive() {
    return archiveClosedJournals(path.join(this.directory, "history"), name => isDailyJournal(name) && KINDS.some(k => name.endsWith(`-${k}.ndjson`)), {
      indexTime: true,
      reserve: (requested, file) => this.enqueue(async () => {
        const headroom = Math.min(this.limits.maxBytes - this.journalBytes, this.freeBytes - this.limits.reserveBytes);
        // Leave half the remaining room available to live writes throughout compression.
        const bytes = Math.max(0, Math.min(requested, Math.floor(headroom / 2)));
        this.stagingBytes = bytes;
        this.compressing = file;
        return {bytes, release: () => {
          this.stagingBytes = 0;
          this.compressing = undefined;
          this.lastPressureCheck = -Infinity;
        }};
      }),
      rotate: (work) => {
        const rotation = this.queue.catch(() => {}).then(work);
        this.queue = rotation.catch(() => {});
        return rotation;
      },
    });
  }
  private async files(kind?: HistoryEvent["kind"], firstIngestDay?: string) {
    const kinds = kind ? [kind] : KINDS;
    const [legacy, daily] = await Promise.all([
      journalSegments(this.directory, name => kinds.some(k => name === `history-${k}.ndjson`)),
      journalSegments(path.join(this.directory, "history"), name =>
        isDailyJournal(name) && (!firstIngestDay || name.slice(0, 10) >= firstIngestDay) && kinds.some(k => name.endsWith(`-${k}.ndjson`))),
    ]);
    return [...legacy.map(item => ({...item, dbKey: item.key})), ...daily.map(item => ({...item, dbKey: "history/" + item.key}))];
  }
  private async queryFiles(kind: HistoryEvent["kind"], pending?: Record<string, Checkpoint>, firstIngestDay?: string) {
    const files = await this.files(kind, firstIngestDay);
    const saved = pending && resolveRotatedCheckpoints(files, pending);
    return files.map(file => {
      const start = saved ? checkpointFor(file,saved)?.offset ?? 0 : 0;
      return {...file, start};
    }).filter(file => file.start < file.size);
  }
  private events(file: JournalSegment, start = 0) {
    return parseJournalRecords(journalBytes(file, start), file.name, file.identity, start);
  }
  private async *queryRows(file: StoredJournal, start: number, onPartial?: (reason: string) => void) {
    if (!onPartial) {
      yield* this.events(file,start);
      return;
    }
    try { yield* this.partitionRows(file,start); }
    catch (error) {
      if (!(error instanceof JournalSourceError)) throw error;
      onPartial(error.message);
    }
  }
  async read(
    projectId: string,
    kind: HistoryEvent["kind"],
    asOf = Date.now(),
    limit = 5000,
  ) {
    const page = await this.page(projectId, { kind, asOf, limit });
    return page.items.reverse();
  }
  private pendingReadOffsets(kind: HistoryEvent["kind"]) {
    // Fresh writes are already durable in the outbox. A page can read that suffix
    // while the independent replication clock batches it for TimescaleDB.
    if (this.connected && (this.replicationPaused || this.replicatedGeneration < (this.lastAppend.get(kind) ?? 0)))
      return this.checkpoints;
  }
  async sampleSnapshots(projectId:string,size:number,asOf=Date.now()) {
    if(!Number.isFinite(size)||size<300_000)throw new Error('Invalid sample interval');
    await this.queue;
    return this.readers.read(() => this.readSnapshotSamples(projectId,size,asOf,this.pendingReadOffsets('snapshot')));
  }
  private async readSnapshotSamples(projectId: string, size: number, asOf: number, protectedOffsets?: Record<string,Checkpoint>) {
    const end=Math.floor((asOf-90_000)/size)*size,from=end-202*size-90_000;
    let pending = protectedOffsets;
    let databaseSamples: HistoryEvent[] = [];
    if(this.connected&&this.pool)try{
      const result=await this.pool.query(`SELECT DISTINCT ON (market_key,ceil(extract(epoch from event_time)*1000/$1)) id,kind,market_key AS "marketKey",project_id AS "projectId",extract(epoch from event_time)*1000 AS "eventTime",extract(epoch from ingest_time)*1000 AS "ingestTime",source,quality,payload FROM nox_history_events WHERE project_id=$2 AND kind='snapshot' AND event_time >= $3 AND event_time <= $4 AND ingest_time <= $5 AND ceil(extract(epoch from event_time)*1000/$1)*$1-extract(epoch from event_time)*1000 <= 90000 AND quality NOT IN ('stale','unavailable') ORDER BY market_key,ceil(extract(epoch from event_time)*1000/$1),event_time DESC,ingest_time DESC,id COLLATE "C" DESC`,[size,projectId,new Date(Math.max(0,from)),new Date(end),new Date(asOf)]);
      databaseSamples = result.rows.map(r=>({...r,eventTime:Number(r.eventTime),ingestTime:Number(r.ingestTime)})) as HistoryEvent[];
      if (!pending) return databaseSamples;
    }catch{pending=undefined;this.connected=false;this.error='Historical sampling query failed; local fallback';}
    const scan = async () => {
      const samples=new Map<string,HistoryEvent>();
      for (const e of databaseSamples) samples.set(`${e.marketKey}:${Math.ceil(e.eventTime/size)*size}`, e);
      for(const file of (await this.queryFiles('snapshot',pending)).filter(f => overlaps(f, from, end, asOf)))for await(const{event:e}of this.queryRows(file,file.start,pending ? reason => { this.error = reason; } : undefined)){
        if (pending && this.timescaleRetention.expired(e.eventTime)) continue;
        if(e.projectId!==projectId||e.eventTime<from||e.eventTime>end||e.ingestTime>asOf||['stale','unavailable'].includes(e.quality))continue;
        const boundary=Math.ceil(e.eventTime/size)*size;if(boundary-e.eventTime>90_000)continue;
        const k=`${e.marketKey}:${boundary}`,current=samples.get(k);
        if(!current||e.eventTime>current.eventTime||(e.eventTime===current.eventTime&&e.ingestTime>current.ingestTime))samples.set(k,e);
      }
      return [...samples.values()].sort((a,b)=>a.eventTime-b.eventTime);
    };
    return scan();
  }
  /** Runs one query on a dedicated connection and cancels it in PostgreSQL on abort. */
  private async queryWithCancel(text: string, values: unknown[], signal?: AbortSignal) {
    if (!this.pool) throw new Error('database unavailable');
    if (!signal) return this.pool.query(text, values);
    signal.throwIfAborted();
    const client = await this.pool.connect();
    const processId = (client as unknown as { processID?: number }).processID;
    let cancelling: Promise<unknown> | undefined;
    let discarded = false;
    let reusable = true;
    const onAbort = () => {
      // Never queue a cancellation behind the very reads occupying the pool.
      if (processId && this.pool && this.pool.idleCount > 0 && this.pool.waitingCount === 0) {
        cancelling = this.pool.query('SELECT pg_cancel_backend($1)', [processId]).catch(() => undefined);
      } else {
        discarded = true;
        client.release(true);
      }
    };
    const statementTimeout = Math.max(1_000, Number(process.env.NOX_DB_STATEMENT_TIMEOUT_MS ?? 10_000));
    try {
      signal.throwIfAborted();
      signal.addEventListener('abort', onAbort, { once: true });
      reusable = false;
      await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${Math.round(statementTimeout)}`);
      signal.throwIfAborted();
      const result = await client.query(text, values);
      signal.throwIfAborted();
      await client.query('COMMIT');
      signal.throwIfAborted();
      reusable = true;
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (cancelling) await cancelling;
      // A delayed backend signal must never hit the next reader of this session.
      if (!discarded) client.release(!reusable);
    }
  }

  async page(projectId: string, query: HistoryQuery) {
    await this.queue;
    if (this.publishingLinks) await this.publishingLinks;
    if (query.signal?.aborted) throw new Error('cancelled');
    const cursor = decode(query.cursor),
      asOf = query.asOf ?? cursor?.asOf ?? Date.now(),
      from = query.from ?? 0,
      to = Math.min(query.to ?? asOf, asOf),
      limit = Math.max(1, Math.min(query.limit ?? 200, 10_000));
    if (cursor && cursor.asOf !== asOf)
      throw new Error("Invalid historical cursor cutoff");
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      throw new Error("Invalid historical time range");
    // A concurrent replay may acknowledge and retire a pending partition after the
    // database SELECT. Pin local sources across both halves of a hybrid read.
    return this.readers.read(() => this.readPage(projectId, query, cursor, asOf, from, to, limit, this.pendingReadOffsets(query.kind)));
  }
  private async readPage(projectId: string, query: HistoryQuery, cursor: Position | null,
    asOf: number, from: number, to: number, limit: number, pending?: Record<string,Checkpoint>) {
    query.signal?.throwIfAborted();
    let rows: HistoryEvent[] = [],
      backend = "local-journal",
      fallback: string | null =
        this.pool && !this.connected ? this.error : null;
    if (this.connected && this.pool) {
      try {
        const payload=query.priceOnly&&query.kind==='snapshot'?"jsonb_build_object('price',e.payload->'price')":query.summarizeRegime?`CASE WHEN e.source='nox.regime.v2' THEN jsonb_set(e.payload,'{venues}',(SELECT coalesce(jsonb_agg((v #- '{input,snapshots}' #- '{input,perpBuckets}' #- '{input,spotBuckets}') || jsonb_build_object('inputSnapshotCount',coalesce(jsonb_array_length(v #> '{input,snapshots}'),0))),'[]'::jsonb) FROM jsonb_array_elements(e.payload->'venues') AS x(v))) ELSE e.payload END`:'e.payload';
        const result = await this.queryWithCancel(
          `SELECT e.id,e.kind,e.market_key AS "marketKey",e.project_id AS "projectId",extract(epoch from e.event_time)*1000 AS "eventTime",extract(epoch from e.ingest_time)*1000 AS "ingestTime",e.source,e.quality,${payload} AS payload
        FROM nox_history_events e WHERE e.kind=$1 AND e.event_time >= $2 AND e.event_time <= $3 AND e.ingest_time <= $4
        AND ($5::text IS NULL OR e.market_key=$5) AND (e.project_id=$6 OR (e.project_id IS NULL AND EXISTS (SELECT 1 FROM nox_project_market_links l WHERE l.project_id=$6 AND l.market_key=e.market_key AND e.ingest_time >= l.valid_from AND (l.valid_to IS NULL OR e.ingest_time < l.valid_to))))
        AND ($12::text IS NULL OR e.payload->>'interval'=$12) AND ($11::text IS NULL OR e.source=$11) AND ($10::text IS NULL OR e.id=$10) AND ($7::timestamptz IS NULL OR (e.event_time,e.id COLLATE "C") < ($7,$8::text COLLATE "C")) ORDER BY e.event_time DESC,e.id COLLATE "C" DESC LIMIT $9`,
          [
            query.kind,
            new Date(from),
            new Date(to),
            new Date(asOf),
            query.marketKey ?? null,
            projectId,
            cursor ? new Date(cursor.time) : null,
            cursor?.id ?? null,
            limit + 1,
            query.id??null,
            query.source??null,
            query.regimeInterval??null,
          ],
          query.signal,
        );
        rows = result.rows.map((r) => ({
          ...r,
          eventTime: Number(r.eventTime),
          ingestTime: Number(r.ingestTime),
        }));
        backend = "timescaledb";
        if (pending) fallback = this.error;
      } catch (error) {
        query.signal?.throwIfAborted();
        if (query.signal && safeCode(error) === '57014') throw new Error('history page timeout');
        this.connected = false;
        this.error = "Database query failed; explicit local fallback";
        fallback = this.error;
      }
    }
    const pendingOnly = backend === "timescaledb" ? pending : undefined;
    let collectorTailIncomplete = false;
    if (backend === "local-journal" || pendingOnly) {
      query.signal?.throwIfAborted();
      const scan = async () => {
        const keep = limit + 1; // The extra row proves whether a subsequent page exists.
        const matches = new Map<string, { event: HistoryEvent; fileOrder: number }>();
        for (const event of rows) matches.set(`${event.eventTime}:${event.id}`, { event, fileOrder: -1 });
        let cutoff: HistoryEvent | undefined;
        const trim = () => {
          if (matches.size < keep || (matches.size === keep && cutoff)) return;
          const ordered = [...matches.entries()].sort((a, b) => compare(a[1].event, b[1].event));
          cutoff = ordered[keep - 1][1].event;
          for (let i = keep; i < ordered.length; i++) matches.delete(ordered[i][0]);
        };
        // Scan hot/unindexed files first. Only measured event-time bounds can exclude a cold file.
        trim();
        const firstIngestDay = query.collectorRecoverySince === undefined ? undefined
          : new Date(query.collectorRecoverySince).toISOString().slice(0, 10);
        const recovery = firstIngestDay !== undefined;
        let remaining = COLLECTOR_RECOVERY_BYTES;
        const files = (await this.queryFiles(query.kind,pendingOnly,firstIngestDay))
          .map((file, order) => ({ file, order, maxTime: file.maxTime ?? Infinity }))
          .filter(({ file }) => overlaps(file, from, Math.min(to, cursor?.time ?? to), asOf))
          .sort((a, b) => recovery || a.maxTime === b.maxTime ? b.order - a.order : b.maxTime - a.maxTime);
        for (const { file, order, maxTime } of files) {
          if (query.signal?.aborted) throw new Error('cancelled');
          if (!recovery && cutoff && maxTime < cutoff.eventTime) break;
          let records = this.queryRows(file,file.start,pendingOnly ? reason => { fallback = reason; } : undefined);
          if (recovery) {
            if (!remaining) { collectorTailIncomplete = true; break; }
            // Gzip has to decompress from the beginning even for a suffix read.
            if (file.compressed && file.size > remaining) { collectorTailIncomplete = true; continue; }
            const offset = Math.max(file.start, file.size - remaining);
            if (file.size > remaining) collectorTailIncomplete = true;
            const chunks = journalBytes(file, offset, remaining);
            records = parseJournalRecords(offset > file.start ? completeTail(chunks) : chunks, file.name, file.identity);
            remaining -= file.compressed ? file.size : file.size - offset;
          }
          for await (const { event: e } of records) {
            query.signal?.throwIfAborted();
            if (pendingOnly && this.timescaleRetention.expired(e.eventTime)) continue;
            if (cutoff && e.eventTime < cutoff.eventTime) continue;
            const belongs =
              e.projectId === projectId ||
              (e.projectId == null &&
                this.links.some(
                  (l) =>
                    l.projectId === projectId &&
                    l.marketKey === e.marketKey &&
                    e.ingestTime >= l.from &&
                    (l.to == null || e.ingestTime < l.to),
                ));
            if (
              !belongs ||
              e.eventTime < from ||
              e.eventTime > to ||
              e.ingestTime > asOf ||
              (query.marketKey && e.marketKey !== query.marketKey) || (query.id && e.id!==query.id) || (query.source && e.source!==query.source) || (query.regimeInterval&&(e.payload as RegimeReport).interval!==query.regimeInterval) ||
              (cursor &&
                !(
                  e.eventTime < cursor.time ||
                  (e.eventTime === cursor.time &&
                    Buffer.compare(Buffer.from(e.id), Buffer.from(cursor.id)) < 0)
                ))
            )
              continue;
            if (cutoff && e.eventTime === cutoff.eventTime && compare(e, cutoff) > 0) continue;
            const key = `${e.eventTime}:${e.id}`;
            // Returning to canonical file order on a tie preserves the original first-written payload.
            if (order < (matches.get(key)?.fileOrder ?? Infinity)) {
              let event = e;
              if (query.priceOnly && e.kind === 'snapshot') {
                event = { ...e, payload: { price: (e.payload as { price: number | null }).price } };
              } else if (query.summarizeRegime && e.source === 'nox.regime.v2') {
                const report = e.payload as RegimeReport;
                event = { ...e, payload: { ...report, venues: report.venues.map(venue => ({
                  ...venue,
                  inputSnapshotCount: venue.input.snapshots?.length ?? venue.inputSnapshotCount ?? 0,
                  input: { ...venue.input, snapshots: [], perpBuckets: [], spotBuckets: [] },
                })) } };
              }
              matches.set(key, { event, fileOrder: order });
            }
            if (matches.size >= 2 * keep) trim();
          }
          trim();
        }
        return [...matches.values()].map(match => match.event).sort(compare);
      };
      rows = await scan();
    }
    const more = rows.length > limit,
      items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      ...(query.collectorRecoverySince !== undefined ? {collectorTailIncomplete} : {}),
      backend,
      fallback,
      asOf,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ time: last.eventTime, id: last.id, asOf }),
            ).toString("base64url")
          : null,
      localScan: backend === "local-journal" || !!pendingOnly,
    };
  }
  sync() {
    if (!this.pool) return Promise.resolve();
    if (!this.syncWork)
      this.syncWork = this.replicate().finally(() => {
        this.syncWork = undefined;
      });
    return this.syncWork;
  }
  // A failure reading a partition must never advance past the offending bytes.
  // Scope it to the source so other partitions can still drain.
  private async *partitionRows(file: StoredJournal, start: number, rewind?: () => Promise<void>): AsyncGenerator<JournalRow> {
    let offset = start;
    try {
      for await (const row of this.events(file, start)) {
        offset = row.offset;
        yield row;
      }
    } catch (error) {
      if (start > 0 && error instanceof JournalRecordError && error.offset === start) {
        // Only inspect the preceding byte after a decode failure. Healthy gzip
        // resumes avoid a second pass through their compressed prefix.
        let insideRecord = false;
        try {
          for await (const chunk of journalBytes(file,start - 1)) {
            insideRecord = chunk[0] !== 10;
            break;
          }
        } catch { /* Keep the original partition error if its boundary cannot be verified. */ }
        if (insideRecord) {
          await rewind?.();
          yield* this.partitionRows(file,0);
          return;
        }
      }
      const detail = error instanceof JournalRecordError ? error.message :
        `Journal read failed at byte ${offset} ${safeCode(error)}`.trimEnd();
      throw new JournalSourceError(`${file.dbKey}: ${detail}`);
    }
  }

  // Split only deterministic data/constraint failures. Stage each committed prefix;
  // the bounded replay pass publishes all its byte offsets together before releasing its lease.
  private async commitRows(client: PoolClient, identity: string, file: StoredJournal, rows: JournalRow[], start: number): Promise<void> {
    if (!rows.length) return;
    await this.timescaleRetention.check(client, identity);
    let bytes = 0, offset = start;
    const accepted = rows.filter(row => {
      const keep = !this.timescaleRetention.expired(row.event.eventTime);
      if (keep) bytes += row.offset - offset;
      offset = row.offset;
      return keep;
    });
    if (accepted.length) {
      try {
        if (await this.timescaleRetention.admitBatch(client, identity, bytes, accepted.length)) {
          return this.commitRows(client, identity, file, rows, start);
        }
      } catch (error) {
        if (!(error instanceof HistoryBatchTooLarge)) throw error;
        return this.splitRejectedBatch(client, identity, file, rows, start, error.message);
      }
      const values: unknown[] = [];
      const tuples = accepted.map(({event: e}) => {
        const first = values.length;
        values.push(e.id,e.kind,e.marketKey,e.projectId,new Date(e.eventTime),new Date(e.ingestTime),e.source,e.quality,JSON.stringify(e.payload));
        return "(" + Array.from({length:9}, (_, i) => "$" + (first+i+1)).join(",") + ")";
      });
      await client.query("BEGIN");
      let inserted = 0;
      try {
        const result = await client.query(
          "INSERT INTO nox_history_events (id,kind,market_key,project_id,event_time,ingest_time,source,quality,payload) VALUES " +
          tuples.join(",") + " ON CONFLICT (event_time,id) DO NOTHING", values,
        );
        inserted = result.rowCount ?? 0;
      } catch (error) {
        await client.query("ROLLBACK");
        const code = safeCode(error);
        if (!/^(22|23)/.test(code)) throw error;
        return this.splitRejectedBatch(client,identity,file,rows,start,`SQLSTATE ${code}`);
      }
      try { await client.query("COMMIT"); }
      catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      this.writes.databaseInsertBatches++;
      this.writes.databaseRowsInserted += inserted;
      this.timescaleRetention.recordBatch(bytes, accepted.length);
    }
    const checkpoint = checkpointFor(file, this.checkpoints);
    this.checkpoints = { ...this.checkpoints, [file.dbKey]: {
      offset, identity: file.identity, birth: file.birth, rows: (checkpoint?.rows ?? 0) + accepted.length,
    }};
  }

  private async splitRejectedBatch(client: PoolClient, identity: string, file: StoredJournal, rows: JournalRow[], start: number, reason: string) {
    if (rows.length === 1) throw new PartitionError(`${file.dbKey}: history row rejected at byte ${start} (${reason})`);
    const mid = Math.floor(rows.length / 2);
    await this.commitRows(client,identity,file,rows.slice(0,mid),start);
    await this.commitRows(client,identity,file,rows.slice(mid),rows[mid-1].offset);
  }

  private async syncMarketLinks(client: PoolClient, links: Link[]) {
    if (!links.length) return;
    const values = [
      links.map(l => l.projectId), links.map(l => l.marketKey),
      links.map(l => new Date(l.from)), links.map(l => l.to == null ? null : new Date(l.to)),
    ];
    // A read-only comparison also detects a partially restored membership table
    // with its original database identity. Only changed intervals reach an INSERT.
    const input = `SELECT DISTINCT ON (project_id, market_key, valid_from) project_id, market_key, valid_from, valid_to
      FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
        WITH ORDINALITY AS input(project_id, market_key, valid_from, valid_to, seq)
      ORDER BY project_id, market_key, valid_from, seq DESC`;
    const difference = `SELECT l.project_id, l.market_key, l.valid_from, l.valid_to FROM (${input}) l
      WHERE NOT EXISTS (SELECT 1 FROM nox_project_market_links old
        WHERE (old.project_id, old.market_key, old.valid_from) = (l.project_id, l.market_key, l.valid_from)
          AND old.valid_to IS NOT DISTINCT FROM l.valid_to)`;
    const check = await client.query(difference + ' LIMIT 1', values);
    if (!check.rows.length) return;
    await client.query(`INSERT INTO nox_project_market_links AS stored (project_id, market_key, valid_from, valid_to)
      ${difference}
      ON CONFLICT (project_id, market_key, valid_from) DO UPDATE SET valid_to = EXCLUDED.valid_to
      WHERE stored.valid_to IS DISTINCT FROM EXCLUDED.valid_to`, values);
  }

  private async replicate() {
    let stage = "connecting to TimescaleDB";
    let more = false, batches = 0, reclaimCache = false;
    try {
      await this.queue;
      await this.readers.read(async () => {
        this.verifiedDatabase = false;
        const client = await this.pool!.connect();
        const previousOffsets = this.checkpoints, previousIdentity = this.databaseId;
        let reusable = true;
        let failure: {error: unknown} | undefined;
        try {
          stage = "checking TimescaleDB extension";
          if (
            !(
              await client.query(
                "SELECT 1 FROM pg_extension WHERE extname='timescaledb'",
              )
            ).rowCount
          )
            throw new Error("TimescaleDB extension missing");
          stage = "checking history database identity";
          const identity = (
            await client.query(
              "SELECT store_id FROM nox_history_storage_meta WHERE singleton=true",
            )
          ).rows[0]?.store_id as string | undefined;
          if (!identity) throw new Error("Database identity migration missing");
          if (this.databaseId !== identity) {
            this.checkpoints = {};
            this.databaseId = identity;
            this.nextPartition = undefined;
            this.replicatedGeneration = -1;
          }
          this.verifiedDatabase = true;
          stage = "replicating project market links";
          const links = this.links;
          await this.syncMarketLinks(client, links);
          this.publishedLinks = links;
          stage = "checking history retention";
          await this.timescaleRetention.check(client, identity);
          stage = "listing history partitions";
          const generation = this.generation;
          const files = await this.files();
          let resolved = resolveRotatedCheckpoints(files, this.checkpoints);
          // A restored volume can have checkpoints for partitions it no longer contains.
          const present = new Set(files.map(file => file.dbKey));
          if (Object.keys(resolved).some(key => !present.has(key)))
            resolved = Object.fromEntries(Object.entries(resolved).filter(([key]) => present.has(key)));
          this.checkpoints = resolved;
          const remaining = files.filter(f => (checkpointFor(f,this.checkpoints)?.offset ?? 0) < f.size);
          const next = remaining.findIndex(f => f.dbKey === this.nextPartition);
          const pending = next > 0 ? remaining.slice(next).concat(remaining.slice(0,next)) : remaining;
          this.nextPartition = undefined;
          const deadline = Date.now() + REPLAY_TURN_MS;
          let blocked = 0, firstError = "";
          for (const [i,file] of pending.entries()) {
            let start = checkpointFor(file,this.checkpoints)?.offset ?? 0;
            stage = `replicating ${file.dbKey} at byte ${start}`;
            let batch: JournalRow[] = [];
            const flush = async () => {
              if (!batch.length) return;
              await this.commitRows(client, identity, file, batch, start);
              start = batch[batch.length-1].offset;
              stage = `replicating ${file.dbKey} at byte ${start}`;
              batches++;
              batch = [];
            };
            try {
              try {
                const rewind = async () => {
                  const corrected = {...this.checkpoints};
                  delete corrected[file.dbKey];
                  this.checkpoints = corrected;
                  start = 0;
                };
                for await (const row of this.partitionRows(file,start,rewind)) {
                  batch.push(row);
                  // Validate decompression/CRC through EOF before acknowledging the final record.
                  if (row.offset < file.size && (batch.length >= 250 || row.offset-start >= this.timescaleRetention.batchBytes)) {
                    await flush();
                    if (batches >= REPLAY_BATCHES || Date.now() >= deadline) {
                      this.nextPartition = file.dbKey;
                      break;
                    }
                  }
                }
              } catch (error) {
                if (!(error instanceof PartitionError)) throw error;
                // On a failed archive checksum, the final record is never acknowledged.
                if (batch.at(-1)?.offset === file.size) batch.pop();
                // A failed SQL batch has already isolated and acknowledged its valid prefix.
                if (error instanceof JournalSourceError) await flush();
                throw error;
              }
              await flush();
            } catch (error) {
              if (!(error instanceof PartitionError)) throw error;
              blocked++;
              firstError ||= error.message;
            }
            if (!this.nextPartition && i+1 < pending.length && (batches >= REPLAY_BATCHES || Date.now() >= deadline))
              this.nextPartition = pending[i+1].dbKey;
            if (this.nextPartition) { more = true; break; }
          }
          if (!this.connected || batches > 0) this.lastPressureCheck = -Infinity;
          this.connected = true;
          this.replicationPaused = !!blocked || more;
          if (!this.replicationPaused) this.replicatedGeneration = generation;
          this.error = blocked ? `Journal recovery pending (${blocked} partitions in this pass): ${firstError}` :
            more ? "History replication catching up; pending rows available locally" : null;
          if (this.journalBytes > this.limits.ackCacheBytes) {
            const cached = files.reduce((sum, file) =>
              sum + (checkpointFor(file, this.checkpoints)?.offset === file.size ? file.storedBytes : 0), 0);
            reclaimCache = cached > this.limits.ackCacheBytes;
          }
        } catch (error) {
          // A lost response can leave a server-side transaction open. Discard the session before retrying.
          reusable = error instanceof TimescaleWritesPaused;
          failure = {error};
        } finally {
          client.release(!reusable);
        }
        if (this.checkpoints !== previousOffsets || this.databaseId !== previousIdentity) {
          try {
            // A crash before rename replays the committed prefix via ON CONFLICT.
            await this.atomic(this.checkpointFile, {databaseId: this.databaseId, files: this.checkpoints});
          } catch (error) {
            this.checkpoints = this.databaseId === previousIdentity ? previousOffsets : {};
            this.replicatedGeneration = -1;
            stage = 'saving history replay offsets';
            throw error;
          }
        }
        if (failure) throw failure.error;
      });
    } catch (error) {
      if (error instanceof TimescaleWritesPaused) {
        // The database can still serve existing history while the bounded journal holds new writes.
        this.connected = true;
        this.error = error.message;
        this.replicationPaused = true;
      } else {
        this.replicationPaused = false;
        this.connected = false;
        this.error = `History sync failed while ${stage}${safeCode(error) ? " (" + safeCode(error) + ")" : ""}; local history retained`;
      }
    }
    if (this.verifiedDatabase && (reclaimCache || !this.canFit(0))) await this.runRetentionMaintenance();
    if (more && batches > 0 && !this.closing && !this.catchupTimer) {
      this.catchupTimer = setTimeout(() => {
        this.catchupTimer = undefined;
        void this.sync();
      }, 100);
      this.catchupTimer.unref();
    }
  }
  measure() {
    return this.enqueue(() => this.measureNow());
  }
  private async measureNow(listed?: StoredJournal[]) {
    let journalBytes = 0,
      pendingBytes = 0, confirmed = 0;
    const byKind: NonNullable<typeof this.capacity>["byKind"] = {};
    const files = listed ?? await this.files();
    const checkpoints = resolveRotatedCheckpoints(files, this.checkpoints);
    for (const file of files) {
      const saved = checkpointFor(file,checkpoints);
      const pending = file.size - (saved?.offset ?? 0);
      if (saved?.offset === file.size) confirmed += file.storedBytes;
      journalBytes += file.storedBytes;
      pendingBytes += pending;
      const kind = KINDS.find(kind => file.name.endsWith(`-${kind}.ndjson`));
      if (kind) {
        const total = byKind[kind] ??= { journalBytes: 0, pendingBytes: 0 };
        total.journalBytes += file.storedBytes;
        total.pendingBytes += pending;
      }
    }
    const fs = await statfs(this.directory),
      freeBytes = fs.bavail * fs.bsize,
      threshold = Number(process.env.NOX_DISK_WARNING_BYTES ?? 5 * 1024 ** 3);
    this.rawSizes = new Map(files.filter(f => f.key === f.name).map(f => [f.file, f.size]));
    this.journalBytes = journalBytes;
    this.freeBytes = freeBytes;
    this.capacity = {
      journalBytes,
      pendingBytes,
      acknowledgedFileBytes: this.verifiedDatabase && this.connected ? confirmed : null,
      byKind,
      freeBytes,
      warning:
        freeBytes < threshold
          ? "Low disk space; operator action required"
          : null,
      checkedAt: Date.now(),
    };
    return this.capacity;
  }
  status() {
    return {
      mode: this.pool ? "timescaledb-with-local-outbox" : "local-journal",
      connected: this.connected,
      writes: { ...this.writes, journalRowsByKind: { ...this.writes.journalRowsByKind } },
      error: this.error,
      timescaleRetention: this.pool ? this.timescaleRetention.status() : null,
      databaseRowsAcknowledged: Object.values(this.checkpoints).reduce(
        (a, b) => a + b.rows,
        0,
      ),
      queryBackend: this.connected ? "timescaledb" : "local-journal",
      checkpoint: "persistent-byte-offset",
      partitioning: "UTC ingest date",
      capacity: this.capacity && { ...this.capacity,
        acknowledgedFileBytes: this.verifiedDatabase && this.connected ? this.capacity.acknowledgedFileBytes : null },
      retention: {
        ...this.limits, ackCacheBytes: this.pool ? this.limits.ackCacheBytes : null,
        journalBytes: this.journalBytes, stagingBytes: this.stagingBytes, queuedBytes: this.queuedBytes,
        refusedRows: this.refusedRows, retiredBytes: this.removedBytes, warning: this.writeWarning, error: this.retentionError,
      },
      archiveError: this.archiveError,
    };
  }
  async close() {
    this.closing = true;
    if (this.catchupTimer) clearTimeout(this.catchupTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    await this.measurementWork;
    await this.archiveWork;
    await this.queue;
    await this.sync();
    await this.pool?.end();
  }
}
