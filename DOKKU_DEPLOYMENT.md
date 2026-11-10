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

Keep one web process with the current journal outbox. Maintain the existing persistent mounts and private host directory permissions. Both directories are owned by UID/GID 1000.

```text
/var/lib/dokku/data/storage/ans/data:/app/.data
/var/lib/dokku/data/storage/ans/auth:/app/var/auth
```

The `ans-history` TimescaleDB service supplies `DATABASE_URL` through its Dokku link. For a new service, apply `db/migrations` before linking it. Replay an existing journal before cutting over the application. Keep the database port internal. The data mount contains the journal and retry checkpoints, and the auth mount contains the SQLite database and encrypted provider credentials. Keep runtime data and credentials out of source archives.

Verify the source archive checksum on the server, then deploy it with `dokku git:from-archive --archive-type tar.gz ans file:///tmp/<archive-name>.tar.gz`. Check `/api/health` and `/api/operations`. The storage report should show `connected: true` and `queryBackend: timescaledb`. Confirm an existing project's history endpoint also returns `backend: timescaledb`.
