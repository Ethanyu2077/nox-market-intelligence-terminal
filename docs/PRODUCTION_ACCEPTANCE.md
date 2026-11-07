# Production acceptance runbook

All commands are read-only probes. A probe prints `PASS` only with direct evidence;
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
