# Deployment Guide

This app has three independent pieces to deploy: the MySQL database, the
Express API, and the static React build. They can live on different
providers — nothing here is locked to a specific host.

## 1. Database (MySQL)

Any managed MySQL 8 / MariaDB 10.6+ instance works — e.g. Railway, PlanetScale,
AWS RDS, or a self-managed server. Steps are the same regardless of provider:

### Brand-new database only

`database/schema.sql` is a bootstrap script for a **brand-new, empty database**.
It creates and selects the fixed database name `hospital_management`, disables
foreign-key checks, and contains `DROP TABLE IF EXISTS` statements before
recreating the application tables. Running it against an existing installation
deletes existing table data, including patient, appointment, clinical, account,
and audit data.

**Never execute `database/schema.sql` against an existing installation or a
production database.** Do not use it to upgrade a database. The script is not
a non-destructive schema synchronizer and does not preserve existing data.

Only when provisioning a genuinely new, empty database, bootstrap with:

```bash
mysql -h <host> -u <user> -p < database/schema.sql
```

`database/seed.sql` is optional sample data for local development and demos;
never run it in production.

### Existing installation upgrade

Use the additive migration runner for an existing database. Before a production
schema change, make a backup and verify it by restoring it into an isolated
database and checking that the restored database is usable. A successful backup
command alone does not verify recoverability.

Before running a migration, use the same database connection settings the
backend will use and execute the read-only query `SELECT DATABASE();`. Confirm
that the returned database is exactly the intended target. Stop if the identity
is unexpected or cannot be confirmed. Do not rely on a database name written
in a shell command as proof of the live connection target.

From `server/`, run the existing migration command against that verified
target:

```bash
npm run db:migrate
```

The runner applies migrations 001, 002, and 003 under the MySQL advisory lock. These
are the upgrade path; do not rerun `database/schema.sql` or `database/seed.sql`
for an existing installation. Non-production startup also attempts this runner
when schema preflight is incomplete. Production does not auto-migrate and will
fail startup until the explicit migration command has completed successfully.
Migration 003 adds durable reminder storage and accepts only the reviewed
legacy or current notification enum definitions. It appends the reminder type
to the legacy enum without removing or reordering legacy values; unknown enum
definitions or column attributes fail closed for operator review. Appointment
booking now enrolls an
eligible pending reminder in the booking transaction; rescheduling replaces
only a pending reminder, and cancellation, completion, or no-show invalidates
it in the corresponding transaction. API startup never starts a reminder
worker. A separate, explicitly invoked entry point is available as
`npm run worker:reminders`; do not run it until the database, clock, and
operational readiness reviews below are complete. Its readiness check
authenticates and performs schema preflight only; it does not run migrations.
The dependency-injected worker services provide candidate discovery,
lease/retry bookkeeping, pre-delivery validation, and atomic in-app delivery.
Delivery inserts one generic patient notification and marks the reminder
delivered in the same managed database transaction, protected by the unique
notification-to-reminder constraint. On an uncertain commit result it checks
the persisted reminder and linked notification before returning an outcome;
it does not blindly retry an insert. Successful delivery counts as one of at
most five lifetime attempts; failure delays are 1, 2, 4, and 8 minutes, and no
retry is scheduled at or after appointment start. An injected lease must be a
positive integer no greater than five minutes. The service uses an injected
process clock and checks the appointment-start boundary before its transaction
returns. The notification is not guaranteed to become committed or visible
before the appointment starts: database commit may complete after the final
in-transaction clock check. A conservative operational cutoff margin could
reduce near-start delivery, but no such margin is currently part of the policy
and it would not be a hard visibility guarantee. A shared, synchronized clock
across multiple worker hosts has not been verified. The
separate worker polls every 15 seconds by default, with batches of at most 25
candidates and a lease no longer than five minutes. Startup retries transient
connection failures a bounded number of times; poll failures use a capped
backoff, and unexpected errors stop the worker. Candidate work is sequential
within a batch, overlapping poll ticks are skipped, and shutdown stops future
ticks and claims before waiting up to ten seconds for current work. On timeout,
the owned connection remains open until in-flight work settles. Importing the
entry-point module does not connect, poll, or attach signal handlers. An
expired claim consumes one failed attempt during recovery; recovery clears the
claim before any later retry can be claimed. The worker is not started by API
startup or deployment scripts, and reminders remain operationally inactive
until a separately reviewed process is explicitly launched.

