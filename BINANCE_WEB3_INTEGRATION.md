# Binance Web3 market / DeFi integration — 2026-10-26

## Scope and status

This extends the existing NOX architecture and Liquidity Intelligence workspace. Binance USDT-M Futures and the seven CEX adapters are unchanged. Binance Web3 is a **separate authenticated on-chain provider**, not another CEX venue. No OI, funding, liquidations or native CEX CVD is invented from this source.

Implemented read-only adapters:

- Runtime supported-market-chain discovery.
- Contract-scoped price, market cap, liquidity, holders, and 5M/1H/4H/24H price/volume/buy/sell observations.
- On-chain OHLC candles following the global 1M/5M/15M/1H/4H selection, with keyboard/pointer candle inspection.
- Major DEX liquidity pools, displayed as a returned subset, not a global total.
- Earn and LiquidityPool product discovery, filtered by the saved chain **and token address**, paginated at 20 per type.
- Read-only capability status in Settings and independently labeled Binance Web3 / DexPaprika sections.
- Additive `web3` context in the existing research JSON export. Missing data remains explicit.

Current local verification has **no Binance Web3 developer credentials**. The UI correctly shows `not-configured`, not live sample data. Authentication, permissions, current venue coverage, regional eligibility, and credentialed UI/data acceptance remain pending. REST refresh is every 30 seconds while the workspace is open; this increment does not implement Web3 WebSocket streaming or historical on-chain backfill/storage.

## Security and transport

Credentials are server-side environment variables:

```text
BINANCE_WEB3_API_KEY=
BINANCE_WEB3_SECRET_KEY=
```

These are Binance **Web3 developer-platform** credentials, not Binance exchange trading keys. Do not paste secrets into chat, browser code, `VITE_` variables, public deployment configuration or source control. Use read-only permissions where available and follow Binance's account, service-plan and regional restrictions.

The adapter signs the exact transmitted method/path/body using HMAC-SHA256 with Base64 output. The `/build` prefix is included in both URL and signature, and every request has a unique nonce. Endpoint paths and the upstream origin are fixed in server code; wallet, position, swap, approval, transaction-building, and broadcast endpoints are not in the allowlist. Error responses expose sanitized status codes rather than upstream bodies or credentials. Redirects are rejected.

The shared client deduplicates concurrent identical calls, caches market data for 30 seconds, DeFi pages for 5 minutes and supported chains for 1 hour. Its global 250ms dispatch interval is conservative relative to the documented default per-endpoint limit. A bounded pending queue prevents unlimited waiting work. HTTP/business 429 responses start a shared cooldown; HTTP Retry-After seconds are honored. Read-only HTTP 5xx calls may retry once; auth/permission/region errors are not retried or bypassed. Requests time out after 10 seconds.

## Data rules

- Market-chain support is discovered at runtime. DeFi product support is a separate documented EVM-chain set; Solana market support does not imply Solana DeFi-product support.
- Price rows must match the requested chain and contract; Solana addresses remain case-sensitive.
- Web3 candles are **OHLC, volume, timestamp, transaction-count**, unlike Binance CEX kline arrays. Timestamp normalization uses documented milliseconds. Future/malformed OHLC bars are discarded and valid bars sorted/deduplicated.
- Candle volume units are not explicit enough in the inspected documentation to label them USD. They are retained as raw upstream volume, not aggregated with CEX USD volume.
- Rolling buy/sell differences are descriptive window net values, not a continuous CVD series. Overlapping windows are never accumulated.
- DeFi `apyDisplay` is displayed unchanged, `apyBps` is retained as an integer, and TVL decimal strings retain upstream precision. APY/APR is not guaranteed return. No TVL sum or combined DEX/DeFi/CEX liquidity total is produced.
- Each section independently reports available/empty/unsupported/error states, source timestamp, fetch timestamp and freshness. Cached data retains its source timestamp. A fetch timestamp is not presented as an on-chain event timestamp.
- Existing DexPaprika calls are now deduplicated/cached and refresh while viewed. Identity search no longer falls back to the first unrelated result. Unknown pool liquidity does not draw a fake minimum-size bar, and DEX buy/sell labels do not assert verified aggressor identity.

## Local configuration and acceptance

The existing `npm start` reads process environment variables. To use a local `.env`, create/edit it yourself (do not overwrite an existing file), then start Node with its explicit env-file support:

```sh
npm run build
NODE_ENV=production PORT=4173 node --env-file=.env --import tsx server/index.ts
```

Do not start a second process on an occupied port. Configure/restart with your own credentials, then run the opt-in **read-only** live capability test:

```sh
NOX_TEST_BINANCE_WEB3_LIVE=true node --env-file=.env --import tsx --test tests/binance-web3-live.test.ts
```

After successful capability authentication, validate at least one confirmed project's exact price identity, source ages, OHLC ordering, pool membership and both token-filtered DeFi categories against Binance's actual responses. The mock-transport tests prove request/calculation behavior, not live source availability. Empty products are not evidence of zero global DeFi liquidity.

Endpoints:

```text
GET /api/web3/capabilities
GET /api/projects/:id/web3?interval=5m&page=1
```

Verification: 93 automated tests, 91 pass, two skip (real Web3 credentials and real Timescale test database not configured). Production build and lint pass. Browser checks cover Chinese/English and dark/light not-configured states; credentialed charts/tables remain unverified until keys are configured. No keys, project preferences, wallets, trading permissions or publishing settings were created or changed.

## Official references inspected

- [Authentication, signing and limits](https://web3.binance.com/zh-CN/dev-docs/authentication)
- [General market-data REST](https://web3.binance.com/zh-CN/dev-docs/catalog/web3-wallet/api/rest-api/general-data)
- [DeFi REST data](https://web3.binance.com/zh-CN/dev-docs/catalog/web3-wallet/api/rest-api/defi-data)
- [DeFi supported chains](https://web3.binance.com/zh-CN/dev-docs/products/defi-api/supported-chains)
- [Regional restrictions](https://web3.binance.com/zh-CN/dev-docs/web3-api-prohibited-regions)

Follow-up: live credential acceptance first; then Web3 streaming, durable chain-history ingestion, provider comparisons, and verified protocol-detail/risk context. No automatic trading or yield allocation is part of this work.
