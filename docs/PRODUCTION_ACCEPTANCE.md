# Production acceptance runbook

The L2 probe is read-only. The Timescale probe performs isolated test writes only with
explicit opt-in; it is not a read-only command. A probe prints `PASS` only with direct evidence;
missing environments print `NOT VERIFIED` and must not be counted as passing.

## 1. Live L2 (Binance / Bybit / OKX)

```bash
node scripts/acceptance/l2-live.mjs http://127.0.0.1:8787 20
```

- PASS requires `state=live`, `verified=true` and a sequence id for that venue.
- Binance REST is intermittently blocked on this host; expect Binance to remain
  `NOT VERIFIED` while Bybit/OKX pass.

## 2. Network recovery

1. Start the API and open the L2 stream.
2. Disable the network for ~10 s (`networksetup -setairportpower Wi-Fi off` on macOS,
   or tc/netem on Linux).
3. Re-enable it and watch `resyncs` increase and `state` return to `live`.
4. Acceptance requires no crash and an explicit resync; it is `NOT VERIFIED` until
   this is executed on a controllable network.

## 3. TimescaleDB

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/nox node scripts/acceptance/timescale.mjs
```

Requires migrations to have run (`nox_history_events` present). Restart recovery:
write a bucket, restart the API, query the same window and compare ids.

## 4. Frozen historical dataset

Required for `VERIFIED WITH REAL DATA`:

1. Authorized export with event / received / available timestamps.
2. SHA256 manifest of the raw files.
3. Fixed factor rules version, timeframe, lookback and costs.
4. Run the research twice and diff the JSON output.

Without these, cross-exchange results stay `NOT VERIFIED`.

## 5. Panel E2E

`npm run e2e` covers the shell only; the dedicated Evidence Panel interactions
require a Chromium run against the research page. Until that suite exists, the
panel stays `NOT VERIFIED` even though it renders real API data.

## Updates (2026-11 final round)

### L2 probe V2

`node scripts/acceptance/l2-live.mjs <apiBase> <seconds>`

- Timeouts: overall (seconds + 10s), per-read 3s, no-data 8s; AbortController always released.
- PASS requires ≥2 valid updates, ≥1 strict sequence advance, one book epoch, positive
  spread/bid/ask depth, `gapsDelta = 0`, and max message delay ≤15s. A final `live`
  frame alone is a FAIL, not a PASS.
- Each venue reports duration, frames, valid updates, advances, epochs, gaps/resyncs,
  max delay, integrity, final state and PASS/FAIL/NOT VERIFIED.

### Timescale acceptance

```bash
DATABASE_URL=postgres://.../nox_test \
ACCEPTANCE_ALLOW_WRITES=1 \
ACCEPTANCE_RESTART_CMD='npm run start:test' \
node scripts/acceptance/timescale.mjs
```

- WRITE requires `ACCEPTANCE_ALLOW_WRITES=1` **and** a URL containing test/acceptance/tmp/ci;
  otherwise it refuses and reports NOT VERIFIED (no production writes).
- Rows use `source=acceptance:<ns>` and are deleted afterwards.
- RECOVERY closes the pool, optionally runs the restart command, then re-reads and compares
  ids/payload. Without the restart command it is a fresh-connection check, and the output
  says so; process restart is not claimed.
- READ / WRITE / RECOVERY are reported separately; overall PASS requires all three.

### Still NOT VERIFIED

- Panel dedicated E2E (no suite this round).
- Frozen real historical dataset + SHA256.
- Binance live L2 (REST intermittently unreachable here).
- Network interruption/reconnect execution.
- Timescale with a real disposable instance (script not executed).


## Updates (final E2E round)

### Evidence Panel E2E

`npm run e2e:evidence` renders `e2e/evidence.html` (real CrossExchangePanel) in Chromium,
intercepts the research API with deterministic fixtures and asserts 19 behaviours
(factor/timeframe/lookback/pair/sort, coverage, truncation, 500, empty, OOS NOT VERIFIED,
EN/ZH, 390px, no console errors). Missing Chrome reports SKIPPED (exit 2). CI runs it after
the smoke E2E. Fixtures are UI-only.

### Timescale statuses

READ / WRITE / CONNECTION RECOVERY / PROCESS RESTART RECOVERY are independent.
`connectionRecovery` uses a fresh pool in the same process. `processRestartRecovery` runs
only with `ACCEPTANCE_RESTART_CMD` and stays NOT VERIFIED otherwise. Overall PASS requires
all four.

### L2 continuity

Probe V2 reports requested/observed/continuous durations, max update gap, invalid-state
duration, valid window %, sequence advances, epoch changes and recoveryCompleted. PASS
requires ≥80% observed window, ≥80% valid window, gap ≤5s, one epoch, no new gap, positive
spread/depth, delay ≤15s and no early SSE end. Fewer than two valid frames is NOT VERIFIED.
