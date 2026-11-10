/** Field-level provenance and native-vs-aggregator comparison. */
export type CheckStatus = 'agree' | 'diverge' | 'native-only' | 'coinglass-only' | 'unavailable';

export interface ProviderCheck {
  projectId: string;
  exchange: string;
  symbol: string;
  field: 'oiUsd' | 'fundingRate';
  native: number | null;
  coinGlass: number | null;
  divergencePct: number | null;
  status: CheckStatus;
  nativeSource: string | null;
  coinGlassSource: 'coinglass';
}
