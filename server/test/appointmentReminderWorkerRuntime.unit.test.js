'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const databaseConfigPath = require.resolve('../src/config/db');
const modelIndexPath = require.resolve('../src/models');
const migrationRunnerPath = require.resolve('../src/migrations/run');

function loadRuntimeModule() {
  return require('../src/workers/appointmentReminderWorker');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({
  worker = {},
  delivery = {},
  readiness = async () => {},
  clockValue = new Date('2026-04-16T12:00:00.000Z'),
  clock = () => new Date(clockValue),
  ownsResources = false,
  closeResources = async () => {},
  onFatalError = async () => {},
  timers = {},
  settings = {},
} = {}) {
  const logs = [];
  const logger = {
    info: (message, metadata) => logs.push({ level: 'info', message, metadata }),
    warn: (message, metadata) => logs.push({ level: 'warn', message, metadata }),
    error: (message, metadata) => logs.push({ level: 'error', message, metadata }),
  };
  const intervals = [];
  const clearIntervals = [];
  const runtime = loadRuntimeModule().createAppointmentReminderWorkerRuntime({
    readiness,
    workerService: {
      claimDueBatch: async () => [],
      validateClaimForDelivery: async (claim) => ({ ...claim, outcome: 'eligible_for_delivery' }),
      recordProcessingFailure: async () => ({ outcome: 'retry_scheduled' }),
      batchSize: 25,
      leaseDurationMs: 300_000,
      ...worker,
    },
    deliveryService: { deliverClaim: async () => ({ outcome: 'delivered' }), ...delivery },
    logger,
    clock,
    sleep: async () => {},
    setIntervalFn: (fn, interval) => {
      const handle = { fn, interval };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => clearIntervals.push(handle),
    setTimeoutFn: timers.setTimeoutFn || ((fn) => ({ fn })),
    clearTimeoutFn: timers.clearTimeoutFn || (() => {}),
    ownsResources,
    closeResources,
    onFatalError,
    ...settings,
  });
  return { runtime, logs, intervals, clearIntervals };
}

function claim(appointmentId) {
  return {
    outcome: 'claimed',
    appointmentId: String(appointmentId),
    reminderId: String(appointmentId + 100),
    patientId: '71',
    recipientUserId: '9001',
    scheduleRevision: '1',
    claimToken: '11111111-1111-4111-8111-111111111111',
  };
}

describe('appointment reminder worker runtime (synthetic, database-free fakes)', () => {
  test('import is dormant and does not load database, models, or migration configuration', () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    assert.equal(require.cache[databaseConfigPath], undefined);
    assert.equal(require.cache[modelIndexPath], undefined);
    assert.equal(require.cache[migrationRunnerPath], undefined);
    const api = loadRuntimeModule();
    assert.equal(typeof api.createAppointmentReminderWorkerRuntime, 'function');
    assert.equal(require.cache[databaseConfigPath], undefined);
    assert.equal(require.cache[modelIndexPath], undefined);
    assert.equal(require.cache[migrationRunnerPath], undefined);
    assert.equal(process.listenerCount('SIGINT'), sigintListeners);
    assert.equal(process.listenerCount('SIGTERM'), sigtermListeners);
  });

  test('standalone readiness authenticates and preflights schema without a migration path', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '../src/workers/appointmentReminderWorker.js'), 'utf8');
    assert.match(entrypoint, /await sequelize\.authenticate\(\)/);
    assert.match(entrypoint, /database\.checkSchemaPreflight\(sequelize\)/);
    assert.doesNotMatch(entrypoint, /migrations\/run|\.migrate\s*\(/);
  });

  test('validates bounded interval, batch, lease, backoff, and shutdown configuration', () => {
    const { createAppointmentReminderWorkerRuntime } = loadRuntimeModule();
    const base = {
      readiness: async () => {},
      workerService: {
        claimDueBatch: async () => [],
        validateClaimForDelivery: async () => ({}),
        recordProcessingFailure: async () => ({ outcome: 'retry_scheduled' }),
        batchSize: 25,
        leaseDurationMs: 300_000,
      },
      deliveryService: { deliverClaim: async () => ({}) },
      logger: { info() {}, warn() {}, error() {} },
    };
    for (const invalid of [
      { pollIntervalMs: 0 },
      { pollIntervalMs: 999 },
      { pollIntervalMs: 300_001 },
      { pollIntervalMs: Number.NaN },
      { batchSize: 0 },
      { batchSize: 26 },
      { leaseDurationMs: 300_001 },
      { startupAttempts: 6 },
      { shutdownTimeoutMs: 60_001 },
    ]) {
      assert.throws(() => createAppointmentReminderWorkerRuntime({ ...base, ...invalid }));
    }
    assert.throws(() => createAppointmentReminderWorkerRuntime({ ...base, batchSize: 2 }), /match the claim service/);
  });

  test('readiness failure prevents claims and never imports or invokes migrations', async () => {
    let claims = 0;
    let closed = 0;
    const h = createHarness({
      readiness: async () => { throw new Error('synthetic schema-not-ready'); },
      worker: { claimDueBatch: async () => { claims += 1; return []; } },
      ownsResources: true,
      closeResources: async () => { closed += 1; },
    });
    await assert.rejects(h.runtime.start(), /readiness failed/);
    assert.equal(claims, 0);
    assert.equal(closed, 1);
    assert.equal(require.cache[migrationRunnerPath], undefined);
  });

  test('retries transient startup readiness with bounded backoff before polling', async () => {
    const delays = [];
    let readyChecks = 0;
    let claimCalls = 0;
    const h = createHarness({
      readiness: async () => {
        readyChecks += 1;
        if (readyChecks < 3) {
          const error = new Error('unavailable');
          error.name = 'SequelizeConnectionError';
          throw error;
        }
      },
      worker: { claimDueBatch: async () => { claimCalls += 1; return []; } },
      settings: { sleep: async (delay) => delays.push(delay) },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.equal(readyChecks, 3);
    assert.deepEqual(delays, [1_000, 2_000]);
    assert.equal(claimCalls, 1);
  });

  test('exhausted startup retries fail closed without starting polling', async () => {
    let readinessCalls = 0;
    let claimCalls = 0;
    let closed = 0;
    const h = createHarness({
      readiness: async () => {
        readinessCalls += 1;
        const error = new Error('not reachable');
        error.code = 'ECONNREFUSED';
        throw error;
      },
      worker: { claimDueBatch: async () => { claimCalls += 1; return []; } },
      ownsResources: true,
      closeResources: async () => { closed += 1; },
      settings: { sleep: async () => {} },
    });
    await assert.rejects(h.runtime.start(), /readiness failed/);
    assert.equal(readinessCalls, 3);
    assert.equal(claimCalls, 0);
    assert.equal(h.intervals.length, 0);
    assert.equal(closed, 1);
  });

  test('uses 15-second polling, at most 25 candidates, and processes claims sequentially', async () => {
    const events = [];
    const claims = [claim(1), claim(2), claim(3)];
    const h = createHarness({
      worker: {
        claimDueBatch: async (options) => {
          assert.equal(typeof options.shouldStop, 'function');
          events.push('claim-batch');
          return claims;
        },
        validateClaimForDelivery: async (candidate) => {
          events.push(`validate-${candidate.appointmentId}`);
          return { ...candidate, outcome: 'eligible_for_delivery' };
        },
      },
      delivery: {
        deliverClaim: async (candidate) => {
          events.push(`deliver-${candidate.appointmentId}`);
          return { outcome: 'delivered' };
        },
      },
    });
    assert.equal(h.runtime.config.pollIntervalMs, 15_000);
    assert.equal(h.runtime.config.batchSize, 25);
    assert.equal(h.runtime.config.leaseDurationMs, 300_000);
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.deepEqual(events, [
      'claim-batch', 'validate-1', 'deliver-1', 'validate-2', 'deliver-2', 'validate-3', 'deliver-3',
    ]);
    assert.equal(h.intervals[0].interval, 15_000);
    await h.runtime.stop();
  });

  test('overlapping poll ticks are skipped while a batch is in flight', async () => {
    const gate = deferred();
    let calls = 0;
    const h = createHarness({
      worker: { claimDueBatch: async () => { calls += 1; await gate.promise; return []; } },
    });
    await h.runtime.start();
    assert.equal(await h.runtime.pollOnce().then((result) => result.outcome), 'overlap_skipped');
    assert.equal(calls, 1);
    gate.resolve();
    await h.runtime.whenIdle();
    await h.runtime.stop();
  });

  test('transient polling failures back off rather than spin and recover on a later tick', async () => {
    let now = new Date('2026-04-16T12:00:00.000Z');
    let calls = 0;
    const h = createHarness({
      clock: () => new Date(now),
      worker: {
        claimDueBatch: async () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('connection reset');
            error.code = 'ECONNRESET';
            throw error;
          }
          return [];
        },
      },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.equal(calls, 1);
    assert.equal((await h.runtime.pollOnce()).outcome, 'backoff_wait');
    assert.equal(calls, 1);
    now = new Date(now.getTime() + 1_000);
    assert.equal((await h.runtime.pollOnce()).outcome, 'poll_completed');
    assert.equal(calls, 2);
    await h.runtime.stop();
  });

  test('candidate errors are isolated and logs contain no candidate identifiers or raw error messages', async () => {
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1), claim(2)],
        validateClaimForDelivery: async (candidate) => {
          if (candidate.appointmentId === '1') throw new TypeError('synthetic private detail');
          return { ...candidate, outcome: 'eligible_for_delivery' };
        },
      },
      delivery: { deliverClaim: async () => ({ outcome: 'delivered' }) },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    const output = JSON.stringify(h.logs);
    assert.match(output, /candidate_validation/);
    assert.doesNotMatch(output, /synthetic private detail|9001|appointmentId|recipientUserId/);
    assert.equal(h.logs.find((entry) => entry.message === 'Appointment reminder poll completed').metadata.candidateErrors, 1);
    await h.runtime.stop();
  });

  test('uncertain commit outcomes retain their lease and are not recorded as failures', async () => {
    let deliveries = 0;
    let failureRecords = 0;
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1)],
        validateClaimForDelivery: async (candidate) => ({ ...candidate, outcome: 'eligible_for_delivery' }),
        recordProcessingFailure: async () => { failureRecords += 1; },
      },
      delivery: {
        deliverClaim: async () => {
          deliveries += 1;
          return { outcome: 'not_committed_retryable', failureCategory: 'outcome_uncertain' };
        },
      },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.equal(deliveries, 1);
    assert.equal(failureRecords, 0);
    assert.equal(h.logs.find((entry) => entry.message === 'Appointment reminder poll completed').metadata.uncertain, 1);
    await h.runtime.stop();
  });

  test('a definitive pre-commit delivery failure enters the bounded failure recorder once', async () => {
    const recorded = [];
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1)],
        validateClaimForDelivery: async (candidate) => ({ ...candidate, outcome: 'eligible_for_delivery' }),
        recordProcessingFailure: async (failure) => {
          recorded.push(failure);
          return { outcome: 'retry_scheduled', attemptCount: 1 };
        },
      },
      delivery: {
        deliverClaim: async () => ({
          outcome: 'definitively_not_committed',
          failureCategory: 'definitively_not_committed',
          failureCode: 'delivery_failed',
        }),
      },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.deepEqual(recorded, [{
      appointmentId: '1',
      claimToken: '11111111-1111-4111-8111-111111111111',
      scheduleRevision: '1',
      outcomeCode: 'delivery_failed',
    }]);
    await h.runtime.stop();
  });

  test('non-delivery validation failures do not consume a delivery attempt', async () => {
    let failureRecords = 0;
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1)],
        validateClaimForDelivery: async (candidate) => ({ ...candidate, outcome: 'eligible_for_delivery' }),
        recordProcessingFailure: async () => { failureRecords += 1; },
      },
      delivery: {
        deliverClaim: async () => ({
          outcome: 'schedule_snapshot_mismatch',
          failureCategory: 'non_delivery_validation_failure',
        }),
      },
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.equal(failureRecords, 0);
    await h.runtime.stop();
  });

  test('unexpected errors stop polling, surface through the fatal hook, and close only owned resources', async () => {
    const fatal = [];
    let closed = 0;
    const h = createHarness({
      worker: { claimDueBatch: async () => { throw new Error('unexpected internal error'); } },
      ownsResources: true,
      closeResources: async () => { closed += 1; },
      onFatalError: async (error) => fatal.push(error),
    });
    await h.runtime.start();
    await h.runtime.whenIdle();
    assert.equal(h.runtime.getState().stopping, true);
    assert.equal(h.clearIntervals.length, 1);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0].message, 'unexpected internal error');
    assert.equal(closed, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /unexpected internal error/);
  });

  test('shutdown stops subsequent claim processing and waits for current delivery before closing owned resources', async () => {
    const gate = deferred();
    const deliveryStarted = deferred();
    const events = [];
    let closed = 0;
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1), claim(2)],
        validateClaimForDelivery: async (candidate) => ({ ...candidate, outcome: 'eligible_for_delivery' }),
      },
      delivery: {
        deliverClaim: async (candidate) => {
          events.push(candidate.appointmentId);
          if (candidate.appointmentId === '1') {
            deliveryStarted.resolve();
            await gate.promise;
          }
          return { outcome: 'delivered' };
        },
      },
      ownsResources: true,
      closeResources: async () => { closed += 1; },
    });
    await h.runtime.start();
    await deliveryStarted.promise;
    const stopping = h.runtime.stop();
    assert.equal(closed, 0);
    gate.resolve();
    assert.equal((await stopping).outcome, 'stopped');
    assert.deepEqual(events, ['1']);
    assert.equal(closed, 1);
  });

  test('shutdown timeout leaves the owned connection open until in-flight work settles', async () => {
    const gate = deferred();
    const deliveryStarted = deferred();
    let timeoutCallback;
    let closed = 0;
    const h = createHarness({
      worker: {
        claimDueBatch: async () => [claim(1)],
        validateClaimForDelivery: async (candidate) => ({ ...candidate, outcome: 'eligible_for_delivery' }),
      },
      delivery: { deliverClaim: async () => { deliveryStarted.resolve(); await gate.promise; return { outcome: 'delivered' }; } },
      ownsResources: true,
      closeResources: async () => { closed += 1; },
      timers: { setTimeoutFn: (callback) => { timeoutCallback = callback; return 1; } },
      settings: { shutdownTimeoutMs: 10 },
    });
    await h.runtime.start();
    await deliveryStarted.promise;
    const stopping = h.runtime.stop();
    timeoutCallback();
    assert.equal((await stopping).outcome, 'shutdown_timeout');
    assert.equal(closed, 0);
    gate.resolve();
    await h.runtime.whenIdle();
    await h.runtime.whenResourcesClosed();
    assert.equal(closed, 1);
  });

  test('a runtime that does not own its connection never closes it', async () => {
    let closed = 0;
    const h = createHarness({ closeResources: async () => { closed += 1; } });
    await h.runtime.start();
    await h.runtime.whenIdle();
    await h.runtime.stop();
    assert.equal(closed, 0);
  });
});