If delivery processing cannot establish whether its transaction committed, it
does not release the claim or immediately count a failure. The reminder waits
for the remaining lease; after expiry, recovery revalidates it and counts the
failed attempt, then schedules the configured backoff from recovery time. The
next attempt can therefore be delayed by the remaining lease plus the retry
delay, and can be skipped if that time reaches appointment start. This favors
duplicate prevention over prompt delivery when commit status is uncertain.

The worker's shutdown timeout is a bounded wait, not a database-transaction
abort. The external process supervisor must send SIGTERM/SIGINT and allow the
configured grace period for in-flight work to settle. If it forcibly terminates
the process after that period, the database connection may close during a
transaction; transaction rollback and lease recovery then depend on the actual
database/driver behavior and have not been verified here. Do not close the
worker-owned connection underneath an active transaction or treat a shutdown
timeout as proof that work was rolled back.

The worker uses the host process clock for due-time and lease decisions. The
lease bound does not establish synchronized time across hosts; multi-host
execution is unsupported until clock synchronization and database locking are
verified in the target deployment. Do not launch multiple worker hosts based
only on the single-process claim logic.
Rollback is not part of routine deployment or startup. Migration 001 rollback
removes the refresh-token family and replacement-lineage columns, permanently
discarding that lineage metadata; it is unavailable through the forward runner
and requires a separately reviewed maintenance procedure.
The migration CLI loads the effective environment using the same dotenv
configuration as the application before validating its target. `NODE_ENV` must
be explicitly set either in the invoking process or the applicable `.env` file;
the CLI will not silently use the application's development default when it is
absent. The designated test database is rejected unless the effective mode is
`test`.

### Isolated server test database

Database-backed server tests create, update, and remove fixtures; the refresh
token suite also reruns the session-security migrations. Use only a separately
provisioned, disposable database named exactly
`hospital_management_test_fresh`. The test-mode configuration and launcher
reject every other database name and reject the MySQL `root` account. The
launcher sets `NODE_ENV=test`, loads `server/.env` independently of the caller's
working directory, and runs test files with concurrency set to one. Before any
test suite starts, test mode requires `TEST_DB_SERVER_UUID`: the canonical UUID
of the intended MySQL server, independently verified by the operator. It is
not inferred from `DB_HOST`, a hostname, or a value queried and trusted
automatically. On each physical test connection Sequelize checks both
`SELECT DATABASE()` and `@@GLOBAL.server_uuid`; the migration runner performs
the same checks on its reserved connection before acquiring its advisory lock.
A missing variable, unsupported server variable, missing metadata, or mismatch
fails closed and discards the connection. The application does not log the
UUID. Each database-backed test file also refuses to load unless the exact test
mode, database name, non-root test account, and expected UUID are present;
direct test-file invocation cannot silently fall back to development settings.

Before enabling database-writing tests, verify the intended target through an
operator-approved connection using the same server endpoint and database
account, and record the returned database name and server UUID through the
approved configuration process. For a MySQL server, the read-only check is:

```sql
SELECT DATABASE(), @@GLOBAL.server_uuid;
```

Confirm that the database is exactly `hospital_management_test_fresh` and that
the UUID is the intended server identity, then set `TEST_DB_SERVER_UUID` to
that verified UUID through the approved local environment mechanism. Do not
copy an unverified value from an application connection. MySQL UUID pinning
reduces accidental wrong-server connections; it does not prove the database is
empty or disposable, authenticate a server against an active network attacker,
or prevent a cloned server from reusing an identity. The documented MariaDB
deployment option is not sufficient evidence that its server exposes this
MySQL-specific variable: test mode safely refuses servers that do not return a
valid UUID. Confirm variable support and identity independently before tests.

The separately opt-in reminder MySQL integration harness (`npm run
test:reminders:mysql`) has an additional pre-launch endpoint approval. An
authorized operator must supply an absolute path in
`MERIDIAN_REMINDER_APPROVAL_FILE` to a non-secret, access-controlled JSON file
containing exactly `database`, `host`, `port` (integer), and `serverUuid`. The
operator must independently establish all four values; do not generate the
file from application defaults or a just-opened connection. The harness
requires exact agreement with `DB_NAME`, `DB_HOST`, `DB_PORT`, and
`TEST_DB_SERVER_UUID` before launching a child that receives `DB_PASSWORD`.
The approval file is not forwarded to the child. This is a literal endpoint
allowlist, not server authentication: DNS changes, proxies, or a cloned UUID
can still direct credentials to a different server before the post-connect
identity check. If that threat matters, use an independently verified TLS
certificate or trusted tunnel reviewed for the actual topology before running
the harness; no certificate or tunnel is configured by this harness.

