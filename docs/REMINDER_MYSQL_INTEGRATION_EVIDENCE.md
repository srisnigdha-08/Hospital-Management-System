# Reminder MySQL Integration: External Evidence Package

This is a blank review template, not an approval, a credential store, or an
executable runbook. The default decision is **NO-GO**. Filling a field does not
authorize an operation; the responsible owner must explicitly approve that
operation after independent review. Do not pass this Markdown file as
`MERIDIAN_REMINDER_APPROVAL_FILE`. Do not record passwords, tokens, private keys,
or connection strings here.

The source requires test mode, the exact test database name
`hospital_management_test_fresh`, a non-root database user, and a separately
verified `TEST_DB_SERVER_UUID`. The dedicated reminder harness additionally
compares its proposed database, host, port, and UUID with a non-secret endpoint
approval artifact before starting a child. Its live connection guard checks
the selected database and MySQL server UUID after connection. These controls
reduce accidental targeting; they do not prove ownership, empty/disposable
contents, pre-authentication server identity, or cross-host exclusivity.

See [Deployment Guide](DEPLOYMENT.md#isolated-server-test-database) and
[Environment Variables](ENVIRONMENT.md#server-test-database) for the current
source-backed requirements. This package grants no permission to run any of
their commands.

Source anchors: [test identity rules](../server/src/config/testDatabaseIdentity.js),
[live connection guard](../server/src/config/db.js),
[dedicated launcher](../server/test/run-appointmentReminder.mysql.integration.js),
and [integration suite](../server/test/appointmentReminder.mysql.integration.test.js).
The suite checks for zero existing reminder rows before writing; that narrow
check does not prove the rest of the database is empty or disposable.

## Gate checklist

All gates are OPEN. Record evidence references and independent review in the
separate templates below. A technical observation is not an owner's approval.

| Gate | Responsible role | Required evidence | Independent verification | Still unverified / STOP condition |
| --- | --- | --- | --- | --- |
| A. Owner authorization | Database owner | Written scope naming instance, test database, allowed writes, time window, and operator | Reviewer confirms the owner has authority over that instance and approves the exact operation | Owner or scope unknown; approval absent or expired |
| B. Target identity and contents | DBA | Approved endpoint/port, independently trusted server UUID, database owner, client source host, database inventory and contents classification | Compare trusted provider/DBA record with a separately authorized read-only observation using the intended route and account | Mismatch; database/account already exists unexpectedly; contents, ownership, or disposability unclear |
| C. Transport | Security reviewer | Certificate chain and hostname-verification evidence, or trusted-tunnel design and endpoint evidence | Independently validate the actual credential path, DNS/proxy/tunnel topology, and server authentication before credentials are sent | Unauthenticated endpoint or unverified route; do not rely on a post-connect UUID check alone |
| D. Exclusivity | Operator and DBA | Inventory and exclusion of other hosts, API/worker processes, tests, and writers for the run window | Compare supervisor, host, and DBA records; confirm a target-wide coordination plan | Any writer remains possible or process ownership is uncertain |
| E. Least privilege | DBA | Dedicated non-root account identity, source host, effective grants, and account lifecycle | Independently inspect effective privileges on the approved target and compare with reviewed operations | Unknown, shared, root, global, or broader-than-approved grants |
| F. Preparation | Owner and DBA | Separate decisions for database/account provisioning, bootstrap, fixtures, and migrations, with reviewed source/version and rollback plan | Review each operation's target, preconditions, schema diff, grants, and consequences before that operation | Target not empty when required; unexpected schema; missing operation-specific approval |
| G. Execution | Owner and operator | One approval for read-only preflight and a later, distinct approval for integration writes | Review preflight results and all A-F evidence before deciding on writes | Preflight missing/failed, approvals stale, or write approval absent |
| H. Closeout | Operator and DBA | Results, process/lock state, fixture inventory, residual data, and incident/cleanup decision | Independently reconcile the target state and process inventory after the run | Unexpected data, activity, locks, or uncertain child/descendant termination |

## Separate approval templates

Each template is intentionally blank. Attach non-secret evidence by reference
through an approved operator/DBA record system. Keep any completed copy out of
source control if it reveals sensitive infrastructure details. A reviewer must
not approve their own unverified assertion. Record an explicit STOP decision
when a required fact cannot be established.

### A. Database owner authorization

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Owner and authority over target: ____
- Evidence reference for ownership and test-write permission: ____
- Permitted operation(s), data scope, operator, and time window: ____
- Reviewer: ____
- Date: ____
- Decision (blank until explicit approval): ____
- Scope and conditions: ____
- STOP if: ownership, disposability, or the scope of writes is uncertain.

### B. DBA target identity and contents verification

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Independent trusted endpoint/UUID record and evidence reference: ____
- Separately authorized read-only observation reference: ____
- Database/account existence, ownership, schema inventory, contents classification, and evidence reference: ____
- Client source host as seen by MySQL and evidence reference: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: a value differs, the database/account unexpectedly exists, or contents cannot be classified as disposable.

### C. Security transport verification

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Transport method and authenticated endpoint: ____
- Certificate validation or trusted-tunnel evidence reference: ____
- DNS, proxy, and routing review reference: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: credentials could reach an endpoint not independently authenticated for this route.

### D. Cross-host and cross-process exclusivity

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Run window and list of authorized writers: ____
- Other-host, API, worker, test, supervisor, and scheduled-job exclusion evidence reference: ____
- Target-wide coordination and recovery owner: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: another writer can use the target or process ownership cannot be established.

### E. Least-privilege test account review

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Dedicated test principal and allowed client source host: ____
- Effective database-scoped grant evidence reference: ____
- Separate provisioning/initializer principal and retirement plan: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: root, shared, global, or unexplained privileges are required; do not widen grants to make a test pass.

### F. Schema/bootstrap/fixture/migration authorization

Make a separate decision for **each** proposed operation. This form does not
authorize another operation merely because one is approved.

- Operation (provisioning / bootstrap / fixtures / migration): ____
- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Reviewed artifact path, version/hash, schema and data effects: ____
- Empty-target or current-schema evidence reference: ____
- Backup/restore or recovery evidence and operator plan, where applicable: ____
- Evidence reference for this operation's approval: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: target/schema differs, partial prior application is unexplained, or any statement is outside the approved scope.

### G1. Read-only preflight authorization

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Exact permitted checks and account/route: ____
- A-F evidence references reviewed: ____
- Evidence reference for preflight-only approval: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: target, transport, privilege, or exclusivity evidence is missing. This approval does not authorize writes.

### G2. Separate integration-write authorization

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Reviewed preflight results and evidence reference: ____
- Exact suite, operator, run window, expected writes, timeout, and failure owner: ____
- A-F evidence references rechecked immediately before the run: ____
- Evidence reference for integration-write approval: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP if: preflight failed, evidence changed, another writer appeared, or approval is absent. Do not substitute `npm test` for the dedicated harness.

### H. Post-run cleanup and residual-data review

- Actual target identity (database, endpoint, port, server UUID, client source host): ____
- Run result and evidence reference: ____
- Child/descendant processes, local lock, and temporary-directory review reference: ____
- Fixture and residual-state review reference: ____
- Cleanup decision, approver, and evidence reference: ____
- Reviewer: ____
- Date: ____
- Decision: ____
- Scope and conditions: ____
- STOP further runs if: child termination is uncertain or unexpected data, locks, or activity remain. Do not delete residue without separate authorization.

## Go / no-go matrix

| Proposed action | Minimum evidence and distinct approval | Default decision |
| --- | --- | --- |
| Provision database or account | A-D, responsible owner/DBA approval, reviewed identity and privilege design | **NO-GO** |
| Bootstrap or seed | A-F for each operation; verified empty target and reviewed artifact | **NO-GO** |
| Run migrations | A-F for this migration; verified schema and target; separate change approval | **NO-GO** |
| Read-only application preflight | A-F and explicit G1 approval; independently verified transport/target | **NO-GO** |
| Run reminder MySQL integration | A-F, successful G1 evidence, explicit G2 approval, active exclusivity | **NO-GO** |
| Close out or authorize another run | H completed; any residue or uncertainty resolved by owner/DBA | **NO-GO** |

An approval file only checks literal target values in the launcher. A syntactically
valid UUID, a matching database name, a source-level test result, or a successful
connection is not independent proof that the database is disposable or that the
remote endpoint was authenticated before credentials were sent. An approval
document without an authorized owner decision is not authorization.

## Staged operator sequence (not authorization to execute)

1. Obtain A, including a named owner, exact scope, operator, and time window. STOP if any are missing.
2. Gather B's trusted DBA/provider records and obtain separate permission for any external read-only observation. This is not the G1 application preflight. STOP on unknown ownership or contents.
3. Complete C before any credential-bearing observation; then finish B by comparing the authorized read-only observation with the trusted record. STOP if transport authentication is unproven or values differ.
4. Complete D and E: exclude other writers and review effective non-root grants. STOP on uncertain host/process ownership or excessive privilege.
5. Separately review and authorize each F preparation operation. Never use `database/schema.sql` or `db:init` for this test target: the general bootstrap selects `hospital_management` and drops tables. The test bootstrap and synthetic fixture seed are distinct artifacts; do not assume they are safe to rerun after partial application.
6. Obtain G1 before a read-only application identity/schema preflight. STOP if the live target or schema does not match the reviewed evidence.
7. Review preflight results; obtain a new G2 decision for the controlled, dedicated integration run. STOP on changed evidence or concurrent writers.
8. If separately authorized later, run only within the approved window and record the exact result. A local lock covers only cooperating invocations using the same local temporary directory; it does not exclude another host, API, or worker.
9. Complete H. A timeout or abnormal exit may leave the lock, temporary directory, and fixtures; do not assume every descendant stopped or delete residue without review.
10. Plan migration idempotency and broader regression separately. The reminder integration suite does not establish those behaviors or real deployment readiness.

Real InnoDB row locking, transaction rollback and commit ambiguity, duplicate
prevention, lease recovery, and concurrent lifecycle behavior remain unverified
until an approved isolated MySQL run supplies evidence. Reminder visibility
strictly before appointment start is not guaranteed by the current design.
