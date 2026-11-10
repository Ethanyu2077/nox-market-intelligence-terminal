import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CachedResult<T> { value: T; at: number; stale: boolean }

/**
 * Server-owned cache: fresh -> return; stale -> return immediately and refresh once;
 * cold -> single-flight load. Values persist to disk so a restart or upstream outage can
 * still serve the last good snapshot (explicitly marked stale).
 */
export class MarketCache {
  private memory = new Map<string, { at: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private dir = path.join(process.env.DATA_DIR ?? '.data', 'cache')) {}

  private file(key: string) {
    return path.join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  private async load(key: string): Promise<{ at: number; value: unknown } | null> {
    const hit = this.memory.get(key);
    if (hit) return hit;
    try {
      const parsed = JSON.parse(await readFile(this.file(key), 'utf8')) as { key: string; at: number; value: unknown };
      if (parsed.key !== key || !Number.isFinite(parsed.at)) return null;
      this.memory.set(key, parsed);
      return parsed;
    } catch { return null; }
  }

  private async persist(key: string, at: number, value: unknown) {
    try {
      await mkdir(this.dir, { recursive: true });
      const temp = `${this.file(key)}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ key, at, value }), { mode: 0o600 });
      await rename(temp, this.file(key));
    } catch { /* cache persistence must never fail a request */ }
  }

  async get<T>(key: string, options: { ttlMs: number; staleMs?: number; timeoutMs?: number; load: () => Promise<T> }): Promise<CachedResult<T>> {
    const entry = await this.load(key);
    const now = Date.now();
    if (entry && now - entry.at < options.ttlMs) return { value: entry.value as T, at: entry.at, stale: false };
    const refresh = () => {
      const existing = this.inflight.get(key);
      if (existing) return existing as Promise<T>;
      const task = (async () => {
        const value = await options.load();
        const at = Date.now();
        this.memory.set(key, { at, value });
        await this.persist(key, at, value);
        return value;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
      return task;
    };
    if (entry && now - entry.at < (options.staleMs ?? options.ttlMs * 4)) {
      void refresh().catch(() => undefined);
      return { value: entry.value as T, at: entry.at, stale: true };
    }
    if (entry) {
      try {
        const value = await refresh();
        return { value, at: Date.now(), stale: false };
      } catch {
        return { value: entry.value as T, at: entry.at, stale: true };
      }
    }
    const value = await Promise.race([
      refresh(),
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('cache loader timeout')), options.timeoutMs ?? 10_000)),
    ]);
    return { value, at: Date.now(), stale: false };
  }
}

export const marketCache = new MarketCache();
