const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envModulePath = require.resolve('../src/config/env');
const TEST_SERVER_UUID = '5d4c7a61-80b2-4a13-9d05-5e8b2218b3f4';

function loadEnv(overrides, dotenvContents = null) {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-env-test-'));
  if (dotenvContents !== null) fs.writeFileSync(path.join(workingDirectory, '.env'), dotenvContents, 'utf8');
  const childEnv = { ...process.env };
  delete childEnv.JWT_ACCESS_SECRET;
  delete childEnv.JWT_REFRESH_SECRET;
  delete childEnv.DB_HOST;
  delete childEnv.DB_NAME;
  delete childEnv.DB_USER;
  delete childEnv.DB_PASSWORD;
  delete childEnv.TEST_DB_SERVER_UUID;
  delete childEnv.CLIENT_URL;
  Object.assign(childEnv, overrides);

  const script = `process.chdir(${JSON.stringify(workingDirectory)}); require(${JSON.stringify(envModulePath)})`;
  try {
    return spawnSync(process.execPath, ['-e', script], {
      env: childEnv,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function runMigrationCli(environment, dotenvContents = null) {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-migration-test-'));
  if (dotenvContents !== null) fs.writeFileSync(path.join(workingDirectory, '.env'), dotenvContents, 'utf8');
  const childEnv = { ...process.env };
  for (const name of ['NODE_ENV', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'TEST_DB_SERVER_UUID']) delete childEnv[name];
  Object.assign(childEnv, environment);
  const migrationPath = path.resolve(__dirname, '../src/migrations/run.js');
  try {
    return spawnSync(process.execPath, [migrationPath], {
      cwd: workingDirectory,
      env: childEnv,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function makeMigrationSequence({
  acquireResult = 1,
  acquireError,
  releaseResult = 1,
  releaseError,
  destroyError,
  failDescribeTable,
} = {}) {
  const operations = [];
  const connection = {
    query(_sql, callback) { callback(null, [{ databaseName: 'hospital_management_test_fresh', serverUuid: TEST_SERVER_UUID }]); },
    destroy() { operations.push('connection.destroy'); },
  };
  const queryInterface = {
    async describeTable(name) {
      operations.push(`describe:${name}`);
      if (failDescribeTable === name) throw new Error(`synthetic ${name} inspection failure`);
      if (name === 'refresh_tokens') {
        return { family_id: { allowNull: false }, replaced_by_token_id: { allowNull: true } };
      }
      return { token_version: { allowNull: false } };
    },
    async showIndex() {
      operations.push('showIndex');
      return ['idx_rt_family', 'idx_rt_token_hash', 'idx_rt_replaced_by'].map((name) => ({ name }));
    },
  };
  const sequence = {
    QueryTypes: { SELECT: 'SELECT' },
    connectionManager: {
      async getConnection() { operations.push('getConnection'); return connection; },
      releaseConnection() { operations.push('releaseConnection'); },
      async destroyConnection(resource) {
        assert.equal(resource, connection);
        operations.push('destroyConnection');
        if (destroyError) throw destroyError;
      },
    },
    getQueryInterface() { return queryInterface; },
    async query(sql) {
      if (sql.includes('GET_LOCK')) {
        operations.push('GET_LOCK');
        if (acquireError) throw acquireError;
        return [{ lockAcquired: acquireResult }];
      }
      if (sql.includes('RELEASE_LOCK')) {
        operations.push('RELEASE_LOCK');
        if (releaseError) throw releaseError;
        return [{ lockReleased: releaseResult }];
      }
      operations.push('backfill');
      return [];
    },
  };
  return { sequence, operations };
}

test('unknown NODE_ENV values fail startup', () => {
  const result = loadEnv({ NODE_ENV: 'prod' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NODE_ENV must be development, test, or production/);
});

test('development fallback secrets are distinct and not known defaults', () => {
  const script = `
    process.chdir(require('os').tmpdir());
    const env = require(${JSON.stringify(envModulePath)});
    const known = ['dev-access-secret-change-me', 'dev-refresh-secret-change-me'];
    if (env.jwt.accessSecret === env.jwt.refreshSecret || known.includes(env.jwt.accessSecret) || known.includes(env.jwt.refreshSecret)) process.exit(1);
  `;
  const childEnv = { ...process.env, NODE_ENV: 'development' };
  delete childEnv.JWT_ACCESS_SECRET;
  delete childEnv.JWT_REFRESH_SECRET;
  childEnv.TEST_DB_SERVER_UUID = 'not-used-outside-test-mode';
  const result = spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('test mode requires the designated database and a non-root account while development keeps its existing default', () => {
  const missing = loadEnv({ NODE_ENV: 'test' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /DB_NAME to be exactly hospital_management_test_fresh/);

  for (const databaseName of ['hospital_management', 'hospital_management_test', 'another_database']) {
    const refused = loadEnv({ NODE_ENV: 'test', DB_NAME: databaseName, DB_USER: 'meridian_test_runner' });
    assert.notEqual(refused.status, 0, `Expected ${databaseName} to be refused`);
    assert.match(refused.stderr, /refusing database access/);
  }

  const missingUser = loadEnv({ NODE_ENV: 'test', DB_NAME: 'hospital_management_test_fresh' });
  assert.notEqual(missingUser.status, 0);
  assert.match(missingUser.stderr, /explicitly configured non-root DB_USER/);

  const rootUser = loadEnv({ NODE_ENV: 'test', DB_NAME: 'hospital_management_test_fresh', DB_USER: 'root' });
  assert.notEqual(rootUser.status, 0);
  assert.match(rootUser.stderr, /explicitly configured non-root DB_USER/);
  const blankUser = loadEnv({ NODE_ENV: 'test', DB_NAME: 'hospital_management_test_fresh', DB_USER: '   ' });
  assert.notEqual(blankUser.status, 0);
  assert.match(blankUser.stderr, /explicitly configured non-root DB_USER/);

  const accepted = loadEnv({
    NODE_ENV: 'test',
    DB_NAME: 'hospital_management_test_fresh',
    DB_USER: 'meridian_test_runner',
    TEST_DB_SERVER_UUID: TEST_SERVER_UUID,
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  const missingServerIdentity = loadEnv({
    NODE_ENV: 'test', DB_NAME: 'hospital_management_test_fresh', DB_USER: 'meridian_test_runner',
  });
  assert.notEqual(missingServerIdentity.status, 0);
  assert.match(missingServerIdentity.stderr, /operator-verified TEST_DB_SERVER_UUID/);
  for (const malformedUuid of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    const malformedIdentity = loadEnv({
      NODE_ENV: 'test',
      DB_NAME: 'hospital_management_test_fresh',
      DB_USER: 'meridian_test_runner',
      TEST_DB_SERVER_UUID: malformedUuid,
    });
    assert.notEqual(malformedIdentity.status, 0);
    assert.match(malformedIdentity.stderr, /operator-verified TEST_DB_SERVER_UUID/);
  }

  const development = loadEnv({ NODE_ENV: 'development' });
  assert.equal(development.status, 0, development.stderr);
  const developmentTestDatabase = loadEnv(
    { NODE_ENV: 'development' },
    'DB_NAME=hospital_management_test_fresh\nDB_USER=meridian_test_runner\n',
  );
  assert.notEqual(developmentTestDatabase.status, 0);
  assert.match(developmentTestDatabase.stderr, /requires NODE_ENV=test/);

  const developmentEnv = { ...process.env, NODE_ENV: 'development' };
  delete developmentEnv.DB_NAME;
  const developmentDatabase = spawnSync(process.execPath, ['-e', `process.chdir(require('os').tmpdir()); process.stdout.write(require(${JSON.stringify(envModulePath)}).db.name)`], {
    env: developmentEnv,
    encoding: 'utf8',
  });
  assert.equal(developmentDatabase.status, 0, developmentDatabase.stderr);
  assert.equal(developmentDatabase.stdout, 'hospital_management');
});

test('test launcher refuses unsafe database names before spawning test suites', () => {
  const { runTests, validateTestEnvironment } = require('./run-tests');
  let spawnCount = 0;

  for (const databaseName of [undefined, 'hospital_management', 'hospital_management_test', 'another_database']) {
    assert.throws(
      () => runTests({ DB_NAME: databaseName, DB_USER: 'meridian_test_runner', TEST_DB_SERVER_UUID: TEST_SERVER_UUID }, () => { spawnCount += 1; }),
      /DB_NAME to be exactly hospital_management_test_fresh/,
    );
  }
  assert.equal(spawnCount, 0);
  assert.throws(() => validateTestEnvironment({ DB_NAME: 'hospital_management_test_fresh' }), /non-root DB_USER/);
  assert.throws(() => validateTestEnvironment({ DB_NAME: 'hospital_management_test_fresh', DB_USER: 'root' }), /non-root DB_USER/);
  assert.throws(() => validateTestEnvironment({ DB_NAME: 'hospital_management_test_fresh', DB_USER: '   ' }), /non-root DB_USER/);
  assert.throws(
    () => validateTestEnvironment({ DB_NAME: 'hospital_management_test_fresh', DB_USER: 'meridian_test_runner' }),
    /operator-verified TEST_DB_SERVER_UUID/,
  );
  assert.throws(() => validateTestEnvironment({
    DB_NAME: 'hospital_management_test_fresh', DB_USER: 'meridian_test_runner', TEST_DB_SERVER_UUID: 'malformed',
  }), /operator-verified TEST_DB_SERVER_UUID/);
  assert.doesNotThrow(() => validateTestEnvironment({
    DB_NAME: 'hospital_management_test_fresh', DB_USER: 'meridian_test_runner', TEST_DB_SERVER_UUID: TEST_SERVER_UUID,
  }));
});

test('direct database-backed suite invocation fails before loading the application without approved test settings', () => {
  const databaseSuites = [
    'appointment.concurrency.test.js',
    'auth.hardening.test.js',
    'auth.refreshToken.test.js',
    'medicalAttachment.security.test.js',
  ];
  for (const filename of databaseSuites) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.match(source.slice(0, 100), /require\('\.\/helpers\/require-test-environment'\)/, `${filename} must guard before imports`);
  }

  const childEnv = { ...process.env };
  for (const name of ['NODE_ENV', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'TEST_DB_SERVER_UUID', 'NODE_TEST_CONTEXT']) delete childEnv[name];
  const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'auth.refreshToken.test.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnv,
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Database-backed tests require NODE_ENV=test/);
  assert.doesNotMatch(output, /ECONNREFUSED|SequelizeAccessDeniedError/);

  const missingServerIdentity = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'helpers/require-test-environment.js'))})`], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...childEnv,
      NODE_ENV: 'test',
      DB_NAME: 'hospital_management_test_fresh',
      DB_USER: 'meridian_test_runner',
    },
    encoding: 'utf8',
  });
  assert.notEqual(missingServerIdentity.status, 0);
  assert.match(`${missingServerIdentity.stdout}${missingServerIdentity.stderr}`, /operator-verified TEST_DB_SERVER_UUID/);
  assert.doesNotMatch(`${missingServerIdentity.stdout}${missingServerIdentity.stderr}`, /Sequelize|ECONNREFUSED/);
});

test('migration CLI validates dotenv-loaded database settings before connecting', () => {
  const missingEnvironment = runMigrationCli({});
  assert.equal(missingEnvironment.status, 1);
  assert.match(`${missingEnvironment.stdout}${missingEnvironment.stderr}`, /requires an explicit NODE_ENV/);

  const wrongTestDatabase = runMigrationCli({ NODE_ENV: 'test', DB_NAME: 'hospital_management', DB_USER: 'meridian_test_runner' });
  assert.notEqual(wrongTestDatabase.status, 0);
  assert.match(`${wrongTestDatabase.stdout}${wrongTestDatabase.stderr}`, /DB_NAME to be exactly hospital_management_test_fresh/);
  assert.doesNotMatch(`${wrongTestDatabase.stdout}${wrongTestDatabase.stderr}`, /ECONNREFUSED|SequelizeAccessDeniedError/);

  const rootTestAccount = runMigrationCli({ NODE_ENV: 'test', DB_NAME: 'hospital_management_test_fresh', DB_USER: 'root' });
  assert.notEqual(rootTestAccount.status, 0);
  assert.match(`${rootTestAccount.stdout}${rootTestAccount.stderr}`, /explicitly configured non-root DB_USER/);
  assert.doesNotMatch(`${rootTestAccount.stdout}${rootTestAccount.stderr}`, /ECONNREFUSED|SequelizeAccessDeniedError/);

  const testDatabaseWithoutTestMode = runMigrationCli(
    { NODE_ENV: 'development', DB_USER: 'meridian_test_runner' },
    'DB_NAME=hospital_management_test_fresh\n',
  );
  assert.notEqual(testDatabaseWithoutTestMode.status, 0);
  assert.match(`${testDatabaseWithoutTestMode.stdout}${testDatabaseWithoutTestMode.stderr}`, /requires NODE_ENV=test/);
  assert.doesNotMatch(`${testDatabaseWithoutTestMode.stdout}${testDatabaseWithoutTestMode.stderr}`, /ECONNREFUSED|SequelizeAccessDeniedError/);

  const validTest = loadEnv({
    NODE_ENV: 'test',
    DB_NAME: 'hospital_management_test_fresh',
    DB_USER: 'meridian_test_runner',
    TEST_DB_SERVER_UUID: TEST_SERVER_UUID,
  });
  assert.equal(validTest.status, 0, validTest.stderr);

  const validProduction = loadEnv({
    NODE_ENV: 'production',
    DB_HOST: 'db.invalid',
    DB_NAME: 'meridian_production',
    DB_USER: 'meridian_app',
    TEST_DB_SERVER_UUID: 'ignored-outside-test-mode',
    DB_PASSWORD: 'synthetic-not-a-real-password',
    JWT_ACCESS_SECRET: 'synthetic-access-secret-value-123456789',
    JWT_REFRESH_SECRET: 'synthetic-refresh-secret-value-123456789',
    CLIENT_URL: 'https://meridian.invalid',
  });
  assert.equal(validProduction.status, 0, validProduction.stderr);
});

test('test launcher forces test mode for child suites after validating the database name', () => {
  const { runTests } = require('./run-tests');
  let call;
  const result = runTests({
    DB_NAME: 'hospital_management_test_fresh',
    DB_USER: 'meridian_test_runner',
    TEST_DB_SERVER_UUID: TEST_SERVER_UUID,
    NODE_ENV: 'production',
  }, (...args) => {
    call = args;
    return { status: 0, signal: null };
  });

  assert.equal(result, 0);
  assert.equal(call[2].env.NODE_ENV, 'test');
  assert.equal(call[2].env.DB_NAME, 'hospital_management_test_fresh');
  assert.equal(call[2].env.DB_USER, 'meridian_test_runner');
  assert.equal(call[2].env.TEST_DB_SERVER_UUID, TEST_SERVER_UUID);
  assert.equal(call[2].cwd, path.resolve(__dirname, '..'));
  assert.ok(call[1].includes('--test-concurrency=1'));
  assert.ok(call[1].includes(path.join(__dirname, 'auth.hardening.test.js')));
});

test('test database SQL artifacts preserve all tables and contain no destructive or database-selection statements', () => {
  const sourceSchema = fs.readFileSync(path.resolve(__dirname, '../../database/schema.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../database/test-bootstrap.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, 'fixtures/seed.sql'), 'utf8');
  const tables = (sql) => [...sql.matchAll(/^\s*CREATE TABLE\s+`?([a-z0-9_]+)/gim)].map((match) => match[1]).sort();
  const tableDefinitions = (sql) => [...sql.matchAll(/^\s*CREATE TABLE\s+`?([a-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*ENGINE=InnoDB;/gim)]
    .map((match) => [match[1], match[2].replace(/--.*$/gm, '').replace(/\s+/g, ' ').replace(/,\s+/g, ',').trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  const namedConstraints = (sql) => [...sql.matchAll(/CONSTRAINT\s+([a-z0-9_]+)/gi)].map((match) => match[1]).sort();
  const namedIndexes = (sql) => [...sql.matchAll(/(?:INDEX|UNIQUE KEY)\s+([a-z0-9_]+)/gi)].map((match) => match[1]).sort();

  assert.equal(tables(sourceSchema).length, 19);
  assert.deepEqual(tables(bootstrap), tables(sourceSchema));
  assert.deepEqual(tableDefinitions(bootstrap), tableDefinitions(sourceSchema));
  assert.deepEqual(namedConstraints(bootstrap), namedConstraints(sourceSchema));
  assert.deepEqual(namedIndexes(bootstrap), namedIndexes(sourceSchema));
  assert.doesNotMatch(bootstrap, /\b(?:CREATE\s+DATABASE|USE\s+[a-z0-9_]+|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.equal((seed.match(/INSERT\s+INTO\b/gi) || []).length, 7);
  assert.equal((seed.match(/ON\s+DUPLICATE\s+KEY\s+UPDATE/gi) || []).length, 7);
  assert.doesNotMatch(seed, /\b(?:DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.match(seed, /@hms\.test/);
  assert.doesNotMatch(seed, /@(?:gmail|yahoo|outlook)\./i);
});

test('refresh-token appointment fixture references seeded, related patient, doctor, and department rows', () => {
  const refreshTest = fs.readFileSync(path.join(__dirname, 'auth.refreshToken.test.js'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, 'fixtures/seed.sql'), 'utf8');
  const appointmentStart = refreshTest.indexOf("const sampleAppt = await Appointment.create({");
  const appointmentEnd = refreshTest.indexOf('});', appointmentStart);
  assert.notEqual(appointmentStart, -1);
  const appointmentFixture = refreshTest.slice(appointmentStart, appointmentEnd);
  assert.match(appointmentFixture, /patientId:\s*401/);
  assert.match(appointmentFixture, /doctorId:\s*201/);
  assert.match(appointmentFixture, /departmentId:\s*10/);
  assert.match(seed, /\(201,\s*102,\s*10,/);
  assert.match(seed, /\(401,\s*105,/);
  assert.match(seed, /\(10,\s*'Test Cardiology'/);
  assert.doesNotMatch(appointmentFixture, /(?:patientId|doctorId|departmentId):\s*1\b/);
});

test('legacy migration and rollback modules expose no mutating API and refuse direct execution', () => {
  const migrationPaths = [
    require.resolve('../src/migrations/001_add_refresh_token_families'),
    require.resolve('../src/migrations/001_add_refresh_token_families.rollback'),
    require.resolve('../src/migrations/002_add_user_token_version'),
  ];
  const childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DB_NAME: 'hospital_management_test_fresh',
    DB_USER: 'meridian_test_runner',
    TEST_DB_SERVER_UUID: TEST_SERVER_UUID,
  };

  for (const migrationPath of migrationPaths) {
    const result = spawnSync(process.execPath, [migrationPath], {
      cwd: path.resolve(__dirname, '..'),
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /Direct (migration|rollback) execution is disabled/);
  }

  for (const migrationPath of migrationPaths) {
    assert.deepEqual(Object.keys(require(migrationPath)), []);
  }
  assert.deepEqual(Object.keys(require('../src/migrations/run')), ['migrate']);

  const runnerSource = fs.readFileSync(path.resolve(__dirname, '../src/migrations/run.js'), 'utf8');
  const databaseSource = fs.readFileSync(path.resolve(__dirname, '../src/config/db.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(packageJson.scripts['db:migrate'], 'node src/migrations/run.js');
  assert.match(runnerSource, /if \(require\.main === module\)[\s\S]*?migrate\(\)/);
  assert.match(databaseSource, /const \{ migrate \} = require\('\.\.\/migrations\/run'\);\s*await migrate\(sequelize\);/);
  assert.doesNotMatch(runnerSource, /\bdown\b/);
});

test('supported migration API acquires one advisory lock before applying migrations', async () => {
  const env = require('../src/config/env');
  const { migrate } = require('../src/migrations/run');
  const oldNodeEnv = env.nodeEnv;
  const oldIsTest = env.isTest;
  const oldDatabaseName = env.db.name;
  const oldDatabaseUser = env.db.user;
  const oldTestDatabaseName = env.testDatabaseName;
  const oldTestDatabaseServerUuid = env.testDatabaseServerUuid;
  const operations = [];
  const connection = {
    query(_sql, callback) { callback(null, [{ databaseName: 'hospital_management_test_fresh', serverUuid: TEST_SERVER_UUID }]); },
  };
  const queryInterface = {
    async describeTable(name) {
      operations.push(`describe:${name}`);
      if (name === 'refresh_tokens') {
        return { family_id: { allowNull: false }, replaced_by_token_id: { allowNull: true } };
      }
      return { token_version: { allowNull: false } };
    },
    async showIndex() {
      operations.push('showIndex');
      return ['idx_rt_family', 'idx_rt_token_hash', 'idx_rt_replaced_by'].map((name) => ({ name }));
    },
  };
  const sequence = {
    QueryTypes: { SELECT: 'SELECT' },
    connectionManager: {
      async getConnection() { operations.push('getConnection'); return connection; },
      releaseConnection() { operations.push('releaseConnection'); },
    },
    getQueryInterface() { return queryInterface; },
    async query(sql) {
      operations.push(sql.includes('GET_LOCK') ? 'GET_LOCK' : sql.includes('RELEASE_LOCK') ? 'RELEASE_LOCK' : 'other');
      return sql.includes('GET_LOCK') ? [{ lockAcquired: 1 }] : [{ lockReleased: 1 }];
    },
  };

  try {
    env.nodeEnv = 'test';
    env.isTest = true;
    env.db.name = 'hospital_management_test_fresh';
    env.db.user = 'meridian_test_runner';
    env.testDatabaseName = 'hospital_management_test_fresh';
    env.testDatabaseServerUuid = TEST_SERVER_UUID;
    await migrate(sequence);

    assert.equal(operations.filter((item) => item === 'GET_LOCK').length, 1);
    assert.equal(operations.filter((item) => item === 'RELEASE_LOCK').length, 1);
    assert.ok(operations.indexOf('GET_LOCK') < operations.indexOf('describe:refresh_tokens'));
    assert.ok(operations.indexOf('RELEASE_LOCK') > operations.indexOf('describe:users'));
    assert.equal(operations.at(-1), 'releaseConnection');
  } finally {
    env.nodeEnv = oldNodeEnv;
    env.isTest = oldIsTest;
    env.db.name = oldDatabaseName;
    env.db.user = oldDatabaseUser;
    env.testDatabaseName = oldTestDatabaseName;
    env.testDatabaseServerUuid = oldTestDatabaseServerUuid;
  }
});

test('effective test-database configuration in development is rejected before connection acquisition', async () => {
  const env = require('../src/config/env');
  const { migrate } = require('../src/migrations/run');
  const old = {
    nodeEnv: env.nodeEnv,
    isTest: env.isTest,
    name: env.db.name,
    user: env.db.user,
    testServerUuid: env.testDatabaseServerUuid,
  };
  const { sequence, operations } = makeMigrationSequence();

  try {
    env.nodeEnv = 'development';
    env.isTest = false;
    env.db.name = 'hospital_management_test_fresh';
    env.db.user = 'meridian_test_runner';
    await assert.rejects(migrate(sequence), /requires NODE_ENV=test/);
    assert.deepEqual(operations, []);
  } finally {
    env.nodeEnv = old.nodeEnv;
    env.isTest = old.isTest;
    env.db.name = old.name;
    env.db.user = old.user;
    env.testDatabaseServerUuid = old.testServerUuid;
  }
});

test('migration executor destroys connections when lock acquisition is uncertain', async (t) => {
  const env = require('../src/config/env');
  const { migrate } = require('../src/migrations/run');
  const old = {
    nodeEnv: env.nodeEnv,
    isTest: env.isTest,
    name: env.db.name,
    user: env.db.user,
    testName: env.testDatabaseName,
    testServerUuid: env.testDatabaseServerUuid,
  };
  env.nodeEnv = 'test';
  env.isTest = true;
  env.db.name = 'hospital_management_test_fresh';
  env.db.user = 'meridian_test_runner';
  env.testDatabaseName = 'hospital_management_test_fresh';
  env.testDatabaseServerUuid = TEST_SERVER_UUID;

  try {
    for (const acquireResult of [0, null]) {
      await t.test(`GET_LOCK result ${acquireResult} is rejected and destroyed`, async () => {
        const { sequence, operations } = makeMigrationSequence({ acquireResult });
        await assert.rejects(migrate(sequence), /Failed to acquire migration advisory lock/);
        assert.ok(operations.includes('destroyConnection'));
        assert.ok(!operations.includes('releaseConnection'));
        assert.ok(!operations.some((operation) => operation.startsWith('describe:')));
      });
    }

    await t.test('acquisition query exception is preserved and connection is destroyed', async () => {
      const original = new Error('synthetic acquisition transport failure');
      const { sequence, operations } = makeMigrationSequence({ acquireError: original });
      await assert.rejects(migrate(sequence), (error) => error === original);
      assert.ok(operations.includes('destroyConnection'));
      assert.ok(!operations.includes('releaseConnection'));
    });

    await t.test('pool destroy failure is reported and socket destruction is attempted', async () => {
      const original = new Error('synthetic acquisition transport failure');
      const destroyFailure = new Error('synthetic pool destroy failure');
      const { sequence, operations } = makeMigrationSequence({ acquireError: original, destroyError: destroyFailure });
      await assert.rejects(migrate(sequence), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], original);
        assert.equal(error.errors[1], destroyFailure);
        return true;
      });
      assert.ok(operations.includes('destroyConnection'));
      assert.ok(operations.includes('connection.destroy'));
      assert.ok(!operations.includes('releaseConnection'));
    });
  } finally {
    env.nodeEnv = old.nodeEnv;
    env.isTest = old.isTest;
    env.db.name = old.name;
    env.db.user = old.user;
    env.testDatabaseName = old.testName;
    env.testDatabaseServerUuid = old.testServerUuid;
  }
});

test('migration failures release a confirmed lock and preserve the original error', async (t) => {
  const env = require('../src/config/env');
  const { migrate } = require('../src/migrations/run');
  const old = {
    nodeEnv: env.nodeEnv,
    isTest: env.isTest,
    name: env.db.name,
    user: env.db.user,
    testName: env.testDatabaseName,
    testServerUuid: env.testDatabaseServerUuid,
  };
  env.nodeEnv = 'test';
  env.isTest = true;
  env.db.name = 'hospital_management_test_fresh';
  env.db.user = 'meridian_test_runner';
  env.testDatabaseName = 'hospital_management_test_fresh';
  env.testDatabaseServerUuid = TEST_SERVER_UUID;

  try {
    for (const table of ['refresh_tokens', 'users']) {
      await t.test(`${table} migration failure cleans up`, async () => {
        const { sequence, operations } = makeMigrationSequence({ failDescribeTable: table });
        await assert.rejects(migrate(sequence), new RegExp(`synthetic ${table} inspection failure`));
        assert.ok(operations.includes('GET_LOCK'));
        assert.ok(operations.includes('RELEASE_LOCK'));
        assert.ok(operations.includes('releaseConnection'));
        assert.ok(!operations.includes('destroyConnection'));
        if (table === 'users') assert.ok(operations.includes('backfill'));
      });
    }
  } finally {
    env.nodeEnv = old.nodeEnv;
    env.isTest = old.isTest;
    env.db.name = old.name;
    env.db.user = old.user;
    env.testDatabaseName = old.testName;
    env.testDatabaseServerUuid = old.testServerUuid;
  }
});

test('migration executor destroys connections when lock release is unconfirmed', async (t) => {
  const env = require('../src/config/env');
  const { migrate } = require('../src/migrations/run');
  const old = {
    nodeEnv: env.nodeEnv,
    isTest: env.isTest,
    name: env.db.name,
    user: env.db.user,
    testName: env.testDatabaseName,
    testServerUuid: env.testDatabaseServerUuid,
  };
  env.nodeEnv = 'test';
  env.isTest = true;
  env.db.name = 'hospital_management_test_fresh';
  env.db.user = 'meridian_test_runner';
  env.testDatabaseName = 'hospital_management_test_fresh';
  env.testDatabaseServerUuid = TEST_SERVER_UUID;

  try {
    for (const releaseResult of [0, null]) {
      await t.test(`RELEASE_LOCK result ${releaseResult} is rejected and destroyed`, async () => {
        const { sequence, operations } = makeMigrationSequence({ releaseResult });
        await assert.rejects(migrate(sequence), /Failed to confirm release/);
        assert.ok(operations.includes('destroyConnection'));
        assert.ok(!operations.includes('releaseConnection'));
      });
    }

    await t.test('release exception is reported and connection is destroyed', async () => {
      const { sequence, operations } = makeMigrationSequence({ releaseError: new Error('synthetic release failure') });
      await assert.rejects(migrate(sequence), /synthetic release failure/);
      assert.ok(operations.includes('destroyConnection'));
      assert.ok(!operations.includes('releaseConnection'));
    });

    await t.test('migration error and release error are both retained', async () => {
      const { sequence, operations } = makeMigrationSequence({
        failDescribeTable: 'refresh_tokens',
        releaseError: new Error('synthetic release failure'),
      });
      await assert.rejects(migrate(sequence), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /synthetic refresh_tokens inspection failure/);
        assert.match(error.errors[1].message, /synthetic release failure/);
        assert.equal(error.cause, error.errors[0]);
        return true;
      });
      assert.ok(operations.includes('destroyConnection'));
      assert.ok(!operations.includes('releaseConnection'));
    });
  } finally {
    env.nodeEnv = old.nodeEnv;
    env.isTest = old.isTest;
    env.db.name = old.name;
    env.db.user = old.user;
    env.testDatabaseName = old.testName;
    env.testDatabaseServerUuid = old.testServerUuid;
  }
});

test('test database identity must match on the active connection before migration', async () => {
  const env = require('../src/config/env');
  const {
    sequelize,
    verifyTestDatabaseIdentity,
  } = require('../src/config/db');
  const { migrate } = require('../src/migrations/run');
  const oldNodeEnv = env.nodeEnv;
  const oldIsTest = env.isTest;
  const oldDatabaseName = env.db.name;
  const oldDatabaseUser = env.db.user;
  const oldTestDatabaseName = env.testDatabaseName;
  const oldTestDatabaseServerUuid = env.testDatabaseServerUuid;
  const identityQueries = [];
  const identity = (databaseName, serverUuid = TEST_SERVER_UUID) => ({
    query(sql, callback) {
      identityQueries.push(sql);
      callback(null, [{ databaseName, serverUuid }]);
    },
  });

  try {
    env.nodeEnv = 'test';
    assert.ok(sequelize.options.hooks.afterConnect.includes(verifyTestDatabaseIdentity));
    env.isTest = true;
    env.db.name = 'hospital_management_test_fresh';
    env.db.user = 'meridian_test_runner';
    env.testDatabaseName = 'hospital_management_test_fresh';
    env.testDatabaseServerUuid = TEST_SERVER_UUID;

    await assert.rejects(
      verifyTestDatabaseIdentity(identity('hospital_management')),
      /identity verification failed/,
    );
    await assert.rejects(
      verifyTestDatabaseIdentity(identity('another_database')),
      /identity verification failed/,
    );
    await assert.rejects(
      verifyTestDatabaseIdentity(identity('hospital_management_test_fresh', 'c0ffee')),
      /identity verification failed/,
    );
    await assert.rejects(
      verifyTestDatabaseIdentity(identity('hospital_management_test_fresh', null)),
      /identity verification failed/,
    );
    const configuredUuid = env.testDatabaseServerUuid;
    env.testDatabaseServerUuid = undefined;
    let destroyedWithoutExpectedUuid = false;
    await assert.rejects(verifyTestDatabaseIdentity({
      query(_sql, callback) {
        callback(null, [{ databaseName: 'hospital_management_test_fresh', serverUuid: TEST_SERVER_UUID }]);
      },
      destroy() { destroyedWithoutExpectedUuid = true; },
    }), /identity verification failed/);
    assert.equal(destroyedWithoutExpectedUuid, true);
    env.testDatabaseServerUuid = configuredUuid;
    assert.equal(await verifyTestDatabaseIdentity(identity('hospital_management_test_fresh')), true);
    assert.ok(identityQueries.at(-1).includes('@@GLOBAL.server_uuid'));

    let destroyedOnMismatch = false;
    await assert.rejects(verifyTestDatabaseIdentity({
      query(_sql, callback) {
        callback(null, [{ databaseName: 'hospital_management_test_fresh', serverUuid: '00000000-0000-0000-0000-000000000000' }]);
      },
      destroy() { destroyedOnMismatch = true; },
    }), /identity verification failed/);
    assert.equal(destroyedOnMismatch, true);

    let closedUnexpectedConnection = false;
    const identityQueryFailure = {
      query(_sql, callback) { callback(new Error('connection metadata unavailable')); },
      destroy() { closedUnexpectedConnection = true; },
    };
    await assert.rejects(verifyTestDatabaseIdentity(identityQueryFailure), /identity verification failed/);
    assert.equal(closedUnexpectedConnection, true);

    const operations = [];
    const badTargetSequence = {
      QueryTypes: { SELECT: 'SELECT' },
      connectionManager: {
        async getConnection() { return identity('hospital_management'); },
        releaseConnection() { operations.push('release'); },
        async destroyConnection() { operations.push('destroy'); },
      },
      async query(sql) { operations.push(sql); return [{ lockAcquired: 1 }]; },
    };

    await assert.rejects(
      migrate(badTargetSequence),
      /identity verification failed/,
    );
    assert.deepEqual(operations, ['destroy']);
  } finally {
    env.nodeEnv = oldNodeEnv;
    env.isTest = oldIsTest;
    env.db.name = oldDatabaseName;
    env.db.user = oldDatabaseUser;
    env.testDatabaseName = oldTestDatabaseName;
    env.testDatabaseServerUuid = oldTestDatabaseServerUuid;
  }
});

test('production requires explicit database settings and a non-root account', () => {
  const common = {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'access-secret-which-is-long-enough-123456',
    JWT_REFRESH_SECRET: 'refresh-secret-which-is-long-enough-123456',
  };
  const missingDb = loadEnv(common);
  assert.notEqual(missingDb.status, 0);
  assert.match(missingDb.stderr, /Missing required environment variable: DB_USER/);

  const rootDb = loadEnv({ ...common, DB_HOST: 'db', DB_NAME: 'hms', DB_USER: 'root', DB_PASSWORD: 'set' });
  assert.notEqual(rootDb.status, 0);
  assert.match(rootDb.stderr, /DB_USER must not be root/);
});

test('email mock never logs message content or reports delivery', async () => {
  const loggerPath = require.resolve('../src/utils/logger');
  const emailPath = require.resolve('../src/services/email.service');
  const messages = [];
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      info: (value) => messages.push(String(value)),
      warn: (value) => messages.push(String(value)),
    },
  };
  const emailService = require(emailPath);
  const env = require('../src/config/env');
  const oldProduction = env.isProduction;

  try {
    for (const production of [false, true]) {
      env.isProduction = production;
      const result = await emailService.send({
        to: 'recipient@example.test',
        subject: 'Password reset',
        text: 'reset-token-marker-must-not-be-logged',
      });
      assert.equal(result.delivered, false);
    }
    assert.ok(messages.length > 0);
    assert.ok(messages.every((message) => !message.includes('reset-token-marker-must-not-be-logged')));
    assert.ok(messages.every((message) => !message.includes('recipient@example.test')));
  } finally {
    env.isProduction = oldProduction;
    delete require.cache[emailPath];
    delete require.cache[loggerPath];
  }
});

test('error responses omit stack traces and internal error messages', () => {
  const loggerPath = require.resolve('../src/utils/logger');
  const handlerPath = require.resolve('../src/middleware/errorHandler');
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { error() {}, warn() {} },
  };
  const errorHandler = require(handlerPath);
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  try {
    errorHandler(new Error('internal-marker-must-not-be-returned'), { method: 'GET', originalUrl: '/' }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.message, 'Something went wrong');
    assert.equal(Object.hasOwn(res.payload, 'stack'), false);
    assert.doesNotMatch(JSON.stringify(res.payload), /internal-marker-must-not-be-returned/);
  } finally {
    delete require.cache[handlerPath];
    delete require.cache[loggerPath];
  }
});
