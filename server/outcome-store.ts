import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, truncate } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { StudyResponse } from "../shared/event-study.ts";
import { appendJournalBatch } from "./journal-append.ts";
import { archiveClosedJournals, journalBytes, journalSegments, type JournalSegment } from "./journal-archive.ts";
import { storageLimit, storageReserveBytes } from "./storage-limits.ts";

const compress = promisify(gzip), decompress = promisify(gunzip);
const DAY = 86_400_000;
const outcomeFile = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
const temporary = /^(?:revision-index\.json|revision-checkpoint\.json\.gz\.[a-f0-9-]{36}|\d{4}-\d{2}-\d{2}\.ndjson\.\d+-\d+-(?:b\d+-)?[a-f0-9-]{36}\.[a-f0-9-]{36}\.gz)\.tmp$/;
const checkpointName = "revision-checkpoint.json.gz";
const legacyName = "revision-index.json";
type Cursor = { file: string; offset: number };
type Revision = [hash: string, owner: string, sequence: number];
type Checkpoint = { version: 2; active: Cursor; backdated: boolean; sequence: number; revisions: Record<string, Revision> };
type Inventory = { parts: JournalSegment[]; checkpoint: number; legacy: number; bytes: number };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const owner = (part: Pick<JournalSegment, "name" | "identity" | "birth">) => part.name + ":" + part.identity + ":" + (part.birth ?? "");
const revisionKey = (method: string, id: string) => method + ":" + id;
const dayEnd = (name: string) => Date.parse(name.slice(0, 10)) + DAY;

/** Rebuildable research output. Live queries read source observations, independently of this journal. */
export class OutcomeStore {
  private queue = Promise.resolve();
  private revisions: Map<string, Revision> | null = null;
  private active: Cursor | null = null;
  private sequence = 0;
  private backdated = false;
  private archiveDay = "";
  private archive = Promise.resolve();
  private readonly directory: string;
  private readonly maxBytes = storageLimit("NOX_OUTCOME_MAX_BYTES", 256 * 1024 ** 2);
  private readonly days = storageLimit("NOX_OUTCOME_RETENTION_DAYS", 35);
  private readonly reserve = storageReserveBytes();
  private bytes = 0;
  private block = 4096;
  private removed = 0;
  private skipped = 0;
  private blocked: string | null = null;
  private lastPruneDay = "";

  constructor(directory: string) {
    this.directory = path.join(directory, "outcomes");
  }

  status() {
    return { bytes: this.bytes, maxBytes: this.maxBytes, retentionDays: this.days, removedSegments: this.removed,
      skippedRows: this.skipped, writePressure: this.blocked };
  }

  private run<T>(fn: () => Promise<T>) {
    const work = this.queue.then(fn);
    this.queue = work.then(() => {}, () => {
      // A failing maintenance pass may already have unlinked a source or its checkpoint.
      this.revisions = null;
      this.active = null;
    });
    return work;
  }

  private async inventory(cleanTemps = false): Promise<Inventory> {
    await mkdir(this.directory, { recursive: true });
    this.block = (await statfs(this.directory)).bsize || 4096;
    if (cleanTemps) {
      // The single outcome writer waits for its own archiver before reclaiming abandoned staging files.
      for (const file of await readdir(this.directory)) {
        if (temporary.test(file)) await rm(path.join(this.directory, file));
      }
    }
    const size = async (name: string) => {
      try {
        const info = await stat(path.join(this.directory, name));
        return Math.max(this.charge(info.size), info.blocks * 512);
      }
      catch (error) { if (missing(error)) return 0; throw error; }
    };
    const [segments, checkpoint, legacy] = await Promise.all([
      journalSegments(this.directory, name => outcomeFile.test(name)), size(checkpointName), size(legacyName),
    ]);
    const parts = segments.map(p => ({...p, storedBytes: Math.max(this.charge(p.storedBytes), p.allocatedBytes ?? 0)}));
    const bytes = parts.reduce((sum, p) => sum + p.storedBytes, checkpoint + legacy);
    this.bytes = bytes;
    return { parts, checkpoint, legacy, bytes };
  }

  private charge(bytes: number) { return Math.max(1, Math.ceil(bytes / this.block)) * this.block; }

