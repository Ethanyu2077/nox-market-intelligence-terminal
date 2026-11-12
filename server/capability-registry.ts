import type { CapabilityRegistry, CapabilityRow, CoverageState, DataFamily } from '../shared/capabilities.ts';
import { DATA_FAMILIES } from '../shared/capabilities.ts';
import type { ExchangeId } from '../shared/types.ts';
import { enabledCcxtVenues, resolveCcxtConfig } from './ccxt/config.ts';
import { exchangeCapabilities } from './exchanges.ts';
import { isDepthVenue } from './orderbook.ts';
import { venueBreakers } from './venue-health.ts';

/**
 * Single source of truth for "what data can this deployment actually get, right now".
 *
 * Static support comes from the venue adapters; live coverage comes from the per-family
 * circuit breakers. UI pages and research modules should consult this instead of each
 * hard-coding their own capability lists.
 */

/** Venues with a normalised aggressor tape. Aster supports USDⓈ-M perpetuals. */
const FLOW_VENUES = new Set<ExchangeId>(['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin', 'aster']);
/** Venues with a public liquidation stream (Gate requires credentials, so excluded). */
export const LIQUIDATION_VENUES = new Set<ExchangeId>(['binance', 'bybit', 'okx']);

const FAMILY_NOTES: Record<DataFamily, string[]> = {
  discovery: [],
  snapshot: [],
  series: ['Native candles and aggressor trades; Aster has no historical OI endpoint, so OI history stays empty.'],
  depth: ['REST depth snapshot (top 5–50 levels). Not a sequenced L2 feed; hidden/iceberg size is not observable.'],
  flow: ['Aggressor-side tape from REST recovery + WebSocket overlap; MEXC and CCXT-only venues are excluded.'],
  liquidation: ['Public, venue-throttled partial feed. Silence is not evidence of no liquidation.'],
};

function coverageFor(exchange: ExchangeId, family: DataFamily): CapabilityRow['coverage'] {
  const row = venueBreakers.snapshot().find((item) => item.exchange === exchange && item.family === family);
  if (!row) return { state: 'unknown', cooldownUntil: null, lastSuccessAt: null, lastFailureAt: null, lastError: null };
  const state: CoverageState = row.state === 'open' ? 'unavailable' : row.state === 'half-open' ? 'degraded' : row.lastFailureAt && (!row.lastSuccessAt || row.lastFailureAt > row.lastSuccessAt) ? 'degraded' : 'live';
  return {
    state,
    cooldownUntil: row.openedUntil,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastError: row.lastError,
  };
}

export function capabilityRegistry(now = Date.now(), env: NodeJS.ProcessEnv = process.env): CapabilityRegistry {
  const config = resolveCcxtConfig(env);
  const enabledCcxt = new Set(enabledCcxtVenues(config));
  const rows: CapabilityRow[] = [];

  for (const capability of exchangeCapabilities()) {
    if (!capability.enabled) continue;
    const venue = capability.exchange;
    const isCcxt = capability.transport === 'ccxt';
    const support: Record<DataFamily, boolean> = {
      discovery: capability.restDiscovery,
      snapshot: capability.restSnapshot,
      series: capability.historicalSeries,
      depth: isDepthVenue(venue),
      flow: FLOW_VENUES.has(venue),
      liquidation: LIQUIDATION_VENUES.has(venue),
    };
    for (const family of DATA_FAMILIES) {
      rows.push({
        venue,
        family,
        supported: support[family],
        transport: support[family] ? (isCcxt ? 'ccxt' : 'native') : 'none',
        coverage: support[family] ? coverageFor(venue, family) : { state: 'unavailable', cooldownUntil: null, lastSuccessAt: null, lastFailureAt: null, lastError: 'Not implemented for this venue' },
        notes: [
          ...(venue === 'aster' && family === 'flow' ? ['Aster USDⓈ-M perpetual trades.'] : []),
          ...(isCcxt ? ['Served through the CCXT adapter (quote/OI/funding only).'] : []),
          ...FAMILY_NOTES[family],
          ...capability.notes.filter((note) => family === 'snapshot' && /openInterest|no historical|WebSocket/i.test(note)),
        ],
      });
    }
    void enabledCcxt;
  }

  return { generatedAt: now, families: DATA_FAMILIES, rows };
}
