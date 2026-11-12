import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketProject } from '../../shared/types';
import { connectWatchLive } from '../watch-live-connection';
import { boardMarkets, mergeBoardPrices, updateBoardPrices, type BoardPrices } from '../../shared/watchlist-live-prices';
import type { ConnectionState, WatchlistQuote, WatchlistQuotesResponse } from '../../shared/watchlist';

/**
 * Combine the visible projects’ live prices with their periodically hydrated market metrics.
 */
export function useWatchlistQuotes(projects: readonly MarketProject[], onConnectionChange?: (state: ConnectionState) => void) {
  const [snapshots, setSnapshots] = useState<WatchlistQuote[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  const [prices, setPrices] = useState<BoardPrices>(() => new Map());
  const signature = JSON.stringify(boardMarkets(projects));
  const markets = useMemo<ReturnType<typeof boardMarkets>>(() => JSON.parse(signature), [signature]);
  useEffect(() => {
    let stop: (() => void) | undefined;
    const marketKeys = new Map(markets.map(m => [m.projectId, m.marketKey]));
    const reset = () => setPrices(current => updateBoardPrices(current, markets, [], Date.now(), false));
    function syncVisibility() {
      if (document.hidden || !markets.length) { stop?.(); stop = undefined; reset(); onConnectionChange?.('polling'); return; }
      if (stop) return;
      stop = connectWatchLive(markets.map(m => m.projectId), frame => {
        if (frame.channel === 'quotes' && Array.isArray(frame.ticks)) {
          const ticks = frame.ticks;
          setPrices(current => updateBoardPrices(current, markets, ticks, Date.now()));
        }
      }, state => { if (state !== 'live') reset(); }, { mode: 'board', marketKeys, onConnectionChange });
    }
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => { document.removeEventListener('visibilitychange', syncVisibility); stop?.(); };
  }, [markets, onConnectionChange]);

  const items = useMemo(() => mergeBoardPrices(snapshots, markets, prices), [snapshots, markets, prices]);
  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const response = await fetch('/api/watchlist/quotes', { signal: next.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Quote board unavailable (HTTP ${response.status})`);
      const body = (await response.json()) as WatchlistQuotesResponse;
      if (next.signal.aborted) return;
      setSnapshots(body.items);
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
