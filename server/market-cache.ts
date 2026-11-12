import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { SnapshotBudget } from './snapshot-budget.ts';
import { storageLimit } from './storage-limits.ts';
import path from 'node:path';

export interface CachedResult<T> { value: T; at: number; stale: boolean }

interface CacheOptions<T> { ttlMs: number; timeoutMs?: number; storage?: 'memory'; load: () => Promise<T> }
interface Snapshot { at: number; value: unknown }
interface Entry {
  options: CacheOptions<unknown>;
  group: string;
  lastRead: number;
  snapshot?: Snapshot;
  lastSaveAttempt?: number;
  stale: boolean;
  pending?: Promise<Snapshot>;
  timer?: NodeJS.Timeout;
}

const MAX_ACTIVE_KEYS = 128;
const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

/** Serve a shared snapshot while the server refreshes recently used keys on its own cadence. */
export class MarketCache {
  private entries = new Map<string, Entry>();
  private budget?: SnapshotBudget;
  constructor(
    private dir: string | null = path.join(process.env.DATA_DIR ?? '.data', 'cache'),
    private idleMs = 120_000,
    maxBytes = storageLimit('NOX_MARKET_CACHE_MAX_BYTES', 128 * 1024 ** 2),
  ) {
    if (dir) this.budget = new SnapshotBudget(dir, 'market', maxBytes,
      group => [...this.entries.values()].some(entry => entry.group === group));
  }

  initStorage() { return this.budget?.init(); }
  storageStatus() { return this.budget?.status() ?? null; }

  private file(key: string) {
    if (!this.dir) return null;
    return path.join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  private async readDisk(key: string): Promise<Snapshot | undefined> {
    const file = this.file(key);
    if (!file || !this.budget) return;
    try {
      const handle = await open(file, 'r');
      try {
        const { maxBytes, maxPendingBytes } = this.budget.status();
        // Older snapshots can predate the current writer's admission limit.
        if ((await handle.stat()).size > Math.min(maxBytes, maxPendingBytes)) return;
        const parsed = JSON.parse(await handle.readFile('utf8')) as Snapshot & { key: string };
        if (parsed.key === key && Number.isFinite(parsed.at)) return parsed;
      } finally { await handle.close(); }
    } catch { /* a missing or incomplete cache is a cold start */ }
  }

  private async persist(key: string, snapshot: Snapshot) {
    const file = this.file(key);
    if (!file) return;
    try { await this.budget?.write(path.basename(file), file, JSON.stringify({ key, ...snapshot })); }
    catch { /* Cached persistence is optional; serve the fresh snapshot from memory. */ }
  }

  private schedule(key: string, entry: Entry, delay: number) {
    if (this.entries.get(key) !== entry) return;
    entry.timer = setTimeout(() => {
      if (Date.now() - entry.lastRead >= this.idleMs) {
        this.entries.delete(key);
        return;
      }
      entry.stale = true;
      entry.pending = this.deadline(this.refresh(key, entry), entry);
    }, delay);
    entry.timer.unref();
  }

  private async refresh(key: string, entry: Entry): Promise<Snapshot> {
    try {
      const value = await entry.options.load();
      const snapshot = { value, at: Date.now() };
      if (this.dir && entry.options.storage !== 'memory' && this.entries.get(key) === entry &&
          (entry.lastSaveAttempt === undefined || snapshot.at - entry.lastSaveAttempt >= CHECKPOINT_INTERVAL_MS)) {
        entry.lastSaveAttempt = snapshot.at;
        await this.persist(key, snapshot);
      }
      entry.snapshot = snapshot;
      entry.stale = false;
      return snapshot;
    } finally {
      this.schedule(key, entry, Math.max(1, entry.options.ttlMs));
    }
  }

  private async initialize(key: string, entry: Entry): Promise<Snapshot> {
    if (!this.dir || entry.options.storage === 'memory') return this.refresh(key, entry);
    await this.initStorage();
    const saved = await this.readDisk(key);
    if (!saved) return this.refresh(key, entry);
    const untilRefresh = entry.options.ttlMs - (Date.now() - saved.at);
    entry.lastSaveAttempt = Math.min(Date.now(), saved.at);
    entry.snapshot = saved;
    entry.stale = untilRefresh <= 0;
    this.schedule(key, entry, Math.max(0, untilRefresh));
    return saved;
  }

  private deadline(pending: Promise<Snapshot>, entry: Entry) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cache loader timeout')), entry.options.timeoutMs ?? 10_000);
      timer.unref();
    });
    const result = Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
    // A background refresh can fail when no request is waiting for it.
    void result.catch(() => undefined);
    return result;
  }

  async get<T>(key: string, options: CacheOptions<T>): Promise<CachedResult<T>> {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_ACTIVE_KEYS) throw new Error('market cache is at capacity');
      entry = { options, group: options.storage === 'memory' ? '' : path.basename(this.file(key) ?? ''), lastRead: Date.now(), stale: false };
      this.entries.set(key, entry);
      entry.pending = this.deadline(this.initialize(key, entry), entry);
    }
    entry.lastRead = Date.now();
    const snapshot = entry.snapshot ?? await entry.pending;
    if (!snapshot) throw new Error('market snapshot unavailable');
    return { value: snapshot.value as T, at: snapshot.at, stale: entry.stale };
  }

  close() {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.budget?.close();
  }
}

export const marketCache = new MarketCache();
