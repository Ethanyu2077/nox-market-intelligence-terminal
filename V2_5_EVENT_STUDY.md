# V2.5 research increment — 2026-10-25

This increment extends the existing NOX frontend, collector and history store. It does not enable trading, third-party signal publishing, private account access or public deployment.

## Implemented

- Historical Analysis now reads frozen `nox.regime.v2` events. The earlier V1 study remains available behind an explicit expand control.
- Forward price horizons: 15 minutes, 1 hour, 4 hours and 24 hours. Filters: global venue/window, regime label, minimum evidence quality, flow concentration and 1/7/30-day research range.
- Signal Readiness shows current per-venue baseline count, remaining samples, freshness, flow continuity/gaps and observed metric availability. Paused, unsupported, stale, warming and ready states do not relax the V2 quality gates.
- Separate OI-USDT and rolling-24H-volume weighted distributions use the latest frozen event's known inputs. Original count-based consensus remains unchanged. Missing weights are null; shares use known weights only. All-zero denominators have no dominant label or share. These are exposure distributions, not probabilities or causal leadership scores.
- Background outcome tracking runs after collection, at most once per project per five minutes. One bounded input scan serves all four horizons. Derived revisions are stored separately under `.data/outcomes`; original signal journals are never rewritten by this feature.
- Read-only endpoints: `GET /api/projects/:id/event-study` and `GET /api/projects/:id/readiness`. Background errors appear in `/api/operations`.

## Methodology: `nox.event-study.v1`

Entry uses the latest valid observed price at or before the **actual decision timestamp**, known by that timestamp, with a maximum 90-second source age. It does not use window-close price as a substitute. Event and ingestion cutoffs are enforced. Future observations are used only for outcomes, never for event classification or cohort features.

An outcome remains pending until its horizon matures. It is incomplete if its final sample is more than 90 seconds before the horizon, or its observed path contains a gap over 390 seconds. Missing entry, incomplete path and failed essential evidence gates produce null returns, not zero. Observed flat prices can legitimately produce zero. MFE/MAE represent sampled price excursions relative to entry, not tick-level extremes or direction-adjusted trade P&L.

The interactive study purges overlapping project-event horizons within the selected cohort. Selection happens before outcome completeness is known. All selected venue paths for a parent event must be complete for that event to enter summary statistics. Venue returns are equally averaged into **one event cluster**; they are not counted as independent trials. Changing the cohort changes the purge selection. Remaining serial dependence and cross-project dependence are not assumed absent.

Median, Q10/Q90 and positive-price frequency are descriptive. Quantiles are not confidence intervals. Positive-price frequency is not strategy win rate. No calibrated edge, executable strategy, fee/funding/slippage simulation or independent-sample confidence interval is supplied. A signed directional scenario is present only for applicable inferred labels in the API; it is not represented as observed position opening or executable return.

Background tracking retains overlapping observations. Each changed study appends rows with stable methodology/event-venue/horizon IDs and revision hashes. Identical refreshes reuse the retained revisions. The worker expires the oldest derived data at 35 days or under its 256 MiB budget. The original market observations have their own journal and database retention settings. See [Dokku deployment](DOKKU_DEPLOYMENT.md).

## Bounded history and deployment

Research scans page through at most 4,000 V2 event envelopes and 100,000 price snapshots per request. Summary projections omit large frozen input arrays; price projections retain only price. If either cap is reached, summary statistics are suppressed and background persistence is skipped with an operations warning. Narrow the range rather than interpreting truncated cohorts.

Optional migration `006_regime_research.sql` adds a regime/source/interval query index, after migrations 003–005. SQL projections and the new index still require a real TimescaleDB acceptance run. This environment uses the existing local-journal fallback; a skipped integration test is not database acceptance.

No project, symbol, monitoring mode or credential is automatically created or changed. Active continuous collection is necessary to accumulate eligible flow windows; changing collection mode still requires the existing authenticated role.

## Verification and remaining work

- Automated tests: 80 total, 79 passed, one real-Timescale integration test skipped because no test database is configured.
- Production build and lint pass. Read-only live API checks cover all four existing user-selected projects; their currently insufficient evidence correctly produces zero eligible clusters and null performance statistics.
- Browser checks cover the new Historical Analysis and Signal Readiness views, Chinese/English, dark/light themes and narrow/desktop layout.

Remaining: real TimescaleDB integration/performance acceptance, longer Active-mode data accumulation, statistically justified uncertainty estimates, historical outcome-query tooling, transition analysis, cost-aware strategy research and broader replay UI. None is claimed complete by this increment.
