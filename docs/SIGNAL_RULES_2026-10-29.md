# Position-flow label rules and backtests — 2026-10-29

Base: NOX R23 handoff (fixed-r23 plus the wide navigation update), unmodified on `main`.
Changes: branch `signal-rule-options`, three commits on top of the baseline. Written in English.

## Summary

- The original position-flow labels did not predict direction on 7 days of data for IDOL, DOS, JCT, DOOD and EVAA. Directional labels were right 46.8% of the time at 60m, against a 49.6% baseline, and labelled 53.5% of all bars.
- New **opt-in** rule options (adaptive thresholds, minimum flow imbalance, multi-step windows) make labels fire less often and more steadily. In a 28-day walk-forward test they did **not** add a measurable edge: the variant chosen on the training days hit 52.5% vs 49.5% on the held-out days, but its after-cost return was +0.11% with t = 0.10, and −0.31% with a one-bar entry delay.
- Recommendation: keep the options opt-in. The app still calls the label code with its defaults, which reproduce the original labels exactly.

## Changes

### 1. `source/server/calculations.ts` — `detectPositionFlowSignals`

New optional fifth argument `options: SignalRuleOptions`. `DEFAULT_SIGNAL_RULES` is exported.

| Option | Effect | Default |
|---|---|---|
| `adaptive: { quantile, lookbackWindows, minHistory }` | A price or OI move must exceed this market's own `quantile` of \|move\| over the previous `lookbackWindows` windows. With fewer than `minHistory` prior windows the window gets no label (no fallback to fixed values). Absorption's "flat price" test uses the prior median move. | `null` (fixed 0.08% price / 0.05% OI) |
| `minFlowImbalancePct` | Flow must be at least this one-sided, `(buy − sell) / (buy + sell) × 100`, in the label's direction. At 0 the original sign-only rule is kept, including its handling of missing flow. | `0` |
| `windowSteps` | Price, base OI change and flow are measured over this many consecutive OI steps. The OI spike flag is set if any step in the window is a spike. | `1` |
| `limit` | Number of most recent signals returned, newest first. | `80` |

- Invalid options throw: non-integer or < 1 `windowSteps`, `minFlowImbalancePct` outside 0–100 or NaN, `limit` < 1, `quantile` outside (0, 1), `minHistory` > `lookbackWindows`.
- Point-in-time: thresholds use only windows evaluated before the current one, so later data never changes an earlier label (covered by a test).
- Signal evidence lists the adaptive thresholds and window length when those options are used. Window-level OI delta/percent are reported in `oiDeltaBase` / `oiDeltaPct`.
- **Behaviour fix:** a zero flow baseline (median prior \|delta\| = 0) can no longer certify `market_absorption`. Absorption is always withheld in the app (no L2 depth), so nothing visible changes.

### 2. `source/tests/calculations.test.ts`

Six new tests: defaults equal the original rules; adaptive thresholds label only moves beyond the market's own range and refuse with too little history; no rewriting of earlier labels when data is appended; minimum imbalance; multi-step windows; invalid options.

### 3. `source/package-lock.json` (separate commit)

`npm audit fix`: body-parser 1.20.8 → 1.20.9 (GHSA-27r3-jxmh-p828) and qs 6.16.0 → 6.16.2 (GHSA-6pq8-jhm2-2vcw). The zod advisory (GHSA-mrhx-c7xc-m3w5) needs zod 4 and is not addressed. Drop this commit if the dependency update should be reviewed separately.

### 4. `research/signal-rules-2026-10-29/`

Backtest scripts, raw public market data, results and the two HTML reports. See its README.

## Tests actually run (Node 24.22.2, macOS arm64)

- `npm run lint`: pass. `npm run typecheck`: pass. `npm run build`: pass (main bundle ~510 kB warning, unchanged).
- `npm test`: 196 tests, 193 pass, 0 fail, 3 skipped (opt-in live Binance Web3, CoinGlass and TimescaleDB tests).
- Regression on real data: with default options the new code reproduces the original code's labels exactly on 7 days × 5 tokens (6,073 labels, identical fields) — `research/signal-rules-2026-10-29/regress.mjs`.
- Not run: the app UI, live exchange REST/WebSocket feeds, long-running collection, Regime V2 or timeframe-alignment studies.

## Data validation

- Source: Binance USDT-M public `/fapi/v1/klines` and `/futures/data/openInterestHist`, 5m, fetched 2026-10-29. No API keys.
- 7-day set: 2,316 bars per token (2,016 evaluated + 300 warm-up), no gaps. 28-day set: 8,352 bars per token (28 days + 288 warm-up), no gaps. Binance serves OI history only for about the last 30 days.
- Flow comes from candle taker-buy volume (same buyer-maker rule as aggTrades), so every bucket is complete. This tests the label rules, not the live app's 1,000-trade window, which would withhold most of these bars.

## Results

7 days, original rules, 60m: directional hit 46.8% (n = 3,751) vs baseline 49.6%; after 10 bps cost −0.31% average; non-overlapping 45.4% (n = 654, z ≈ −2.1).

28-day walk-forward (train Oct 1–20, test Oct 20–29), 18 variants, selection fixed before running (best non-overlapping 60m after-cost return on train, ≥ 100 samples):

| 60m | Fires | Hit vs baseline | Non-overlapping n / hit / after cost / t |
|---|---|---|---|
| Current rules, train | 27% | 47.7 vs 48.4 | 1,335 / 46.1% / −0.08% / −1.0 |
| Current rules, test | 52% | 47.1 vs 49.5 | 829 / 45.8% / −0.26% / −1.3 |
| Selected (60m window, 90th pct), train | 42% | 52.5 vs 48.5 | 207 / 46.4% / +0.51% / 1.05 |
| Selected, test | 40% | 52.5 vs 49.5 | 100 / 52.0% / +0.11% / 0.10 |
| Selected, test, entry +1 bar | — | — | 100 / 49.0% / −0.31% / −0.34 |

No variant reached t ≥ 2 on the test days. Train vs test rank correlation across variants: 0.10.

## Compatibility and rollback

- Callers that pass no options get the original behaviour; `server/binance.ts` and the API response shape are unchanged.
- Roll back by checking out `main`, or reverting `2b691c5…` (rules) and/or the lockfile commit independently.

## Not done / open

- The new options are not exposed in the API or UI.
- Not yet tested: funding/premium, liquidation events (`forceOrder`), cross-venue confirmation, spot-vs-perp lead/lag, trend vs chop regimes, calibrated confidence.
- Longer history needs NOX's own collector; 28 days of 5 correlated small-cap tokens is a small sample, and 18 variants were compared.
- Earlier review items still open in R23: execution ledger not wired into the app and missing finite/range validation (R21 review); zod 4 upgrade; the calculation inconsistencies noted on 2026-10-29 (different entry conventions between the alignment and event studies, partial edge buckets feeding CVD, 0 instead of null for `pctBase` / `imbalancePct`, mixed-label clusters dropped from event-study cohorts).

Descriptive research on past public data. Not investment advice.
