'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  buildChildEnvironment,
  hasLauncherOwnedContext,
  runIntegration,
  validateIntegrationEnvironment,
} = require('./run-appointmentReminder.mysql.integration');
const { barrier, deferred, waitForGate } = require('./helpers/reminderIntegrationGates');

const UUID = '61f1eab2-71ba-4dda-987f-5912a0e31d14';
const LAUNCHER_FILE = path.join(__dirname, 'run-appointmentReminder.mysql.integration.js');
const INTEGRATION_FILE = path.join(__dirname, 'appointmentReminder.mysql.integration.test.js');
const approvedTarget = () => ({
  database: 'hospital_management_test_fresh',
  host: 'approved-test-host.invalid',
  port: 3306,
  serverUuid: UUID,
});

function withApproval(callback, target = approvedTarget(), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-reminder-approval-unit-'));
  try {
    const approvalFile = path.join(directory, 'approval.json');
    fs.writeFileSync(approvalFile, JSON.stringify(target));
    return callback(environment({ MERIDIAN_REMINDER_APPROVAL_FILE: approvalFile, ...overrides }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function environment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    MERIDIAN_REMINDER_MYSQL_INTEGRATION: '1',
    DB_NAME: 'hospital_management_test_fresh',
    DB_HOST: 'approved-test-host.invalid',
    DB_PORT: '3306',
    DB_USER: 'meridian_test_runner',
    DB_PASSWORD: 'synthetic-secret-not-used',
    TEST_DB_SERVER_UUID: UUID,
    PATH: 'synthetic-path',
    TMPDIR: 'synthetic-temporary-directory',
    UNRELATED_SECRET: 'must-not-be-forwarded',
    ...overrides,
  };
}

function runDirectSuite(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-reminder-direct-unit-'));
  try {
    const preload = path.join(directory, 'block-database.js');
    fs.writeFileSync(preload, `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === '../src/models' || request === '../src/config/db'
          || request === '../src/config/env' || request === 'mysql2') {
          throw new Error('DATABASE_INITIALIZATION_ATTEMPTED');
        }
        return load.call(this, request, parent, isMain);
      };
    `);
    const childEnvironment = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[name] !== undefined) childEnvironment[name] = process.env[name];
    }
    Object.assign(childEnvironment, {
      NODE_ENV: 'test',
      DB_NAME: 'hospital_management_test_fresh',
      DB_HOST: 'synthetic.invalid',
      DB_PORT: '3306',
      DB_USER: 'synthetic_nonroot',
      TEST_DB_SERVER_UUID: crypto.randomUUID(),
      MERIDIAN_REMINDER_MYSQL_INTEGRATION: '1',
      MERIDIAN_REMINDER_MYSQL_HARNESS: '1',
      MERIDIAN_REMINDER_NO_DOTENV: '1',
      ...overrides,
    });
    return spawnSync(process.execPath, ['--require', preload, '--test', INTEGRATION_FILE], {
      cwd: directory,
      env: childEnvironment,
      encoding: 'utf8',
      timeout: 5000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('dedicated runner requires explicit opt-in and test mode', () => {
  assert.throws(() => validateIntegrationEnvironment(environment({ MERIDIAN_REMINDER_MYSQL_INTEGRATION: undefined })), /explicitly opt in/);
  assert.throws(() => validateIntegrationEnvironment(environment({ NODE_ENV: 'development' })), /NODE_ENV=test/);
});

test('dedicated runner delegates database name, account, and UUID policy to the shared guard', () => {
  assert.throws(() => validateIntegrationEnvironment(environment({ DB_NAME: 'hospital_management' })), /DB_NAME/);
  assert.throws(() => validateIntegrationEnvironment(environment({ DB_USER: 'root' })), /non-root/);
  assert.throws(() => validateIntegrationEnvironment(environment({ TEST_DB_SERVER_UUID: 'not-a-uuid' })), /TEST_DB_SERVER_UUID/);
  assert.doesNotThrow(() => validateIntegrationEnvironment(environment(), approvedTarget()));
});

test('runner requires explicit host, valid port, and explicit password variable', () => {
  assert.throws(() => validateIntegrationEnvironment(environment({ DB_HOST: '' })), /DB_HOST/);
  assert.throws(() => validateIntegrationEnvironment(environment({ DB_PORT: '70000' })), /DB_PORT/);
  const missingPassword = environment();
  delete missingPassword.DB_PASSWORD;
  assert.throws(() => validateIntegrationEnvironment(missingPassword), /DB_PASSWORD/);
});

test('operator approval fails closed for missing, mismatched, or malformed target identity', () => {
  assert.throws(() => validateIntegrationEnvironment(environment()), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment(), { ...approvedTarget(), host: 'other.invalid' }), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment(), { ...approvedTarget(), port: 3307 }), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment(), { ...approvedTarget(), serverUuid: crypto.randomUUID() }), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment(), { ...approvedTarget(), serverUuid: 'invalid' }), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment(), { ...approvedTarget(), extra: 'not-approved' }), /operator-approved/i);
  assert.throws(() => validateIntegrationEnvironment(environment({ MERIDIAN_REMINDER_MYSQL_TIMEOUT_MS: '0' }), approvedTarget()), /TIMEOUT_MS/);
});

