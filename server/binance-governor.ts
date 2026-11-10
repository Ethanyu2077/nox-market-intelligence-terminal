/**
 * Process-wide governor for Binance REST. Prevents parallel modules from hammering the
 * same endpoint, respects 418/429 Retry-After, and dedupes in-flight requests.
 * It does NOT bypass exchange limits (no IP rotation, no proxy).
 */
export type BinanceFamily = 'aggTrades' | 'kline' | 'depth' | 'premiumIndex' | 'openInterest' | 'exchangeInfo' | 'ticker' | 'other';

const MIN_INTERVAL: Record<BinanceFamily, number> = {
  aggTrades: 1_000, kline: 500, depth: 1_000, premiumIndex: 500,
  openInterest: 60_000, exchangeInfo: 3_600_000, ticker: 1_000, other: 500,
};

export function familyOf(url: string): BinanceFamily {
  const path = new URL(url).pathname;
  if (path.includes('aggTrades')) return 'aggTrades';
  if (path.includes('kline') || path.includes('continuousKlines')) return 'kline';
  if (path.includes('depth')) return 'depth';
  if (path.includes('premiumIndex')) return 'premiumIndex';
  if (path.includes('openInterest')) return 'openInterest';
  if (path.includes('exchangeInfo')) return 'exchangeInfo';
  if (path.includes('ticker')) return 'ticker';
  return 'other';
}

function retryAfterMs(headers: Headers, fallback: number): number {
  const header = headers.get('retry-after');
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : fallback;
}

export class BinanceCooldownError extends Error {
  constructor(public readonly retryAfterMs: number, public readonly reason: string) {
    super(`Binance cooldown: ${reason}`);
    this.name = 'BinanceCooldownError';
  }
}

export function createBinanceGovernor(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let bannedUntil = 0;
  let banReason: string | null = null;
  let banCount = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  const lastAt = new Map<BinanceFamily, number>();
  const inflight = new Map<string, Promise<unknown>>();
  const cache = new Map<string, { at: number; value: unknown }>();
  const stats = { requests: 0, failures: 0, cooldowns: 0, deduped: 0, cached: 0, lastStatus: null as number | null, lastError: null as string | null, lastSuccessAt: null as number | null };

  const acquire = async (): Promise<void> => {
    if (active < 3) { active += 1; return; }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = () => { active = Math.max(0, active - 1); waiters.shift()?.(); };

  async function json<T>(url: string, options: { cacheMs?: number } = {}): Promise<T> {
    const family = familyOf(url);
    const cacheKey = url;
    const cached = cache.get(cacheKey);
    if (cached && (options.cacheMs ?? 0) > 0 && now() - cached.at < (options.cacheMs ?? 0)) { stats.cached += 1; return cached.value as T; }
    const pending = inflight.get(cacheKey);
    if (pending) { stats.deduped += 1; return pending as Promise<T>; }
    if (now() < bannedUntil) throw new BinanceCooldownError(bannedUntil - now(), banReason ?? 'HTTP 418/429');

    const task = (async () => {
      const wait = (lastAt.get(family) ?? 0) + MIN_INTERVAL[family] - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await acquire();
      try {
        if (now() < bannedUntil) throw new BinanceCooldownError(bannedUntil - now(), banReason ?? 'HTTP 418/429');
        lastAt.set(family, now());
        stats.requests += 1;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(9_000), headers: { 'User-Agent': 'NOX-Market-Intelligence/0.2' } });
        stats.lastStatus = response.status;
        if (response.status === 418 || response.status === 429 || response.status === 403 || response.status === 451) {
          // 403/451 are usually geo/IP blocks: retrying cannot fix them, so stop for longer.
          const blocked = response.status === 403 || response.status === 451;
          const delay = retryAfterMs(response.headers, blocked ? 15 * 60_000 : 60_000 * 2 ** Math.min(banCount, 4));
          banCount += 1;
          bannedUntil = now() + delay;
          banReason = `Binance ${response.status}${blocked ? ' (blocked)' : ''}: ${family}`;
          stats.cooldowns += 1; stats.failures += 1; stats.lastError = banReason;
          throw new BinanceCooldownError(delay, banReason);
        }
        if (!response.ok) {
          stats.failures += 1; stats.lastError = `HTTP ${response.status}`;
          throw new Error(`Binance ${response.status}: ${new URL(url).pathname}`);
        }
        const value = await response.json() as T;
        banCount = 0;
        stats.lastSuccessAt = now();
        stats.lastError = null;
        if ((options.cacheMs ?? 0) > 0) cache.set(cacheKey, { at: now(), value });
        return value;
      } finally { release(); }
    })();
    inflight.set(cacheKey, task);
    try { return await task; } finally { inflight.delete(cacheKey); }
  }

  return {
    json,
    status: () => ({ bannedUntil: bannedUntil || null, banReason, active, ...stats }),
    resetCooldown: () => { bannedUntil = 0; banReason = null; },
  };
}

export const binanceGovernor = createBinanceGovernor();
