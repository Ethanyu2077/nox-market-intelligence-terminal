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