`MERIDIAN_REMINDER_MYSQL_TIMEOUT_MS` optionally sets the harness deadline
from 30000 to 1800000 milliseconds (default 600000). Concurrency gates fail
after 30000 milliseconds. A timeout or abnormal child exit leaves the local
run lock and its unique temporary working directory in place for operator
review; do not remove them until the child and its database activity are
confirmed stopped. The lock coordinates only
invocations sharing the same local temporary directory, not other machines,
users with different temporary directories, or independent API/worker
processes. Before approving an integration run, the operator must ensure no
other process is using the isolated target. The test is invoked as one direct
Node child. That child requires the launcher's open lock-file descriptor before
loading database models; setting the harness environment markers alone cannot
start the writing suite. This is an accidental-entry safeguard, not proof of
operator authorization against a malicious local process with database access.
The launcher does not promise to terminate arbitrary descendants.
Migration execution and idempotency are separate from this integration suite
and require their own reviewed, authorized stage.

The existing `database/schema.sql` and `npm run db:init` are not safe test
bootstrap paths: the SQL selects the fixed `hospital_management` database and
contains destructive `DROP TABLE` statements. `npm run db:migrate` adds the
session-security columns and indexes plus the durable appointment-reminder
storage structure; it does not create the 19 application tables.
For a fresh test database, use only the reviewed
[`test-bootstrap.sql`](../database/test-bootstrap.sql), which contains table,
constraint, and index creation statements and has no database selector or drop
statements. It includes reminder storage but does not enroll appointments or
enable delivery. It must be applied to an operator-selected, newly created empty
database. Then apply the synthetic fixture data in
[`server/test/fixtures/seed.sql`](../server/test/fixtures/seed.sql). That seed is
repeatable for its fixed fixture IDs, but rerunning it restores those rows to
the canonical test values; use it only in this isolated test database.

Use distinct provisioning and test principals:

- **Provisioning account:** an operator-controlled account is used only for
  one-time creation of the empty database and restricted test principal, and
  initialization of the reviewed schema and fixtures. Never store it in the
  application environment or use it to run tests. Use an operator's existing
  database-administration process for database/account provisioning; use a
  temporary initializer scoped to `hospital_management_test_fresh` for schema
  and fixture setup. It needs only `CREATE`, `INDEX`, and `REFERENCES` for the
  bootstrap plus `INSERT` and `UPDATE` for fixture upserts; it does not need
  `DROP`, `DELETE`, `FILE`, `SUPER`, global privileges, or `GRANT OPTION`.
  Revoke or disable that initializer after setup.
- **Test principal:** restricted to `hospital_management_test_fresh`. The
  current suite and idempotency migration checks require `SELECT`, `INSERT`,
  `UPDATE`, and `DELETE` on this database only. The complete bootstrap already
  contains the current token-version and refresh-token schema, so the supported
  migration path should not need schema-alter privileges. It does not require
  `CREATE`, `ALTER`, `INDEX`, `DROP`, `FILE`, `SUPER`, global privileges, or
  `GRANT OPTION`. If migrations report that schema changes are needed, stop and
  review the schema; do not widen the test principal as a workaround.

The operator should verify the new database is empty and confirm the active
database identity before applying the bootstrap. Example schema and fixture
imports from a POSIX-compatible shell at the repository root are:

```bash
mysql --database=hospital_management_test_fresh --user=PROVISIONING_USER -p < database/test-bootstrap.sql
mysql --database=hospital_management_test_fresh --user=PROVISIONING_USER -p < server/test/fixtures/seed.sql
```

The SQL files do not select a database themselves. Do not proceed if the
operator-selected connection does not identify `hospital_management_test_fresh`.
The existing `database/seed.sql` is the general demo seed and is not the test
fixture seed.

After the schema and fixtures are prepared, run the canonical migration runner
and test launcher from `server/`, using the non-root test account and transient
test settings. Set the password through the approved local secret mechanism;
do not put it in a command, SQL file, documentation, or source control.
PowerShell:

