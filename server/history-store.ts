import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import type { MarketProject } from "../shared/types.ts";
export type { HistoryEvent } from "../shared/history.ts";
import type { HistoryEvent } from "../shared/history.ts";
import type {RegimeReport} from '../shared/regime-v2.ts';

const KINDS = ["trade", "liquidation", "snapshot", "regime", "volume", "alignment", "l2"] as const;
type Link = {
  projectId: string;
  marketKey: string;
  from: number;
  to: number | null;
};
type Checkpoint = { offset: number; identity: string; rows: number };
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
    await mkdir(path.join(this.directory, "history"), { recursive: true });
    const saved = await this.load<{
      databaseId: string | null;
      files: Record<string, Checkpoint>;
    }>(this.checkpointFile, { databaseId: null, files: {} });
    this.checkpoints = saved.files;
    this.databaseId = saved.databaseId;
    this.links = await this.load(this.linksFile, []);
    await this.measure();
    if (this.pool) await this.sync();
    this.timer = setInterval(() => {
      void this.sync();
      void this.measure().catch(() => {});
    }, 15_000);
    this.timer.unref();
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
      const work = this.queue
        .catch(() => {})
        .then(() => this.atomic(this.linksFile, saved));
      this.queue = work;
      await work;
    }
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
    const work = this.queue
      .catch(() => {})
      .then(() =>
        appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
      );
    this.queue = work;
    this.generation++;
    return work;
  }
  private async files(kind?: HistoryEvent["kind"]) {
    const output: string[] = [];
    for (const k of kind ? [kind] : KINDS) {
      const legacy = `history-${k}.ndjson`;
      try {
        await stat(path.join(this.directory, legacy));
        output.push(legacy);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    for (const name of (
      await readdir(path.join(this.directory, "history"))
    ).sort())
      if (
        /^\d{4}-\d{2}-\d{2}-(trade|liquidation|snapshot|regime|volume|alignment)\.ndjson$/.test(
          name,
        ) &&
        (!kind || name.endsWith(`-${kind}.ndjson`))
      )
        output.push(`history/${name}`);
    return output;
  }
  private async *events(file: string, start = 0) {
    const absolute = path.join(this.directory, file),
      info = await stat(absolute),
      identity = `${info.dev}:${info.ino}`;
    if (start > info.size)
      throw new Error("Journal truncated after checkpoint");
    if (start === info.size) return;
    const stream = createReadStream(absolute, { start, end: info.size - 1 });
    let pending = Buffer.alloc(0),
      offset = start;
    try {
      for await (const chunk of stream) {
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
              `Corrupt journal ${file} at byte ${offset}; not overwritten`,
            );
          }
          yield { event, offset, identity };
        }
      }
      if (pending.length)
        throw new Error(
          `Incomplete journal tail in ${file}; recovery required`,
        );
    } finally {
      stream.destroy();
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
  async sampleSnapshots(projectId:string,size:number,asOf=Date.now()) {
    if(!Number.isFinite(size)||size<300_000)throw new Error('Invalid sample interval');
    await this.queue;if(this.pool)await this.sync();
    const end=Math.floor((asOf-90_000)/size)*size,from=end-202*size-90_000;
    if(this.connected&&this.pool)try{
      const result=await this.pool.query(`SELECT DISTINCT ON (market_key,ceil(extract(epoch from event_time)*1000/$1)) id,kind,market_key AS "marketKey",project_id AS "projectId",extract(epoch from event_time)*1000 AS "eventTime",extract(epoch from ingest_time)*1000 AS "ingestTime",source,quality,payload FROM nox_history_events WHERE project_id=$2 AND kind='snapshot' AND event_time >= $3 AND event_time <= $4 AND ingest_time <= $5 AND ceil(extract(epoch from event_time)*1000/$1)*$1-extract(epoch from event_time)*1000 <= 90000 AND quality NOT IN ('stale','unavailable') ORDER BY market_key,ceil(extract(epoch from event_time)*1000/$1),event_time DESC,ingest_time DESC,id COLLATE "C" DESC`,[size,projectId,new Date(Math.max(0,from)),new Date(end),new Date(asOf)]);
      return result.rows.map(r=>({...r,eventTime:Number(r.eventTime),ingestTime:Number(r.ingestTime)})) as HistoryEvent[];
    }catch{this.connected=false;this.error='Historical sampling query failed; local fallback';}
    const samples=new Map<string,HistoryEvent>();
    for(const file of await this.files('snapshot'))for await(const{event:e}of this.events(file)){
      if(e.projectId!==projectId||e.eventTime<from||e.eventTime>end||e.ingestTime>asOf||['stale','unavailable'].includes(e.quality))continue;
      const boundary=Math.ceil(e.eventTime/size)*size;if(boundary-e.eventTime>90_000)continue;
      const k=`${e.marketKey}:${boundary}`,current=samples.get(k);
      if(!current||e.eventTime>current.eventTime||(e.eventTime===current.eventTime&&e.ingestTime>current.ingestTime))samples.set(k,e);
    }
    return [...samples.values()].sort((a,b)=>a.eventTime-b.eventTime);
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
      if (this.connected && this.replicatedGeneration < requiredGeneration)
        await this.sync();
    }
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
      } catch {
        this.connected = false;
        this.error = "Database query failed; explicit local fallback";
        fallback = this.error;
      }
    }
    if (backend === "local-journal") {
      const unique = new Map<string, HistoryEvent>();
      for (const file of await this.files(query.kind))
        for await (const { event: e } of this.events(file)) {
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
          const key = `${e.eventTime}:${e.id}`;
          if (!unique.has(key)) {
            const r=e.payload as RegimeReport;
            unique.set(key,query.priceOnly&&e.kind==='snapshot'?{...e,payload:{price:(e.payload as {price:number|null}).price}}:query.summarizeRegime&&e.source==='nox.regime.v2'?{...e,payload:{...r,venues:r.venues.map(v=>({...v,inputSnapshotCount:v.input.snapshots?.length??v.inputSnapshotCount??0,input:{...v.input,snapshots:[],perpBuckets:[],spotBuckets:[]}}))}}:e);
          }
          if (unique.size > limit + 1) {
            const oldest = [...unique.values()].sort(compare).at(-1)!;
            unique.delete(`${oldest.eventTime}:${oldest.id}`);
          }
        }
      rows = [...unique.values()].sort(compare);
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
      localScan: backend === "local-journal",
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
      await this.queue;
      const generation = this.generation;
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
        for (const l of this.links)
          await client.query(
            "INSERT INTO nox_project_market_links(project_id,market_key,valid_from,valid_to) VALUES ($1,$2,$3,$4) ON CONFLICT(project_id,market_key,valid_from) DO UPDATE SET valid_to=EXCLUDED.valid_to",
            [
              l.projectId,
              l.marketKey,
              new Date(l.from),
              l.to == null ? null : new Date(l.to),
            ],
          );
        for (const file of await this.files()) {
          const info = await stat(path.join(this.directory, file)),
            checkpoint = this.checkpoints[file];
          if (checkpoint && checkpoint.identity !== `${info.dev}:${info.ino}`)
            throw new Error("Journal identity changed; recovery required");
          let batch: Array<{
            event: HistoryEvent;
            offset: number;
            identity: string;
          }> = [];
          const flush = async () => {
            if (!batch.length) return;
            await client.query("BEGIN");
            try {
              for (const { event: e } of batch)
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
            const last = batch.at(-1)!,
              next = {
                ...this.checkpoints,
                [file]: {
                  offset: last.offset,
                  identity: last.identity,
                  rows: (this.checkpoints[file]?.rows ?? 0) + batch.length,
                },
              };
            await this.atomic(this.checkpointFile, {
              databaseId: this.databaseId,
              files: next,
            });
            this.checkpoints = next;
            batch = [];
          };
          for await (const item of this.events(file, checkpoint?.offset ?? 0)) {
            batch.push(item);
            if (batch.length >= 250) await flush();
          }
          await flush();
        }
        this.connected = true;
        this.replicatedGeneration = generation;
        this.error = null;
      } finally {
        client.release();
      }
    } catch {
      this.connected = false;
      this.error =
        "TimescaleDB unavailable, migration missing or journal recovery required; local history retained";
    }
  }
  async measure() {
    let journalBytes = 0,
      pendingBytes = 0;
    for (const file of await this.files()) {
      const size = (await stat(path.join(this.directory, file))).size;
      journalBytes += size;
      pendingBytes += Math.max(0, size - (this.checkpoints[file]?.offset ?? 0));
    }
    const fs = await statfs(this.directory),
      freeBytes = fs.bavail * fs.bsize,
      threshold = Number(process.env.NOX_DISK_WARNING_BYTES ?? 5 * 1024 ** 3);
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
      databaseRowsAcknowledged: Object.values(this.checkpoints).reduce(
        (a, b) => a + b.rows,
        0,
      ),
      queryBackend: this.connected ? "timescaledb" : "local-journal",
      checkpoint: "persistent-byte-offset",
      partitioning: "UTC ingest date",
      capacity: this.capacity,
      retention: "No automatic deletion; operator-configured policy required",
    };
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.queue;
    await this.sync();
    await this.pool?.end();
  }
}
