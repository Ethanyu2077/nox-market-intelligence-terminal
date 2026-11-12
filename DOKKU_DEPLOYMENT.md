# Dokku deployment

Production runs as the `ans` application at `https://ans.y2k.ventures`. The frontend and API share the same origin. Build and deploy from a source-only archive of `main` using the Dockerfile builder. The image uses Node 24 and listens on port 3000. Dokku checks `/api/health` before routing traffic to a new container.

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
| Derived event-study revisions | 256 MiB, 35 days | `NOX_OUTCOME_MAX_BYTES`, `NOX_OUTCOME_RETENTION_DAYS` |
| Order-flow checkpoints across markets | 512 MiB | `NOX_ORDERFLOW_MAX_BYTES` |
| Market data cache across keys | 128 MiB | `NOX_MARKET_CACHE_MAX_BYTES` |
| TimescaleDB `nox_history_events` and its indexes | 4 GiB target, 90 days | `NOX_TIMESCALE_MAX_BYTES`, `NOX_TIMESCALE_RETENTION_DAYS` |
| Free-space threshold on the local data volume | 512 MiB | `NOX_STORAGE_MIN_FREE_BYTES` |

With a database configured, the local journal protects unacknowledged observations. A sustained database outage can fill the journal. Further historical writes then stop, and missed observations during that interval can leave a historical gap. Local-only mode can retire older journal data to make room. Live feeds continue to update in memory. The storage section of `/api/operations` exposes the effective budgets and disk-pressure state.

At 90% of its budget, TimescaleDB retention reclaims the oldest completed chunks until usage falls to 80% or only open chunks remain. The application pauses replication if current chunks still occupy 90% of the budget. During that pause, reads combine existing database history with pending local observations. The database service also needs space for WAL, system catalogs and other tables.

Configure storage for backups, Docker builds/images and host logs separately. With Docker's `json-file` log driver, the following app option rotates the new web container's logs at 10 MB and retains three files. Check existing options before changing them.

```sh
dokku docker-options:report ans
dokku docker-options:add ans deploy '--log-opt max-size=10m' '--log-opt max-file=3'
```

[Dokku container options](https://dokku.com/docs/advanced-usage/docker-options/) · [Docker log rotation](https://docs.docker.com/engine/logging/drivers/json-file/)
