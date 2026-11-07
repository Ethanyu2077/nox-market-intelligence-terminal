import type {KoreanSpotResponse} from './korean-spot.ts';
import type {CoinGlassResponse} from './coinglass.ts';
import type {Web3ProjectResponse} from './binance-web3.ts';
export type Quality = 'live' | 'stale' | 'partial' | 'unavailable';

export interface Instrument {
  id: string;
  venue: ExchangeId;
  marketType: 'spot' | 'perpetual';
  nativeSymbol: string;
  base: string;
  quote: string;
  settlement: string;
  contractType: string;
  status: string;
  tickSize: number;
  stepSize: number;
  contractMultiplier?: number;
}

/** Venues with a hand-written native adapter (REST + where available WebSocket). */
export const NATIVE_EXCHANGE_IDS = ['binance', 'bitget', 'bybit', 'okx', 'gate', 'kucoin', 'mexc', 'aster', 'upbit', 'bithumb'] as const;
/**
 * Venues served exclusively through CCXT. They are inert until enabled with
 * NOX_CCXT_VENUES, so discovery latency and UI clutter stay opt-in.
 */
export const CCXT_EXCHANGE_IDS = ['htx', 'bingx', 'phemex', 'bitfinex'] as const;
export const EXCHANGE_IDS = [...NATIVE_EXCHANGE_IDS, ...CCXT_EXCHANGE_IDS] as const;
export type ExchangeId = typeof EXCHANGE_IDS[number];
export type NativeExchangeId = typeof NATIVE_EXCHANGE_IDS[number];
export type CcxtExchangeId = typeof CCXT_EXCHANGE_IDS[number];
export type ExchangeSelection = 'aggregated' | ExchangeId;
export type ProjectMarketType = 'spot' | 'perpetual';

export interface ProjectMarket {
  id: string;
  exchange: ExchangeId;
  marketType: ProjectMarketType;
  symbol: string;
  base: string;
  quote: string;
  status: string;
}

export interface ExchangeCapabilities {
  exchange: ExchangeId;
  label: string;
  restDiscovery: boolean;
  restSnapshot: boolean;
  websocketTrades: boolean;
  websocketTicker: boolean;
  websocketOrderBook: boolean;
  historicalSeries: boolean;
  openInterest: boolean;
  funding: boolean;
  liquidations: boolean;
  /** 'native' = bespoke adapter with its own WS/HIST support; 'ccxt' = unified CCXT adapter. */
  transport: 'native' | 'ccxt';
  /** False for a CCXT venue that is not listed in NOX_CCXT_VENUES. */
  enabled: boolean;
  notes: string[];
}

export interface VenueMarketSnapshot {
  exchange: ExchangeId;
  symbol: string;
  marketType: ProjectMarketType;
  price: number | null;
  markPrice: number | null;
  change24hPct: number | null;
  volume24hBase: number | null;
  volume24hUsd: number | null;
  takerBuyVolumeUsd: number | null;
  takerSellVolumeUsd: number | null;
  volumeDeltaUsd: number | null;
  cvd: number | null;
  oiBase: number | null;
  oiUsd: number | null;
  oiDeltaBase: number | null;
  oiDeltaUsd: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  eventTime: number;
  fetchedAt: number;
  quality: Quality;
  source: string;
  unavailable: string[];
}

export interface AggregatedMarketSnapshot {
  exchange: 'aggregated';
  price: number | null;
  markPrice: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  oiBase: number | null;
  oiUsd: number | null;
  fundingRate: number | null;
  spreadBps: number | null;
  coverage: { requested: number; successful: number; fresh: number; venues: ExchangeId[] };
  eventTime: number | null;
  methodology: string[];
}

export interface ProjectVenueResponse {
  snapshots: VenueMarketSnapshot[];
  aggregate: AggregatedMarketSnapshot;
  contribution: ExchangeContributionSummary;
  insights: CrossExchangeInsight[];
  failures: Array<{ exchange: ExchangeId; symbol: string; message: string }>;
  capabilities: ExchangeCapabilities[];
}

export interface ExchangeContributionRow {
  exchange: ExchangeId;
  symbol: string;
  volume24hUsd: number | null;
  volumeSharePct: number | null;
  oiUsd: number | null;
  oiSharePct: number | null;
  oiChange1hUsd: number | null;
  netAggressiveVolumeUsd: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  totalDepthUsd: number | null;
  depthSharePct: number | null;
  fundingRate: number | null;
  freshness: Quality;
  eventTime: number;
}

export interface ExchangeContributionSummary {
  rows: ExchangeContributionRow[];
  totals: { volume24hUsd: number | null; oiUsd: number | null; totalDepthUsd: number | null };
  coverage: {
    selectedVenues: number;
    volumeVenues: number;
    oiVenues: number;
    oiChange1hVenues: number;
    aggressiveFlowVenues: number;
    depthVenues: number;
  };
  updatedAt: number | null;
  methodology: string[];
}

