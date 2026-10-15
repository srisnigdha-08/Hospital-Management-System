# Environment Variables

## Server (`server/.env`, based on `server/.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Set to `production` on deploy — hides stack traces, tightens error messages. |
| `PORT` | No | `5000` | |
| `CLIENT_URL` | Yes | `http://localhost:5173` | Used for CORS origin and building password-reset links. Must match your deployed frontend URL in production. |
| `DB_HOST` | Yes | `localhost` | |
| `DB_PORT` | No | `3306` | |
| `DB_NAME` | Yes | `hospital_management` in development; explicitly set in production | In `NODE_ENV=test`, must be exactly `hospital_management_test_fresh`; the previous test DB name, development DB, missing name, and other names are rejected. The live database and MySQL server identities are checked on test connections. |
| `DB_USER` | Yes | `root` in development | Test mode requires an explicitly configured non-root account. Use a dedicated least-privilege user in production as well. |
| `DB_PASSWORD` | Yes | — | Supply test credentials through the approved local environment/secret mechanism; do not put them in commands or source control. |
| `TEST_DB_SERVER_UUID` | Test mode only | None | Required in test mode. Set only to the canonical MySQL server UUID independently verified by the operator; no hostname or live-value fallback is used. |
| `MERIDIAN_REMINDER_APPROVAL_FILE` | Opt-in reminder MySQL integration harness only | None | Supply transiently outside `.env`: absolute path to the operator-owned, non-secret endpoint approval JSON described in the deployment guide. Not forwarded to the test child. |
| `MERIDIAN_REMINDER_MYSQL_TIMEOUT_MS` | No | `600000` | Opt-in reminder MySQL integration harness deadline in milliseconds; permitted range 30000–1800000. |
| `DB_LOGGING` | No | `false` | Set `true` to log every SQL statement — verbose, dev only. |
| `JWT_ACCESS_SECRET` | Yes | — | Random string (min 32 chars). Required in production; cannot use default placeholders. Rotate this to invalidate sessions. |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Any [ms](https://github.com/vercel/ms)-style string. |
| `JWT_REFRESH_SECRET` | Yes | — | Random string (min 32 chars). Must be distinct from `JWT_ACCESS_SECRET`. Required in production. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | |
| `PASSWORD_RESET_EXPIRES_MIN` | No | `30` | |
| `RATE_LIMIT_WINDOW_MIN` | No | `15` | Applies to the general API limiter. |
| `RATE_LIMIT_MAX` | No | `300` | Requests per window per IP. |
| `AUTH_RATE_LIMIT_MAX` | No | `20` | Tighter limit on `/auth/*` routes. |
| `UPLOAD_DIR` | No | `uploads` | Relative to the server's working directory. |
| `MAX_UPLOAD_MB` | No | `10` | |
| `EMAIL_FROM` | No | `no-reply@hms.test` | Cosmetic only until a real provider is wired into `email.service.js`. |

**Generating strong secrets:**

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Server test database

Database-backed tests write and clean up fixtures and the refresh-token suite
reruns session-security migrations. Use only a separately provisioned,
disposable database named exactly `hospital_management_test_fresh`. The normal
`npm test` launcher from `server/` sets `NODE_ENV=test`, loads `server/.env`
independently of the caller's working directory, and requires that exact
`DB_NAME`, an explicitly configured non-root `DB_USER`, and an independently
verified `TEST_DB_SERVER_UUID` before starting any suite. It has no
development-database fallback and runs suites serially. Each test connection
must report both the designated database name and the pinned MySQL
`@@GLOBAL.server_uuid` before queries are allowed. Configuration-only tests can be run without a database using
`npm run test:config`. See
[the deployment guide](DEPLOYMENT.md#isolated-server-test-database) for the test
invocation and safety requirements. Do not use
`database/schema.sql` to create or reset this database; that script selects
`hospital_management` and is destructive to existing installations.

## Client (`client/.env`, based on `client/.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_API_URL` | No | *(empty)* | Leave empty for local dev — Vite's dev server proxies `/api` and `/uploads` to `http://localhost:5000` (see `vite.config.js`). Set to your deployed API's base URL (e.g. `https://api.yourhospital.com`) for a production build, since there's no proxy once it's a static build. |

## A note on secrets

Neither `.env` file is committed (see `.gitignore` in both `server/` and
`client/`) — only the `.env.example` templates are. Never commit real JWT
secrets or database credentials.
