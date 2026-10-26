import type { MarketProject } from "../shared/types.ts";
import type {
  DefiProduct,
  Web3Candle,
  Web3Interval,
  Web3Market,
  Web3Pool,
  Web3ProjectResponse,
  Web3Section,
} from "../shared/binance-web3.ts";
import { BinanceWeb3Client, Web3Error } from "./binance-web3-client.ts";
type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v != null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
export const numeric = (v: unknown): number | null => {
  if (v == null || v === "" || typeof v === "boolean" || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const decimal = (v: unknown) =>
  typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null;
const positive = (v: unknown) => {
  const n = numeric(v);
  return n != null && n >= 0 ? n : null;
};
export function web3ChainId(network: string | null): string | null {
  if (!network) return null;
  const v = network.trim().toLowerCase().replace(/_/g, "-");
  return (
    (
      {
        eth: "1",
        ethereum: "1",
        bsc: "56",
        bnb: "56",
        "binance-smart-chain": "56",
        base: "8453",
        arbitrum: "42161",
        "arbitrum-one": "42161",
        arb: "42161",
        polygon: "137",
        "polygon-pos": "137",
        matic: "137",
        optimism: "10",
        op: "10",
        avalanche: "43114",
        avax: "43114",
        "avalanche-c-chain": "43114",
        robinhood: "4663",
        katana: "747474",
        arc: "5042",
        sol: "CT_501",
        solana: "CT_501",
        "ct-501": "CT_501",
      } as Record<string, string>
    )[v] ?? (/^\d+$/.test(v) ? v : null)
  );
}
export function normalizeWeb3Market(value: unknown): Web3Market {
  const r = row(value);
  return {
    priceUsd: positive(r.price),
    marketCapUsd: positive(r.marketCap),
    liquidityUsd: positive(r.liquidity),
    holders: positive(r.holders),
    windows: (["5M", "1H", "4H", "24H"] as const).map((window) => {
      const buyUsd = positive(r["buyVolume" + window]),
        sellUsd = positive(r["sellVolume" + window]);
      return {
        window,
        changePct: numeric(r["priceChange" + window]),
        volumeUsd: positive(r["volume" + window]),
        buyUsd,
        sellUsd,
        deltaUsd: buyUsd != null && sellUsd != null ? buyUsd - sellUsd : null,
        transactions: positive(r["txs" + window]),
      };
    }),
  };
}
export function normalizeWeb3Candles(
  value: unknown,
  now = Date.now(),
): Web3Candle[] {
  const result = new Map<number, Web3Candle>();
  for (const v of Array.isArray(value) ? value : []) {
    if (!Array.isArray(v)) continue;
    const [open, high, low, close, volume, time, transactions] = v.map(numeric);
    if (
      [open, high, low, close, time].some((n) => n == null) ||
      time! < 1e12 ||
      time! > now ||
      low! <= 0 ||
      high! < Math.max(open!, close!) ||
      low! > Math.min(open!, close!) ||
      high! < low!
    )
      continue;
    result.set(time!, {
      time: time!,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume != null && volume >= 0 ? volume : null,
      transactions:
        transactions != null && transactions >= 0 ? transactions : null,
    });
  }
  return [...result.values()].sort((a, b) => a.time - b.time);
}
export function normalizeWeb3Pools(value: unknown): Web3Pool[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((v) => {
    const r = row(v),
      address = text(r.poolAddress);
    if (!address || seen.has(address.toLowerCase())) return [];
    seen.add(address.toLowerCase());
    return [
      {
        address,
        name: text(r.pool) ?? address,
        protocol: text(r.protocolName),
        liquidityUsd: decimal(r.liquidityUsd),
        tokens: (Array.isArray(r.liquidityAmount) ? r.liquidityAmount : []).map(
          (t) => {
            const x = row(t);
            return {
              symbol: text(x.tokenSymbol),
              address: text(x.tokenContractAddress),
              amount: decimal(x.tokenAmount),
            };
          },
        ),
      },
    ];
  });
}
export function normalizeDefiProducts(
  value: unknown,
  chainId: string,
  type: "Earn" | "LiquidityPool",
): DefiProduct[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((v) => {
    const r = row(v),
      id = text(r.investmentId);
    if (
      !id ||
      r.binanceChainId !== chainId ||
      r.investType !== type ||
      seen.has(id)
    )
      return [];
    seen.add(id);
    const bps = numeric(r.apyBps);
    return [
      {
        id,
        chainId,
        protocolId: text(r.defiProtocolId) ?? "",
        protocolName: text(r.protocolName),
        name: text(r.investmentName),
        type,
        apyType: text(r.apyType),
        apyBps: bps != null && Number.isSafeInteger(bps) ? bps : null,
        apyDisplay: text(r.apyDisplay),
        tvlUsd: decimal(r.tvl),
      },
    ];
  });
}
const DEFI_CHAINS = new Set([
  "1",
  "56",
  "8453",
  "42161",
  "137",
  "10",
  "43114",
  "4663",
  "747474",
  "5042",
]);
function unavailable<T>(
  state: Web3Section<T>["state"],
  reason: string,
): Web3Section<T> {
  return {
    state,
    data: null,
    reason,
    sourceTime: null,
    fetchedAt: null,
    freshness: "unknown",
  };
}
export class BinanceWeb3Service {
  constructor(private client = new BinanceWeb3Client()) {}
  get configured() {
    return this.client.configured;
  }
  async project(
    project: MarketProject,
    interval: Web3Interval = "5m",
    page = 1,
  ): Promise<Web3ProjectResponse> {
    const chainId = web3ChainId(project.identityNetwork),
      address = project.contractAddress;
    const missing = !this.client.configured
      ? "not-configured"
      : !chainId || !address
        ? "identity-required"
        : null;
    const blocked = <T>(): Web3Section<T> =>
      unavailable(
        missing === "not-configured" ? "not-configured" : "unsupported",
        missing ?? "unsupported-chain",
      );
    const result: Web3ProjectResponse = {
      projectId: project.id,
      source: "Binance Web3",
      chainId,
      contractAddress: address,
      interval,
      generatedAt: Date.now(),
      configured: this.configured,
      market: blocked(),
      candles: blocked(),
      pools: blocked(),
      earn: blocked(),
      liquidity: blocked(),
      limitations: [
        "Binance Web3 is separate from Binance USDT-M Futures; DEX data is not included in CEX OI, funding or CVD aggregation.",
        "Only the saved contract and chain are queried. DeFi products are token-filtered, paginated and not investment recommendations.",
        "APY/APR display strings and TVL decimal strings retain upstream precision. TVL is not order-book depth.",
        "Buy/sell windows use provider classifications; overlapping rolling windows do not form a valid CVD series.",
        "Candle volume units are not confirmed in the documentation and are not treated as USD.",
        "No wallets, positions, swap, approvals, transaction construction or broadcasting endpoints are exposed.",
      ],
    };
    if (missing) return result;
    try {
      const chains = await this.client.request(
        "/api/v1/dex/market/supported/chain",
        {},
        3_600_000,
      );
      if(!Array.isArray(chains.data))throw new Web3Error('invalid-response');
      const supported = chains.data.some(
        (v) => row(v).binanceChainId === chainId,
      );
      if (!supported) {
        for (const field of [
          "market",
          "candles",
          "pools",
          "earn",
          "liquidity",
        ] as const)
          result[field] = unavailable("unsupported", "unsupported-chain");
        return result;
      }
    } catch (e) {
      const reason = e instanceof Web3Error ? e.code : "upstream-unavailable";
      for (const field of [
        "market",
        "candles",
        "pools",
        "earn",
        "liquidity",
      ] as const)
        result[field] = unavailable("error", reason);
      return result;
    }
    const identity = {
      binanceChainId: chainId!,
      tokenContractAddress: address!,
    };
    const section = async <T>(
      request: () => ReturnType<BinanceWeb3Client["request"]>,
      convert: (data: unknown) => T,
      isEmpty: (v: T) => boolean,
      sourceTime?: (data: unknown) => number | null,
    ): Promise<Web3Section<T>> => {
      try {
        const response = await request(),
          data = convert(response.data),
          time = sourceTime ? sourceTime(response.data) : response.timestamp;
        return {
          state: isEmpty(data) ? "empty" : "available",
          data,
          reason: null,
          sourceTime: time,
          fetchedAt: response.fetchedAt,
          freshness:
            time == null
              ? "unknown"
              : Date.now() - time > 120_000 || time > Date.now() + 5000
                ? "stale"
                : "fresh",
        };
      } catch (e) {
        return unavailable(
          "error",
          e instanceof Web3Error ? e.code : "invalid-response",
        );
      }
    };
    const exact = (data: unknown) =>
      (Array.isArray(data) ? data : []).find((v) => {
        const r = row(v);
        return (
          r.binanceChainId === chainId &&
          (chainId === "CT_501"
            ? r.tokenContractAddress === address
            : text(r.tokenContractAddress)?.toLowerCase() ===
              address!.toLowerCase())
        );
      });
    const defi = (type: "Earn" | "LiquidityPool") =>
      DEFI_CHAINS.has(chainId!)
        ? section(
            () =>
              this.client.request(
                "/api/v1/defi/data/investment/list",
                {
                  investType: type,
                  binanceChainId: chainId!,
                  tokenAddressList: [address!],
                  page,
                  size: 20,
                  sortField: "tvl",
                  sortDirection: "DESC",
                },
                300_000,
              ),
            (data) => ({
              items: normalizeDefiProducts(row(data).list, chainId!, type),
              page,
              total: positive(row(data).total),
            }),
            (v) => !v.items.length,
          )
        : Promise.resolve(
            unavailable<{
              items: DefiProduct[];
              page: number;
              total: number | null;
            }>("unsupported", "defi-chain-unsupported"),
          );
    [
      result.market,
      result.candles,
      result.pools,
      result.earn,
      result.liquidity,
    ] = await Promise.all([
      section(
        () => this.client.request("/api/v1/dex/market/price-info", [identity]),
        (data) => normalizeWeb3Market(exact(data)),
        (v) =>
          [v.priceUsd,v.marketCapUsd,v.liquidityUsd,v.holders,...v.windows.flatMap(w=>[w.changePct,w.volumeUsd,w.buyUsd,w.sellUsd,w.transactions])].every(x=>x==null),
        (data) => positive(row(exact(data)).time),
      ),
      section(
        () =>
          this.client.request("/api/v1/dex/market/candles", {
            ...identity,
            bar: interval,
            limit: "200",
          }),
        (data) => normalizeWeb3Candles(data),
        (v) => !v.length,
      ),
      section(
        () =>
          this.client.request(
            "/api/v1/dex/market/token/top-liquidity",
            identity,
          ),
        normalizeWeb3Pools,
        (v) => !v.length,
      ),
      defi("Earn"),
      defi("LiquidityPool"),
    ]);
    return result;
  }
}
