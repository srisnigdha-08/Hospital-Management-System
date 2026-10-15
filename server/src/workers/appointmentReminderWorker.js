'use strict';

const {
  BATCH_SIZE,
  MAX_CLAIM_LEASE_MS,
  createAppointmentReminderWorkerService,
} = require('../services/appointmentReminderWorker.service');
const { createAppointmentReminderDeliveryService } = require('../services/appointmentReminderDelivery.service');

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const STARTUP_ATTEMPTS = 3;
const STARTUP_BACKOFF_MS = 1_000;
const MAX_STARTUP_BACKOFF_MS = 4_000;
const POLL_BACKOFF_MS = 1_000;
const MAX_POLL_BACKOFF_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const DEFAULT_CONFIG = Object.freeze({
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  batchSize: BATCH_SIZE,
  leaseDurationMs: MAX_CLAIM_LEASE_MS,
});

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
]);
const TRANSIENT_ERROR_NAMES = new Set([
  'SequelizeConnectionError',
  'SequelizeConnectionAcquireTimeoutError',
  'SequelizeHostNotFoundError',
]);
const CANDIDATE_ERROR_NAMES = new Set(['TypeError', 'RangeError', 'SequelizeValidationError']);

function isPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateConfig({
  pollIntervalMs,
  batchSize,
  leaseDurationMs,
  startupAttempts,
  startupBackoffMs,
  maxStartupBackoffMs,
  pollBackoffMs,
  maxPollBackoffMs,
  shutdownTimeoutMs,
}) {
  if (!isPositiveInteger(pollIntervalMs, MAX_POLL_INTERVAL_MS) || pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    throw new TypeError(`pollIntervalMs must be between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS} milliseconds`);
  }
  if (!isPositiveInteger(batchSize, BATCH_SIZE)) {
    throw new TypeError(`batchSize must be a positive integer no greater than ${BATCH_SIZE}`);
  }
  if (!isPositiveInteger(leaseDurationMs, MAX_CLAIM_LEASE_MS)) {
    throw new TypeError(`leaseDurationMs must be a positive integer no greater than ${MAX_CLAIM_LEASE_MS} milliseconds`);
  }
  if (!isPositiveInteger(startupAttempts, 5)) throw new TypeError('startupAttempts must be between 1 and 5');
  if (!isPositiveInteger(startupBackoffMs, 30_000)
    || !isPositiveInteger(maxStartupBackoffMs, 30_000)
    || startupBackoffMs > maxStartupBackoffMs) {
    throw new TypeError('Startup backoff must use positive bounded delays');
  }
  if (!isPositiveInteger(pollBackoffMs, 60_000)
    || !isPositiveInteger(maxPollBackoffMs, 5 * 60_000)
    || pollBackoffMs > maxPollBackoffMs) {
    throw new TypeError('Polling backoff must use positive bounded delays');
  }
  if (!isPositiveInteger(shutdownTimeoutMs, 60_000)) {
    throw new TypeError('shutdownTimeoutMs must be a positive integer no greater than 60000 milliseconds');
  }
}

function errorCode(error) {
  return error?.code ?? error?.parent?.code ?? error?.original?.code;
}

function isTransientOperationalError(error) {
  return TRANSIENT_ERROR_NAMES.has(error?.name) || TRANSIENT_ERROR_CODES.has(errorCode(error));
}

function isRecoverableCandidateError(error) {
  return CANDIDATE_ERROR_NAMES.has(error?.name);
}

function safeErrorCategory(error) {
  if (isTransientOperationalError(error)) return 'transient_database';
  if (isRecoverableCandidateError(error)) return 'candidate_validation';
  return 'unexpected';
}

function validClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Worker runtime clock must return a valid Date');
  }
  return value.getTime();
}

