import type { TimeframeInterval } from './timeframe.ts';
import type { CandlePoint } from './types.ts';

export interface NativeCandleMarket {
  exchange: 'binance' | 'aster';
  marketType: 'perpetual';
  symbol: string;
  interval: TimeframeInterval;
}

export interface NativeCandleUpdate {
  candle: CandlePoint;
  eventTime: number;
  closed: boolean;
}

export interface NativeCandleFrame extends NativeCandleMarket {
  bars: NativeCandleUpdate[];
}
