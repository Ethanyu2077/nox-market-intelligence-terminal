# Binance exchange market follow-up — 2026-10-26

The Liquidity Intelligence workspace now begins with a dedicated **Binance Exchange** panel, followed by Binance Web3 and DexPaprika. Exchange public market data does not require Web3 developer credentials.

- Reuses the existing Binance perpetual snapshot adapter and original WebSocket analytics. Adds REST bid/ask top-of-book snapshots.
- Adds public Spot ticker and best-bid/ask reads for **already selected** Binance spot pairs. No pair discovery result is automatically saved and no default market is added.
- The new panel refreshes every five seconds while viewed. Server calls are deduplicated/cached per market for five seconds.
- Displays price, 24-hour quote turnover, bid/ask spread, base/USD OI, funding, next settlement, source time, state and selected-market coverage.
- Spot OI, mark price and funding remain unavailable/not applicable. Non-USDT quote turnover retains its quote unit rather than being assumed to equal USD. Missing book data does not become zero.
- This panel is REST polling, not a new high-frequency WebSocket or sequence-verified depth engine. Native synchronized charts and aggressor analytics remain in Market Structure / Advanced Order Flow.

Endpoint: `GET /api/projects/:id/binance`. Only saved Binance markets of that project are queried. Other venues and private/execution APIs are excluded.

Live checks succeeded for all four saved Binance perpetuals (JCT, ORDER, BTR, ARIA), including last price, OI, funding and bid/ask. The saved projects currently have no Binance spot market selected; Spot normalization/transport is unit-tested but selected-project Spot live acceptance remains pending until the user selects a verified pair.

Verification: production build and lint pass; 97 tests, 95 pass, two environment skips (credentialed Web3 and TimescaleDB). Existing credentials, monitoring preferences and selected markets were not changed.

Sources: [Binance public Spot market-data-only service](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [Binance USD-M market data](https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).
