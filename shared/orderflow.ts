import type { ExchangeId, ProjectMarket } from './types.ts';

export const FLOW_INTERVALS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const;
export type FlowInterval = keyof typeof FLOW_INTERVALS;
export type FlowReset = 'window' | 'utc-day' | 'utc-hour';
export interface FlowTrade {
  id: string; exchange: ExchangeId; marketType: 'spot' | 'perpetual'; symbol: string;
  price: number; quantity: number; notional: number; side: 'buy' | 'sell'; time: number; source: 'rest' | 'websocket';
}
export interface FlowGap { from: number; to: number; reason: string }
export interface FlowBucket {
  time: number; buy: number | null; sell: number | null; delta: number | null; cvd: number | null;
  /** Base-asset quantity in the bucket (contract multipliers already applied by the adapters). */
  base: number | null;
  buyBase: number | null;
  sellBase: number | null;
  /** Base-weighted average trade price inside the bucket; null when no known base quantity. */
  vwap: number | null;
  high: number | null;
  low: number | null;
  /** Largest single observed print in the bucket (notional), for rough block/whale context. */
  maxTradeNotional: number | null;
  complete: boolean; count: number; zScore: number | null; reset: boolean;
}
export interface FlowVenue {
  key: string; market: ProjectMarket; state: 'connecting' | 'live' | 'partial' | 'stale' | 'unavailable';
  transport: string; lastTradeAt: number | null; checkedAt: number | null; coverageFrom: number | null; coverageTo: number | null;
  gaps: FlowGap[]; buckets: FlowBucket[]; warnings: string[]; retainedTrades: number;
}
export interface FlowSignal {
  id: string; label: string; classification: 'hypothesis'; confidence: number;
  evidence: string[]; missing: string[]; timestamp: number;
}
export interface LiquidationEvent {
  id: string; exchange: ExchangeId; symbol: string; time: number; orderSide: 'buy' | 'sell';
  liquidatedSide: 'long' | 'short'; price: number; quantity: number; notional: number;
}
export interface FlowTradeCluster {
  id: string; exchange: ExchangeId; marketType: 'spot' | 'perpetual'; symbol: string; side: 'buy' | 'sell';
  from: number; to: number; notional: number; quantity: number; tradeIds: string[];
}
export interface OrderFlowResponse {
  projectId: string; generatedAt: number; interval: FlowInterval; reset: FlowReset; unit: 'USDT';
  venues: FlowVenue[];
  aggregates: Record<'spot' | 'perpetual', { buckets: FlowBucket[]; requested: number; covered: number; keys: string[] }>;
  trades: FlowTrade[]; signals: FlowSignal[];
  tradeClusters: FlowTradeCluster[];
  liquidations: LiquidationEvent[];
  liquidationCoverage: Array<{ exchange: ExchangeId; symbol: string; state: string; note: string }>;
  methodology: string[];
}
