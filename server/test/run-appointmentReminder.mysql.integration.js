'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  normalizeMysqlServerUuid,
  validateTestDatabaseSettings,
} = require('../src/config/testDatabaseIdentity');

const INTEGRATION_OPT_IN = 'MERIDIAN_REMINDER_MYSQL_INTEGRATION';
const HARNESS_MARKER = 'MERIDIAN_REMINDER_MYSQL_HARNESS';
const NO_DOTENV_MARKER = 'MERIDIAN_REMINDER_NO_DOTENV';
const APPROVAL_FILE = 'MERIDIAN_REMINDER_APPROVAL_FILE';
const TIMEOUT_MS = 'MERIDIAN_REMINDER_MYSQL_TIMEOUT_MS';
const DEFAULT_TIMEOUT_MS = 600_000;
const TEST_FILE = path.join(__dirname, 'appointmentReminder.mysql.integration.test.js');
const LOCK_DESCRIPTOR = 3;
const LOCK_RECORD_PATTERN = /^([1-9]\d*) ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\n$/i;

function approvedTargetFromFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('An absolute operator-owned reminder approval file path is required');
  }
  let descriptor;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('Approval file must not be a symbolic link');
    descriptor = fs.openSync(filePath, 'r');
    const details = fs.fstatSync(descriptor);
    if (!details.isFile() || details.size < 2 || details.size > 4096) throw new Error('Invalid approval file');
    const buffer = Buffer.alloc(details.size);
    if (fs.readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) throw new Error('Incomplete approval file');
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('Unable to read a valid operator-owned reminder approval file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function integrationTimeoutMs(environment) {
  const raw = environment[TIMEOUT_MS];
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(String(raw)) || Number(raw) < 30_000 || Number(raw) > 1_800_000) {
    throw new Error(`${TIMEOUT_MS} must be an integer from 30000 to 1800000`);
  }
  return Number(raw);
}

function validateIntegrationEnvironment(environment, approvedTarget) {
  if (environment[INTEGRATION_OPT_IN] !== '1') {
    throw new Error(`Set ${INTEGRATION_OPT_IN}=1 to explicitly opt in to MySQL reminder integration tests`);
  }
  if (environment.NODE_ENV !== 'test') {
    throw new Error('MySQL reminder integration tests require NODE_ENV=test');
  }
  validateTestDatabaseSettings({
    dbName: environment.DB_NAME,
    dbUser: environment.DB_USER,
    expectedServerUuid: environment.TEST_DB_SERVER_UUID,
  });
  if (!environment.DB_HOST?.trim()) throw new Error('An explicit DB_HOST is required');
  if (!/^\d+$/.test(String(environment.DB_PORT ?? '')) || Number(environment.DB_PORT) < 1 || Number(environment.DB_PORT) > 65535) {
    throw new Error('An explicit valid DB_PORT is required');
  }
  if (!Object.prototype.hasOwnProperty.call(environment, 'DB_PASSWORD')) {
    throw new Error('DB_PASSWORD must be supplied explicitly through the approved secret mechanism');
  }
  integrationTimeoutMs(environment);
  if (!approvedTarget || typeof approvedTarget !== 'object' || Array.isArray(approvedTarget)
    || Object.keys(approvedTarget).sort().join(',') !== 'database,host,port,serverUuid'
    || approvedTarget.database !== environment.DB_NAME
    || typeof approvedTarget.host !== 'string' || !approvedTarget.host.trim()
    || approvedTarget.host !== environment.DB_HOST
    || !Number.isInteger(approvedTarget.port) || approvedTarget.port !== Number(environment.DB_PORT)
    || !normalizeMysqlServerUuid(approvedTarget.serverUuid)
    || normalizeMysqlServerUuid(approvedTarget.serverUuid) !== normalizeMysqlServerUuid(environment.TEST_DB_SERVER_UUID)) {
    throw new Error('Operator-approved MySQL target does not match the explicit test configuration');
  }
}

function buildChildEnvironment(environment) {
  const child = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (environment[name] !== undefined) child[name] = environment[name];
  }
  for (const name of ['NODE_ENV', 'DB_NAME', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'TEST_DB_SERVER_UUID']) {
    child[name] = environment[name];
  }
  child[INTEGRATION_OPT_IN] = '1';
  child[HARNESS_MARKER] = '1';
  child[NO_DOTENV_MARKER] = '1';
  return child;
}

function hasHarnessMarkers(environment) {
  return environment[HARNESS_MARKER] === '1' && environment[NO_DOTENV_MARKER] === '1';
}