export type CrossExchangeInsightType = 'volume_concentration' | 'oi_concentration' | 'funding_divergence' | 'price_dispersion';
export interface CrossExchangeInsight {
  id: string;
  type: CrossExchangeInsightType;
  label: string;
  confidence: number;
  exchange: ExchangeId | null;
  observed: string[];
  evidence: string[];
  freshness: Quality;
  timestamp: number;
  inferenceNotice: string;
}

export interface ProjectMonitoringPreferences {
  collectionMode?: 'active' | 'standard' | 'paused';
  defaultInterval: '1m' | '5m' | '15m' | '1h' | '4h';
  streamingEnabled: boolean;
}

export interface MarketProject {
  id: string;
  name: string;
  tokenSymbol: string;
  contractAddress: string | null;
  identitySource: 'symbol' | 'contract';
  identityNetwork: string | null;
  markets: ProjectMarket[];
  primaryMarketId: string;
  monitoring: ProjectMonitoringPreferences;
  archived: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDiscoveryResult {
  query: string;
  identity: {
    symbol: string;
    name: string | null;
    contractAddress: string | null;
    network: string | null;
    source: 'symbol' | 'contract';
  };
  markets: ProjectMarket[];
  warnings: string[];
}

export interface OnchainPoolSnapshot {
  address: string;
  dexId: string;
  dexName: string;
  network: string;
  pair: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  transactions24h: number | null;
  priceChange24hPct: number | null;
  fee: number | null;
}

export interface OnchainProjectSnapshot {
  status: 'available' | 'unavailable';
  reason: string | null;
  source: 'DexPaprika';
  network: string | null;
  contractAddress: string | null;
  token: {
    name: string | null;
    symbol: string | null;
    priceUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    buy24hUsd: number | null;
    sell24hUsd: number | null;
    transactions24h: number | null;
    website: string | null;
    explorer: string | null;
  } | null;
  pools: OnchainPoolSnapshot[];
  coverage: {
    poolsReturned: number;
    poolsWithLiquidity: number;
    displayedLiquidityUsd: number | null;
    displayedVolume24hUsd: number | null;
  };
  fetchedAt: number;
  methodology: string[];
}

export interface ProjectResearchContext {
  schemaVersion: 'nox.research-context.v1';
  generatedAt: number;
  project: MarketProject;
  centralizedMarkets: ProjectVenueResponse;
  onchain: OnchainProjectSnapshot;
  web3?: Web3ProjectResponse;
  coinglass?: CoinGlassResponse;
  koreanSpot?: KoreanSpotResponse;
  interpretationBoundaries: string[];
}

export interface ScannerRow {
  symbol: string;
  base: string;
  price: number;
  change24hPct: number;
  volume24hBase: number;
  volume24hUsd: number;
  oiBase: number | null;
  oiUsd: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  high24h: number;
  low24h: number;
  trades24h: number;
  eventTime: number;
  quality: Quality;
}

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
  volumeUsd: number;
}

export interface LinePoint { time: number; value: number }
// `complete` is false when the venue/API window cuts the bucket (first/last buckets of the returned
// 1000-trade window are partial), so coverage gates cannot mistake truncated flow for full flow.
export interface CvdPoint extends LinePoint { delta: number; buyNotional: number; sellNotional: number; complete: boolean }

export interface OiDeltaPoint extends LinePoint {
  baseValue: number;
  /** USD OI is null when the venue did not return sumOpenInterestValue for that timestamp. */
  usdValue: number | null;
  deltaBase: number;
  /** Null when either side of the USD OI pair is unavailable; never filled with zero. */
  deltaUsd: number | null;
  pctBase: number;
  pctUsd: number | null;
  robustScore: number;
  spike: boolean;
}

export interface VolumeFlowPoint extends LinePoint {
  buyNotional: number;
  sellNotional: number;
  deltaNotional: number;
  imbalancePct: number;
  deltaChangePct: number | null;
  /** False when the bucket is truncated by the fetched trade-window boundary. */
  complete: boolean;
}

export type PositionSignalType =
  | 'potential_long_buildup'
  | 'potential_short_buildup'
  | 'potential_long_liquidation'
  | 'potential_short_covering'
  | 'market_absorption'
  | 'price_oi_delta_divergence';

export type SignalStatus = 'hypothesis' | 'withheld';

