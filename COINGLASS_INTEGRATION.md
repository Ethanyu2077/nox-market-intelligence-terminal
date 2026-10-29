# CoinGlass V4 and Binance Web3 analysis

Implemented 2026-10-26. Credentialed acceptance remains pending.

## In-app configuration

Open Settings / Data Sources → CoinGlass V4. Administrators can save/replace/delete a key and test authentication. Saving applies immediately; the key is never returned to the browser. Keys are encrypted with AES-256-GCM in `var/auth/providers.sqlite` (or `NOX_AUTH_DIR`), using a separate private `provider-master.key`. Back up both together; losing the master key prevents decryption. Saved keys override environment configuration; deleting a saved key restores the environment fallback, if any. Anonymous users and analyst/viewer roles cannot read or modify credential settings. Test connection verifies the supported-coins endpoint only; other endpoint permissions depend on the subscription.

Metrics are available in Cross-Exchange Analysis → CoinGlass: OI USD and 5M/15M/30M/1H/4H/24H changes, venue funding, taker buy/sell and rolling delta, and long/short liquidations. OI USD history and OI-weighted funding history are loaded on demand at 1H/4H/1D (120 requested bars, last 30 valid bars shown). The frontend polls every 60 seconds while viewed. History interval entitlement remains provider-controlled.

Binance Web3 remains in Liquidity Intelligence; Settings supplies a direct navigation button. Its Key/Secret remain server environment configuration.


## Data available

Server APIs now provide independent CoinGlass data: OI USD and 1H/24H change by exchange, stablecoin/coin-margined funding observations, and long/short liquidation USD for 4H/12H/24H windows. The capability endpoint reports server credential configuration. Research JSON includes a separate `coinglass` object.

Binance Web3 additionally queries contract-scoped advanced token information: top-10 concentration, developer, smart-money, KOL, bundled, professional, fresh, sniper and insider holding percentages, creator, holders and provider tags. The additional analysis is exposed through the API and research export; existing UI, layout, styling and colors are unchanged. These address categories can overlap and must not be added. Tags are provider assertions, not independently verified identity/risk findings. Existing price, OHLC, pools and token-filtered DeFi remain available.

CoinGlass uses symbols, not chain/contract identity. Exact supported-symbol matching does not resolve duplicate tickers; users must verify identity before interpreting data. No guessed 1000-token aliases or default BTC fallback. CoinGlass exchange coverage is independent of saved native venue selection and never merged into native OI/CVD. `All` rows are upstream aggregates, not additional venues to sum. Funding values retain upstream raw units; no assumed percentage/decimal conversion. Source observation time is unknown when not supplied; fetch time is labeled separately.

## Server configuration

Use an ignored local `.env` or process environment; never use frontend `VITE_` variables:

```text
BINANCE_WEB3_API_KEY=
BINANCE_WEB3_SECRET_KEY=
COINGLASS_API_KEY=
```

Binance requires developer-platform Key **and Secret**; CoinGlass requires its own API Key. Never overwrite existing environment settings. Existing npm scripts do not auto-load `.env`. After configuring the file and building, explicitly load it:

```sh
NODE_ENV=production PORT=4173 node --env-file=.env --import tsx server/index.ts
```

Restart the existing service after configuration instead of starting a duplicate process. To validate credentials without printing keys or responses:

```sh
NOX_TEST_BINANCE_WEB3_LIVE=true node --env-file=.env --import tsx --test tests/binance-web3-live.test.ts
NOX_TEST_COINGLASS_LIVE=true node --env-file=.env --import tsx --test tests/coinglass.test.ts
```

Capability authentication alone does not establish project-level permissions or data accuracy. Validate one confirmed project per network and the chosen CoinGlass plan before relying on observations. Inspect the read-only capability and project endpoints for independent error/empty states.

## Transport and limits

CoinGlass calls only seven allowlisted fixed-origin GET endpoints. Server-side API header, redirect rejection, 10-second timeout, bounded queue/cache, shared 650ms dispatch spacing, in-flight deduplication and 60-second observation cache. Supported coins cache for one hour. HTTP/business 429 starts a shared cooldown (Retry-After seconds honored). Authentication/plan errors are sanitized and never retried automatically. The metrics panel refreshes every 60 seconds while viewed. Unconfigured keys do not trigger upstream traffic. Credential configuration routes require admin authorization. There is no automatic trading or mock live data.

Routes: `GET /api/coinglass/capabilities`, `GET /api/projects/:id/coinglass?range=24h`. Invalid range returns 400; absent project returns 404. Existing authentication policy for read access remains in effect.

Not implemented: durable CoinGlass historical storage, liquidation heatmaps, ETF data, chain transfers, websocket subscriptions, strategy calibration. Binance Web3 remains REST only with no long-term on-chain ingestion. Add further endpoints after credential/plan acceptance.

## Official references

- https://web3.binance.com/zh-CN/dev-docs/authentication
- https://web3.binance.com/zh-CN/dev-docs/catalog/web3-wallet/api/rest-api/general-data
- https://docs.coinglass.com/reference/authentication
- https://docs.coinglass.com/reference/oi-exchange-list
- https://docs.coinglass.com/reference/fr-exchange-list
- https://docs.coinglass.com/reference/liquidation-exchange-list
- https://docs.coinglass.com/reference/responses-error-codes

