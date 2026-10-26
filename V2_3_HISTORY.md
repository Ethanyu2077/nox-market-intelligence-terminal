# V2.3 — Historical Data Infrastructure (first increment)

This increment changes the historical backend, not the frontend or exchange adapters. It does not enable trading, external signal publishing, or automatic data deletion.

## Implemented

- Healthy TimescaleDB is now the primary backend for `HistoryStore.read()` and the paginated history API. Existing regime evaluation and Event Study callers reuse this path. Connection, migration or query failures return explicitly labelled local-journal fallback. No missing rows are replaced with fabricated data.
- Parameterized range queries use project, market, kind, source-event cutoff and ingest cutoff. Migration `004_history_queries.sql` adds project/market membership, database identity, and range indexes. Native trade events remain shared, rather than duplicated per project.
- Project-to-market membership is persisted with effective ingestion-time intervals. Adding a market today does not automatically claim its past shared-feed history. Membership tracking starts when this increment first observes the project, without inventing earlier mapping history. Existing project-tagged snapshots remain available.
- New journals are partitioned by UTC **ingest date** and event kind. Legacy V2.2 `history-*.ndjson` files are read and replicated in place. They are not deleted or rewritten.
- Replication resumes from persisted byte offsets instead of rescanning previously committed lines. Checkpoints advance only after database COMMIT and atomic checkpoint-file replacement. Failed batches roll back. A crash after COMMIT but before checkpoint persistence safely replays using `ON CONFLICT`.
- Checkpoints include file identity and are namespaced by the configured database URL fingerprint; credentials are never included in status responses. A database-side UUID also detects a fresh/replaced database and triggers replay. Unexpected journal truncation, replacement or malformed tails stop replication and report degradation; they are not silently discarded.
- Pagination orders by event time and UTF-8 ID, deduplicates retries, preserves an `asOf` ingest cutoff, and reports the actual backend. Append operations arriving during an existing replication pass trigger the additional pass required before a primary read.
- `/api/operations` now includes journal bytes, unacknowledged bytes, available disk space, low-disk warning, checkpoint type, partitioning and actual query backend. `NOX_DISK_WARNING_BYTES` defaults to 5 GiB; monitoring refreshes every 15 seconds.
- Operator lifecycle CLI supports reviewed compression/retention plans; it is dry-run by default. No policies were applied during this implementation.

## History API

`GET /api/projects/:id/history?kind=trade&from=...&to=...&asOf=...&marketKey=binance:perpetual:SYMBOLUSDT&limit=200`

`kind` is trade, liquidation, snapshot or regime. Times are epoch milliseconds. `limit` is 1–1000. `marketKey` is optional. No symbol is automatically added by this endpoint.

Response: `items` (newest first), `backend`, `fallback`, `asOf`, `nextCursor`, `localScan`. For the next page pass the returned cursor with the same filters; the cursor retains its original cutoff. Changing an explicit cutoff mid-pagination is rejected. A new query is needed to include subsequently ingested events.

The existing `read()` compatibility method still returns oldest-to-newest within its bounded latest-record window. The new endpoint exposes full pagination rather than silently pretending that a bounded result is complete history.

## Database setup and real integration test

1. Supply a real self-hosted TimescaleDB instance (none was installed on this machine during this run).
2. On an existing V2.2 database, run `db/migrations/004_history_queries.sql` after `003_history.sql`. New Compose volumes apply all migrations; an existing Compose volume does **not** automatically rerun new initialization scripts.
3. Set `DATABASE_URL` in the server process environment, restart, then inspect `/api/operations`. Confirm `connected: true`, `queryBackend: timescaledb`, and advancing acknowledged bytes/rows. Do not assume a configured URL proves a live database.
4. Set `NOX_TEST_DATABASE_URL` to a **dedicated disposable test database with TimescaleDB already installed**, then run `npm test`. The integration test creates an isolated generated schema, runs migrations, writes real records, queries project-mapped trades, verifies restart recovery and removes only that generated test schema. Do not point it at production.

Without this test URL, the real-database test is explicitly **skipped**, not passed. Mock database tests check orchestration and SQL parameter use only; they do not prove SQL or Timescale compatibility.

## Compression and retention

`npm run history:policy` prints the default disabled dry-run plan. Set operator-chosen integer values for `NOX_HISTORY_COMPRESSION_DAYS` and `NOX_HISTORY_RETENTION_DAYS` to inspect a plan. Retention must exceed the compression age when both are enabled.

Applying a reviewed plan requires `npm run history:policy -- --apply`; any retention additionally requires `--confirm-history-deletion`. This creates a background policy that **permanently removes expired database chunks**. Confirm backups, replay requirements and the retention decision first. Existing policies are never silently replaced. No apply command was run here.

The implementation uses the still-supported Timescale compression API for compatibility with the existing schema. Check installed-version capabilities before production use. References: [Timescale compression](https://github.com/timescale/docs/blob/latest/api/compression/add_compression_policy.md), [retention policy](https://www.tigerdata.com/docs/reference/timescaledb/data-retention/add_retention_policy).

Local journals are not automatically deleted or compressed. Database retention does not reclaim their disk space. Low-disk warnings therefore require operator action. A safe sealed-segment compaction/export/cleanup workflow is still follow-up work, not something silently enabled by this increment.

## Remaining boundaries

Validation in this run: 59 tests discovered; 58 passed, 1 real-Timescale test explicitly skipped, 0 failures. TypeScript production build and lint passed. Running preview returned HTTP 200; real persisted snapshots paginated across two pages with a stable cutoff and no duplicate IDs. All four saved project collectors remained operational. Current live backend is **local-journal**, not TimescaleDB.

- Live TimescaleDB migration/query/EXPLAIN and compression-policy acceptance remain unverified on this host until a real instance is supplied.
- A database restored to an older backup while retaining the same database UUID requires an operator checkpoint reset and journal replay. A backup/restore runbook and database-side transactional replication checkpoints remain future hardening. Run only one writer process per DATA_DIR; distributed leases are not implemented.
- Local fallback is intentionally explicit and memory-bounded but still scans matching journal files. It is not the large-scale production query engine. Local journal fsync/power-loss recovery, sealed-segment retention, backup tooling and capacity alert delivery remain future work.
- Private read authorization, durable sessions and audit trails are not expanded in this backend increment. Existing V2.2 anonymous read-only mode remains unchanged.
- Adaptive Regime Engine rules, immutable full input bundles, independent event deduplication, walk-forward evaluation and Strategy Backtesting remain the next stages. Existing Signal Lab is still an event-study research scenario, not an executable strategy result.