function createAppointmentReminderWorkerRuntime({
  readiness,
  workerService,
  deliveryService,
  logger,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  batchSize = BATCH_SIZE,
  leaseDurationMs = MAX_CLAIM_LEASE_MS,
  startupAttempts = STARTUP_ATTEMPTS,
  startupBackoffMs = STARTUP_BACKOFF_MS,
  maxStartupBackoffMs = MAX_STARTUP_BACKOFF_MS,
  pollBackoffMs = POLL_BACKOFF_MS,
  maxPollBackoffMs = MAX_POLL_BACKOFF_MS,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  clock = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  ownsResources = false,
  closeResources,
  onFatalError = () => {},
}) {
  const config = {
    pollIntervalMs,
    batchSize,
    leaseDurationMs,
    startupAttempts,
    startupBackoffMs,
    maxStartupBackoffMs,
    pollBackoffMs,
    maxPollBackoffMs,
    shutdownTimeoutMs,
  };
  validateConfig(config);
  if (typeof readiness !== 'function' || typeof sleep !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Readiness, sleep, and clock dependencies must be functions');
  }
  if (typeof workerService?.claimDueBatch !== 'function'
    || typeof workerService?.validateClaimForDelivery !== 'function'
    || typeof workerService?.recordProcessingFailure !== 'function'
    || typeof deliveryService?.deliverClaim !== 'function') {
    throw new TypeError('Reminder worker and delivery services are required');
  }
  if (workerService.batchSize !== batchSize || workerService.leaseDurationMs !== leaseDurationMs) {
    throw new TypeError('Worker runtime batch and lease configuration must match the claim service');
  }
  if (!logger || ['info', 'warn', 'error'].some((method) => typeof logger[method] !== 'function')) {
    throw new TypeError('A logger with info, warn, and error methods is required');
  }
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function'
    || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Timer functions are required');
  }
  if (typeof onFatalError !== 'function') throw new TypeError('onFatalError must be a function');
  if (ownsResources && typeof closeResources !== 'function') {
    throw new TypeError('An owning worker runtime requires a resource cleanup function');
  }

  let readinessComplete = false;
  let started = false;
  let starting = false;
  let stopping = false;
  let intervalHandle = null;
  let inFlight = null;
  let readinessInFlight = null;
  let cleanupAfterTimeout = null;
  let stopPromise = null;
  let closePromise = null;
  let pollFailureCount = 0;
  let nextPollAfter = 0;

  async function closeOwnedResources() {
    if (!ownsResources) return;
    if (!closePromise) closePromise = Promise.resolve().then(closeResources);
    return closePromise;
  }

  async function checkReadinessWithBackoff() {
    for (let attempt = 1; attempt <= startupAttempts; attempt += 1) {
      if (stopping) return false;
      try {
        const currentCheck = Promise.resolve().then(readiness);
        readinessInFlight = currentCheck;
        try {
          await currentCheck;
        } finally {
          if (readinessInFlight === currentCheck) readinessInFlight = null;
        }
        readinessComplete = true;
        return true;
      } catch (error) {
        if (!isTransientOperationalError(error) || attempt === startupAttempts) {
          throw new Error('Appointment reminder worker readiness failed');
        }
        const delay = Math.min(startupBackoffMs * (2 ** (attempt - 1)), maxStartupBackoffMs);
        await sleep(delay);
      }
    }
    return false;
  }

  function bumpSummary(summary, result) {
    const outcome = typeof result === 'string' ? result : result?.outcome;
    if (outcome === 'delivered') summary.delivered += 1;
    else if (outcome === 'already_delivered') summary.alreadyDelivered += 1;
    else if (outcome === 'uncertain_commit_outcome' || result?.failureCategory === 'outcome_uncertain') summary.uncertain += 1;
    else summary.deferred += 1;
  }

  async function processClaim(claim, summary) {
    if (stopping) return;
    try {
      const validation = await workerService.validateClaimForDelivery(claim);
      if (validation?.outcome !== 'eligible_for_delivery') {
        bumpSummary(summary, validation?.outcome);
        return;
      }
      const delivery = await deliveryService.deliverClaim(validation);
      if (delivery?.failureCategory === 'definitively_not_committed'
        && delivery?.outcome === 'definitively_not_committed') {
        const failure = await workerService.recordProcessingFailure({
          appointmentId: validation.appointmentId,
          claimToken: validation.claimToken,
          scheduleRevision: validation.scheduleRevision,
          outcomeCode: 'delivery_failed',
        });
        bumpSummary(summary, failure?.outcome);
        return;
      }
      bumpSummary(summary, delivery);
    } catch (error) {
      if (!isRecoverableCandidateError(error)) throw error;
      summary.candidateErrors += 1;
      logger.warn('Appointment reminder candidate deferred after a recoverable processing error', {
        category: safeErrorCategory(error),
      });
      // Keep the lease intact. Normal lease expiry is the only retry path when
      // the delivery service cannot prove whether its transaction committed.
    }
  }

  async function runPollCycle() {
    const summary = {
      claimed: 0,
      delivered: 0,
      alreadyDelivered: 0,
      uncertain: 0,
      deferred: 0,
      candidateErrors: 0,
    };
    const candidates = await workerService.claimDueBatch({ shouldStop: () => stopping });
    if (!Array.isArray(candidates)) throw new TypeError('Reminder worker returned an invalid candidate batch');
    for (const candidate of candidates) {
      if (stopping) break;
      if (candidate?.outcome === 'candidate_error') {
        summary.candidateErrors += 1;
        continue;
      }
      if (candidate?.outcome !== 'claimed') {
        summary.deferred += 1;
        continue;
      }
      summary.claimed += 1;
      await processClaim(candidate, summary);
    }
    logger.info('Appointment reminder poll completed', summary);
    pollFailureCount = 0;
    nextPollAfter = 0;
    return { outcome: stopping ? 'stopped' : 'poll_completed', ...summary };
  }

  function clearPollingInterval() {
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
  }

  async function pollOnce() {
    if (!readinessComplete || !started) return { outcome: 'not_ready' };
    if (stopping) return { outcome: 'stopped' };
    if (inFlight) return { outcome: 'overlap_skipped' };

    let now;
    try {
      now = validClock(clock);
    } catch (error) {
      stopping = true;
      clearPollingInterval();
      logger.error('Appointment reminder worker stopped after an unexpected fatal error');
      try { await closeOwnedResources(); } catch { logger.error('Appointment reminder worker resource cleanup failed'); }
      try { await onFatalError(error); } catch { logger.error('Appointment reminder worker fatal-error handler failed'); }
      return { outcome: 'fatal' };
    }
    if (now < nextPollAfter) return { outcome: 'backoff_wait' };

    let current;
    let fatalError = null;
    current = (async () => {
      try {
        return await runPollCycle();
      } catch (error) {
        if (isTransientOperationalError(error)) {
          pollFailureCount += 1;
          const delay = Math.min(pollBackoffMs * (2 ** Math.min(pollFailureCount - 1, 10)), maxPollBackoffMs);
          nextPollAfter = validClock(clock) + delay;
          logger.warn('Appointment reminder poll deferred after a transient operational error', {
            category: safeErrorCategory(error),
            retryDelayMs: delay,
          });
          return { outcome: 'poll_deferred' };
        }
        fatalError = error;
        stopping = true;
        clearPollingInterval();
        logger.error('Appointment reminder worker stopped after an unexpected fatal error');
        return { outcome: 'fatal' };
      } finally {
        if (inFlight === current) inFlight = null;
        if (fatalError) {
          try {
            await closeOwnedResources();
          } catch {
            logger.error('Appointment reminder worker resource cleanup failed');
          }
          try {
            await onFatalError(fatalError);
          } catch {
            logger.error('Appointment reminder worker fatal-error handler failed');
          }
        }
      }
    })();
    inFlight = current;
    return current;
  }

  async function start() {
    if (started || starting) throw new Error('Appointment reminder worker has already been started');
    if (stopping) return { outcome: 'stopped' };
    starting = true;
    try {
      const ready = await checkReadinessWithBackoff();
      if (!ready || stopping) return { outcome: 'stopped' };
      started = true;
      intervalHandle = setIntervalFn(() => { void pollOnce(); }, pollIntervalMs);
      void pollOnce();
      logger.info('Appointment reminder worker started');
      return { outcome: 'started' };
    } catch (error) {
      stopping = true;
      clearPollingInterval();
      try {
        await closeOwnedResources();
      } catch {
        logger.error('Appointment reminder worker resource cleanup failed');
      }
      throw error;
    } finally {
      starting = false;
    }
  }

  function whenIdle() {
    return Promise.all([inFlight, readinessInFlight]
      .filter(Boolean)
      .map((operation) => Promise.resolve(operation).catch(() => {})));
  }

  async function performStop() {
    stopping = true;
    clearPollingInterval();
    if (!inFlight && !readinessInFlight) {
      try {
        await closeOwnedResources();
        return { outcome: 'stopped' };
      } catch {
        logger.error('Appointment reminder worker resource cleanup failed');
        return { outcome: 'cleanup_failed' };
      }
    }

    let timeoutHandle;
    let didFinish;
    const finished = whenIdle().then(() => { didFinish = true; });
    const timedOut = new Promise((resolve) => {
      timeoutHandle = setTimeoutFn(() => resolve(true), shutdownTimeoutMs);
    });
    await Promise.race([finished, timedOut]);
    clearTimeoutFn(timeoutHandle);
    if (!didFinish) {
      cleanupAfterTimeout = finished.then(async () => {
        try {
          await closeOwnedResources();
        } catch {
          logger.error('Appointment reminder worker resource cleanup failed');
        }
      });
      void cleanupAfterTimeout;
      logger.error('Appointment reminder worker shutdown timed out; resources remain open until work settles');
      return { outcome: 'shutdown_timeout' };
    }
    try {
      await closeOwnedResources();
      return { outcome: 'stopped' };
    } catch {
      logger.error('Appointment reminder worker resource cleanup failed');
      return { outcome: 'cleanup_failed' };
    }
  }

  function stop() {
    if (!stopPromise) stopPromise = performStop();
    return stopPromise;
  }

  function whenResourcesClosed() {
    if (cleanupAfterTimeout) return cleanupAfterTimeout;
    return closePromise || Promise.resolve();
  }

  return Object.freeze({
    start,
    pollOnce,
    stop,
    whenIdle,
    whenResourcesClosed,
    getState: () => Object.freeze({
      ready: readinessComplete,
      started,
      stopping,
      pollInFlight: Boolean(inFlight),
    }),
    config: Object.freeze({ ...config }),
  });
}