  private async removeIndex(state: Inventory) {
    await rm(path.join(this.directory, checkpointName), { force: true });
    await rm(path.join(this.directory, legacyName), { force: true });
    // A crash halfway through deletion must never resurrect a checkpoint for removed segments.
    const handle = await open(this.directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    state.bytes -= state.checkpoint + state.legacy;
    state.checkpoint = state.legacy = 0;
    this.active = null;
  }

  private async prune(state: Inventory, incoming: number) {
    const cutoff = Date.now() - this.days * DAY;
    const over = () => state.bytes + incoming > this.maxBytes;
    if (over() || state.parts.some(p => dayEnd(p.name) <= cutoff)) {
      await this.removeIndex(state);
      const removed = new Set<string>();
      // Release headroom in one pass to avoid rebuilding indexes and evicting on every append.
      const target = over() ? Math.max(incoming, Math.floor(this.maxBytes * 0.85)) : this.maxBytes;
      const retained: JournalSegment[] = [];
      for (const part of state.parts) {
        if (dayEnd(part.name) > cutoff && state.bytes + incoming <= target) {
          retained.push(part);
          continue;
        }
        for (const file of [part.file, ...(part.copies ?? [])]) await rm(file, { force: true });
        removed.add(owner(part));
        state.bytes -= part.storedBytes;
        this.removed++;
      }
      state.parts = retained;
      if (removed.size && this.backdated) {
        // A newer revision can live in an older day. Reconstruct the last *surviving*
        // version if its newer backdated revision was the one removed.
        this.revisions = null;
      } else if (this.revisions && removed.size) {
        for (const [key, [, source]] of this.revisions) if (removed.has(source)) this.revisions.delete(key);
      }
    }
    this.bytes = state.bytes;
  }

  private async replay(segment: JournalSegment, offset: number, revisions: Map<string, Revision>) {
    let pending = Buffer.alloc(0);
    const source = owner(segment);
    for await (const chunk of journalBytes(segment, offset)) {
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const { id, methodology, revision, sequence = 0 } = JSON.parse(pending.toString("utf8", 0, newline));
        if (typeof id !== "string" || typeof methodology !== "string" || typeof revision !== "string")
          throw new Error("Invalid outcome journal record");
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid outcome revision sequence");
        const key = revisionKey(methodology, id);
        if (sequence < this.sequence) this.backdated = true;
        if (sequence >= (revisions.get(key)?.[2] ?? 0)) revisions.set(key, [revision, source, sequence]);
        this.sequence = Math.max(this.sequence, sequence);
        offset += newline + 1;
        pending = pending.subarray(newline + 1);
      }
    }
    if (pending.length) {
      if (segment.key !== segment.name) throw new Error("Incomplete archived outcome row");
      await truncate(segment.file, offset);
    }
  }

  private async load(state: Inventory) {
    if (this.revisions) return;
    const revisions = new Map<string, Revision>();
    this.sequence = 0;
    this.backdated = false;
    // Legacy global indexes can contain years of IDs. Rebuild those from surviving journals.
    const maxCheckpoint = Math.floor(this.maxBytes / 8);
    if (state.checkpoint && state.checkpoint <= maxCheckpoint) {
      let saved: Checkpoint | undefined;
      try {
        const data = await readFile(path.join(this.directory, checkpointName));
        saved = JSON.parse((await decompress(data, { maxOutputLength: Math.min(this.maxBytes, 128 * 1024 ** 2) })).toString());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") throw error;
      }
      if (saved?.version === 2) {
        const { file, offset } = saved.active;
        const active = state.parts.find(p => p.name === file && p.key === p.name);
        if (!outcomeFile.test(file) || !Number.isSafeInteger(offset) || offset < 0)
          throw new Error("Invalid outcome journal checkpoint");
        // Cold maintenance can archive the former writer's active file during downtime.
        // A saved byte offset identifies the old raw file; rebuild from retained revisions
        // when that file has been sealed.
        if (active || !state.parts.some(p => p.name === file)) {
          if (offset > (active?.size ?? 0)) throw new Error("Invalid outcome journal checkpoint");
          for (const [key, value] of Object.entries(saved.revisions)) revisions.set(key, value);
          this.sequence = saved.sequence;
          this.backdated = saved.backdated;
          if (active) await this.replay(active, offset, revisions);
          this.active = saved.active;
          this.revisions = revisions;
          return;
        }
      }
    }
    for (const part of state.parts) await this.replay(part, 0, revisions);
    this.revisions = revisions;
    this.active = null;
  }

  private async freeBytes() {
    const space = await statfs(this.directory);
    return Math.max(0, space.bavail * space.bsize - this.reserve);
  }