test('child receives only required connection settings; markers alone are not launch authority', () => {
  const child = buildChildEnvironment(environment());
  assert.equal(child.MERIDIAN_REMINDER_MYSQL_HARNESS, '1');
  assert.equal(child.MERIDIAN_REMINDER_NO_DOTENV, '1');
  assert.equal(child.DB_NAME, 'hospital_management_test_fresh');
  assert.equal(child.DB_PASSWORD, 'synthetic-secret-not-used');
  assert.equal(child.TMPDIR, 'synthetic-temporary-directory');
  assert.equal(child.UNRELATED_SECRET, undefined);
  assert.equal(hasLauncherOwnedContext(child), false);
});

test('direct test-runner invocation skips without opt-in and refuses forged or incomplete markers before database imports', () => {
  const cases = [
    { overrides: { MERIDIAN_REMINDER_MYSQL_INTEGRATION: undefined }, status: 0 },
    { overrides: { MERIDIAN_REMINDER_MYSQL_HARNESS: undefined }, status: 1 },
    { overrides: { MERIDIAN_REMINDER_NO_DOTENV: undefined }, status: 1 },
    { overrides: {}, status: 1 },
  ];
  for (const { overrides, status } of cases) {
    const result = runDirectSuite(overrides);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, output);
    assert.doesNotMatch(output, /DATABASE_INITIALIZATION_ATTEMPTED/);
    if (status === 1) assert.match(output, /launcher-owned execution context is required/);
  }
});

test('unsafe target is rejected before the integration child can launch', () => {
  let launchCount = 0;
  withApproval((safeEnvironment) => {
    assert.throws(() => runIntegration({
      environment: { ...safeEnvironment, DB_NAME: 'hospital_management' },
      launch: () => { launchCount += 1; return { status: 0 }; },
    }), /DB_NAME/);
    for (const overrides of [{ DB_HOST: 'other.invalid' }, { DB_PORT: '3307' }, { TEST_DB_SERVER_UUID: crypto.randomUUID() }]) {
      assert.throws(() => runIntegration({
        environment: { ...safeEnvironment, ...overrides },
        launch: () => { launchCount += 1; return { status: 0 }; },
      }), /operator-approved/i);
    }
  });
  assert.throws(() => runIntegration({ environment: environment(), launch: () => { launchCount += 1; return { status: 0 }; } }), /approval file/i);
  assert.equal(launchCount, 0);
});

test('valid launch is serial, isolated, and receives the sanitized environment', () => {
  let invocation;
  const status = withApproval((safeEnvironment) => runIntegration({
    environment: safeEnvironment,
    launch: (executable, args, options) => {
      invocation = { executable, args, options };
      return { status: 0 };
    },
  }));

  assert.equal(status, 0);
  assert.equal(invocation.args.length, 1, 'direct node:test execution has no test-runner subprocess');
  assert.ok(invocation.args.at(-1).endsWith('appointmentReminder.mysql.integration.test.js'));
  assert.notEqual(invocation.options.cwd, process.cwd());
  assert.equal(invocation.options.env.UNRELATED_SECRET, undefined);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.MERIDIAN_REMINDER_NO_DOTENV, '1');
  assert.equal(invocation.options.env.MERIDIAN_REMINDER_APPROVAL_FILE, undefined);
  assert.equal(invocation.options.timeout, 600_000);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.ok(Array.isArray(invocation.options.stdio));
  assert.equal(typeof invocation.options.stdio[3], 'number');
  assert.ok(invocation.options.cwd.startsWith(os.tmpdir()));
});

