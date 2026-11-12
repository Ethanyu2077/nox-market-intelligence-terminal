import { useCallback, useEffect, useState } from 'react';
import { StrengthHistory, STRENGTH_WINDOW_MS, type WatchProject } from '../shared/strength-history';

/** Collect on the overview's existing socket; copy data for plotting only while the chart is open. */
export function useStrengthFeed(projects: readonly WatchProject[], open: boolean) {
  const [history] = useState(() => new StrengthHistory(Date.now() - STRENGTH_WINDOW_MS));
  const [view, setView] = useState(() => history.snapshot(Date.now()));
  useEffect(() => { history.watch(projects); }, [history, projects]);
  const restore = useCallback((groups: readonly unknown[]) => history.restore(groups, Date.now()), [history]);
  const ingest = useCallback((ticks: readonly unknown[]) => history.ingest(ticks, Date.now()), [history]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => setView(history.snapshot(Date.now()));
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [history, open]);

  return { ...view, ingest, restore };
}
