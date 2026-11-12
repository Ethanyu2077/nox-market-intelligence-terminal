import {
  mkdir,
  readFile,
  rm,
  rename,
  statfs,
  writeFile,
} from "node:fs/promises";
import { historyLimits, JournalReaders, journalsToRetire } from "./history-retention.ts";
import { appendJournalBatch } from "./journal-append.ts";
import { ArchiveSpaceError, archiveClosedJournals, cleanupAbandonedArchiveTemps, journalBytes, journalSegments, sealJournalForAppend, type JournalSegment } from "./journal-archive.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { TimescaleRetention, TimescaleWritesPaused } from "./timescale-retention.ts";
import type { MarketProject } from "../shared/types.ts";
export type { HistoryEvent } from "../shared/history.ts";
import type { HistoryEvent } from "../shared/history.ts";
import type {RegimeReport} from '../shared/regime-v2.ts';

const KINDS = ["trade", "liquidation", "snapshot", "regime", "volume", "alignment", "l2"] as const;
const isDailyJournal = (name: string) => /^\d{4}-\d{2}-\d{2}-[a-z0-9]+\.ndjson$/.test(name);
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
type Checkpoint = { offset: number; identity: string; rows: number };
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
  /** Cooperative cancellation for long queries; DB-side via pg_cancel_backend. */
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
  private archiveTimer?: NodeJS.Timeout;
  private readonly limits = historyLimits();
  private readonly readers = new JournalReaders();
  private journalBytes = 0;
  private rawSizes = new Map<string,number>();
  private readonly segmentBytes = Math.max(1, Math.min(64 * 1024 ** 2, Math.floor(this.limits.maxBytes / 8)));
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
  private generation = 0;
  private replicatedGeneration = -1;
  private links: Link[] = [];
  private namespace: string;
  private databaseId: string | null = null;
  private capacity: {
    journalBytes: number;
    pendingBytes: number;
    freeBytes: number;
    warning: string | null;
    checkedAt: number;
  } | null = null;
  constructor(
    private directory: string,
    databaseUrl?: string,
    pool?: Pool,
  ) {
    this.pool =
      pool ??
      (databaseUrl
        ? new Pool({
            connectionString: databaseUrl,
            max: 2,
            connectionTimeoutMillis: 3000,
          })
        : undefined);
    this.namespace = createHash("sha256")
      .update(databaseUrl ?? (pool ? "injected" : "local"))
      .digest("hex")
      .slice(0, 16);
    this.pool?.on("error", () => {
      this.connected = false;
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
      void this.measure().catch(() => {});
    }, 15_000);
    this.timer.unref();
    const archive = () => {
      if (this.archiveWork) return;
      this.archiveWork = this.archive().then(() => { this.archiveError = null; })
        .catch(e => { this.archiveError = e instanceof ArchiveSpaceError ? e.message : "Cold journal maintenance failed; inspect storage"; })
        .finally(() => { this.archiveWork = undefined; });
    };
    archive();
    this.archiveTimer = setInterval(() => {
      void this.runRetentionMaintenance().then(archive);
    }, 3_600_000);
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
    let changed = false;
    for (const l of this.links)
      if (l.to == null && !current.has(`${l.projectId}|${l.marketKey}`)) {
        l.to = at;
        changed = true;
      }
    for (const key of current) {
      const [projectId, marketKey] = key.split("|");
      if (
        !this.links.some(
          (l) =>
            l.projectId === projectId &&
            l.marketKey === marketKey &&
            l.to == null,
        )
      ) {
        this.links.push({ projectId, marketKey, from: at, to: null });
        changed = true;
      }
    }
    if (changed) {
      this.generation++;
      const saved = structuredClone(this.links);
      await this.enqueue(() => this.atomic(this.linksFile, saved));
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
      const fs = await statfs(this.directory);
      this.rawSizes = new Map(files.filter(f => f.key === f.name).map(f => [f.file, f.size]));
      this.journalBytes = files.reduce((sum, file) => sum + file.storedBytes, 0);
      this.freeBytes = fs.bavail * fs.bsize;
      const resolved = resolveRotatedCheckpoints(files, this.checkpoints);
      const eligible = (file: typeof files[number]) => {
        // Its compressor may be publishing a new physical path; unrelated partitions remain reclaimable.
        const working = this.compressing;
        if (working?.name === file.name && working.identity === file.identity &&
            (working.birth === undefined || file.birth === undefined || working.birth === file.birth)) return false;
        if (!this.pool) return true;
        const ack = resolved[file.dbKey];
        return this.connected && !!this.databaseId && ack?.identity === file.identity && ack.offset === file.size;
      };
      const retire = journalsToRetire(files, eligible, this.limits, this.freeBytes, incoming + this.stagingBytes, Date.now());
      if (!retire.length) {
        if (!this.canFit(0)) this.writeWarning = "History journal limit or disk reserve reached; persistence paused";
        return;
      }
      if (this.pool) {
        // Forget offsets before unlink. A crash between these steps replays surviving rows idempotently.
        const retainedKeys = new Set(files.map(file => file.dbKey));
        for (const file of retire) retainedKeys.delete(file.dbKey);
        const remaining = Object.fromEntries(Object.entries(resolved).filter(([key]) => retainedKeys.has(key)));
        await this.atomic(this.checkpointFile, { databaseId: this.databaseId, files: remaining });
        this.checkpoints = remaining;
      }
      for (const file of retire) {
        // Remove secondary copies first: a crash leaves the authoritative sealed source.
        for (const name of [...(file.copies ?? []), file.file]) await rm(name, {force: true});
        this.journalBytes -= file.storedBytes;
        this.rawSizes.delete(file.file);
        this.removedBytes += file.storedBytes;
      }
      const after = await statfs(this.directory);
      this.freeBytes = after.bavail * after.bsize;
      if (!this.canFit(0)) this.writeWarning = "History journal limit or disk reserve reached; persistence paused";
      this.lastPressureCheck = -Infinity;
    });
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
    if (bytes > this.limits.maxBytes || this.queuedBytes + bytes > Math.min(this.limits.maxBytes, 16 * 1024 ** 2)) {
      this.refusedRows++;
      this.writeWarning = "History journal append exceeds storage or in-flight byte limit";
      return Promise.reject(new Error(this.writeWarning));
    }
    this.queuedBytes += bytes;
    const current = this.batches.get(file);
    this.generation++;
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
        const rawSize = this.rawSizes.get(file) ?? 0;
        if (rawSize > 0 && (rawSize + batch.bytes > this.segmentBytes || !this.canFit(batch.bytes))) {
          await sealJournalForAppend(file, 1);
          this.rawSizes.delete(file);
          this.lastPressureCheck = -Infinity;
        }
        if (!this.canFit(batch.bytes) && Date.now() - this.lastPressureCheck >= 1_000) {
          this.lastPressureCheck = Date.now();
          await this.enforceRetention(batch.bytes);
        }
        if (!this.canFit(batch.bytes))
          this.refuse(batch.lines.length, "History journal limit or disk reserve reached; persistence paused");
        await appendJournalBatch(file, batch.lines.join(""));
        this.journalBytes += batch.bytes;
        this.rawSizes.set(file, (this.rawSizes.get(file) ?? 0) + batch.bytes);
        this.freeBytes -= batch.bytes;
        this.writeWarning = null;
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
  private async files(kind?: HistoryEvent["kind"]) {
    const kinds = kind ? [kind] : KINDS;
    const [legacy, daily] = await Promise.all([
      journalSegments(this.directory, name => kinds.some(k => name === `history-${k}.ndjson`)),
      journalSegments(path.join(this.directory, "history"), name =>
        isDailyJournal(name) && kinds.some(k => name.endsWith(`-${k}.ndjson`))),
    ]);
    return [...legacy.map(item => ({...item, dbKey: item.key})), ...daily.map(item => ({...item, dbKey: "history/" + item.key}))];
  }
  private async queryFiles(kind: HistoryEvent["kind"], pending?: Record<string, Checkpoint>) {
    const files = await this.files(kind);
    const saved = pending && resolveRotatedCheckpoints(files, pending);
    return files.map(file => {
      const checkpoint = saved?.[file.dbKey];
      const start = checkpoint?.identity === file.identity ? checkpoint.offset : 0;
      return {...file, start};
    }).filter(file => file.start < file.size);
  }
  private async *events(file: JournalSegment, start = 0) {
    let pending = Buffer.alloc(0),
      offset = start;
    for await (const chunk of journalBytes(file, start)) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end).toString("utf8");
        offset += end + 1;
        pending = pending.subarray(end + 1);
        let event: HistoryEvent;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error(
            `Corrupt journal ${file.name} at byte ${offset}; not overwritten`,
          );
        }
        yield { event, offset, identity: file.identity };
      }
    }
    if (pending.length)
      throw new Error(
        `Incomplete journal tail in ${file.name}; recovery required`,
      );
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
  async sampleSnapshots(projectId:string,size:number,asOf=Date.now()) {
    if(!Number.isFinite(size)||size<300_000)throw new Error('Invalid sample interval');
    await this.queue;if(this.pool)await this.sync();
    const end=Math.floor((asOf-90_000)/size)*size,from=end-202*size-90_000;
    let pending = this.replicationPaused ? this.checkpoints : undefined;
    let databaseSamples: HistoryEvent[] = [];
    if(this.connected&&this.pool)try{
      const result=await this.pool.query(`SELECT DISTINCT ON (market_key,ceil(extract(epoch from event_time)*1000/$1)) id,kind,market_key AS "marketKey",project_id AS "projectId",extract(epoch from event_time)*1000 AS "eventTime",extract(epoch from ingest_time)*1000 AS "ingestTime",source,quality,payload FROM nox_history_events WHERE project_id=$2 AND kind='snapshot' AND event_time >= $3 AND event_time <= $4 AND ingest_time <= $5 AND ceil(extract(epoch from event_time)*1000/$1)*$1-extract(epoch from event_time)*1000 <= 90000 AND quality NOT IN ('stale','unavailable') ORDER BY market_key,ceil(extract(epoch from event_time)*1000/$1),event_time DESC,ingest_time DESC,id COLLATE "C" DESC`,[size,projectId,new Date(Math.max(0,from)),new Date(end),new Date(asOf)]);
      databaseSamples = result.rows.map(r=>({...r,eventTime:Number(r.eventTime),ingestTime:Number(r.ingestTime)})) as HistoryEvent[];
      if (!pending) return databaseSamples;
    }catch{pending=undefined;this.connected=false;this.error='Historical sampling query failed; local fallback';}
    return this.readers.read(async () => {
      const samples=new Map<string,HistoryEvent>();
      for (const e of databaseSamples) samples.set(`${e.marketKey}:${Math.ceil(e.eventTime/size)*size}`, e);
      for(const file of (await this.queryFiles('snapshot',pending)).filter(f => overlaps(f, from, end, asOf)))for await(const{event:e}of this.events(file,file.start)){
        if (pending && this.timescaleRetention.expired(e.eventTime)) continue;
        if(e.projectId!==projectId||e.eventTime<from||e.eventTime>end||e.ingestTime>asOf||['stale','unavailable'].includes(e.quality))continue;
        const boundary=Math.ceil(e.eventTime/size)*size;if(boundary-e.eventTime>90_000)continue;
        const k=`${e.marketKey}:${boundary}`,current=samples.get(k);
        if(!current||e.eventTime>current.eventTime||(e.eventTime===current.eventTime&&e.ingestTime>current.ingestTime))samples.set(k,e);
      }
      return [...samples.values()].sort((a,b)=>a.eventTime-b.eventTime);
    });
  }
  /** Runs one query on a dedicated connection and cancels it in PostgreSQL on abort. */
  private async queryWithCancel(text: string, values: unknown[], signal?: AbortSignal) {
    if (!this.pool) throw new Error('database unavailable');
    if (!signal) return this.pool.query(text, values);
    if (signal.aborted) throw new Error('cancelled');
    const client = await this.pool.connect();
    const processId = (client as unknown as { processID?: number }).processID;
    const onAbort = () => {
      if (!processId) return;
      // Cancel the server-side statement instead of merely dropping the promise.
      void this.pool?.query('SELECT pg_cancel_backend($1)', [processId]).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const statementTimeout = Math.max(1_000, Number(process.env.NOX_DB_STATEMENT_TIMEOUT_MS ?? 10_000));
    try {
      await client.query(`SET statement_timeout = ${Math.round(statementTimeout)}`);
      return await client.query(text, values);
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.release();
    }
  }

  async page(projectId: string, query: HistoryQuery) {
    await this.queue;
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
    const requiredGeneration = this.generation;
    if (this.pool) {
      await this.sync();
      if (this.connected && !this.replicationPaused && this.replicatedGeneration < requiredGeneration)
        await this.sync();
    }
    const pending = this.replicationPaused ? this.checkpoints : undefined;
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
      } catch {
        this.connected = false;
        this.error = "Database query failed; explicit local fallback";
        fallback = this.error;
      }
    }
    const pendingOnly = backend === "timescaledb" ? pending : undefined;
    if (backend === "local-journal" || pendingOnly) {
      rows = await this.readers.read(async () => {
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
        const files = (await this.queryFiles(query.kind,pendingOnly))
          .map((file, order) => ({ file, order, maxTime: file.maxTime ?? Infinity }))
          .filter(({ file }) => overlaps(file, from, Math.min(to, cursor?.time ?? to), asOf))
          .sort((a, b) => a.maxTime === b.maxTime ? b.order - a.order : b.maxTime - a.maxTime);
        for (const { file, order, maxTime } of files) {
          if (query.signal?.aborted) throw new Error('cancelled');
          if (cutoff && maxTime < cutoff.eventTime) break;
          for await (const { event: e } of this.events(file,file.start)) {
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
      });
    }
    const more = rows.length > limit,
      items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
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
  private async replicate() {
    try {
      const generation = this.generation;
      await this.queue;
      await this.readers.read(async () => {
        const client = await this.pool!.connect();
        try {
          if (
            !(
              await client.query(
                "SELECT 1 FROM pg_extension WHERE extname='timescaledb'",
              )
            ).rowCount
          )
            throw new Error("TimescaleDB extension missing");
          const identity = (
            await client.query(
              "SELECT store_id FROM nox_history_storage_meta WHERE singleton=true",
            )
          ).rows[0]?.store_id as string | undefined;
          if (!identity) throw new Error("Database identity migration missing");
          if (this.databaseId !== identity) {
            this.checkpoints = {};
            this.databaseId = identity;
          }
          await this.timescaleRetention.check(client, identity);
          if (this.links.length)
            await client.query(
              // Match before inserting so idle syncs don't lock or rewrite unchanged rows.
              // Keep checking the database so a restored/missing interval is repaired on the next sync.
              `WITH links AS (
                SELECT DISTINCT ON (project_id, market_key, valid_from) project_id, market_key, valid_from, valid_to
                FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
                  WITH ORDINALITY AS input(project_id, market_key, valid_from, valid_to, seq)
                ORDER BY project_id, market_key, valid_from, seq DESC
              )
              INSERT INTO nox_project_market_links AS stored (project_id, market_key, valid_from, valid_to)
              SELECT project_id, market_key, valid_from, valid_to FROM links AS l
              WHERE NOT EXISTS (
                SELECT 1 FROM nox_project_market_links AS old
                WHERE (old.project_id, old.market_key, old.valid_from) = (l.project_id, l.market_key, l.valid_from)
                  AND old.valid_to IS NOT DISTINCT FROM l.valid_to
              )
              ON CONFLICT (project_id, market_key, valid_from) DO UPDATE SET valid_to = EXCLUDED.valid_to
              WHERE stored.valid_to IS DISTINCT FROM EXCLUDED.valid_to`,
              [
                this.links.map(l => l.projectId),
                this.links.map(l => l.marketKey),
                this.links.map(l => new Date(l.from)),
                this.links.map(l => l.to == null ? null : new Date(l.to)),
              ],
            );
          const files = await this.files();
          const resolved = resolveRotatedCheckpoints(files, this.checkpoints);
          if (resolved !== this.checkpoints) {
            await this.atomic(this.checkpointFile, { databaseId: this.databaseId, files: resolved });
            this.checkpoints = resolved;
          }
          for (const file of files) {
            const checkpoint = this.checkpoints[file.dbKey];
            if (checkpoint && checkpoint.identity !== file.identity)
              throw new Error("Journal identity changed; recovery required");
            let batch: Array<{
              event: HistoryEvent;
              offset: number;
              identity: string;
            }> = [];
            let batchStart = checkpoint?.offset ?? 0;
            const flush = async () => {
              if (!batch.length) return;
              await this.timescaleRetention.check(client, identity);
              let bytes = 0, offset = batchStart;
              const accepted = batch.filter(item => {
                const retained = !this.timescaleRetention.expired(item.event.eventTime);
                if (retained) bytes += item.offset - offset;
                offset = item.offset;
                return retained;
              });
              if (accepted.length) this.timescaleRetention.checkBatchSize(bytes);
              await client.query("BEGIN");
              try {
                for (const { event: e } of accepted)
                  await client.query(
                    "INSERT INTO nox_history_events (id,kind,market_key,project_id,event_time,ingest_time,source,quality,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (event_time,id) DO NOTHING",
                    [
                      e.id,
                      e.kind,
                      e.marketKey,
                      e.projectId,
                      new Date(e.eventTime),
                      new Date(e.ingestTime),
                      e.source,
                      e.quality,
                      JSON.stringify(e.payload),
                    ],
                  );
                await client.query("COMMIT");
              } catch (e) {
                await client.query("ROLLBACK");
                throw e;
              }
              this.timescaleRetention.recordBatch(bytes, accepted.length);
              const last = batch.at(-1)!,
                next = {
                  ...this.checkpoints,
                  [file.dbKey]: {
                    offset: last.offset,
                    identity: last.identity,
                    rows: (this.checkpoints[file.dbKey]?.rows ?? 0) + accepted.length,
                  },
                };
              await this.atomic(this.checkpointFile, {
                databaseId: this.databaseId,
                files: next,
              });
              this.checkpoints = next;
              batchStart = last.offset;
              batch = [];
            };
            for await (const item of this.events(file, checkpoint?.offset ?? 0)) {
              batch.push(item);
              if (batch.length >= 250 || item.offset - batchStart >= this.timescaleRetention.batchBytes) await flush();
            }
            await flush();
          }
          if (!this.connected || this.replicatedGeneration !== generation) this.lastPressureCheck = -Infinity;
          this.connected = true;
          this.replicationPaused = false;
          this.replicatedGeneration = generation;
          this.error = null;
        } finally {
          client.release();
        }
      });
    } catch (error) {
      if (error instanceof TimescaleWritesPaused) {
        // The database can still serve existing history while the bounded journal holds new writes.
        this.connected = true;
        this.error = error.message;
        this.replicationPaused = true;
        return;
      }
      this.replicationPaused = false;
      this.connected = false;
      this.error =
        "TimescaleDB unavailable, migration missing or journal recovery required; local history retained";
    }
  }
  measure() {
    return this.enqueue(() => this.measureNow());
  }
  private async measureNow() {
    let journalBytes = 0,
      pendingBytes = 0;
    const files = await this.files();
    const checkpoints = resolveRotatedCheckpoints(files, this.checkpoints);
    for (const file of files) {
      journalBytes += file.storedBytes;
      const checkpoint = checkpoints[file.dbKey];
      pendingBytes += Math.max(0, file.size - (checkpoint?.identity === file.identity ? checkpoint.offset : 0));
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
      error: this.error,
      timescaleRetention: this.pool ? this.timescaleRetention.status() : null,
      databaseRowsAcknowledged: Object.values(this.checkpoints).reduce(
        (a, b) => a + b.rows,
        0,
      ),
      queryBackend: this.connected ? "timescaledb" : "local-journal",
      checkpoint: "persistent-byte-offset",
      partitioning: "UTC ingest date",
      capacity: this.capacity,
      retention: {
        ...this.limits, journalBytes: this.journalBytes, stagingBytes: this.stagingBytes, queuedBytes: this.queuedBytes,
        refusedRows: this.refusedRows, retiredBytes: this.removedBytes, warning: this.writeWarning, error: this.retentionError,
      },
      archiveError: this.archiveError,
    };
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    await this.archiveWork;
    await this.queue;
    await this.sync();
    await this.pool?.end();
  }
}
