import type {
  MarketProject,
  ProjectMarket,
  VenueMarketSnapshot,
} from "../shared/types.ts";
import type { BinanceExchangeResponse } from "../shared/binance-exchange.ts";
import { marketSnapshot } from "./exchanges.ts";
type Json = Record<string, unknown>;
const n = (v: unknown) =>
  v == null || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v))
    ? null
    : Number(v);
export function normalizeBinanceSpot(
  market: ProjectMarket,
  ticker: Json,
  book: Json,
  now = Date.now(),
): VenueMarketSnapshot {
  if (ticker.symbol !== market.symbol)
    throw new Error("Binance spot identity mismatch");
  const bid = book.symbol === market.symbol ? n(book.bidPrice) : null,
    ask = book.symbol === market.symbol ? n(book.askPrice) : null;
  const time = n(ticker.closeTime),
    price = n(ticker.lastPrice);
  return {
    exchange: "binance",
    symbol: market.symbol,
    marketType: "spot",
    price,
    markPrice: null,
    change24hPct: n(ticker.priceChangePercent),
    volume24hBase: n(ticker.volume),
    volume24hUsd: market.quote === "USDT" ? n(ticker.quoteVolume) : null,
    takerBuyVolumeUsd: null,
    takerSellVolumeUsd: null,
    volumeDeltaUsd: null,
    cvd: null,
    oiBase: null,
    oiUsd: null,
    oiDeltaBase: null,
    oiDeltaUsd: null,
    fundingRate: null,
    nextFundingTime: null,
    bid,
    ask,
    spreadBps:
      bid != null && ask != null && bid > 0 && ask >= bid
        ? ((ask - bid) / ((ask + bid) / 2)) * 10_000
        : null,
    eventTime: time ?? 0,
    fetchedAt: now,
    quality:
      time == null || price == null
        ? "partial"
        : now - time > 60_000 || time > now + 5_000
          ? "stale"
          : "live",
    source: "Binance Spot public REST (24h ticker + bookTicker)",
    unavailable: [
      "markPrice",
      "takerBuyVolumeUsd",
      "takerSellVolumeUsd",
      "volumeDeltaUsd",
      "cvd",
      "oiBase",
      "oiUsd",
      "oiDeltaBase",
      "oiDeltaUsd",
      "fundingRate",
      "nextFundingTime",
    ],
  };
}
export class BinanceExchangeService {
  private cache = new Map<
    string,
    { until: number; value: BinanceExchangeResponse["items"][number] }
  >();
  private pending = new Map<
    string,
    Promise<BinanceExchangeResponse["items"][number]>
  >();
  constructor(
    private transport: typeof fetch = fetch,
    private perpetual = marketSnapshot,
  ) {}
  private async get(base: string, path: string): Promise<Json> {
    const response = await this.transport(base + path, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok)
      throw new Error(`Binance exchange HTTP ${response.status}`);
    return response.json() as Promise<Json>;
  }
  private async snapshot(market: ProjectMarket) {
    const key = JSON.stringify([
        market.marketType,
        market.symbol,
        market.quote,
      ]),
      cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return { ...cached.value, market };
    const pending = this.pending.get(key);
    if (pending) return { ...(await pending), market };
    const task = (async () => {
      const symbol = encodeURIComponent(market.symbol);
      let snapshot: VenueMarketSnapshot, volume24hQuote: number | null;
      if (market.marketType === "spot") {
        const base =
          process.env.BINANCE_SPOT_REST_BASE ??
          "https://data-api.binance.vision";
        const [ticker, book] = await Promise.all([
          this.get(base, `/api/v3/ticker/24hr?symbol=${symbol}`),
          this.get(base, `/api/v3/ticker/bookTicker?symbol=${symbol}`).catch(
            () => ({}),
          ),
        ]);
        snapshot = normalizeBinanceSpot(market, ticker, book);
        volume24hQuote = n(ticker.quoteVolume);
      } else {
        const [existing, book] = await Promise.all([
          this.perpetual(market),
          this.get(
            process.env.BINANCE_REST_BASE ?? "https://fapi.binance.com",
            `/fapi/v1/ticker/bookTicker?symbol=${symbol}`,
          ).catch(() => ({}) as Json),
        ]);
        const bid = book.symbol === market.symbol ? n(book.bidPrice) : null,
          ask = book.symbol === market.symbol ? n(book.askPrice) : null;
        snapshot = {
          ...existing,
          bid,
          ask,
          spreadBps:
            bid != null && ask != null && bid > 0 && ask >= bid
              ? ((ask - bid) / ((ask + bid) / 2)) * 10_000
              : null,
        };
        volume24hQuote = existing.volume24hUsd;
      }
      const value = { market, snapshot, volume24hQuote, quote: market.quote };
      if (this.cache.size >= 200)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { until: Date.now() + 5_000, value });
      return value;
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async project(project: MarketProject): Promise<BinanceExchangeResponse> {
    const markets = project.markets.filter((m) => m.exchange === "binance"),
      results = await Promise.allSettled(markets.map((m) => this.snapshot(m))),
      items: BinanceExchangeResponse["items"] = [],
      failures: BinanceExchangeResponse["failures"] = [];
    results.forEach((r, i) =>
      r.status === "fulfilled"
        ? items.push(r.value)
        : failures.push({
            marketId: markets[i].id,
            symbol: markets[i].symbol,
            marketType: markets[i].marketType,
            reason:
              r.reason instanceof Error
                ? r.reason.message
                : "Binance data unavailable",
          }),
    );
    return {
      projectId: project.id,
      generatedAt: Date.now(),
      authentication: "public-no-key",
      items,
      failures,
      coverage: {
        spotSelected: markets.filter((m) => m.marketType === "spot").length,
        perpetualSelected: markets.filter((m) => m.marketType === "perpetual")
          .length,
        successful: items.length,
        requested: markets.length,
      },
    };
  }
}
