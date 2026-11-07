# NOX Market Intelligence Terminal — architecture note

For the current V2.2 incremental data/auth/regime architecture and its explicitly unverified production boundaries, see [V2_2_IMPLEMENTATION.md](V2_2_IMPLEMENTATION.md). This note retains the initial-stage architecture audit below.

## AI analyst boundary (2026-11)

```text
venue adapters ──► research.ts (deterministic) ──┐
project snapshots / coverage ────────────────────┴─► ai/prompt.ts  evidence packet (S1..Sn, capped)
                                                            │
                                    server/ai/deepseek.ts (SSE) ──► /api/ai/chat
                                                            └─────► /api/ai/brief (JSON + citation gate)
```

The model is a reader, never a calculator: every numeric claim in the UI comes from the deterministic
report, and the brief parser drops any citation id that was not in the packet it sent. Server-key calls
require a session; browser-key calls are forwarded per request and never persisted. See
[DEEPSEEK_INTEGRATION.md](DEEPSEEK_INTEGRATION.md). The UI shell (`src/shell/*`, `src/design/*`) keeps the
instrument context, coverage and freshness visible on every project page.

## Audit result

The repository contained only a new Git directory and no reusable application code. The initial slice therefore uses a TypeScript workspace while retaining established NOX dashboard conventions: dense information layout, compact sidebar/header, restrained neutral palette, monospaced market values, and explicit source/freshness labels.

## Project-based Phase 1 vertical slice

```text
Browser (React + Vite)
  ├─ project identity + market selection ── 7 CEX catalogs + DexPaprika identity
  ├─ selected-project REST /api/* ── Express API ── normalized venue adapters
  ├─ selected-project SSE stream ── reconnecting native WS adapters
  ├─ on-chain context ── contract-scoped DexPaprika token + pool API
  ├─ versioned research context ── CEX + on-chain + provenance + boundaries
  ├─ optional lazy TradingView iframe ── TradingView public market data
  └─ projects/preferences ── atomic serialized local data store

Production data path (schema included, wiring next)
  Binance adapters → bounded normalizer/aggregator → TimescaleDB
                                            └────→ Redis cache/alert queue
```

The API/UI boundary and standardized instrument identity are explicit. There are no default token symbols: data collection begins only after a user confirms an identity, selects markets and designates a perpetual primary feed. Seven native adapters cover Binance, Bitget, Bybit, OKX, Gate, KuCoin and MEXC without routing the production hot path through CCXT. The live process uses a zero-credential atomic data store for project records and preferences; the included TimescaleDB migration remains the target for historical market data and horizontally safe multi-user persistence.

## External repository integration decisions

- DexPaprika MCP: adopted the capability-first, contract-scoped discovery pattern and current network-scoped pool search contract. NOX calls the public REST API directly because the browser application does not need an MCP process in its runtime path.
- MCP Server CCXT: adopted the exchange capability registry and normalized-symbol mindset. NOX retains native adapters so exchange-specific contract multipliers, OI units, WebSocket sequencing and unsupported metrics stay visible.
- Crypto Claude Desk: adopted versioned structured research context and a future verify-after-expiry learning loop. NOX does not embed an autonomous trading agent or expose a shell; the current export is read-only market intelligence.

## Hybrid chart boundary

The Market Structure workspace owns a project-scoped chart-mode preference. NOX mode renders the native synchronized analytics and consumes the existing project SSE/REST state. TradingView mode lazy-loads `AdvancedRealTimeChart` only when selected, resolves the primary market to TradingView notation, and disposes the widget DOM on unmount. It does not open a second NOX stream.

The TradingView widget is intentionally treated as an isolated third-party chart. Theme, locale, symbol and supported interval are configuration inputs, but NOX does not claim access to its internal chart state. TradingView branding remains visible. Custom OI, OI Delta, CVD, Volume Delta, funding, liquidation and signal logic continues to run exclusively in NOX components.

## Data semantics

- `m=true` on Binance aggregate trades means the buyer was maker, so the aggressor was the seller.
- Futures CVD is `Σ(price × base quantity × aggressor sign)`. The API returns bucket deltas plus a cumulative value reset at the fetched window start.
- Linear USDⓈ-M base OI is retained separately from `base OI × mark price`. The UI never labels one as the other.
- OI Delta is computed from venue historical `sumOpenInterest`; USD OI and USD delta use the separately returned `sumOpenInterestValue`. They are never substituted for Volume Delta.
- Volume Delta is aggressor-buy notional minus aggressor-sell notional. Taker buy/sell, Volume Delta and CVD share the same bounded aggregate-trade coverage contract.
- OI spikes use a median/MAD robust score. Structure labels combine price, OI Delta and available order flow and are always presented as probabilistic inferences with counterevidence.
- Historical signal replay synchronizes every visible chart to the selected event time. The reliability view evaluates a three-bar forward move inside the fetched window and labels small samples as descriptive only.
- Missing OI history stays missing; the server never fills an unavailable point with zero.
- On-chain token and pool values stay distinct from CEX snapshots. Returned top-pool totals are coverage-limited and are never described as global liquidity.
- The research-context export preserves raw observations, probabilistic inferences, missing values and interpretation boundaries as separate fields.
- WebSocket clients receive explicit `connecting`, `live`, `stale`, and `degraded` states. Upstream reconnect uses bounded exponential backoff.

## Current scaling boundaries

The scanner polls OI for at most 40 high-notional instruments. A production worker should continuously ingest a configured universe, batch/cache snapshots, persist event-time data, and serve scanner queries from TimescaleDB rather than fan out to Binance per request.

Binance historical OI starts at 5M granularity. In 1M mode, price and aggregate-trade flow remain 1M while OI and OI Delta retain their authoritative 5M timestamps. True 1M OI requires the planned local snapshot collector and must not be reconstructed from volume or price.
