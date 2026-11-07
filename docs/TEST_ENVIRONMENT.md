# Disposable Timescale test environment

Isolated PostgreSQL + TimescaleDB started with Docker Compose. It is not production and
contains no real credentials.

## Start / stop

```bash
cd deploy/test
cp .env.example .env         # edit the two passwords
docker compose up -d
docker compose ps            # healthcheck must be healthy
```

```bash
docker compose down          # keep the volume
docker compose down -v       # destroy test data
```

Connection: `postgres://nox_test:<password>@127.0.0.1:55432/nox_test`.

## Migrations / schema

The journal schema used by `HistoryStore` is created by the application on first use.
After the API has connected once, verify it:

```bash
docker compose exec timescale psql -U nox_test -d nox_test -c "\dt"
```

`nox_history_events` must exist before running the acceptance probe.

## Acceptance (never against production)

Start the API with an explicit test environment and acceptance flag:

```bash
NODE_ENV=test NOX_ACCEPTANCE_MODE=1 NOX_API_URL=http://127.0.0.1:8787 \
  ACCEPTANCE_ADMIN_USER=... ACCEPTANCE_ADMIN_PASSWORD=... \
  ACCEPTANCE_ALLOW_WRITES=1 ACCEPTANCE_TEST_DB_NAME=nox_test \
  DATABASE_URL=postgres://... \
  node scripts/acceptance/timescale.mjs
```

For process-restart recovery also set `ACCEPTANCE_RESTART_CMD` to an explicitly
authorized command. Without it the probe reports `NOT VERIFIED`.

## Status

The compose file and probe are IMPLEMENTED. No Timescale instance was started in this
session, so READ/WRITE/CONNECTION RECOVERY/PROCESS RESTART RECOVERY remain
**NOT VERIFIED**.
