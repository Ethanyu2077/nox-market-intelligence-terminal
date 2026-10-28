import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BinanceWeb3Client, signWeb3 } from "../server/binance-web3-client.ts";
import {
  BinanceWeb3Service,
  normalizeDefiProducts,
  normalizeWeb3Candles,
  normalizeWeb3Market,
  normalizeWeb3Pools,
  numeric,
  web3ChainId,
} from "../server/binance-web3.ts";
import type { MarketProject } from "../shared/types.ts";
const address = "0x1111111111111111111111111111111111111111";
const project = {
  id: "p",
  contractAddress: address,
  identityNetwork: "bsc",
} as MarketProject;
const ok = (data: unknown) =>
  new Response(
    JSON.stringify({ code: 0, success: true, data, timestamp: Date.now() }),
    { status: 200 },
  );
test("Web3 HMAC includes build prefix and exact encoded query or raw POST body", () => {
  const time = "2026-10-26T00:00:00.000Z",
    path = "/build/api/v1/dex/market/candles?a=one%20two";
  assert.equal(
    signWeb3("test", time, "GET", path),
    createHmac("sha256", "test")
      .update(time + "GET" + path)
      .digest("base64"),
  );
  assert.throws(() =>
    signWeb3("test", time, "GET", "/api/v1/dex/market/candles"),
  );
  assert.notEqual(
    signWeb3("test", time, "POST", path, '{"a":1}'),
    signWeb3("test", time, "POST", path, '{ "a":1}'),
  );
});
test("client deduplicates/caches requests and signs the transmitted body, without browser credentials", async () => {
  let count = 0;
  const transport: typeof fetch = async (url, init) => {
    count++;
    const headers = new Headers(init?.headers),
      path = new URL(String(url)).pathname;
    assert.equal(path, "/build/api/v1/dex/market/price-info");
    assert.equal(
      headers.get("X-OC-SIGN"),
      signWeb3(
        "test-secret",
        headers.get("X-OC-TIMESTAMP")!,
        "POST",
        path,
        String(init?.body),
      ),
    );
    assert.ok(headers.get("X-OC-NONCE"));
    return ok([]);
  };
  const client = new BinanceWeb3Client("test-key", "test-secret", transport),
    params = [{ binanceChainId: "56", tokenContractAddress: address }];
  await Promise.all([
    client.request("/api/v1/dex/market/price-info", params),
    client.request("/api/v1/dex/market/price-info", params),
  ]);
  await client.request("/api/v1/dex/market/price-info", params);
  assert.equal(count, 1);
});
test("missing credentials and forbidden transaction/wallet paths never cause a request", async () => {
  let count = 0;
  const client = new BinanceWeb3Client("", "", async () => {
    count++;
    return ok([]);
  });
  await assert.rejects(
    client.request("/api/v1/dex/market/price-info", []),
    /not-configured/,
  );
  await assert.rejects(
    client.request("/api/v1/defi/transaction/deposit", {}),
    /endpoint-not-allowed/,
  );
  await assert.rejects(
    client.request("/api/v1/defi/data/position/list", {}),
    /endpoint-not-allowed/,
  );
  assert.equal(count, 0);
});
test("429 cooldown is honored without repeated upstream requests or raw error leakage", async () => {
  let count = 0;
  const client = new BinanceWeb3Client("key", "secret", async () => {
    count++;
    return new Response("secret echo", {
      status: 429,
      headers: { "Retry-After": "10" },
    });
  });
  await assert.rejects(
    client.request("/api/v1/dex/market/supported/chain", {}),
    /rate-limited/,
  );
  await assert.rejects(
    client.request("/api/v1/dex/market/supported/chain", {}),
    /rate-limited/,
  );
  assert.equal(count, 1);
});
test("auth and region failures are not retried or surfaced as private upstream text", async () => {
  const client = new BinanceWeb3Client(
    "key",
    "secret",
    async () => new Response("secret echo", { status: 403 }),
  );
  await assert.rejects(
    client.request("/api/v1/dex/market/supported/chain", {}),
    /permission-or-region-restricted/,
  );
});
test("chain aliases preserve unknown networks as unsupported; Solana uses a distinct identifier", () => {
  assert.equal(web3ChainId("BSC"), "56");
  assert.equal(web3ChainId("polygon_pos"), "137");
  assert.equal(web3ChainId("solana"), "CT_501");
  assert.equal(web3ChainId("unknown"), null);
  assert.equal(web3ChainId(null), null);
});
test("market windows preserve zero and missing values; rolling delta is not OI or CVD", () => {
  const result = normalizeWeb3Market({
    price: "0.05",
    volume24H: "0",
    buyVolume24H: "12",
    sellVolume24H: "20",
    priceChange24H: "-3.2",
  });
  assert.equal(result.windows[3].deltaUsd, -8);
  assert.equal(result.windows[3].volumeUsd, 0);
  assert.equal(result.windows[0].deltaUsd, null);
  assert.equal(result.holders, null);
  assert.equal(numeric(false), null);
  assert.equal(numeric(""), null);
  assert.equal(numeric("NaN"), null);
});
test("Web3 candles use OHLC-volume-time ordering, millisecond timestamps and reject malformed/future bars", () => {
  const now = Date.now();
  const result = normalizeWeb3Candles(
    [
      [2, 4, 1, 3, "9", now - 60_000, 5],
      [3, 5, 2, 4, null, now, 6],
      [4, 2, 3, 5, 1, now - 120_000, 3],
      [1, 2, 0.5, 1, 1, Math.floor(now / 1000), 1],
      [1, 2, 0.5, 1, 1, now + 60_000, 1],
    ],
    now,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].open, 2);
  assert.equal(result[0].time, now - 60_000);
  assert.equal(result[1].volume, null);
});
test("DeFi precision and display values are retained; wrong-chain/type and duplicate rows are rejected", () => {
  const p = {
    investmentId: "id",
    binanceChainId: "56",
    investType: "Earn",
    apyBps: 1235,
    apyDisplay: "12.35%",
    apyType: "APY",
    tvl: "1250000.123456789123456789",
  };
  const items = normalizeDefiProducts(
    [p, p, { ...p, investmentId: "wrong", binanceChainId: "1" }],
    "56",
    "Earn",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].tvlUsd, p.tvl);
  assert.equal(items[0].apyDisplay, "12.35%");
  assert.equal(items[0].apyBps, 1235);
  const pools = normalizeWeb3Pools([
    {
      poolAddress: address,
      pool: "TEST/USDT",
      liquidityUsd: "0.00000000000001",
      liquidityAmount: [],
    },
  ]);
  assert.equal(pools[0].liquidityUsd, "0.00000000000001");
});
test("project service sends only confirmed identity, keeps partial failures independent, and filters DeFi by token", async () => {
  const paths: string[] = [];
  const client = new BinanceWeb3Client("test", "test", async (url, init) => {
    const u = new URL(String(url));
    paths.push(u.pathname);
    if (u.pathname.endsWith("/supported/chain"))
      return ok([{ binanceChainId: "56" }]);
    if (u.pathname.endsWith("/advanced-info")) return ok({binanceChainId:"56",tokenContractAddress:address,top10HoldingPercent:"40"});
    if (u.pathname.endsWith("/price-info")) {
      assert.deepEqual(JSON.parse(String(init?.body)), [
        { binanceChainId: "56", tokenContractAddress: address },
      ]);
      return ok([
        {
          binanceChainId: "56",
          tokenContractAddress: address,
          price: "1",
          time: Date.now(),
        },
      ]);
    }
    if (u.pathname.endsWith("/candles")) {
      assert.equal(u.searchParams.get("bar"), "15m");
      return ok([]);
    }
    if (u.pathname.endsWith("/top-liquidity"))
      return new Response("bad", { status: 403 });
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tokenAddressList, [address]);
    assert.equal(body.binanceChainId, "56");
    assert.equal(body.page, 2);
    return ok({ list: [], total: 0 });
  });
  const result = await new BinanceWeb3Service(client).project(
    project,
    "15m",
    2,
  );
  assert.equal(result.market.state, "available");
  assert.equal(result.pools.state, "error");
  assert.equal(result.earn.state, "empty");
  assert.equal(paths.length, 7);
  assert.equal(result.advanced.state, "available");
  assert.equal(result.contractAddress, address);
});
test("unconfigured or unconfirmed projects do not query unselected tokens", async () => {
  let count = 0;
  const client = new BinanceWeb3Client("", "", async () => {
    count++;
    return ok([]);
  });
  const result = await new BinanceWeb3Service(client).project(project);
  assert.equal(result.market.state, "not-configured");
  assert.equal(count, 0);
  const configured = new BinanceWeb3Client("test", "test", async () => {
    count++;
    return ok([]);
  });
  assert.equal(
    (
      await new BinanceWeb3Service(configured).project({
        ...project,
        contractAddress: null,
      })
    ).market.reason,
    "identity-required",
  );
  assert.equal(count, 0);
});
