# Signal-rule backtests — 2026-10-29

V3 update (2026-10-30): run from the project root with `node --import tsx research/signal-rules-2026-10-29/walkforward.mjs server/calculations.ts IDOLUSDT DOSUSDT JCTUSDT DOODUSDT EVAAUSDT`. Current output is `results/walkforward-v3.json`: purged split boundaries, hypothesis-only directional outcomes, same-duration absorption baselines. Delayed-entry baseline is unavailable (not reused from immediate entry). See root `RESEARCH_V3_PHASE1_2026-10-30.md`. Instructions and reports below describe the historical upstream snapshot, not the V3 acceptance results.

Reproducible inputs and scripts for `docs/SIGNAL_RULES_2026-10-29.md`. Public Binance market data only; no keys, accounts or positions.

## Contents

| Path | What it is |
|---|---|
| `data/` | 7-day set: 5m klines + 5m OI per symbol, 2,316 bars each (2,016 evaluated + 300 warm-up), ending 2026-10-29 12:55 UTC |
| `data30/` | 28-day set: 8,352 bars each (28 days + 288 warm-up), ending 2026-10-29 13:05 UTC |
| `fetch.mjs` | Downloads the data. `DAYS`, `WARMUP_BARS` and `OUT_DIR` env vars; defaults are the 7-day set |
| `backtest.mjs` | 7-day accuracy of the original labels by label, horizon and token |
| `subsets.mjs` | 7-day stricter subsets: OI spikes, confidence ≥ 70, non-overlapping |
| `walkforward.mjs` | 28-day train/test comparison of 18 rule variants |
| `regress.mjs` | Checks that default options reproduce the original code's labels |
| `results/` | Outputs from the runs used in the reports |
| `reports/` | The two HTML reports (open in a browser) |

Symbols: `IDOLUSDT DOSUSDT JCTUSDT DOODUSDT EVAAUSDT`.

## Re-running

Run from this folder after `npm ci` in `source/`. The scripts import NOX's own label code; nothing is copied.

```sh
TSX=../../source/node_modules/tsx/dist/esm/index.mjs
CALC=../../source/server/calculations.ts
SYMBOLS="IDOLUSDT DOSUSDT JCTUSDT DOODUSDT EVAAUSDT"
node --import $TSX backtest.mjs $CALC $SYMBOLS
node --import $TSX subsets.mjs $CALC $SYMBOLS
node --import $TSX walkforward.mjs $CALC $SYMBOLS
```

Regression against the original code (from the repository root, after `git show main:source/server/calculations.ts > /tmp/calculations-orig.ts` and pointing its `../shared/types.ts` import at `source/shared/types.ts`):

```sh
node --import $TSX regress.mjs $CALC /tmp/calculations-orig.ts $SYMBOLS
```

Re-fetching (`node fetch.mjs ...`) replaces the saved inputs with newer data and changes the results; keep the saved sets to reproduce the reports. Binance only serves about 30 days of OI history, so the 28-day set cannot be re-fetched later.

## Method notes

- Flow is each candle's taker-buy quote volume versus total quote volume, so every bucket is complete.
- Entry at the open of the signal bar, exit at the close 3, 12 or 48 bars later; 10 bps round-trip cost.
- Non-overlapping samples keep at most one signal per token per horizon.
