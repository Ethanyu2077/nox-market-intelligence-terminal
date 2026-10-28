# Authentication: SQLite and sign-in dialog

The workspace remains anonymously readable. POST/PATCH changes require analyst/admin, DELETE and settings changes require admin. Discovery remains a read-only POST. Existing usernames, password hashes and roles are migrated without resetting credentials.

Authentication storage is independent of market journals (`DATA_DIR=.data`). The default database is `var/auth/auth.sqlite`, configurable with `NOX_AUTH_DIR`. The containing directory has mode 0700 and database mode 0600; both are ignored by Git. Only password salts/hashes and session/setup token hashes are persisted, never passwords or raw session tokens. SQLite is not encryption; filesystem access controls remain necessary. It is served by neither Vite nor the production static directory.

On first start, validated legacy `.data/auth.json` accounts are inserted transactionally. Only after a successful migration are obsolete `auth.json` and `bootstrap-token.txt` removed. Invalid legacy content aborts migration and preserves the source. Existing legacy in-memory sessions require signing in once after restart. New SQLite-backed sessions expire after eight hours, support logout and survive server restarts. Login throttling persists across restarts.

If no administrator exists, run `npm run auth:setup-token` locally in the project directory. It displays a one-time setup code valid for fifteen minutes; the database stores only its hash. Open **Sign in** in the existing workspace, enter the code, and choose your own username/password (minimum eight characters). The application does not create credentials automatically. Use the same `NOX_AUTH_DIR` for the command and server if customized. A `NOX_BOOTSTRAP_TOKEN` environment variable (24–256 characters) is optional; remove it after setup.

No separate login page or navigation change is installed. Sign-in is a modal, including on a 401 response; cancelling retains read-only access. Existing theme variables supply colors. The project editor's scrolling override specifically fixes generic `.panel { overflow:hidden }` clipping without modifying the overall style or palette. When no verified USDT perpetual is returned, create stays disabled and explains the missing requirement; network failure is not interpreted as a confirmed absence of listings.

Requires Node 22.13+ for built-in SQLite (no native package installation). Keep `var/auth` private and back up its SQLite database separately from market journals. A single local SQLite database does not introduce multi-tenant project isolation.

Local launch now honors explicit HTTP(S)_PROXY variables or, on macOS, the already-enabled system HTTPS proxy. Only the child application process receives these settings; localhost remains direct. Node must support `--use-env-proxy` when a proxy is configured (use current Node 24 LTS). OS settings and provider region restrictions are not modified.
