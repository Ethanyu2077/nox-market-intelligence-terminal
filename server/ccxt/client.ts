import type { CcxtExchangeHealth, CcxtExchangeLike, CcxtMarket } from './types.ts';
import { CCXT_LABELS, resolveCcxtConfig, type CcxtConfig } from './config.ts';
import type { CcxtExchangeId } from '../../shared/types.ts';

/**
 * Lazy CCXT client pool.
 *
 * `ccxt` is imported on first use so process start-up and the npm dependency tree stay
 * unaffected when the adapter is disabled. One instance per exchange keeps the library's
 * built-in rate limiter and its market cache effective.
 */

type Ctor = new (options: Record<string, unknown>) => CcxtExchangeLike;

const instances = new Map<string, Promise<CcxtExchangeLike>>();
const marketCache = new Map<string, { at: number; value: Record<string, CcxtMarket>; latencyMs: number }>();
const health = new Map<string, CcxtExchangeHealth>();

export class CcxtUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CcxtUnavailableError';
  }
}

async function construct(id: CcxtExchangeId, config: CcxtConfig): Promise<CcxtExchangeLike> {
  const module: unknown = await import('ccxt');
  const bag = module as Record<string, unknown>;
  const fallbackBag = (bag.default ?? {}) as Record<string, unknown>;
  const candidate = bag[id] ?? fallbackBag[id];
  if (typeof candidate !== 'function') throw new CcxtUnavailableError(`CCXT does not expose an exchange named "${id}"`);
  const instance = new (candidate as Ctor)({
    enableRateLimit: true,
    timeout: config.timeoutMs,
    // Most CCXT methods used here are perp-aware; explicit symbols override this default.
    options: { defaultType: 'swap', adjustForTimeDifference: true },
  });
  if (instance.id !== id) throw new CcxtUnavailableError(`CCXT returned ${instance.id} instead of ${id}`);
  return instance;
}

export async function getCcxtExchange(id: CcxtExchangeId, config: CcxtConfig = resolveCcxtConfig()): Promise<CcxtExchangeLike> {
  if (!config.enabled) throw new CcxtUnavailableError('CCXT is disabled (NOX_CCXT_ENABLED)');
  const existing = instances.get(id);
  if (existing) return existing;
  const created = construct(id, config).catch((error: unknown) => {
    instances.delete(id);
    throw error;
  });
  instances.set(id, created);
  return created;
}

export async function getCcxtMarkets(id: CcxtExchangeId, config: CcxtConfig = resolveCcxtConfig()): Promise<Record<string, CcxtMarket>> {
  const cached = marketCache.get(id);
  if (cached && Date.now() - cached.at < config.marketsTtlMs) return cached.value;
  const started = Date.now();
  const exchange = await getCcxtExchange(id, config);
  try {
    const value = await exchange.loadMarkets();
    const latencyMs = Date.now() - started;
    marketCache.set(id, { at: Date.now(), value, latencyMs });
    health.set(id, {
      id,
      enabled: true,
      loaded: true,
      markets: Object.keys(value).length,
      perpetuals: countPerpetuals(value),
      latencyMs,
      error: null,
      checkedAt: Date.now(),
    });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    health.set(id, {
      id,
      enabled: true,
      loaded: false,
      markets: 0,
      perpetuals: 0,
      latencyMs: Date.now() - started,
      error: message.slice(0, 240),
      checkedAt: Date.now(),
    });
    throw error;
  }
}

function countPerpetuals(markets: Record<string, CcxtMarket>): number {
  return Object.values(markets).filter((market) => (market.swap || market.future) && market.quote === 'USDT' && market.active !== false).length;
}

/** Health for the settings page. Never triggers a load and never leaks internals beyond a message. */
export function ccxtHealth(config: CcxtConfig = resolveCcxtConfig()): { enabled: boolean; venues: string[]; exchanges: CcxtExchangeHealth[] } {
  const rows = config.venues.map((id) => health.get(id) ?? {
    id,
    enabled: true,
    loaded: false,
    markets: 0,
    perpetuals: 0,
    latencyMs: null,
    error: null,
    checkedAt: null,
  });
  return {
    enabled: config.enabled,
    venues: config.venues.map((id) => CCXT_LABELS[id]),
    exchanges: rows,
  };
}

/** Test hook: drop the pool and caches. */
export function resetCcxtState(): void {
  instances.clear();
  marketCache.clear();
  health.clear();
}