/** Explicit record of which required data actually existed when a label was produced. */
export interface SignalCoverage {
  /** Candle bars inside the OI window that the label should cover. */
  expectedWindowBars: number;
  /** Aggressor-flow buckets actually present inside that window. */
  flowBars: number;
  /** flowBars / expectedWindowBars; null when the window cannot be measured. */
  flowCoveragePct: number | null;
  /** Sequence-correct L2 depth is not collected in this version. */
  depth: 'unavailable';
  /** Per-event liquidations are not collected in this version. */
  liquidationEvents: 'unavailable';
}

export interface PositionFlowSignal {
  id: string;
  time: number;
  type: PositionSignalType;
  label: string;
  /** 'withheld' = pattern observed, but required data is missing so NO directional label is asserted. */
  status: SignalStatus;
  /** Rule score, never a calibrated probability. Kept explicit so the UI cannot call it a win rate. */
  confidence: number;
  confidenceBasis: 'heuristic-rule-uncalibrated';
  priceChangePct: number;
  oiDeltaBase: number;
  oiDeltaPct: number;
  volumeDeltaUsd: number | null;
  observed: string[];
  evidence: string[];
  counterevidence: string[];
  /** Alternative explanations that the same observations are compatible with. */
  alternatives: string[];
  /** Concrete future observations that would invalidate the label. */
  invalidation: string[];
  /** Required data that was missing when the label was evaluated. */
  missing: string[];
  coverage: SignalCoverage;
  withheldReason: string | null;
  freshness: Quality;
  inferenceNotice: string;
}

export interface BacktestResult {
  execution?: {
    version: 'nox-ledger-v1'; ruleVersion: 'position-flow-v3';
    feeBpsPerSide: number; slippageBpsPerSide: number;
    funding: 'unavailable'; samples: number;
    averageNetBeforeFundingPct: number | null; positiveAfterCostsPct: number | null; basis: string;
  };
  type: PositionSignalType;
  label: string;
  samples: number;
  resolvedSamples: number;
  /** Signals of this type suppressed by evidence gates; never counted as hits. */
  withheldSamples: number;
  hitRate: number | null;
  averageForwardReturnPct: number | null;
  /** Unconditional same-direction hit rate of the fetched window (descriptive baseline). */
  baselineHitRate: number | null;
  /** hitRate - baselineHitRate in percentage points; null when either is unavailable. */
  liftPct: number | null;
  /** Last 30% of resolved signals by time, evaluated chronologically as a descriptive holdout. */
  holdout: { samples: number; resolvedSamples: number; hitRate: number | null } | null;
  horizonBars: number;
  edgeStatement: string;
  caveat: string;
}

export interface PositionFlowAnalytics {
  oiInterval: string;
  requestedInterval: string;
  oiDelta: OiDeltaPoint[];
  volumeFlow: VolumeFlowPoint[];
  signals: PositionFlowSignal[];
  backtest: BacktestResult[];
  methodology: {
    oiSpikeRule: string;
    volumeDeltaRule: string;
    classificationRule: string;
    evidenceGateRule: string;
    reliabilityRule: string;
    oneMinuteOiNotice: string | null;
    forwardHorizonBars: number;
  };
}

export interface MarketSeries {
  symbol: string;
  interval: string;
  candles: CandlePoint[];
  oiBase: LinePoint[];
  oiUsd: LinePoint[];
  cvd: CvdPoint[];
  positionFlow: PositionFlowAnalytics;
  coverage: {
    candlesFrom: number | null;
    cvdFrom: number | null;
    tradeCount: number;
    cvdMethod: string;
    oiSource: string;
  };
  eventTime: number;
  source: string;
}

export interface Overview {
  symbol: string;
  /** Venue fields stay nullable: an unavailable metric is never substituted with zero. */
  price: number | null;
  markPrice: number | null;
  change24hPct: number | null;
  volume24hBase: number | null;
  volume24hUsd: number | null;
  oiBase: number | null;
  oiUsd: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  cvdWindowDelta: number | null;
  cvdWindowFrom: number | null;
  eventTime: number;
  source: string;
  quality: Quality;
  /** Top-of-book when the snapshot path fetched it; nullable and optional by design. */
  bid?: number | null;
  ask?: number | null;
}

export interface AlertRule {
  id: string;
  symbol: string;
  metric: 'price_change_24h' | 'funding_rate' | 'volume_24h_usd';
  operator: 'gt' | 'lt';
  threshold: number;
  enabled: boolean;
  createdAt: number;
  /** Restrict evaluation to one project; omitted/null = first project covering the symbol. */
  projectId?: string | null;
  /** Restrict to one venue; omitted/null = the project aggregate. */
  venue?: ExchangeId | null;
  /** Market type used with `venue`; omitted/null = the project's primary perpetual. */
  marketType?: ProjectMarketType | null;
  /** Evaluation cadence/granularity; cooldown is at least this window. */
  timeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | null;
}
