# NOX V2.1 — Advanced Order Flow increment

Implemented 2026-10-23 against the existing NOX React/Express/TypeScript application. The supplied image is an information-hierarchy reference, not a source of market data or a trading strategy. No hardcoded monitoring symbols, execution tools, or external signal publishing were introduced.

## Delivered in this increment

- New **Advanced Order Flow** navigation entry, preserving all existing pages, TradingView and the original research workspace.
- Native synchronized charts: observed Binance price candles, venue-level spot/perpetual Delta, venue-level CVD, strict aligned aggregate CVD, native Binance OI Delta and candle volume.
- One shared UTC time grid and native crosshair. Intervals: 1m/5m/15m/1h/4h. CVD reset: covered window / UTC hour / UTC day; incomplete reset periods explicitly remain covered-segment CVD.
- Separate venue/market/symbol ledgers with native-ID deduplication, contract normalization, bounded recent-trade backfill and REST overlap recovery, heartbeat/reconnect handling, local persistence and explicit gaps.
- Shared perpetual stream subscriptions reused by the existing market stream and the order-flow collector. Multiple viewers reuse the same collector. Collection starts only when the selected project's order-flow view is subscribed and streaming preference is enabled; it stops after the final subscriber leaves (5-second grace).
- Configurable large-print tape (minimum notional, venue, spot/perpetual filters), prior-print median size ratio (minimum 20 earlier records), optional 2-second same-venue/symbol/type/side clusters retaining native record IDs and constituent values.
- Binance liquidation snapshot decoder/timeline, with explicit incomplete-feed semantics. Other venues are marked unverified/unavailable; no zero liquidation assumption.
- Four spot/perpetual flow hypotheses: opposing buy/sell flow and synchronized buy/sell flow. Requires at least 20 earlier completed aligned buckets and absolute robust z-score ≥2 on both sides. Delta histogram anomalies use |z|≥3. No placeholder signal when history is insufficient.
- Project-specific saved docking layout, focus-panel selector and restore action. Optional local event-time replay from the retained trade ledger. Existing AI research interface remains independent and disabled unless configured.

## Calculation contract

1. `base quantity = raw size × contract multiplier` for OKX/Gate/KuCoin linear contracts. Binance, Bybit and Bitget trade sizes are already base quantity. The instrument must exactly match the selected market type, symbol, base and quote in the existing exchange catalog. Missing multipliers reject a feed instead of substituting one.
2. `notional = price × base quantity`. This increment accepts USDT quote pairs only. UI says **USDT notional**; this is the existing USD-equivalent reporting convention, not an observed USDT/USD FX conversion. Non-USDT pairs remain unavailable to avoid assuming a conversion.
3. Buy/sell is aggressor side. Binance buyer-maker means aggressor **sell**. Gate signed contract size determines taker side. Unknown sides, invalid prices/sizes/timestamps and absent stable trade IDs are rejected. Negotiated Bybit block trades are excluded rather than classified as book aggressors.
4. `Delta = Σ taker-buy notional − Σ taker-sell notional`. This is never OI Delta. OI Delta remains token quantity in the native Binance chart; OI availability at 1m is not fabricated from 5m observations.
5. A bucket is complete only when bounded REST trade coverage spans its start and end and no unresolved gap overlaps it. The first/last bucket may contain observed partial values (faded bars). A zero is allowed only inside a covered complete bucket with no trades; unknown intervals remain null.
6. Native CVD accumulates actually retained trades in a covered segment. It resets after an unresolved gap and at the configured reset boundary; plots do not interpolate through unknown data. **Partial CVD is not full-period CVD.**
7. Aggregate CVD is recalculated from aligned completed deltas, not a sum of differently reset native CVDs. Every selected market of that market type must cover the bucket. Missing markets suppress aggregate values rather than being silently omitted. Visibility toggles do not change the methodology; the global venue selector filters individual lines/tape and hides the all-venue aggregate outside Aggregated mode.
8. Statistical baseline is median and MAD of at least 20 earlier completed buckets. `robust z = (x − median) / (1.4826 × MAD)`. Zero MAD or insufficient history yields unavailable z-score, not an invented signal. Confidence is a bounded heuristic, not a calibrated probability.
9. Tape clusters are a UI/event grouping, not inferred whale ownership. Binance aggTrade records can already contain multiple underlying fills; the tape retains native aggregate records, not a claimed reconstruction of every individual execution.

## Adapter capability matrix

