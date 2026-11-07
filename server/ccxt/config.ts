import { CCXT_EXCHANGE_IDS, type CcxtExchangeId } from '../../shared/types.ts';

/**
 * CCXT adapter configuration.
 *
 * CCXT is a *coverage and resilience* layer, never the only path for a native venue:
 * - `venues` enables additional perpetual markets served only by CCXT;
 * - `fallback` lets a failed native REST snapshot retry through CCXT;
 * - `spot` lets CCXT quote spot markets that have no native snapshot adapter.
 *
 * Everything is server-side only; the browser receives the resulting snapshots, not
 * exchange credentials or the CCXT client.
 */

export interface CcxtConfig {
  enabled: boolean;
  /** CCXT-only venues to expose in discovery and the venue picker. */
  venues: CcxtExchangeId[];
  fallback: boolean;
  spot: boolean;
  timeoutMs: number;
  /** How long a loadMarkets() catalogue is reused. */
  marketsTtlMs: number;
  /** Names in NOX_CCXT_VENUES that are not part of the supported set. */
  ignored: string[];
}

export const CCXT_LABELS: Record<CcxtExchangeId, string> = {
  htx: 'HTX',
  bingx: 'BingX',
  phemex: 'Phemex',
  bitfinex: 'Bitfinex',
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
}

export function resolveCcxtConfig(env: NodeJS.ProcessEnv = process.env): CcxtConfig {
  const enabled = bool(env.NOX_CCXT_ENABLED, true);
  const requested = (env.NOX_CCXT_VENUES ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const venues: CcxtExchangeId[] = [];
  const ignored: string[] = [];
  for (const name of requested) {
    if ((CCXT_EXCHANGE_IDS as readonly string[]).includes(name)) venues.push(name as CcxtExchangeId);
    else ignored.push(name);
  }
  return {
    enabled,
    venues: enabled ? [...new Set(venues)] : [],
    fallback: enabled && bool(env.NOX_CCXT_FALLBACK, true),
    spot: enabled && bool(env.NOX_CCXT_SPOT, true),
    timeoutMs: clamp(Number(env.NOX_CCXT_TIMEOUT_MS), 12_000, 3_000, 60_000),
    marketsTtlMs: clamp(Number(env.NOX_CCXT_MARKETS_TTL_MS), 30 * 60_000, 60_000, 12 * 3_600_000),
    ignored,
  };
}

function clamp(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export function isCcxtVenue(exchange: string, config: CcxtConfig = resolveCcxtConfig()): exchange is CcxtExchangeId {
  return config.enabled && (CCXT_EXCHANGE_IDS as readonly string[]).includes(exchange);
}

export function enabledCcxtVenues(config: CcxtConfig = resolveCcxtConfig()): CcxtExchangeId[] {
  return config.enabled ? config.venues : [];
}
