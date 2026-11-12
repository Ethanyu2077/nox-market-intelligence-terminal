import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { NativeCandleFrame, NativeCandleUpdate } from '../shared/native-candles';
import { mergeCandleUpdates, nativeCandleView } from '../shared/native-candle-view';
import type { CandlePoint } from '../shared/types';
import type { TimeframeInterval } from '../shared/timeframe';
import { subscribeLiveChannel } from './live-channel';

export interface CandleScope {
  key: string;
  streaming: boolean;
  exchange: 'binance' | 'aster';
  symbol: string;
  interval: TimeframeInterval;
}
export const NativeCandleSource = createContext<CandleScope | null>(null);
const noUpdates: readonly NativeCandleUpdate[] = [];
const noHistory: CandlePoint[] = [];

export function useNativeCandles(history: CandlePoint[] = noHistory, enabled = true, replayAt: number | null = null) {
  const source = useContext(NativeCandleSource);
  const [live, setLive] = useState<{ key: string; updates: readonly NativeCandleUpdate[] }>();
  useEffect(() => {
    if (!enabled || !source?.streaming) return;
    const { key, exchange, symbol, interval } = source;
    let active = true;
    const stop = subscribeLiveChannel<NativeCandleFrame>('candles', {exchange, marketType: 'perpetual', symbol, interval}, frame => {
      if (!active || frame.exchange !== exchange || frame.marketType !== 'perpetual' ||
          frame.symbol !== symbol || frame.interval !== interval || !Array.isArray(frame.bars) || !frame.bars.length) return;
      setLive(previous => {
        const updates = mergeCandleUpdates(previous?.key === key ? previous.updates : noUpdates, frame.bars);
        return previous?.key === key && updates === previous.updates ? previous : {key, updates};
      });
    });
    return () => { active = false; stop(); };
  }, [source, enabled]);

  const updates = (enabled || replayAt !== null) && source?.streaming && live?.key === source.key ? live.updates : noUpdates;
  const candles = useMemo(() => nativeCandleView(history, updates, replayAt), [history, updates, replayAt]);
  return { candles, updatedAt: updates.at(-1)?.eventTime, source };
}
