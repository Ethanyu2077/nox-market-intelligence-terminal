# Dokku deployment

Production runs as the `ans` application at `https://ans.y2k.ventures`. The frontend and API share the same origin. The Dockerfile builds a Node 24 image listening on port 3000. From the original checkout, run `bash deploy/dokku-sync.sh <commit>` to fast-forward the configured Dokku remote. The script checks the persistent mounts, enforces a single writer during rollout, and reports application storage and host filesystem usage. Use `--check <commit>` for local preflight or `--verify <commit>` to read the running release.

Use these application settings:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATA_DIR=/app/.data
NOX_AUTH_DIR=/app/var/auth
NOX_ALLOWED_ORIGINS=https://ans.y2k.ventures
NOX_SECURE_COOKIES=true
NODE_OPTIONS=--max-old-space-size=1024
```

Keep one writer per data mount, including during deployments. Quiesce the old collector before starting the replacement against the same data. Maintain the existing persistent mounts and private host directory permissions. Both directories are owned by UID/GID 1000.

```text
/var/lib/dokku/data/storage/ans/data:/app/.data
/var/lib/dokku/data/storage/ans/auth:/app/var/auth
```

The `ans-history` TimescaleDB service supplies `DATABASE_URL` through its Dokku link. For a new service, apply `db/migrations` before linking it. Replay an existing journal before cutting over the application. Keep the database port internal. The data mount contains the journal and retry checkpoints, and the auth mount contains the SQLite database and encrypted provider credentials. Keep runtime data and credentials out of source archives.

Verify the source archive checksum on the server, then deploy it with `dokku git:from-archive --archive-type tar.gz ans file:///tmp/<archive-name>.tar.gz`. Check `/api/health` and `/api/operations`. The storage report should show `connected: true` and `queryBackend: timescaledb`. Confirm an existing project's history endpoint also returns `backend: timescaledb`.

## Storage budgets

These settings take effect on startup, including for existing data. The byte limit can shorten the time window. Keep independent backups outside the application volume for longer-term research.

| Data | Default | Environment |
| --- | --- | --- |
| Local history and replication journals | 2 GiB, 45 days | `NOX_JOURNAL_MAX_BYTES`, `NOX_JOURNAL_RETENTION_DAYS` |
| Fully committed local copies within the journal budget | 256 MiB target | `NOX_JOURNAL_ACK_CACHE_BYTES` |
| Derived event-study revisions | 256 MiB, 35 days | `NOX_OUTCOME_MAX_BYTES`, `NOX_OUTCOME_RETENTION_DAYS` |
| Order-flow checkpoints across markets | 512 MiB | `NOX_ORDERFLOW_MAX_BYTES` |
| Market data cache across keys | 128 MiB | `NOX_MARKET_CACHE_MAX_BYTES` |
| TimescaleDB `nox_history_events` and its indexes | 4 GiB target, 90 days | `NOX_TIMESCALE_MAX_BYTES`, `NOX_TIMESCALE_RETENTION_DAYS` |
| Free-space threshold on the local data volume | 512 MiB | `NOX_STORAGE_MIN_FREE_BYTES` |

## Live feeds and historical capture

| Data | Default handling | Use |
| --- | --- | --- |
| Per-second strength quotes, current watchlist and venue quotes, live order-book frames | Shared feed or bounded in-memory cache | Live dashboard and reconnect |
| Individual trades | Bounded order-flow checkpoint, up to 24 hours or 50,000 trades per market, whichever comes first | Recent trade replay, CVD and gap detection after a restart |
| Liquidations, sampled market observations, volume, alignment decisions, regime evidence and completed L2 metric buckets | Journal, then TimescaleDB | Historical queries and research |
| Event studies | Computed from recorded evidence on request | Same historical study API |

