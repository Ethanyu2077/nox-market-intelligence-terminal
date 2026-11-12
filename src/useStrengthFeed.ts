import { useCallback, useEffect, useState } from 'react';
import { StrengthHistory, STRENGTH_WINDOW_MS, type WatchProject } from '../shared/strength-history';

/** Ingest the existing socket at full fidelity and render at the selected period's cadence. */
export function useStrengthFeed(projects: readonly WatchProject[], refreshMs: number) {
  const [history] = useState(() => new StrengthHistory(Date.now() - STRENGTH_WINDOW_MS));
  const [view, setView] = useState(() => history.snapshot(Date.now()));
  useEffect(() => { history.watch(projects); }, [history, projects]);
  const restore = useCallback((groups: readonly unknown[]) => history.restore(groups, Date.now()), [history]);
  const ingest = useCallback((ticks: readonly unknown[]) => history.ingest(ticks, Date.now()), [history]);

  useEffect(() => {
    if (!refreshMs) return;
    const refresh = () => { if (!document.hidden) setView(history.snapshot(Date.now())); };
    refresh();
    const timer = window.setInterval(refresh, refreshMs);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [history, refreshMs]);

  return { ...view, ingest, restore };
}
