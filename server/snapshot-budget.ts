import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rmdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageReserveBytes } from './storage-limits.ts';

const HOUR = 3_600_000;
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const temporarySuffix = '(?:\\.(?:' + UUID + '\\.)?tmp)?$';
const orderFlowDelta = new RegExp('^' + UUID + '\\.\\d{2}\\.json' + temporarySuffix);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type Files = { files: Map<string, number>; newest: number };

/** One writer per Dokku data mount. Only generated snapshot names belong to this budget. */
export class SnapshotBudget {
  private readonly baseName: RegExp;
  private groups = new Map<string, Files>();
  private used = 0;
  private block = 4096;
  private scanned = false;
  private queue = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private skippedWrites = 0;
  private lastError: string | null = null;

  constructor(private directory: string, private kind: 'market' | 'flow', private maxBytes: number,
    private isActive: (group: string) => boolean, private reserve = storageReserveBytes()) {
    const length = kind === 'market' ? 32 : 64;
    this.baseName = new RegExp('^([0-9a-f]{' + length + '}\\.json)' + temporarySuffix);
  }

  private run<T>(work: () => Promise<T>) {
    const result = this.queue.then(work);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private charge(bytes: number) { return Math.max(1, Math.ceil(bytes / this.block)) * this.block; }
  private track(group: string, file: string, bytes: number, time: number) {
    const entry = this.groups.get(group) ?? { files: new Map(), newest: 0 };
    this.used += bytes - (entry.files.get(file) ?? 0);
    entry.files.set(file, bytes);
    entry.newest = Math.max(entry.newest, time);
    this.groups.set(group, entry);
  }
  private forget(group: string, file: string) {
    const entry = this.groups.get(group);
    if (!entry) return;
    this.used -= entry.files.get(file) ?? 0;
    entry.files.delete(file);
    if (!entry.files.size) this.groups.delete(group);
  }

  private async inventory() {
    await mkdir(this.directory, {recursive:true});
    this.block = (await statfs(this.directory)).bsize || 4096;
    this.groups.clear(); this.used = 0;
    const inspect = async (group: string, file: string) => {
      try {
        const info = await stat(file);
        if (file.endsWith('.tmp') && info.mtimeMs < Date.now() - HOUR) { await unlink(file); return; }
        this.track(group, file, Math.max(this.charge(info.size), info.blocks * 512), info.mtimeMs);
      } catch (error) { if (!missing(error)) throw error; }
    };
    for (const item of await readdir(this.directory, {withFileTypes:true})) {
      const file = path.join(this.directory, item.name);
      if (item.isFile()) {
        const match = this.baseName.exec(item.name);
        if (match) await inspect(match[1], file);
      } else if (this.kind === 'flow' && item.isDirectory() && /^[0-9a-f]{64}\.json\.d$/.test(item.name)) {
        const group = item.name.slice(0, -2);
        const items = await readdir(file, {withFileTypes:true});
        for (const child of items) if (child.isFile() && orderFlowDelta.test(child.name)) await inspect(group, path.join(file, child.name));
        if (!this.isActive(group)) await this.removeEmptyDirectory(file);
      }
    }
    this.scanned = true;
  }

  private async removeEmptyDirectory(directory: string) {
    try { await rmdir(directory); }
    catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
  }

  private async removeFile(group: string, file: string) {
    try { await unlink(file); }
    catch (error) { if (!missing(error)) throw error; }
    this.forget(group, file);
  }

  private async makeRoom(group: string | null, extra: number) {
    const space = await statfs(this.directory);
    const maxGroups = this.kind === 'flow' ? 256 : 512;
    const newGroup = Number(group !== null && !this.groups.has(group));
    const fits = (free: number) => this.used + extra <= this.maxBytes && this.groups.size + newGroup <= maxGroups && free >= this.reserve + extra;
    let free = space.bavail * space.bsize;
    if (fits(free)) return true;
    if (extra > this.maxBytes) return false;
    const candidates = [...this.groups].sort((a,b) => a[1].newest - b[1].newest);
    for (const [key, entry] of candidates) {
      if (group === key || this.isActive(key)) continue;
      // Removing the base first means even an interrupted eviction cannot publish a partial tape.
      const base = path.join(this.directory, key);
      const files = [...entry.files.keys()].sort((a,b) => Number(b === base) - Number(a === base));
      for (const file of files) { await this.removeFile(key, file); }
      if (this.kind === 'flow') await this.removeEmptyDirectory(base + '.d');
      if (free < this.reserve + extra) {
        const available = await statfs(this.directory);
        free = available.bavail * available.bsize;
      }
      if (fits(free)) return true;
    }
    return false;
  }

  private async maintain() {
    await this.inventory();
    const fits = await this.makeRoom(null, 0);
    this.lastError = fits ? null : 'Snapshot quota or filesystem free-space reserve reached';
  }
  init() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.run(() => this.maintain()).catch(() => { this.scanned = false; this.lastError = 'Snapshot maintenance failed'; });
      }, HOUR);
      this.timer.unref();
    }
    return this.run(async () => {
      if (!this.scanned) await this.maintain();
    }).catch(() => { this.scanned = false; this.lastError = 'Snapshot maintenance failed'; });
  }
  close() { clearInterval(this.timer); }
  status() { return { bytes: this.used, maxBytes: this.maxBytes, groups: this.groups.size, skippedWrites: this.skippedWrites, lastError: this.lastError }; }

  // Serialize admissions including temp + old base during replacement. Concurrent feeds cannot
  // independently spend the same bytes. Cache failures never discard a feed's in-memory samples.
  write(group: string, file: string, data: string) {
    return this.run(async () => {
      if (!this.scanned) await this.maintain();
      const bytes = this.charge(Buffer.byteLength(data));
      if (!await this.makeRoom(group, bytes)) {
        this.skippedWrites++;
        this.lastError = 'Snapshot quota or filesystem free-space reserve reached';
        throw new Error(this.lastError);
      }
      const temporary = file + '.' + randomUUID() + '.tmp';
      await mkdir(path.dirname(file), {recursive:true});
      try {
        await writeFile(temporary, data, {mode:0o600, flag:'wx'});
        await rename(temporary, file);
        this.track(group, file, bytes, Date.now());
        this.lastError = null;
      } catch (error) {
        this.lastError = 'Snapshot write failed';
        try { await unlink(temporary); } catch (cleanup) { if (!missing(cleanup)) this.scanned = false; }
        throw error;
      }
    });
  }
  remove(group: string, file: string) { return this.run(() => this.removeFile(group, file)); }
}
