# NOX V2.4 — Market Regime & Flow Attribution, first increment

## Implemented scope

This increment implements the four approved priorities without rebuilding the app: stable event identity, venue/aggregate regime separation, historical adaptive baselines, and cross-venue flow attribution. It preserves the seven exchange adapters, project selections, existing native/TradingView charts, historical storage and authentication. No trading, AI model calls or external signal publishing are added.

### Stable, reproducible observations

- Venue and project aggregate IDs hash the project, venue/scope, rule version, interval and closed-window end. Re-evaluating a window does not create another independent event.
- The recorder freezes the first report and its normalized snapshot/bucket inputs. Later data cannot overwrite that observation. A serialized persistent per-project/interval watermark prevents duplicates after restart. Journal lookup handles a crash between the report append and watermark update.
- The engine waits for a 90-second closure grace period. **Decision time is the actual evaluation time**, which can be later because of Standard-mode scheduling, downtime or feed latency. This is not a claim that the signal was available at candle close.
- Frozen inputs retain source-event and ingest times, identity and quality. Data unavailable at decision time is excluded. `evaluateVenue(recordedVenue.input, projectId)` reproduces a recorded venue evaluation. Captured flow buckets are evidence available at decision time; they are not retrospectively reconstructed as though received earlier.
- Recording remains single-writer per DATA_DIR. Cross-process distributed locking is not implemented. Different intervals may overlap in economic exposure and must not be pooled as independent strategy trades.

### Venue versus aggregate state

- 5M, 15M, 1H and 4H evaluations are separate. Every selected perpetual market has its own result, missing-data list and input references.
- An aggregate requires at least two eligible venues. Disagreement remains `Cross-exchange disagreement`; incomplete unanimous coverage is `Partial venue agreement`, not a fabricated full-market consensus.
- Supporting, contradicting and unavailable venues are separate. Evidence quality is a deterministic coverage score, not a probability or a measure of directional profitability.
- Global exchange selection focuses the venue tables and venue state; the project-wide coverage/attribution context remains visible and labelled. Global 1M maps explicitly to the minimum supported 5M regime window. Existing 1M charts are unaffected.

### Adaptive baselines

- Each venue uses up to 200 prior non-overlapping same-duration windows from the selected project. At least 30 comparable price/base-OI windows plus complete aligned aggressor flow are required before a structural label is eligible.
- The current price/OI move is compared with the empirical 75th percentile of absolute historical moves, replacing universal price/OI percentage thresholds. The 75th percentile and sample minimum are versioned **rule choices**, not learned optimal trading thresholds.
- Anomaly rank is the maximum covered price/OI historical percentile (0–100). Aggregate anomaly is the maximum eligible venue rank. It is not a success rate. Evidence quality is separate, and historical edge is explicitly null/unvalidated.
- Absorption additionally needs at least 30 prior complete flow buckets and unusually strong absolute delta. Without a flow baseline the absorption rule is disabled, rather than treating every flat-price trade as absorption.
- Historical snapshots are sampled at interval boundaries instead of taking only the newest N raw records. Boundary tolerance is at most 90 seconds. The database performs range-limited boundary sampling when connected; explicit local fallback scans journals. Source outages, sleep gaps and Standard-mode samples outside boundary tolerance remain missing.

### Flow attribution

- Perpetual and spot aggressive flow remain separate. A window's complete volume delta is also its CVD change; absolute CVD levels with different reset baselines are not summed.
- Perpetual net-delta absolute shares and HHI are calculated only over covered selected venues. Missing denominators stay null. HHI here measures **absolute net-delta concentration**, not total traded-volume concentration or causal venue leadership.
- OI-flow notional = normalized token-quantity OI change × end mark/price. Pure price revaluation of unchanged OI does not create OI expansion. Expansion and contraction shares have separate denominators.
- Full-universe totals remain null unless every selected venue has that metric. Covered subtotals are named separately. Spot coverage is calculated for the exact closed window, not from whether a venue had any complete bucket elsewhere in the cache.

## UI and APIs

- **Signals & Alerts** now shows V2 regime states, baseline sample counts, coverage, venue conflicts, flow attribution and missing inputs. The existing NOX tokens/layout, bilingual controls and theme behavior are reused through the local Sites workflow.
- `GET /api/projects/:id/regimes-v2?interval=5m` returns recent summaries. Large input arrays are omitted from the default response; reference counts remain visible.
- Add `eventId=<stable ID>` to retrieve one complete frozen input bundle. The page provides a download link for reproduction.
- Old V1 history remains intact. The existing historical Signal Lab is still a legacy Event Study; V2 records are excluded from its V1-only evaluator rather than being misinterpreted as executable trades. V2 event-study cohorts and strategy simulation are future stages.
- Existing database users should apply migrations 004 and 005 after 003. Migration 005 indexes identity lookups. The real TimescaleDB sampling query still requires real-database acceptance testing.

## Verification and limitations

- 70 automated tests discovered: **69 passed, 1 real-TimescaleDB test explicitly skipped** because no test instance is configured. Production build and lint passed.
- New tests cover stable identity, all four durations, changed local volatility baselines, venue disagreement, partial/misaligned/future flow, exact input reproduction, base-OI attribution, spot-window coverage, long-window history sampling and recorder restart deduplication.
- Browser checks covered Chinese/dark and English/light, the 775px and 1440px layouts, global exchange focus, interval changes, and explicit insufficient-data results. No new browser errors or horizontal document overflow were observed.
- Live API verification returned HTTP 200 and preserved all four saved projects. All four durations returned stable IDs across repeated reads; their venue outputs reproduced from the real frozen bundles. These observed bundles currently have insufficient baseline/flow coverage, not validated actionable signals. Collector storage-error lists were empty; legacy live-stream status can still report degraded separately.
- Live observations may legitimately show no eligible signal. Enable Active for ongoing supported order-flow collection and allow enough complete history to accumulate. No projects or symbols were auto-added and no monitoring preferences were changed during QA.
- Funding is reported as observed context but does not drive the V2 directional rules. Basis, full L2 depth, comprehensive liquidation coverage, venue lead-lag, historical edge calibration, out-of-sample evaluation and execution simulation are not implemented by this increment. Missing exchange capabilities remain unavailable.
- TimescaleDB remains unconnected on this host; current persistence is local-journal. Full-payload historical API reads and frozen-input storage still need production-scale performance/retention tuning. Private-read authorization and distributed recorder coordination are unchanged from V2.3.

Next stages: real database acceptance; V2 Event Study with independent cohorts and time-indexed forward paths; quality-weighted cross-venue research; only then separately scoped strategy simulation and validated statistical edge.