async function runStandaloneWorker() {
  let sequelize;
  let runtime;
  let logger;
  let signalHandlers;
  try {
    const database = require('../config/db');
    sequelize = database.sequelize;
    sequelize.options.logging = false;
    const models = require('../models');
    logger = require('../utils/logger');

    const workerService = createAppointmentReminderWorkerService({
      Appointment: models.Appointment,
      AppointmentReminder: models.AppointmentReminder,
      Patient: models.Patient,
      sequelize,
      leaseDurationMs: DEFAULT_CONFIG.leaseDurationMs,
      batchSize: DEFAULT_CONFIG.batchSize,
      logger,
    });
    const deliveryService = createAppointmentReminderDeliveryService({
      Appointment: models.Appointment,
      AppointmentReminder: models.AppointmentReminder,
      Patient: models.Patient,
      Notification: models.Notification,
      sequelize,
    });

    let finishRun;
    const runFinished = new Promise((resolve) => { finishRun = resolve; });
    runtime = createAppointmentReminderWorkerRuntime({
      ...DEFAULT_CONFIG,
      readiness: async () => {
        await sequelize.authenticate();
        if (!await database.checkSchemaPreflight(sequelize)) {
          throw new Error('Reminder worker schema is not ready');
        }
      },
      workerService,
      deliveryService,
      logger,
      ownsResources: true,
      closeResources: () => sequelize.close(),
      onFatalError: async () => {
        process.exitCode = 1;
        await runtime.stop();
        finishRun();
      },
    });

    let shutdownRequested = false;
    const shutdown = () => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      logger.info('Appointment reminder worker received a shutdown signal');
      void runtime.stop().then((result) => {
        if (result.outcome === 'shutdown_timeout') process.exitCode = 1;
        if (result.outcome === 'cleanup_failed') process.exitCode = 1;
        finishRun();
      });
    };
    signalHandlers = { SIGINT: shutdown, SIGTERM: shutdown };
    process.on('SIGINT', signalHandlers.SIGINT);
    process.on('SIGTERM', signalHandlers.SIGTERM);

    await runtime.start();
    await runFinished;
  } catch {
    process.exitCode = 1;
    if (logger) logger.error('Appointment reminder worker failed to become ready');
    else console.error('Appointment reminder worker failed to start');
    if (runtime) await runtime.stop();
    else if (sequelize) {
      try { await sequelize.close(); } catch { /* Keep startup errors sanitized. */ }
    }
  } finally {
    if (signalHandlers) {
      process.removeListener('SIGINT', signalHandlers.SIGINT);
      process.removeListener('SIGTERM', signalHandlers.SIGTERM);
    }
  }
}

if (require.main === module) void runStandaloneWorker();

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  STARTUP_ATTEMPTS,
  SHUTDOWN_TIMEOUT_MS,
  createAppointmentReminderWorkerRuntime,
  isTransientOperationalError,
  isRecoverableCandidateError,
};