| Venue | Spot | USDT perpetual | Recovery / limitations |
|---|---|---|---|
| Binance | REST aggregate trades + JSON WS | Existing shared aggregate-trade WS + REST | Recent 1000 native aggregate records; REST fallback remains partial, not labeled WebSocket live. Liquidations use the separate symbol forceOrder snapshot feed. |
| Bitget | REST public fills + spot trade WS | Existing shared futures trade WS + REST public fills | Native tradeId required. Recent endpoint may return fewer records than requested; actual coverage controls charts. |
| Bybit | REST recent trades + public spot WS | Existing shared linear trade WS + REST | Spot max 60 recent records; linear max 1000. Block prints excluded. No complete historical archive implied. |
| OKX | REST trades + spot WS | Existing shared swap trade WS + REST | Swap contract multiplier required. Public trades may aggregate upstream executions. |
| Gate | REST public trades + spot WS | Existing shared futures WS + REST | Signed futures sizes normalized using quanto multiplier; timestamps retained in ms. |
| KuCoin | Public token spot WS + REST histories | Existing token futures WS + REST history | Recent history bounded (futures latest 100 records). Nanoseconds normalized to ms. Spot token refresh after expiry remains an operational follow-up. |
| MEXC | REST recent trades decoder | **Unavailable for CVD/Delta** | Futures public deal schema lacks a documented stable native ID, so fingerprint-based pseudo-dedup is not used. Spot Protobuf WS decoder is not implemented. Other existing MEXC price/OI/funding features are unchanged. |

Native recent REST endpoints are used only for the user-selected markets. Endpoint rejection, region restrictions, catalog failures and invalid payloads surface as unavailable/stale data. Current rate policy is one non-overlapping recovery request per market every 5 seconds, with 10-second request timeout and bounded socket backoff. A shared rate-limit budget, Retry-After scheduling and paginated archival backfill remain follow-ups; this is not unlimited production ingestion.

## Primary API references checked

- [Bybit recent public trades](https://bybit-exchange.github.io/docs/v5/market/recent-trade), [public WebSocket endpoints](https://bybit-exchange.github.io/docs/v5/ws/connect).
- [OKX official API guide](https://www.okx.com/docs-v5/en/).
- [Gate public WebSocket guide](https://www.gate.com/docs/developers/apiv4/ws/en/).
- [KuCoin futures trade history](https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-trade-history), [spot match channel](https://www.kucoin.com/docs-new/3470072w0).
- [MEXC contract API](https://mexcdevelop.github.io/apidocs/contract_v1_en/), [spot v3 API](https://mexcdevelop.github.io/apidocs/spot_v3_en/), [Protobuf WebSocket replacement announcement](https://www.mexc.co/en-GB/announcements/article/mexc-v3-websocket-service-replacement-announcement-17827791522393).
- [Binance official derivatives stream catalog](https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-coin-m-futures/api/ws-streams) documents the liquidation snapshot limitation. No exchange liquidation message was fabricated for testing in the UI.
- Bitget's legacy documentation URLs now redirect to its unified docs. Existing v2 native adapters are extended and runtime HTTP/payload validation remains authoritative. [Bitget documentation](https://www.bitget.com/docs/uta/uta-intro).

## Verification and limits

41 automated tests cover previous NOX calculations, unified aggregation, TradingView mapping, signal safety and the new flow arithmetic, native-side normalization, multiplier conversion, gap/reset behavior, aligned aggregation, clusters, layout validation, deduplication across REST/WS, cross-market rejection and file-backed restart persistence. One concurrent test initially exposed a fixture that assumed asynchronous feed-start order; it now targets streams by market type and verifies rejection of foreign-market events.

Live smoke testing uses the user's existing Orderly Network project (Binance perpetual, Bitget spot/perpetual, Bybit perpetual), without changing its markets. Actual REST trade records were returned for all four selected markets. Bitget and Bybit trade frames were observed; Binance was using bounded REST recovery in this environment. This does not certify every exchange, every region, continuous WS uptime, or full liquidation coverage. No qualifying liquidation event has been asserted from silence.

Browser QA confirmed 1m/5m switching, synchronized CVD crosshairs, tape thresholds and native records, 2-second clusters with expandable constituents, local replay filtering, English/Chinese controls, light/dark surfaces, and no horizontal document overflow at 1540px and 775px. Axis SVGs measure their actual pane width so labels do not shrink with fixed-viewBox scaling. Dark Mosaic headings use NOX text tokens. Production build and ESLint pass; existing user project selections were preserved.

## Remaining V2.1 work

- Historical-baseline price/spot-CVD and price/perpetual-CVD divergence; full price/OI/funding/basis/depth/liquidation fusion into all six requested regime hypotheses.
- Verified additional liquidation feeds, liquidation cluster summaries and authenticated configurable alert delivery. Existing rule/registry interfaces are preserved, not replaced by synthetic signals.
- Full archival backfill, exact snapshot/event-time OI history, longer retention, database transactions and cross-process collector coordination. Current retention is at most 50,000 records per market and 24h; tape response carries the latest 1000 retained events.
- Replay is a reconstructed view of retained records, **not** an availability-at-the-time simulation or an out-of-sample backtest. Existing native candle/OI history is shown only before the replay boundary; historical basis is unavailable. Statistical research needs fees/funding and explicit look-ahead/survivorship tests.
- MEXC spot Protobuf support and a defensible futures identity/dedup strategy; complete live conformance tests for OKX/Gate/KuCoin/Bybit spot and Binance spot with user-selected markets.
- Operator model evaluation and interpretation in Chinese; existing AI opt-in remains off. No automated trading or third-party signal dispatch.
- Production authentication, per-venue quota coordinator, audit/retention operations and multi-user database isolation before public institutional use.
