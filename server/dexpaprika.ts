import type { MarketProject, OnchainPoolSnapshot, OnchainProjectSnapshot } from '../shared/types.ts';

const API = 'https://api.dexpaprika.com';
const TIMEOUT = 10_000;
type Json = Record<string, unknown>;

const NETWORK_ALIASES: Record<string, string> = {
  eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum', sol: 'solana', solana: 'solana',
  bsc: 'bsc', binance: 'bsc', 'binance-smart-chain': 'bsc', polygon: 'polygon', matic: 'polygon', 'polygon-pos': 'polygon',
  arbitrum: 'arbitrum', arb: 'arbitrum', base: 'base', optimism: 'optimism', op: 'optimism',
  avalanche: 'avalanche', avax: 'avalanche', fantom: 'fantom', ftm: 'fantom',
  tron: 'tron', ton: 'ton', sui: 'sui', aptos: 'aptos', linea: 'linea', blast: 'blast',
  scroll: 'scroll', zksync: 'zksync', celo: 'celo', mantle: 'mantle', cronos: 'cronos',
};

export function normalizeDexPaprikaNetwork(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return NETWORK_ALIASES[normalized] ?? normalized;
}

function number(value: unknown): number | null {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'User-Agent': 'NOX-Market-Intelligence/0.3' },
  });
  if (!response.ok) throw new Error(`DexPaprika HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function resolveDexPaprikaIdentity(contractAddress: string) {
  const response = await json<Json>(`/search?query=${encodeURIComponent(contractAddress)}`);
  const tokens = Array.isArray(response.tokens) ? response.tokens as Json[] : [];
  const exact = tokens.find((token) => text(token.id) === contractAddress || (/^0x[0-9a-fA-F]{40}$/.test(contractAddress) && text(token.id)?.toLowerCase() === contractAddress.toLowerCase()));
  if (!exact || !text(exact.symbol)) throw new Error('DexPaprika did not resolve this contract address');
  return { symbol: text(exact.symbol)!.toUpperCase(), name: text(exact.name), network: text(exact.chain) };
}

function pairLabel(row: Json) {
  const tokens = Array.isArray(row.tokens) ? row.tokens as Json[] : [];
  const symbols = tokens.map((token) => text(token.symbol)).filter((value): value is string => Boolean(value));
  return symbols.length ? symbols.join('/') : 'Unknown pair';
}

export function normalizeOnchainPools(rows: Json[]): OnchainPoolSnapshot[] {
  return rows.map((row) => ({
    address: text(row.id) ?? '',
    dexId: text(row.dex_id) ?? '',
    dexName: text(row.dex_name) ?? text(row.dex_id) ?? 'Unknown DEX',
    network: text(row.chain) ?? '',
    pair: pairLabel(row),
    priceUsd: number(row.price_usd),
    liquidityUsd: number(row.liquidity_usd),
    volume24hUsd: number(row.volume_usd_24h),
    transactions24h: number(row.transactions_24h ?? row.txns_24h),
    priceChange24hPct: number(row.price_change_percentage_24h),
    fee: number(row.fee),
  }));
}

function unavailable(project: MarketProject, reason: string): OnchainProjectSnapshot {
  return {
    status: 'unavailable', reason, source: 'DexPaprika', network: normalizeDexPaprikaNetwork(project.identityNetwork),
    contractAddress: project.contractAddress, token: null, pools: [],
    coverage: { poolsReturned: 0, poolsWithLiquidity: 0, displayedLiquidityUsd: null, displayedVolume24hUsd: null },
    fetchedAt: Date.now(), methodology: [
      'On-chain context is requested only for projects saved with a confirmed contract address and network.',
      'Unavailable values remain null and are never inferred from centralized-exchange data.',
    ],
  };
}

async function loadProjectOnchainSnapshot(project: MarketProject): Promise<OnchainProjectSnapshot> {
  const network = normalizeDexPaprikaNetwork(project.identityNetwork);
  if (!project.contractAddress) return unavailable(project, 'Add and confirm a contract address to enable on-chain context.');
  if (!network) return unavailable(project, 'A confirmed blockchain network is required for on-chain context.');

  try {
    const address = encodeURIComponent(project.contractAddress);
    const [token, poolResponse] = await Promise.all([
      json<Json>(`/networks/${encodeURIComponent(network)}/tokens/${address}`),
      json<Json>(`/networks/${encodeURIComponent(network)}/pools/search?token_address=${address}&order_by=liquidity_usd&sort=desc&limit=8&detailed=true`),
    ]);
    const summary = (token.summary as Json | undefined) ?? {};
    const day = (summary['24h'] as Json | undefined) ?? {};
    const pools = normalizeOnchainPools(Array.isArray(poolResponse.results) ? poolResponse.results as Json[] : []);
    const liquidityRows = pools.filter((pool) => pool.liquidityUsd != null);
    const volumeRows = pools.filter((pool) => pool.volume24hUsd != null);
    return {
      status: 'available', reason: null, source: 'DexPaprika', network, contractAddress: project.contractAddress,
      token: {
        name: text(token.name), symbol: text(token.symbol), priceUsd: number(summary.price_usd),
        fdvUsd: number(summary.fdv ?? summary.fdv_usd), liquidityUsd: number(summary.liquidity_usd),
        volume24hUsd: number(day.volume_usd), buy24hUsd: number(day.buy_usd), sell24hUsd: number(day.sell_usd),
        transactions24h: number(day.txns), website: text(token.website), explorer: text(token.explorer),
      },
      pools,
      coverage: {
        poolsReturned: pools.length, poolsWithLiquidity: liquidityRows.length,
        displayedLiquidityUsd: liquidityRows.length ? liquidityRows.reduce((sum, pool) => sum + pool.liquidityUsd!, 0) : null,
        displayedVolume24hUsd: volumeRows.length ? volumeRows.reduce((sum, pool) => sum + pool.volume24hUsd!, 0) : null,
      },
      fetchedAt: Date.now(),
      methodology: [
        'Token totals and pool rows are observed public on-chain analytics from DexPaprika.',
        'Displayed pool totals cover only the returned top pools and must not be treated as global totals.',
        'DEX pool liquidity is separate from centralized-exchange order-book depth.',
        'Buy/sell values follow the upstream pool classification and are not wallet ownership or trader identity.',
      ],
    };
  } catch (error) {
    return unavailable(project, error instanceof Error ? error.message : 'DexPaprika data unavailable');
  }
}

const onchainCache=new Map<string,{until:number;value:OnchainProjectSnapshot}>();
const onchainPending=new Map<string,Promise<OnchainProjectSnapshot>>();
export async function getProjectOnchainSnapshot(project:MarketProject):Promise<OnchainProjectSnapshot>{
  const key=JSON.stringify([project.identityNetwork,project.contractAddress]);
  const cached=onchainCache.get(key);if(cached&&cached.until>Date.now())return cached.value;
  const pending=onchainPending.get(key);if(pending)return pending;
  const task=loadProjectOnchainSnapshot(project).then(value=>{if(onchainCache.size>=200)onchainCache.delete(onchainCache.keys().next().value!);onchainCache.set(key,{until:Date.now()+(value.status==='available'?30_000:10_000),value});return value;});
  onchainPending.set(key,task);try{return await task;}finally{onchainPending.delete(key);}
}
