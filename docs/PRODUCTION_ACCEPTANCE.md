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


## Updates (acceptance integrity round)

### Process restart recovery

Requires `NOX_API_URL`, `ACCEPTANCE_RESTART_CMD`, `DATABASE_URL` and
`ACCEPTANCE_ALLOW_WRITES=1`. The probe records process `startedAt` and test ids through the
API, runs only the explicitly configured restart, waits for `/api/health`, then re-reads
identity and ids through `/api/acceptance/records`. PASS requires a changed identity, a
ready API, and identical ids without duplicates. Connection-pool recovery is reported
separately and never satisfies process restart recovery.

### L2 continuity

`l2-live.mjs` now uses `scripts/acceptance/lib/l2-analysis.mjs`: repeated snapshots are
deduplicated (epoch+sequence), longest continuous live is the longest single run (never a
sum of segments), and PASS requires ≥80% observed window, ≥80% valid window, ≥80% longest
run, gap ≤5s, no new gap, valid spread/depth, delay ≤15s and no early SSE end. Fewer than
two valid updates is NOT VERIFIED.

## Updates (acceptance integration)

- Timescale probe requires `ACCEPTANCE_ADMIN_USER` + `ACCEPTANCE_ADMIN_PASSWORD` (never logged);
  it logs in through `/api/auth/login`, sends the session cookie to `/api/acceptance/records`,
  and re-authenticates after an authorized restart. Missing/invalid credentials are
  NOT VERIFIED, never anonymous access.
- Writes require `ACCEPTANCE_ALLOW_WRITES=1` AND `ACCEPTANCE_TEST_DB_NAME` matching the
  connected `current_database()`, which must look disposable. URL matching alone is rejected.
- L2 JSON report fields (recovery, gap, resync, status) come from the same analyzer decision;
  `state=live` or `integrity=ok` alone never implies recovery.

## Updates (research query reliability)

- `scanHistory` classifies interruptions (timeout/query-error/invalid-cursor/cancelled/
  max-pages/max-records); all set `truncated=true` and keep partial rows. Driver errors are
  sanitized to `query-error`.
- Full-history research runs as an async job (`POST /api/projects/:id/research/jobs`) with
  independent snapshot/L2 cursors, id dedupe, fixed `asOf`, page bounds, concurrency and
  runtime limits (`NOX_RESEARCH_MAX_JOBS`, `_MAX_RECORDS`, `_TIMEOUT_MS`, `_PAGE_LIMIT`,
  `_PAGE_TIMEOUT_MS`). Statuses are QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED/CANCELLED and
  PARTIAL always carries a truncation reason.

## Updates (research job reliability)

- Page deadlines and caller cancellation interrupt journal scans and database reads. Database
  reads use a dedicated connection with a transaction-local `statement_timeout`
  (NOX_DB_STATEMENT_TIMEOUT_MS). An idle pool connection can send `pg_cancel_backend`;
  a saturated pool discards the reading connection immediately. Unit tests cover cancellation
  during query setup. Live PostgreSQL cancellation requires an instance to verify.
- Fingerprint: `[projectId, factor, timeframe, start, end, asOf]`; only identical active
  jobs are reused.
- Persistence: `<dataDirectory>/research-jobs.json` (atomic rename), storing status,
  fingerprint, progress/cursors, truncation reason, error and report. Restart restores
  terminal jobs; persisted RUNNING/QUEUED become INTERRUPTED.
- Limits: NOX_RESEARCH_MAX_JOBS, _MAX_RECORDS, _TIMEOUT_MS, _PAGE_LIMIT,
  _PAGE_TIMEOUT_MS, _TTL_MS, _MAX_RETAINED, _MAX_REPORT_BYTES.
- UI reloads persisted jobs and requires an explicit Load report; PARTIAL/INTERRUPTED are
  never presented as complete conclusions.

## Phase III additions

### Version

`GET /api/version` returns `{ commit, buildTime, apiVersion, startedAt, node }`. Set
`NOX_COMMIT_SHA` and `NOX_BUILD_TIME` at build/deploy time; no paths or secrets are exposed.

### Data health

`GET /api/data-health/center` aggregates live venue snapshots, data-coverage, breakers,
collectors, L2 and storage. States: LIVE / PARTIAL / STALE / UNAVAILABLE / NOT VERIFIED.
A 200 response with null metrics is UNAVAILABLE, never LIVE.

### Journal migration (dry-run by default)

```bash
node scripts/migration/journal-to-timescale.mjs --data-dir=.data
# apply only on an authorized target:
DATABASE_URL=... MIGRATION_ALLOW_WRITES=1 \
  node scripts/migration/journal-to-timescale.mjs --data-dir=.data --apply
```

The tool never deletes the journal; inserts use `ON CONFLICT (event_time,id) DO NOTHING`
and the checkpoint is bound to each file's SHA256. Production apply is NOT executed.


## L2 persistence policy

Only 5m L2 buckets are written to TimescaleDB. 1s/5s depth summaries stay in memory for
live views, and full books are never persisted. Higher timeframes are aggregated from 5m;
1s/5s records written before this policy remain readable via the metrics endpoint.