test('approved launcher supplies an inherited lock handle that a database-free child can verify', () => {
  const status = withApproval((safeEnvironment) => runIntegration({
    environment: safeEnvironment,
    launch: (_executable, _args, options) => {
      const probe = (descriptor) => spawnSync(process.execPath, ['-e', `
        const { hasLauncherOwnedContext } = require(${JSON.stringify(LAUNCHER_FILE)});
        process.exit(hasLauncherOwnedContext(process.env) ? 0 : 1);
      `], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
        encoding: 'utf8',
        timeout: 5000,
      });
      const valid = probe(options.stdio[3]);
      assert.equal(valid.error, undefined);
      assert.equal(valid.status, 0, valid.stderr);

      const unrelated = fs.openSync(path.join(options.cwd, 'unrelated.lock'), 'wx+', 0o600);
      try {
        const original = fs.fstatSync(options.stdio[3]);
        const contents = Buffer.alloc(original.size);
        assert.equal(fs.readSync(options.stdio[3], contents, 0, contents.length, 0), contents.length);
        fs.writeSync(unrelated, contents);
        const rejected = probe(unrelated);
        assert.equal(rejected.error, undefined);
        assert.equal(rejected.status, 1, rejected.stderr);
      } finally {
        fs.closeSync(unrelated);
      }
      return { status: valid.status };
    },
  }), approvedTarget(), {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TMPDIR: process.env.TMPDIR,
  });
  assert.equal(status, 0);
});

test('overlapping launches for the same database identity fail closed', () => {
  let nestedLaunchCount = 0;
  const status = withApproval((safeEnvironment) => runIntegration({
    environment: safeEnvironment,
    launch: () => {
      assert.throws(() => runIntegration({
        environment: safeEnvironment,
        launch: () => { nestedLaunchCount += 1; return { status: 0 }; },
      }), /another reminder MySQL run is active or left a stale lock/i);
      return { status: 0 };
    },
  }));
  assert.equal(status, 0);
  assert.equal(nestedLaunchCount, 0);
});

test('timeout retains only this run lock for operator review and does not launch another child', () => {
  const uuid = crypto.randomUUID();
  const key = crypto.createHash('sha256').update(`hospital_management_test_fresh\0${uuid}`).digest('hex');
  const lockFile = path.join(os.tmpdir(), `meridian-reminder-mysql-${key}.lock`);
  let launchCount = 0;
  try {
    withApproval((safeEnvironment) => {
      assert.throws(() => runIntegration({
        environment: safeEnvironment,
        launch: (_executable, _args, options) => {
          launchCount += 1;
          assert.equal(options.timeout, 45_000);
          return { error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }) };
        },
      }), /timed out; local lock retained/i);
    }, { ...approvedTarget(), serverUuid: uuid }, {
      TEST_DB_SERVER_UUID: uuid,
      MERIDIAN_REMINDER_MYSQL_TIMEOUT_MS: '45000',
    });
    assert.equal(launchCount, 1);
    assert.match(fs.readFileSync(lockFile, 'utf8'), new RegExp(`^${process.pid} `));
  } finally {
    if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').startsWith(`${process.pid} `)) fs.unlinkSync(lockFile);
  }
});

test('missing concurrency participant fails both sides of a barrier without hanging', async () => {
  const arrive = barrier(2, 10);
  await assert.rejects(arrive(), /barrier timed out/);
  await assert.rejects(arrive(), /barrier timed out/);
  assert.throws(() => arrive(), /unexpected participant/);
  const successful = barrier(2, 100);
  await Promise.all([successful(), successful()]);
});

test('individual lifecycle gates fail by a bounded deadline and can resolve normally', async () => {
  const missing = deferred();
  await assert.rejects(waitForGate(missing.promise, 10), /gate timed out/);
  const ready = deferred();
  ready.resolve();
  await waitForGate(ready.promise, 10);
});
