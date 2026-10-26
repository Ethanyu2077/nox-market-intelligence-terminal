export type Web3Interval = "1m" | "5m" | "15m" | "1h" | "4h";
export interface Web3Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  transactions: number | null;
}
export interface Web3Market {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  windows: Array<{
    window: "5M" | "1H" | "4H" | "24H";
    changePct: number | null;
    volumeUsd: number | null;
    buyUsd: number | null;
    sellUsd: number | null;
    deltaUsd: number | null;
    transactions: number | null;
  }>;
}
export interface Web3Pool {
  address: string;
  name: string;
  protocol: string | null;
  liquidityUsd: string | null;
  tokens: Array<{
    symbol: string | null;
    address: string | null;
    amount: string | null;
  }>;
}
export interface DefiProduct {
  id: string;
  chainId: string;
  protocolId: string;
  protocolName: string | null;
  name: string | null;
  type: "Earn" | "LiquidityPool";
  apyType: string | null;
  apyBps: number | null;
  apyDisplay: string | null;
  tvlUsd: string | null;
}
export interface Web3Section<T> {
  state: "available" | "empty" | "not-configured" | "unsupported" | "error";
  data: T | null;
  reason: string | null;
  sourceTime: number | null;
  fetchedAt: number | null;
  freshness: "fresh" | "stale" | "unknown";
}
export interface Web3ProjectResponse {
  projectId: string;
  source: "Binance Web3";
  chainId: string | null;
  contractAddress: string | null;
  interval: Web3Interval;
  generatedAt: number;
  configured: boolean;
  market: Web3Section<Web3Market>;
  candles: Web3Section<Web3Candle[]>;
  pools: Web3Section<Web3Pool[]>;
  earn: Web3Section<{
    items: DefiProduct[];
    page: number;
    total: number | null;
  }>;
  liquidity: Web3Section<{
    items: DefiProduct[];
    page: number;
    total: number | null;
  }>;
  limitations: string[];
}