```powershell
$env:NODE_ENV = 'test'
$env:DB_NAME = 'hospital_management_test_fresh'
$env:DB_USER = 'meridian_test_runner'
$env:TEST_DB_SERVER_UUID = '<operator-verified-MySQL-server-UUID>'
npm run db:migrate
npm test
```

The launcher enforces `--test-concurrency=1`; it does not rely on the Node
runtime's default concurrency. The refresh-token regression suite checks
migration idempotency through the advisory-locked runner; with the complete
bootstrap schema, those checks should require only the test principal's
database-scoped DML permissions. Test-mode identity checks remain active for
both commands. The guard does not itself prove that a database is disposable;
do not run tests until its purpose and contents are confirmed. Configuration-
only tests can run without MySQL using `npm run test:config` from `server/`.

Never widen public registration: `POST /api/auth/register` must remain
patient-only. Provision the first administrator through a restricted,
one-time deployment procedure with direct database access, and remove or
disable that access immediately afterward. Do not expose bootstrap credentials
or a bootstrap endpoint publicly. A bcrypt hash can be generated locally with:

```bash
node -e "console.log(require('bcryptjs').hashSync('YourStrongPassword!', 12))"
```

then insert a `users` row with that hash and `role_id` pointing at `admin`.

## 2. Backend (Render, Railway, Fly.io, or any Node host)

1. Push the `server/` folder to its own repo (or use a monorepo with a
   configured root directory).
2. Set the build command to `npm install` and the start command to
   `npm start`.
3. Set every variable from [`ENVIRONMENT.md`](ENVIRONMENT.md) in the
   platform's environment settings — especially `DB_HOST`, `DB_USER`,
   `DB_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and
   `CLIENT_URL` (this must be your deployed frontend's exact origin, or
   CORS will block every request).
4. Make sure the platform's outbound network can reach your MySQL host
   (same-provider databases usually just work; external databases may need
   an allowlisted IP).
5. For an existing installation, follow **Existing installation upgrade** in
   section 1: verify the backup by restoring it, confirm the live target with
   `SELECT DATABASE()`, and run `npm run db:migrate` from `server/` before
   starting the new backend release. This release adds `users.token_version`
   and reminder storage; the migrations are additive and retryable. Appointment
   lifecycle transactions enroll and maintain pending reminder rows. A
   separate worker entry point exists but is not enabled or invoked by API
   startup. Production startup refuses
   to start when the required schema preflight is incomplete.
6. Attach a persistent volume for `UPLOAD_DIR` if you want uploaded medical
   attachments to survive redeploys — most PaaS filesystems are ephemeral.
   For real production use, swap local disk storage in
   `middleware/upload.js` for S3-compatible object storage.

Password-reset and notification email delivery is not configured in this
repository. Do not treat those workflows as operational in production until a
provider is integrated and delivery is verified. Message bodies and reset
links must never be written to application logs.

Health check endpoint for the platform's uptime monitor: `GET /api/health`.

## 3. Frontend (Vercel or Netlify)

1. Root directory: `client/`.
2. Build command: `npm run build`. Output directory: `dist`.
3. Environment variable: `VITE_API_URL` set to your deployed backend's base
   URL (e.g. `https://hms-api.onrender.com`) — with **no** trailing slash
   and no `/api` suffix (the app appends `/api` itself).
4. Add a SPA rewrite so client-side routes don't 404 on refresh:
   - **Vercel**: create `client/vercel.json`:
     ```json
     { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
     ```
   - **Netlify**: create `client/public/_redirects`:
     ```
     /*  /index.html  200
     ```

## 4. Post-deploy checklist

- [ ] `CLIENT_URL` on the backend exactly matches the frontend's deployed origin.
- [ ] `VITE_API_URL` on the frontend exactly matches the backend's deployed origin.
- [ ] JWT secrets are long, random, and different from each other.
- [ ] `NODE_ENV=production` is set on the backend.
- [ ] The required session-security and reminder-storage migrations completed before starting the
      new backend release. Access JWTs issued before token-version enforcement
      are rejected; an existing active refresh session can obtain a replacement
      access token with the current version. Password reset and password change
      revoke those refresh sessions as part of their operation.
- [ ] Database credentials use a least-privilege user, not root.
- [ ] Uploaded attachments are backed by persistent or object storage, not
      the platform's ephemeral disk.
- [ ] `database/seed.sql` was **not** run against production (it's demo data
      with a publicly-documented password).