Active projects poll venue snapshots every 30 seconds. Historical capture normally saves one snapshot per market and one alignment decision per project per UTC minute. Corrections to the last source timestamp and changes in snapshot quality can be recorded sooner. Repeated receipts of the same source observation are skipped. The rolling 24-hour volume matrix is sampled every five minutes. Standard projects sample all three streams every five minutes. A history page reads committed data and pending journal entries without requesting a database flush.

After a restart, the collector uses the database and up to 512 KiB of recent local journal data per lookup to recover its last samples. If the database is unavailable and that tail is too busy to contain the current window's sample, the collector can save an extra observation in that window.

Changed order-flow tapes normally checkpoint once per minute and flush on a clean shutdown. An abrupt stop can leave the latest uncheckpointed trades to exchange backfill, subject to the venue's replay range. This release reads existing checkpoints. When rolling back to an older binary, a tape with newer sparse corrections may need to be restored from an older checkpoint or rebuilt from exchange data.

Compare two `/api/operations` samples with the same `process.startedAt` to measure writes. `storage.writes.journalRowsByKind` counts newly journaled observations per kind. `databaseRowsInserted` and `databaseInsertBatches` under `storage.writes` count inserted rows and successful insert transactions, including catch-up activity. `storage.orderFlow.writes` counts base and delta files and their bytes separately.

`NOX_ARCHIVE_RAW_TRADES=true` also captures each new trade in long-term history. Existing trade history and pending journals remain readable and eligible for replication under either setting. The trade history endpoint reports the current capture setting. `NOX_OUTCOME_AUDIT_ENABLED=true` enables background event-study revision exports for offline audit.

Inspect `storage.capacity.pendingBytes`, `storage.error` and `storage.queryBackend` on `/api/operations` during recovery. `storage.capacity.byKind` shows local disk usage and unacknowledged logical bytes by event type. The process section reports current RSS, heap and external allocations in bytes. A malformed journal record is retained for repair. `NOX_HISTORY_MAX_RECORD_BYTES` defaults to 16 MiB and can be raised for a known larger legacy record.

If the database itself was restored to an earlier backup, give that restored database a new `nox_history_storage_meta.store_id` before reconnecting the writer. This triggers idempotent replay of retained files. A checkpoint created after the backup can otherwise appear current when the restored database carries the old identity.

With a database configured, the local journal protects unacknowledged observations. A sustained database outage can fill the journal. Further historical writes then stop, and missed observations during that interval can leave a historical gap. Local-only mode can retire older journal data to make room. Live feeds continue to update in memory. The storage section of `/api/operations` exposes the effective budgets and disk-pressure state.

After verifying the database identity, the writer trims fully acknowledged journal files when their combined size exceeds the local cache target. A sweep aims for 80% of that target. This also covers an oversized current-day file after its feed stops writing. Historical queries continue to use the database. During a database outage, the local fallback contains the records still on disk.

When a large plain file contains a verified committed prefix and a smaller pending tail of at most 16 MiB, the writer can reclaim the prefix under hard capacity pressure. It checks the file identity, record boundary and staging space before atomically replacing the file with its exact pending bytes. Check `storage.capacity.acknowledgedFileBytes` and `storage.retention.retiredBytes` to distinguish local copies from pending history during recovery.

At 90% of its budget, TimescaleDB retention reclaims the oldest completed chunks until usage falls to 80% or only open chunks remain. The application pauses replication if current chunks still occupy 90% of the budget. During that pause, reads combine existing database history with pending local observations. The database service also needs space for WAL, system catalogs and other tables.

The deployment script inspects the actual web container's log driver. For an unbounded local Docker log it configures a 10 MiB file size and verifies rotation on the replacement container. Existing finite limits and external log drivers retain their settings. Development and test Compose services use three 10 MiB files each. Host backups, Docker images/build caches, external log services and database WAL have separate storage policies.

[Dokku container options](https://dokku.com/docs/advanced-usage/docker-options/) · [Docker log rotation](https://docs.docker.com/engine/logging/drivers/json-file/)
