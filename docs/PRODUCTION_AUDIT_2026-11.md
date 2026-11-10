# Production audit — https://ans.y2k.ventures (read-only)

Audit time: 2026-11-08 ~19:20 UTC+8. Credentials/session were used read-only; no
production mutation, restart or deployment was performed.

## Deployment

| Item | Finding | Evidence |
| --- | --- | --- |
| Production commit | **Older than main `ba5f615`; exact SHA NOT VERIFIED** (no server access) | `/api/operations` exposes `process` (added c0d1317) but **not** `researchJobs` (34a68a0); `/research/jobs` falls through to SPA HTML (fixed in code) |
| Frontend | Old build without Research Jobs UI | `main-BJgkMQha.js` lacks `Full research` / `/research/jobs`; panel has Quick Preview |
| API health | ok, mode live-public, 14 venues | `GET /api/health` 200 |
| Process uptime | pid 7, startedAt 1794115145437 | `/api/operations.process` |
| Version match | frontend and API are both pre-jobs (consistent, stale vs GitHub) | feature fingerprint |

## Data pipeline

| Check | Finding |
| --- | --- |
| Binance probe | `live`, latency 0ms (cached probe), checkedAt fresh |
| Venue breakers | mostly closed; recent successes; some timeout failures on discovery/series |
| Collector | 3 projects in **standard** mode; last checks recent; no errors |
| Watchlist quotes | PRL/SIGN LIVE, JCT PARTIAL; price/volume/OI/funding populated; ages 4–8s |
| Delayed/STALE | **NOT REPRODUCED** on 5 pages; MEXC SSE produced 262 events/25s; badge logic is SSE-driven (stale after 20s without event) |
| Empty fields | takerBuy/Sell, volumeDelta, OI delta, CVD = `unavailable` for all venues; Cross-Venue page 92 “—” (CoinGlass-backed data absent) |
| JCT mapping | only `mexc:perpetual:JCT_USDT`; live price 0.0078 — mapping valid |
| L2 collector | **not running**: `activeFeeds=0`, `sampled=0`; all projects Standard; JCT is MEXC (L2 engine supports binance/bybit/okx only) |
| TimescaleDB | **not connected**: `storage.mode=local-journal`, `connected=false`, 1.23 GB journal, no DB rows |
| Research jobs API | **absent in production** (HTML fallback) → jobs/persistence not deployed |
| Acceptance API | not registered (HTML fallback), consistent with production guard |

## Root causes

- **P1 — Production is an outdated build.** Latest research-job work (API, UI, persistence,
  cancellation) is not deployed. Fix requires a normal deploy; no auto-deploy performed.
- **P1 — No TimescaleDB connection.** History is local NDJSON; DB audit items are NOT VERIFIED.
- **P1 — L2 collector idle.** Only Active projects with binance/bybit/okx markets collect; all
  are Standard and JCT has no supported venue.
- **P2 — Empty derivatives fields are data-source gaps, not rendering bugs.** Native adapters
  do not provide taker/CVD/OI-delta; CoinGlass-backed cross-venue data is unavailable.
- **P2 — “Delayed” badge could not be reproduced.** It is SSE-driven (20s without an event);
  a stream gap or clock skew can trigger it while REST polling is healthy.
- **Fixed (P1) — Unknown `/api/*` returned SPA HTML with 200.** This hid missing endpoints
  from clients and made version skew look like success. Now JSON 404.

## Fix

Commit `api-not-found`: `server/api-not-found.ts`, mounted before the SPA fallback.
Tests prove unknown API routes return `API_NOT_FOUND` 404 while real API and SPA routes
still work. Requires redeploy to affect production.

## Re-audit (2026-11-09, after TimescaleDB deployment)

| Module | Status | Evidence |
| --- | --- | --- |
| API | LIVE | `/api/health` ok, process pid 7, new `startedAt` |
| TimescaleDB | CONNECTED | `mode=timescaledb-with-local-outbox`, `connected=true`, ~177k rows |
| History query | FAST | `/history` ~291ms, backend `timescaledb` (was 36s local scan) |
| Research quick preview | LIVE | 6 venues / 15 pairs / 140–162 samples; 0.5–0.8s |
| Research job | PASS | COMPLETED 1,734 records in ~0.55s; parallel submit dedupes to one job |
| Data coverage | PARTIAL | 300s cadence, max ingest gap ≈25.8h (previous outage), trade stale |
| L2 collector | IDLE | `activeFeeds=0`, all projects `standard`; JCT has only MEXC |
| Exact deployed SHA | NOT VERIFIED | no server access before `/api/version` deployment |

