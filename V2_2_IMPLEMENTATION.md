# NOX V2.2 — first functional increment

## What is implemented

- Persistent project collection modes, reconciled every five seconds. Legacy projects default to Standard without changing their saved market selections.
- Active holds an independent reference to the existing shared order-flow service: closing the last browser does not stop collection. 30-second normalized market snapshots. Standard saves five-minute snapshots and retains on-demand order-flow behavior. Paused/archived projects release background collection.
- Append-only historical journals for normalized trades, partial liquidation events, market snapshots and immutable regime evaluations. Records retain source event time, ingest time, quality, source and market identity. Project preferences use serialized atomic replacement and corrupt preference files are not silently overwritten.
- Optional TimescaleDB replication with parameterized inserts, same-client transactions, idempotent primary keys and durable local retry journals. Run `db/migrations/003_history.sql` on an existing database first; fresh Compose instances also apply it. Set `DATABASE_URL` in the process environment. No configured database means explicit `local-journal` status, not a simulated Timescale connection.
- Local admin bootstrap, scrypt password hashes, opaque HttpOnly SameSite=Strict sessions, logout, login throttling, admin/analyst/viewer authorization checks. Anonymous access is read-only; project editing requires analyst/admin, deletion requires admin. Discovery remains a read-only POST. Origins are allowlisted and mutations require JSON.
- A versioned conservative regime engine uses same-venue base OI changes, price changes and complete closed five-minute aggressor-flow buckets. Up to 90 seconds of boundary tolerance is disclosed. Spot contradiction reduces the heuristic score. Missing data prevents classification; liquidation cascades are never claimed from price/OI alone.
- Signals and Historical Analysis now show stored real evaluations and Signal Lab research scenarios: matured forward horizons, explicit round-trip cost assumptions, sampled MFE/MAE, missing path coverage and temporal holdout caveats. Future-event and late-ingested records are excluded at historical cutoffs.

## Open the application

Local preview: `http://127.0.0.1:4173/` (while the server is running).

1. Use the **Sign in** dialog. Current SQLite authentication and one-time initialization are described in [AUTH_SQLITE.md](AUTH_SQLITE.md). Choose your own username and password (minimum 8 characters); the agent does not create your credentials.
2. In **Settings / Data Sources**, choose Active for projects requiring uninterrupted high-frequency collection.
3. Keep the Node process running. Persistence survives browser closure and process restart; this is not yet an installed launchd/systemd service.
4. **Signals & Alerts** shows evidence-based regime evaluations. **Historical Analysis** opens Signal Lab. Empty or pending results are expected until sufficient real history has accumulated.

For development use Node 22.13+ and `npm ci`. Environment variables are read from the process; `.env` is not automatically loaded by the scripts. Example: `PORT=4173 npm start` after `npm run build`.

## Security and deployment boundaries

- No automated trading and no third-party publishing are enabled.
- Public market data is readable without login. This is intentional read-only sharing, not private-workspace isolation. Use a reverse proxy access gate if research itself must be private.
- Before public exposure, configure HTTPS, `NOX_SECURE_COOKIES=true`, exact `NOX_ALLOWED_ORIGINS`, reverse-proxy limits and process supervision. The server itself remains loopback-bound. Do not expose the bootstrap file, local database credentials or `.data`.
- Sessions are in memory and expire after eight hours or a server restart. User/role provisioning UI, password recovery, durable auth audit logs and per-project tenancy remain follow-up work. The first user is admin; the role checks also support securely provisioned analyst/viewer records.
- Compose's existing database password is development-only. Replace it for deployment. Database and Redis ports now bind to loopback only.

## Validation and explicit remaining work

- Automated tests cover project-mode persistence, unchanged source calculations, shared connection behavior, journal restart, historical ingest cutoffs, RBAC, session invalidation, scrypt persistence, conservative inference, costs, maturation and sampled excursions.
- Live local collectors have saved actual snapshots for the user's selected projects. No projects or venues were automatically added.
- No Docker/PostgreSQL runtime was available on this machine. The Timescale replication path and SQL are implemented but **not integration-tested against a live database here**. Query APIs currently read bounded results from local journals; production indexed database queries, migration version management, retention, replication checkpoints and disk monitoring are still required. Local queries scan snapshot/signal journals and are not a multi-year production analytics backend.
- Order-flow archive starts when a supported feed is collected. REST warm-up is bounded recent history, not an invented full historical backfill. Unsupported MEXC aggressor data, historical L2 depth, comprehensive liquidation history, and missing venues remain unavailable.
- Signal Lab is a first research evaluator, not a validated strategy backtester. Regime evaluations overlap and are correlated. Holdout labels are temporal candidates only. Walk-forward testing, purged independent events, calibrated reliability, tick-level excursions and adequate accumulated history remain outstanding.
- Broader regime modules (basis, depth recovery, funding anomalies, confirmed liquidation cascades), delivery workers and alert configuration UI remain future work. Existing TradingView/native analysis and seven venue adapters are preserved.
