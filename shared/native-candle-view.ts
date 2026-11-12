import type { NativeCandleUpdate } from './native-candles.ts';
import type { CandlePoint, ProjectMarket } from './types.ts';

const BAR_LIMIT = 120; // Matches the native history endpoints.

export function supportsNativeCandles(market: ProjectMarket | null | undefined) {
  return market?.marketType === 'perpetual' && (market.exchange === 'binance' || market.exchange === 'aster');
}

/** Keep absolute exchange revisions. Replaying a frame never adds its cumulative volume again. */
export function mergeCandleUpdates(current: readonly NativeCandleUpdate[], incoming: NativeCandleUpdate[]) {
  const byTime = new Map(current.map(update => [update.candle.time, update]));
  let changed = false;
  for (const update of incoming) {
    const prior = byTime.get(update.candle.time);
    if (prior) {
      if (prior.closed && !update.closed) continue;
      if (update.eventTime < prior.eventTime) continue;
      if (update.eventTime === prior.eventTime && prior.closed === update.closed &&
          update.candle.volumeBase <= prior.candle.volumeBase) continue;
    }
    byTime.set(update.candle.time, update);
    changed = true;
  }
  return changed ? [...byTime.values()].sort((a, b) => a.candle.time - b.candle.time).slice(-BAR_LIMIT) : current;
}

/** REST gives the history, including a possibly incomplete last candle. Compare cumulative
 * base volume within that bucket instead of REST response time, which can include cache age. */
export function nativeCandleView(history: CandlePoint[], updates: readonly NativeCandleUpdate[], replayAt: number | null = null) {
  if (!updates.length) return history;
  const byTime = new Map(history.map(point => [point.time, point]));
  const lastRest = history.at(-1)?.time;
  for (const { candle, closed, eventTime } of updates) {
    if (replayAt !== null && (!closed || eventTime > replayAt)) continue;
    const observed = byTime.get(candle.time);
    if (observed && !closed && (candle.time < (lastRest ?? 0) || candle.volumeBase < observed.volumeBase)) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a,b) => a.time - b.time).slice(-BAR_LIMIT);
}

/** A historical replay only has final OHLCV for bars that had already ended at the cursor. */
export function completedBy(candles: readonly CandlePoint[], asOf: number, periodMs: number) {
  return candles.filter(candle => candle.time + periodMs <= asOf);
}
