const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateTestDatabaseSettings } = require('../src/config/testDatabaseIdentity');

const SERVER_ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.join(SERVER_ROOT, 'test');

function validateTestEnvironment(environment) {
  validateTestDatabaseSettings({
    dbName: environment.DB_NAME,
    dbUser: environment.DB_USER,
    expectedServerUuid: environment.TEST_DB_SERVER_UUID,
  });
}

function listTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTestFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
  });
}

function runTests(environment = process.env, launch = spawnSync) {
  validateTestEnvironment(environment);

  const files = listTestFiles(TEST_ROOT);
  const result = launch(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: SERVER_ROOT,
    env: { ...environment, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
  return process.exitCode;
}

if (require.main === module) {
  process.env.NODE_ENV = 'test';
  require('dotenv').config({ path: path.join(SERVER_ROOT, '.env') });
  try {
    runTests(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { runTests, validateTestEnvironment };
