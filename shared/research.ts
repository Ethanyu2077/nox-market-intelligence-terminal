import type { ExchangeId, Quality } from './types.ts';

export interface ResearchClaim { text: string; sources: string[] }

/**
 * Dependency map for research metrics. Derived metrics must not be presented as independent
 * confirmations of each other: e.g. CVD is the cumulative sum of Volume Delta, so "Volume Delta
 * and CVD both positive" is one observation, not two.
 */
export interface MetricDependency {
  metric: string;
  role: 'observed' | 'derived' | 'cumulative';
  dependsOn: string[];
  duplicateOf: string[];
  caveat: string;
}

export const METRIC_DEPENDENCIES: MetricDependency[] = [
  { metric: 'price / markPrice', role: 'observed', dependsOn: [], duplicateOf: [], caveat: 'Venue-specific last/mark prices; not comparable across venues without event-time and freshness checks.' },
  { metric: 'volume24hBase / volume24hUsd', role: 'observed', dependsOn: [], duplicateOf: [], caveat: 'Venue 24H rolling windows are not tick-aligned; base and quote volume are different units.' },
  { metric: 'takerBuyVolumeUsd / takerSellVolumeUsd', role: 'derived', dependsOn: ['aggressor trade classification'], duplicateOf: ['volumeDeltaUsd'], caveat: 'Both sides and the delta come from the same aggressor flags; they are one data family.' },
  { metric: 'volumeDeltaUsd', role: 'derived', dependsOn: ['aggressor trade classification'], duplicateOf: ['takerBuyVolumeUsd / takerSellVolumeUsd'], caveat: 'Signed aggressor notional; venue maker/taker conventions differ.' },
  { metric: 'cvd', role: 'cumulative', dependsOn: ['volumeDeltaUsd'], duplicateOf: ['volumeDeltaUsd (different window only)'], caveat: 'Cumulative sum inside the fetched trade window; resets at window start and is NOT an independent confirmation of Volume Delta.' },
  { metric: 'oiBase', role: 'observed', dependsOn: ['venue contract normalization'], duplicateOf: [], caveat: 'Base quantity after contract multiplier; venue-reported and subject to venue snapshot timing.' },
  { metric: 'oiUsd', role: 'derived', dependsOn: ['oiBase', 'markPrice'], duplicateOf: [], caveat: 'Price-sensitive revaluation; a rise can be pure mark-price movement, not new positions.' },
  { metric: 'oiDeltaBase / oiDeltaUsd', role: 'derived', dependsOn: ['oiBase / oiUsd'], duplicateOf: [], caveat: 'Base delta is position-relevant; USD delta mixes price revaluation with position change. Neither equals Volume Delta.' },
  { metric: 'fundingRate', role: 'observed', dependsOn: [], duplicateOf: [], caveat: 'Venue-specific settlement interval and clamping rules; rates must never be summed across venues.' },
  { metric: 'spreadBps', role: 'derived', dependsOn: ['bid', 'ask'], duplicateOf: [], caveat: 'Computed from REST top-of-book; a snapshot, not sequence-correct L2 depth or executable size.' },
  { metric: 'spot volume vs perpetual volume (per venue)', role: 'derived', dependsOn: ['venue spot turnover', 'venue perpetual turnover'], duplicateOf: [], caveat: 'Only comparable when both legs exist on the same venue and quote; the ratio is context, not proof of spot-led or leverage-led price discovery.' },
  { metric: 'cross-venue aggregate (price/volume/OI/funding)', role: 'derived', dependsOn: ['venue rows'], duplicateOf: ['venue rows'], caveat: 'Shares are computed over covered selected venues only; the aggregate must not be added to venue rows or interpreted as the global market.' },
  { metric: 'CoinGlass aggregated OI/funding/liquidations vs native venue metrics', role: 'observed', dependsOn: ['third-party aggregation'], duplicateOf: ['native venue OI/funding/liquidation metrics'], caveat: 'Third-party aggregate and native venue metrics are separate sources; never add them together or treat one as independent confirmation of the other. Symbol matching does not resolve token identity.' },
  { metric: 'spotCvd vs perpCvd', role: 'derived', dependsOn: ['venue-specific aggressor trades'], duplicateOf: [], caveat: 'Spot and perpetual ledgers stay separate; same-sign flow does not establish leadership or causation.' },
  { metric: 'CoinGlass All row vs venue rows', role: 'observed', dependsOn: ['third-party aggregation'], duplicateOf: ['venue rows'], caveat: 'All rows aggregate venues; summing All with venue rows double-counts. Symbol matching does not resolve identity.' },
  { metric: 'DEX pool liquidity / Binance Web3 TVL', role: 'observed', dependsOn: ['provider pool coverage'], duplicateOf: [], caveat: 'On-chain pool totals cover returned pools only and are not CEX order-book depth.' }
];

/** Phenomena that public exchange/on-chain data cannot identify reliably, regardless of indicator count. */
export const NON_IDENTIFIABLE_PHENOMENA: string[] = [
  'Who opened or closed a position (long vs short ownership) from aggregate OI and trades.',
  'Whether an OI decline is ordinary deleveraging or forced liquidation without per-event liquidation data.',
  'Market absorption / liquidity recovery without sequence-correct L2 depth and replenishment data.',
  'Which venue leads a cross-venue move without tick-aligned timestamps and complete coverage.',
  'Counterparty identity, wallet ownership or "smart money" intent from vendor labels.',
  'Executable liquidity or slippage from REST top-of-book or DEX pool TVL.'
];

export interface ResearchReport {
  generatedAt: number; projectId: string; mode: 'evidence-only' | 'ai-assisted';
  observed: ResearchClaim[]; inferences: ResearchClaim[]; hypotheses: ResearchClaim[]; limitations: ResearchClaim[];
  sources: Array<{ id: string; venue: ExchangeId; symbol: string; source: string; eventTime: number; quality: Quality }>;
  tools: string[];
  metricDependencies: MetricDependency[];
  nonIdentifiable: string[];
}
export interface SignalEvent {
  schemaVersion: 'nox.signal.v1'; id: string; projectId: string; timestamp: number; observedAt: number;
  symbol: { base: string; quote: string; native: string; marketType: 'spot' | 'perpetual' };
  venue: ExchangeId; category: string; classification: 'statistical-inference';
  metrics: Record<string, { value: number; unit: string }>;
  evidence: ResearchClaim[]; confidence: number; severity: 'info' | 'warning' | 'critical'; freshness: Quality;
}
