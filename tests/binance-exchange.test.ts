import test from "node:test";
import assert from "node:assert/strict";
import {
  BinanceExchangeService,
  normalizeBinanceSpot,
} from "../server/binance-exchange.ts";
import type {
  MarketProject,
  ProjectMarket,
  VenueMarketSnapshot,
} from "../shared/types.ts";
const spot = {
  id: "binance:spot:TESTUSDT",
  exchange: "binance",
  marketType: "spot",
  symbol: "TESTUSDT",
  base: "TEST",
  quote: "USDT",
  status: "TRADING",
} as ProjectMarket;
test("Binance spot preserves quote units and does not invent OI, mark price or funding", () => {
  const now = Date.now(),
    s = normalizeBinanceSpot(
      spot,
      {
        symbol: spot.symbol,
        lastPrice: "1.5",
        volume: "100",
        quoteVolume: "150",
        closeTime: now,
        priceChangePercent: "0",
      },
      { symbol: spot.symbol, bidPrice: "1.49", askPrice: "1.51" },
      now,
    );
  assert.equal(s.price, 1.5);
  assert.equal(s.volume24hUsd, 150);
  assert.equal(s.change24hPct, 0);
  assert.equal(s.oiUsd, null);
  assert.equal(s.fundingRate, null);
  assert.equal(s.markPrice, null);
  assert.ok(s.spreadBps! > 0);
  const usdc = normalizeBinanceSpot(
    { ...spot, quote: "USDC" },
    { symbol: spot.symbol, lastPrice: "1", quoteVolume: "100", closeTime: now },
    {},
    now,
  );
  assert.equal(usdc.volume24hUsd, null);
});
test("spot identity mismatch is rejected and missing books do not become zero", () => {
  assert.throws(
    () => normalizeBinanceSpot(spot, { symbol: "WRONG" }, {}),
    /identity mismatch/,
  );
  const s = normalizeBinanceSpot(
    spot,
    { symbol: spot.symbol, lastPrice: "1", closeTime: Date.now() },
    {},
  );
  assert.equal(s.bid, null);
  assert.equal(s.spreadBps, null);
});
test("exchange panel queries only selected Binance pairs and deduplicates concurrent requests", async () => {
  let calls = 0,
    perpCalls = 0;
  const transport: typeof fetch = async (url) => {
    calls++;
    const u = new URL(String(url));
    assert.equal(u.searchParams.get("symbol"), spot.symbol);
    return new Response(
      JSON.stringify(
        u.pathname.includes("bookTicker")
          ? { symbol: spot.symbol, bidPrice: "1", askPrice: "1.01" }
          : {
              symbol: spot.symbol,
              lastPrice: "1",
              quoteVolume: "100",
              closeTime: Date.now(),
            },
      ),
    );
  };
  const service = new BinanceExchangeService(transport, async () => {
    perpCalls++;
    return {} as VenueMarketSnapshot;
  });
  const project = {
    id: "p",
    markets: [spot, { ...spot, id: "other", exchange: "bybit" }],
  } as MarketProject;
  const [a, b] = await Promise.all([
    service.project(project),
    service.project(project),
  ]);
  assert.equal(a.items.length, 1);
  assert.equal(b.coverage.spotSelected, 1);
  assert.equal(calls, 2);
  assert.equal(perpCalls, 0);
  await service.project(project);
  assert.equal(calls, 2);
});
test("one unavailable selected market does not hide successful Binance markets", async () => {
  const perp = {
    ...spot,
    id: "perp",
    marketType: "perpetual",
  } as ProjectMarket;
  const service = new BinanceExchangeService(
    async () => new Response("unavailable", { status: 503 }),
    async () => ({
      ...normalizeBinanceSpot(
        spot,
        { symbol: spot.symbol, lastPrice: "1", closeTime: Date.now() },
        {},
      ),
      marketType: "perpetual",
      oiUsd: 100,
    }),
  );
  const result = await service.project({
    id: "p",
    markets: [spot, perp],
  } as MarketProject);
  assert.equal(result.items.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.items[0].snapshot.oiUsd, 100);
  assert.equal(result.items[0].snapshot.bid, null);
});
