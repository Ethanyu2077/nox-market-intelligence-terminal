import type { ProviderCheck } from '../shared/provider-crosscheck.ts';

interface NativeSnapshot { exchange: string; symbol: string; oiUsd: number | null; fundingRate: number | null; source?: string | null }
interface CoinGlassOi { exchange: string; oiUsd: number | null }
interface CoinGlassFunding { exchange: string; rateRaw: number | null }

const alias: Record<string, string> = { binance: 'binance', bybit: 'bybit', okx: 'okx', bitget: 'bitget', gate: 'gate', gateio: 'gate', kucoin: 'kucoin', mexc: 'mexc', bithumb: 'bithumb', upbit: 'upbit', aster: 'aster' };
const key = (exchange: string) => alias[exchange.trim().toLowerCase()] ?? exchange.trim().toLowerCase();

function status(native: number | null, coinGlass: number | null, divergencePct: number | null): ProviderCheck['status'] {
  if (native == null && coinGlass == null) return 'unavailable';
  if (coinGlass == null) return 'native-only';
  if (native == null) return 'coinglass-only';
  if (divergencePct == null) return 'unavailable';
  return divergencePct <= 5 ? 'agree' : 'diverge';
}

/** Compares only fields that exist on both sides; never overwrites native values. */
export function buildProviderChecks(projectId: string, native: NativeSnapshot[], oi: CoinGlassOi[] | null, funding: CoinGlassFunding[] | null): ProviderCheck[] {
  const nativeMap = new Map(native.map((row) => [key(row.exchange), row]));
  const cgOi = new Map((oi ?? []).map((row) => [key(row.exchange), row]));
  const cgFunding = new Map((funding ?? []).map((row) => [key(row.exchange), row]));
  const exchanges = new Set([...nativeMap.keys(), ...cgOi.keys(), ...cgFunding.keys()]);
  const checks: ProviderCheck[] = [];
  for (const exchange of exchanges) {
    const row = nativeMap.get(exchange);
    const symbol = row?.symbol ?? '';
    const nativeOi = row?.oiUsd ?? null;
    const cgOiValue = cgOi.get(exchange)?.oiUsd ?? null;
    const oiDivergence = nativeOi != null && cgOiValue != null && nativeOi + cgOiValue > 0
      ? Math.abs(nativeOi - cgOiValue) / ((nativeOi + cgOiValue) / 2) * 100 : null;
    checks.push({
      projectId, exchange, symbol, field: 'oiUsd', native: nativeOi, coinGlass: cgOiValue,
      divergencePct: oiDivergence == null ? null : Number(oiDivergence.toFixed(2)),
      status: status(nativeOi, cgOiValue, oiDivergence),
      nativeSource: row?.source ?? null, coinGlassSource: 'coinglass',
    });
    const nativeFunding = row?.fundingRate ?? null;
    const cgFundingValue = cgFunding.get(exchange)?.rateRaw ?? null;
    const fundingDivergence = nativeFunding != null && cgFundingValue != null
      ? Math.abs(nativeFunding - cgFundingValue) / Math.max(Math.abs(nativeFunding), Math.abs(cgFundingValue), 1e-9) * 100 : null;
    checks.push({
      projectId, exchange, symbol, field: 'fundingRate', native: nativeFunding, coinGlass: cgFundingValue,
      divergencePct: fundingDivergence == null ? null : Number(fundingDivergence.toFixed(2)),
      status: status(nativeFunding, cgFundingValue, fundingDivergence),
      nativeSource: row?.source ?? null, coinGlassSource: 'coinglass',
    });
  }
  return checks;
}
