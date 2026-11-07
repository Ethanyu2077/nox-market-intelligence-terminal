import { useCallback, useEffect, useRef, useState } from 'react';
import type { WatchlistQuote, WatchlistQuotesResponse } from '../../shared/watchlist';

/**
 * Poll hydrated watchlist quotes. Pauses while the tab is hidden and keeps the previous
 * values on a failed refresh (with `stale` set) instead of blanking the board.
 */
export function useWatchlistQuotes() {
  const [items, setItems] = useState<WatchlistQuote[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const response = await fetch('/api/watchlist/quotes', { signal: next.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Quote board unavailable (HTTP ${response.status})`);
      const body = (await response.json()) as WatchlistQuotesResponse;
      setItems(body.items);
      setAsOf(body.asOf);
      setError('');
    } catch (cause) {
      if (next.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Quote board unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); controller.current?.abort(); };
  }, [load]);

  return { items, asOf, error, reload: load };
}
