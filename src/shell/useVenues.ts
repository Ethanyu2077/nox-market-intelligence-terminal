import { useEffect, useState } from 'react';
import type { ExchangeCapabilities } from '../../shared/types';
import type { VenueOption } from './MarketBar';

/**
 * Venue picker options come from the server, not a hard-coded list: CCXT venues are
 * enabled per deployment through NOX_CCXT_VENUES and must disappear when disabled.
 */
export function useVenues(): VenueOption[] {
  const [options, setOptions] = useState<VenueOption[]>([{ id: 'aggregated', label: 'Aggregated', transport: 'aggregate', ws: false }]);
  useEffect(() => {
    let active = true;
    fetch('/api/exchanges', { headers: { Accept: 'application/json' } })
      .then((response) => response.json())
      .then((body: { items?: ExchangeCapabilities[] }) => {
        if (!active) return;
        const rows = (body.items ?? []).filter((item) => item.enabled && item.restSnapshot);
        setOptions([
          { id: 'aggregated', label: 'Aggregated', transport: 'aggregate', ws: false },
          ...rows.map((item) => ({ id: item.exchange, label: item.label, transport: item.transport, ws: item.websocketTicker || item.websocketTrades })),
        ]);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return options;
}