function targetRunLockPath(environment) {
  const serverUuid = normalizeMysqlServerUuid(environment.TEST_DB_SERVER_UUID);
  if (!serverUuid) return null;
  const key = crypto.createHash('sha256')
    .update(`${environment.DB_NAME}\0${serverUuid}`)
    .digest('hex');
  return path.join(os.tmpdir(), `meridian-reminder-mysql-${key}.lock`);
}

function hasLauncherOwnedContext(environment = process.env) {
  if (environment[INTEGRATION_OPT_IN] !== '1' || environment.NODE_ENV !== 'test' || !hasHarnessMarkers(environment)) {
    return false;
  }
  try {
    validateTestDatabaseSettings({
      dbName: environment.DB_NAME,
      dbUser: environment.DB_USER,
      expectedServerUuid: environment.TEST_DB_SERVER_UUID,
    });
    const lockPath = targetRunLockPath(environment);
    const descriptor = fs.fstatSync(LOCK_DESCRIPTOR);
    const namedLock = fs.lstatSync(lockPath);
    if (!descriptor.isFile() || !namedLock.isFile() || namedLock.isSymbolicLink()
      || !descriptor.ino || descriptor.dev !== namedLock.dev || descriptor.ino !== namedLock.ino
      || descriptor.size < 40 || descriptor.size > 128 || descriptor.size !== namedLock.size) {
      return false;
    }
    const buffer = Buffer.alloc(descriptor.size);
    if (fs.readSync(LOCK_DESCRIPTOR, buffer, 0, buffer.length, 0) !== buffer.length) return false;
    const record = LOCK_RECORD_PATTERN.exec(buffer.toString('utf8'));
    return Boolean(record && Number(record[1]) === process.ppid);
  } catch {
    return false;
  }
}

function acquireTargetRunLock(environment) {
  const lockPath = targetRunLockPath(environment);
  const lockContents = `${process.pid} ${crypto.randomUUID()}\n`;
  let descriptor;
  let ownedFile;

  try {
    descriptor = fs.openSync(lockPath, 'wx+', 0o600);
    ownedFile = fs.fstatSync(descriptor);
    fs.writeSync(descriptor, lockContents, null, 'utf8');
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      try {
        const current = fs.statSync(lockPath);
        if (ownedFile && current.dev === ownedFile.dev && current.ino === ownedFile.ino) fs.unlinkSync(lockPath);
      } catch {}
    }
    if (error.code === 'EEXIST') {
      throw new Error('Another reminder MySQL run is active or left a stale lock; verify the lock owner before retrying');
    }
    throw new Error('Unable to create the local reminder MySQL run lock');
  }

  let released = false;
  const release = ({ retain = false } = {}) => {
    if (released) return;
    released = true;
    fs.closeSync(descriptor);
    if (!retain) {
      try {
        const current = fs.statSync(lockPath);
        if (current.dev !== ownedFile.dev || current.ino !== ownedFile.ino
          || fs.readFileSync(lockPath, 'utf8') !== lockContents) {
          throw new Error('Local reminder MySQL lock ownership changed; leaving it in place');
        }
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error('Unable to remove the local reminder MySQL run lock');
        }
      }
    }
  };
  return { descriptor, release };
}

function runIntegration({ environment = process.env, launch = spawnSync } = {}) {
  const approvedTarget = approvedTargetFromFile(environment[APPROVAL_FILE]);
  validateIntegrationEnvironment(environment, approvedTarget);
  const runLock = acquireTargetRunLock(environment);
  let isolatedCwd;
  let retainLock = false;
  try {
    isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-reminder-mysql-'));
    retainLock = true;
    // Running one node:test file directly avoids a separate test-runner child process.
    const result = launch(process.execPath, [TEST_FILE], {
      cwd: isolatedCwd,
      env: buildChildEnvironment(environment),
      stdio: ['inherit', 'inherit', 'inherit', runLock.descriptor],
      timeout: integrationTimeoutMs(environment),
      killSignal: 'SIGKILL',
    });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error('Reminder MySQL test child timed out; local lock retained pending operator review');
    }
    if (result.error) throw new Error('Reminder MySQL test child failed to launch or exit; local lock retained pending operator review');
    if (result.signal || !Number.isInteger(result.status) || result.status < 0) {
      throw new Error('Reminder MySQL test child exited without a confirmed status; local lock retained pending operator review');
    }
    retainLock = false;
    return result.status;
  } finally {
    try {
      if (isolatedCwd && !retainLock) fs.rmSync(isolatedCwd, { recursive: true, force: true });
    } finally {
      runLock.release({ retain: retainLock });
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = runIntegration();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildChildEnvironment,
  hasLauncherOwnedContext,
  runIntegration,
  validateIntegrationEnvironment,
};
