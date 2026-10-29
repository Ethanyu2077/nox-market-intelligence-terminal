export interface CoinGlassSection<T> {
  state: 'available' | 'empty' | 'not-configured' | 'unsupported' | 'error';
  data: T | null;
  reason: string | null;
  fetchedAt: number | null;
  sourceTime: null;
}
export interface CoinGlassOi { exchange: string; oiUsd: number | null; change1hPct: number | null; change24hPct: number | null; changes: Record<string,number|null> }
export interface CoinGlassFunding { exchange: string; margin: 'stablecoin' | 'coin'; rateRaw: number | null; intervalHours: number | null; nextFundingTime: number | null }
export interface CoinGlassLiquidation { exchange: string; totalUsd: number | null; longUsd: number | null; shortUsd: number | null }
export interface CoinGlassResponse {
  projectId: string; source: 'CoinGlass'; configured: boolean; symbol: string; range: '4h' | '12h' | '24h'; generatedAt: number;
  identity: 'symbol-only';
  oi: CoinGlassSection<CoinGlassOi[]>;
  flow: CoinGlassSection<CoinGlassFlow[]>;
  history?: {interval:string;oi:CoinGlassSection<CoinGlassHistoryBar[]>;funding:CoinGlassSection<CoinGlassHistoryBar[]>};
  funding: CoinGlassSection<CoinGlassFunding[]>;
  liquidations: CoinGlassSection<CoinGlassLiquidation[]>;
}
export interface CoinGlassFlow {exchange:string;buyUsd:number|null;sellUsd:number|null;deltaUsd:number|null;buyPct:number|null;sellPct:number|null}
export interface CoinGlassHistoryBar {time:number;open:number;high:number;low:number;close:number}

