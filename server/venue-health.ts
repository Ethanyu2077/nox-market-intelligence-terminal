import type { ExchangeId } from '../shared/types.ts';
import type { DataFamily } from '../shared/capabilities.ts';

/**
 * Per-venue circuit breaker.
 *
 * A venue that is rate-limited or down should not be hammered by every poller. After a
 * few consecutive failures the breaker opens for a cooldown, then allows a single probe.
 * Success closes it; another failure doubles the cooldown (capped).
 *
 * This only governs the *native* adapter: when the breaker is open, marketSnapshot fails
 * fast and the CCXT fallback (if enabled) still gets a chance.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

/** Independent breaker per endpoint family so a depth outage cannot stop snapshots. */
export type { DataFamily } from '../shared/capabilities.ts';

export interface VenueHealth {
  exchange: ExchangeId;
  family: DataFamily;
  state: BreakerState;
  consecutiveFailures: number;
  failures: number;
  successes: number;
  openedUntil: number | null;
  cooldownMs: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

interface Entry {
  failures: number;
  consecutive: number;
  successes: number;
  openedUntil: number;
  cooldownMs: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  probeStartedAt: number | null;
}

const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const FAILURE_THRESHOLD = 3;

export class VenueBreakers {
  private entries = new Map<string, Entry>();

  private key(exchange: ExchangeId, family: DataFamily): string { return `${exchange}:${family}`; }

  constructor(private now: () => number = Date.now) {}

  private entry(exchange: ExchangeId, family: DataFamily): Entry {
    const key = this.key(exchange, family);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: 0, consecutive: 0, successes: 0, openedUntil: 0, cooldownMs: BASE_COOLDOWN_MS, lastError: null, lastFailureAt: null, lastSuccessAt: null, probeStartedAt: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Whether a native request may be attempted right now. */
  allow(exchange: ExchangeId, family: DataFamily = 'snapshot'): boolean {
    const entry = this.entry(exchange, family);
    if (entry.openedUntil === 0) return true;
    if (this.now() < entry.openedUntil) return false;
    // Cooldown elapsed: allow exactly one probe at a time (half-open).
    if (entry.probeStartedAt != null && this.now() - entry.probeStartedAt < 15_000) return false;
    entry.probeStartedAt = this.now();
    return true;
  }

  success(exchange: ExchangeId, family: DataFamily = 'snapshot'): void {
    const entry = this.entry(exchange, family);
    entry.successes += 1;
    entry.consecutive = 0;
    entry.openedUntil = 0;
    entry.cooldownMs = BASE_COOLDOWN_MS;
    entry.lastSuccessAt = this.now();
    entry.probeStartedAt = null;
  }

  failure(exchange: ExchangeId, reason: string, family: DataFamily = 'snapshot'): void {
    const entry = this.entry(exchange, family);
    entry.failures += 1;
    entry.consecutive += 1;
    entry.lastError = reason.slice(0, 240);
    entry.lastFailureAt = this.now();
    entry.probeStartedAt = null;
    if (entry.consecutive >= FAILURE_THRESHOLD) {
      entry.openedUntil = this.now() + entry.cooldownMs;
      entry.cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.round(entry.cooldownMs * 1.8));
      entry.consecutive = 0;
    }
  }

  state(exchange: ExchangeId, family: DataFamily = 'snapshot'): BreakerState {
    const entry = this.entries.get(this.key(exchange, family));
    if (!entry || entry.openedUntil === 0) return 'closed';
    return this.now() < entry.openedUntil ? 'open' : 'half-open';
  }

  snapshot(): VenueHealth[] {
    return [...this.entries.entries()].map(([key, entry]) => {
      const [exchange, family] = key.split(':') as [ExchangeId, DataFamily];
      return {
      exchange,
      family,
      state: this.state(exchange, family),
      consecutiveFailures: entry.consecutive,
      failures: entry.failures,
      successes: entry.successes,
      openedUntil: entry.openedUntil || null,
      cooldownMs: entry.cooldownMs,
      lastError: entry.lastError,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      };
    });
  }

  /** Test hook. */
  reset(): void {
    this.entries.clear();
  }
}

/** Process-wide breakers shared by the API routes and the collector. */
export const venueBreakers = new VenueBreakers();