The 25.8h ingest gap corresponds to the period when the production site was unreachable;
it explains the stale/partial data observed earlier.

## Historical gap audit (2026-11-09, read-only)

Command (admin session from env, no writes):

```bash
NOX_AUDIT_USER=... NOX_AUDIT_PASSWORD=... \
  node scripts/audit/historical-gaps.mjs --base=https://ans.y2k.ventures --days=3 --min-gap-minutes=10
```

### Perle (6 venues: gate, kucoin, bitget, bybit, binance, mexc)

| Field | Value |
| --- | --- |
| Largest gap | **2026-11-07T03:22:50Z → 2026-11-08T05:10:07Z** |
| Duration | **92,836,958 ms ≈ 25h 47m** |
| Affected venues | all 6 simultaneously |
| Estimated missing | ≈308 snapshots per venue at 300s cadence |
| Second gap | 2026-11-08 ~05:38Z, 1.4–2.3M ms per venue (≈4–7 snapshots) |

### JCT (MEXC only)

First sampled ingest is 2026-11-08T05:23:43Z; a separate gap begins
2026-11-08T06:59:03Z. JCT was added/collected later than Perle, so its window differs.

### Classification

- All venues stop and resume at the same instant, and the local journal's own
  `largestIngestGapMs` matches the DB gap → **collector/API outage**, not an
  exchange-specific failure and not a migration artifact.
- The window is absent from the source journal, so DB migration cannot recover it.
- Exchange REST history (klines/trades) cannot reconstruct the same snapshot OI/funding
  or L2 book events; **no interpolation or synthetic backfill**. The window stays a
  permanent gap marker.
- Trade stream is separately stale (event-driven tape), which is expected when no trades
  are recorded in the sampled window.

## Binance API failure audit (2026-11-10, read-only)

Observed via `/api/operations`, `/api/venues/health`, `/api/data-health/center`:

| Endpoint family | Status | Evidence |
| --- | --- | --- |
| `premiumIndex` (snapshot) | **418** | breaker `binance:snapshot` **open**, 9 failures, lastError `Binance 418: /fapi/v1/premiumIndex?symbol=JCTUSDT` |
| `aggTrades` (series) | **418** | breaker `binance:series` **open**, 9 failures, lastError `Binance 418: /fapi/v1/aggTrades?...` |
| `depth` | **418** | breaker `binance:depth` **half-open**, 9 failures |
| `klines`/series | 502 upstream then 418 | `/api/market/binance/BTCUSDT/series` currently returns open-circuit, not data |
| openInterest/funding | unavailable via same 418 family | collector reports `1 venue(s) unavailable` for all 3 projects |
| CoinGlass | LIVE | provider unaffected (separate vendor) |

- Last success ≈ 2026-11-10T15:38Z; failures start immediately after and stay in cooldown.
- Production `/api/version` exists but `commit=unknown` (no `NOX_COMMIT_SHA` injected).
- L2: **no active feeds at audit time** (`activeFeeds=0`), so the reported 110 gaps / 566
  resyncs were accumulated in an earlier page-opened feed session. They are not
  reproducible now and cannot be attributed without those session logs.
- Research rejection (`0/5`, insufficient samples) is consistent with missing Binance
  trades/klines; it is a correct quality refusal, not a research bug.

### Root cause (confirmed)

**Binance IP-level 418 rate limiting.** Multiple server modules requested the same
uncached endpoints independently (watchlist quotes, overview, structure, order flow,
alignment, research), with no shared in-flight dedupe, no per-endpoint spacing and no
honoring of `Retry-After`. Repeated retries deepened the ban and kept breakers open.

### High probability contributors

1. No unified request budget/dedupe across modules.
2. Snapshot fetch failures caused L2 resync loops that re-requested REST depth.
3. Retry/backoff was per-breaker, not global; other families kept calling during cooldown.

### Not verified

Exact request counts, egress IP and rate-limit headers (not exposed by the API); the
24h error log is not accessible without server access. No IP rotation or proxy bypass
was used or will be used.