  private async startPartition(file: string, state: Inventory, incoming: number, free: number) {
    const active = { file, offset: state.parts.find(p => p.name === file && p.key === file)?.size ?? 0 };
    const checkpoint: Checkpoint = { version: 2, active, backdated: this.backdated, sequence: this.sequence, revisions: Object.fromEntries(this.revisions!) };
    const compressed = await compress(JSON.stringify(checkpoint));
    // The old checkpoint, its replacement and the new batch must fit even before rename.
    const headroom = Math.min(this.maxBytes - state.bytes - incoming, free - incoming);
    if (compressed.length > this.maxBytes / 8 || this.charge(compressed.length) > headroom) {
      await this.removeIndex(state);
      this.active = active;
      return;
    }
    const destination = path.join(this.directory, checkpointName);
    const temporary = destination + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    let allocated: number;
    try {
      try {
        await handle.writeFile(compressed);
        await handle.sync();
        allocated = Math.max(this.charge(compressed.length), (await handle.stat()).blocks * 512);
      }
      finally { await handle.close(); }
      if (allocated > headroom) {
        await rm(temporary);
        await this.removeIndex(state);
        this.active = active;
        return;
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    await rm(path.join(this.directory, legacyName), { force: true });
    state.bytes += allocated - state.checkpoint - state.legacy;
    state.checkpoint = allocated;
    state.legacy = 0;
    this.active = active;
  }

  private async rotate(part: JournalSegment, state: Inventory) {
    // The archive reader orders immutable segments by their embedded time prefix.
    let next = Date.now();
    for (const sibling of state.parts) {
      if (sibling.name === part.name && sibling.key !== sibling.name)
        next = Math.max(next, parseInt(sibling.key.slice(-36, -23).replace("-", ""), 16) + 1);
    }
    const stamp = next.toString(16).padStart(12, "0");
    const id = stamp.slice(0, 8) + "-" + stamp.slice(8) + randomUUID().slice(13);
    const file = part.file + "." + part.identity.replace(":", "-") + "-b" + part.birth + "-" + id + ".sealed";
    await this.removeIndex(state);
    await rename(part.file, file);
  }

  private scheduleArchive(state?: Inventory) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.archiveDay === today || (!this.active && !state?.parts.length)) return;
    this.archiveDay = today;
    const active = this.active?.file;
    this.archive = archiveClosedJournals(this.directory, name => outcomeFile.test(name) && name !== active, {
      reserve: async requested => {
        const {bytes} = await this.inventory();
        return { bytes: Math.max(0, Math.min(requested, this.maxBytes - bytes)), release() {} };
      },
    }).then(async () => { await this.inventory(); })
      .catch(error => { console.warn("Could not compress closed outcome journals", error); });
  }

  maintain() {
    return this.run(async () => {
      await this.archive;
      const state = await this.inventory(true);
      await this.prune(state, 0);
      this.lastPruneDay = new Date().toISOString().slice(0, 10);
      this.scheduleArchive(state);
    });
  }

  record(study: StudyResponse) {
    return this.run(async () => {
      const today = new Date().toISOString().slice(0, 10);
      let state: Inventory | undefined;
      if (!this.revisions || this.lastPruneDay !== today) {
        await this.archive;
        state = await this.inventory(true);
        await this.prune(state, 0);
        await this.load(state);
        this.lastPruneDay = today;
        state = undefined; // Replay can truncate a torn active tail.
      }
      const file = new Date(study.asOf).toISOString().slice(0, 10) + ".ndjson";
      if (dayEnd(file) <= Date.now() - this.days * DAY) return 0;
      const sequence = Math.max(Date.now(), this.sequence + 1);
      const changed = new Map<string, string>(), lines: string[] = [];
      for (const row of study.rows) {
        if (row.status === "overlap-excluded") continue;
        const revision = createHash("sha256").update(JSON.stringify([study.methodology, row])).digest("hex");
        const key = revisionKey(study.methodology, row.id);
        if ((changed.get(key) ?? this.revisions!.get(key)?.[0]) === revision) continue;
        lines.push(JSON.stringify({ id: row.id, revision, sequence, methodology: study.methodology, asOf: study.asOf, row }));
        changed.set(key, revision);
      }
      if (!lines.length) { this.scheduleArchive(); return 0; }
      const data = lines.join("\n") + "\n";
      const incoming = Buffer.byteLength(data);
      await this.archive;
      if (this.charge(incoming) > this.maxBytes) {
        this.skipped += lines.length;
        this.blocked = "batch-exceeds-quota";
        return 0;
      }
      // Optional output must not evict a recent study while the volume is below reserve.
      if (this.charge(incoming) > await this.freeBytes()) {
        this.skipped += lines.length;
        this.blocked = "filesystem-reserve";
        return 0;
      }
      state = await this.inventory();
      let raw = state.parts.find(p => p.name === file && p.key === file);
      const segmentTarget = Math.min(16 * 1024 ** 2, Math.floor(this.maxBytes / 8));
      if (raw && raw.size && raw.size + incoming > segmentTarget) {
        await this.rotate(raw, state);
        state = await this.inventory();
        raw = undefined;
      }
      let growth = Math.max(0, this.charge((raw?.size ?? 0) + incoming) - (raw?.storedBytes ?? 0));
      await this.prune(state, growth);
      if (raw && !state.parts.includes(raw)) {
        raw = undefined;
        growth = this.charge(incoming);
        await this.prune(state, growth);
      }
      if (!this.revisions) await this.load(state);
      if (state.parts.some(part => part.name > file)) this.backdated = true;
      if (this.active?.file !== file) await this.startPartition(file, state, growth, await this.freeBytes());
      const destination = path.join(this.directory, file);
      await appendJournalBatch(destination, data);
      const info = await stat(destination);
      const source = owner({ name: file, identity: info.dev + ":" + info.ino, birth: Math.round(info.birthtimeMs * 1000) });
      this.sequence = sequence;
      for (const [key, revision] of changed) this.revisions!.set(key, [revision, source, sequence]);
      this.bytes = state.bytes - (raw?.storedBytes ?? 0) + Math.max(this.charge(info.size), info.blocks * 512);
      if (this.bytes > this.maxBytes) await this.prune(await this.inventory(), 0);
      this.blocked = null;
      this.scheduleArchive();
      return lines.length;
    });
  }

  async close() {
    await this.queue;
    await this.archive;
  }
}
