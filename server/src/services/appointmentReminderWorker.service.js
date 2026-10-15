'use strict';

const { randomUUID } = require('node:crypto');
const { Op: sequelizeOperators } = require('sequelize');
const {
  MAX_REMINDER_ATTEMPTS,
  MAX_CLAIM_LEASE_MS,
  evaluatePendingReminder,
  buildReminderIdempotencyKey,
  retryAtAfterFailure,
} = require('../utils/appointmentReminderPolicy');

const BATCH_SIZE = 25;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const TERMINAL_OUTCOMES = Object.freeze({
  cancelled: 'appointment_cancelled',
  completed: 'appointment_completed',
  no_show: 'appointment_no_show',
});
const SAFE_FAILURE_CODES = new Set([
  'delivery_failed',
  'delivery_timeout',
  'provider_unavailable',
  'worker_error',
]);
const RECOVERABLE_CANDIDATE_ERROR_NAMES = new Set(['TypeError', 'RangeError', 'SequelizeValidationError']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function databaseId(value, label) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a positive unsigned BIGINT identifier`);
  }
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(normalized) || BigInt(normalized) > MAX_UNSIGNED_BIGINT) {
    throw new TypeError(`${label} must be a positive unsigned BIGINT identifier`);
  }
  return normalized;
}

function revisionValue(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError('Reminder schedule revision is invalid');
  }
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(normalized) || BigInt(normalized) > MAX_UNSIGNED_BIGINT) {
    throw new TypeError('Reminder schedule revision is invalid');
  }
  return normalized;
}

function nextRevision(value) {
  const current = BigInt(revisionValue(value));
  if (current >= MAX_UNSIGNED_BIGINT) throw new RangeError('Reminder schedule revision cannot be incremented safely');
  return (current + 1n).toString();
}

function attemptCount(reminder) {
  if (!Number.isInteger(reminder.attemptCount) || reminder.attemptCount < 0 || reminder.attemptCount > MAX_REMINDER_ATTEMPTS) {
    throw new TypeError('Reminder attempt count is invalid');
  }
  return reminder.attemptCount;
}

function readClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Worker clock must return a valid Date');
  }
  return new Date(value.getTime());
}

function instant(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid persisted Date`);
  }
  return value.getTime();
}

function plainRow(row) {
  return typeof row?.get === 'function' ? row.get({ plain: true }) : row;
}

function save(reminder, changes, transaction) {
  Object.assign(reminder, changes);
  return reminder.save({ transaction });
}

function clearClaim(reminder) {
  return { claimToken: null, leaseExpiresAtUtc: null };
}

function logCode(logger, level, code) {
  if (typeof logger[level] === 'function') {
    logger[level](`Appointment reminder worker outcome: ${code}`);
  }
}

function createAppointmentReminderWorkerService({
  Appointment,
  AppointmentReminder,
  Patient,
  sequelize,
  clock = () => new Date(),
  createClaimToken = randomUUID,
  leaseDurationMs,
  batchSize = BATCH_SIZE,
  logger,
  Op = sequelizeOperators,
}) {
  if (!Appointment || !AppointmentReminder || !Patient || typeof sequelize?.transaction !== 'function') {
    throw new TypeError('Appointment, AppointmentReminder, Patient, and a transaction provider are required');
  }
  if (typeof clock !== 'function' || typeof createClaimToken !== 'function') {
    throw new TypeError('Worker clock and claim-token factory must be functions');
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0 || leaseDurationMs > MAX_CLAIM_LEASE_MS) {
    throw new TypeError(`leaseDurationMs must be a positive integer no greater than ${MAX_CLAIM_LEASE_MS} milliseconds`);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > BATCH_SIZE) {
    throw new TypeError(`batchSize must be a positive integer no greater than ${BATCH_SIZE}`);
  }
  if (!Op?.or || !Op?.lte || !Op?.ne) throw new TypeError('Sequelize query operators are required');
  if (!logger || typeof logger.warn !== 'function') throw new TypeError('A logger with a warn method is required');

  async function lockAppointmentThenReminder(appointmentId, transaction) {
    if (!transaction?.LOCK?.UPDATE) throw new TypeError('Reminder worker requires an UPDATE-locked transaction');

    const appointment = await Appointment.findByPk(appointmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!appointment) return { appointment: null, reminder: null };

    const reminder = await AppointmentReminder.findOne({
      where: { appointmentId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return { appointment, reminder };
  }

  async function verifyPatientOwnership(appointment, reminder, transaction) {
    if (String(appointment.patientId) !== String(reminder.patientId)) return null;
    const patient = await Patient.findByPk(appointment.patientId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!patient?.userId) return null;
    try {
      const patientId = databaseId(patient.patientId, 'patientId');
      const recipientUserId = databaseId(patient.userId, 'recipientUserId');
      if (patientId !== databaseId(appointment.patientId, 'appointment.patientId')) return null;
      if (reminder.idempotencyKey !== buildReminderIdempotencyKey(appointment.appointmentId, recipientUserId)) return null;
      return {
        patientId,
        recipientUserId,
      };
    } catch {
      return null;
    }
  }

  async function closeIneligible(reminder, state, outcomeCode, transaction) {
    return save(reminder, {
      ...clearClaim(reminder),
      scheduleRevision: nextRevision(reminder.scheduleRevision),
      state,
      outcomeCode,
    }, transaction);
  }

  function outcome(code, extra = {}) {
    return { outcome: code, ...extra };
  }

  function normalizeCandidate(rawCandidate) {
    const candidate = plainRow(rawCandidate);
    return {
      appointmentId: databaseId(candidate.appointmentId, 'appointmentId'),
      reminderId: databaseId(candidate.appointmentReminderId, 'appointmentReminderId'),
      candidateRevision: revisionValue(candidate.scheduleRevision),
      candidateToken: candidate.claimToken ?? null,
    };
  }

  async function processCandidate({ appointmentId, reminderId, candidateRevision, candidateToken }) {
    return sequelize.transaction(async (transaction) => {
      const { appointment, reminder } = await lockAppointmentThenReminder(appointmentId, transaction);
      if (!appointment) return outcome('appointment_missing', { appointmentId, reminderId });
      if (!reminder || String(reminder.appointmentReminderId) !== reminderId) {
        return outcome('reminder_missing_or_replaced', { appointmentId, reminderId });
      }
      if (reminder.state !== 'pending') return outcome('not_pending', { appointmentId, reminderId });

      const currentRevision = revisionValue(reminder.scheduleRevision);
      if (currentRevision !== candidateRevision || (reminder.claimToken ?? null) !== candidateToken) {
        return outcome('stale_candidate', { appointmentId, reminderId });
      }

      const now = readClock(clock);
      const terminalOutcome = TERMINAL_OUTCOMES[appointment.status];
      if (terminalOutcome) {
        await closeIneligible(reminder, 'cancelled', terminalOutcome, transaction);
        return outcome('cancelled_terminal', { appointmentId, reminderId });
      }

      const eligibility = evaluatePendingReminder({
        appointment,
        expectedAppointmentStart: reminder.scheduledStartUtc,
        dueAt: reminder.dueAtUtc,
      }, { clock: () => now });
      if (eligibility === 'skip_started') {
        await closeIneligible(reminder, 'skipped', 'appointment_started', transaction);
        return outcome('skipped_started', { appointmentId, reminderId });
      }
      if (eligibility === 'cancel') {
        await closeIneligible(reminder, 'cancelled', 'appointment_ineligible', transaction);
        return outcome('cancelled_ineligible', { appointmentId, reminderId });
      }

      const hasToken = reminder.claimToken !== null && reminder.claimToken !== undefined;
      const hasLease = reminder.leaseExpiresAtUtc !== null && reminder.leaseExpiresAtUtc !== undefined;
      let leaseExpiry = null;
      let invalidLease = false;
      if (hasToken && hasLease) {
        try {
          leaseExpiry = instant(reminder.leaseExpiresAtUtc, 'Reminder leaseExpiresAtUtc');
        } catch {
          invalidLease = true;
        }
      }

      const tokenIsValid = !hasToken || (typeof reminder.claimToken === 'string' && UUID_PATTERN.test(reminder.claimToken));
      if (hasToken !== hasLease || invalidLease || !tokenIsValid) {
        if (hasToken && hasLease && !invalidLease && leaseExpiry > now.getTime()) {
          logCode(logger, 'warn', 'invalid_claim_state');
          return outcome('invalid_claim_state_active', { appointmentId, reminderId });
        }
        logCode(logger, 'warn', 'invalid_claim_state');
        await closeIneligible(reminder, 'failed', 'invalid_claim_state', transaction);
        return outcome('invalid_claim_quarantined', { appointmentId, reminderId });
      }

      if (hasToken && leaseExpiry > now.getTime()) {
        return outcome('claim_active', { appointmentId, reminderId });
      }

      if (eligibility === 'stale') {
        logCode(logger, 'warn', 'schedule_snapshot_mismatch');
        await closeIneligible(reminder, 'failed', 'schedule_snapshot_mismatch', transaction);
        return outcome('schedule_snapshot_quarantined', { appointmentId, reminderId });
      }

      const ownership = await verifyPatientOwnership(appointment, reminder, transaction);
      if (!ownership) {
        logCode(logger, 'warn', 'patient_relationship_mismatch');
        await closeIneligible(reminder, 'failed', 'patient_relationship_mismatch', transaction);
        return outcome('patient_relationship_mismatch', { appointmentId, reminderId });
      }

      const scheduledStart = instant(appointment.scheduledStart, 'Appointment scheduledStart');
      const dueAt = instant(reminder.dueAtUtc, 'Reminder dueAtUtc');
      const nextAttemptAt = instant(reminder.nextAttemptAtUtc, 'Reminder nextAttemptAtUtc');
      if (hasToken) {
        const attempts = attemptCount(reminder);
        if (attempts >= MAX_REMINDER_ATTEMPTS) {
          await save(reminder, {
            ...clearClaim(reminder),
            state: 'failed',
            outcomeCode: 'attempts_exhausted',
          }, transaction);
          return outcome('attempts_exhausted', { appointmentId, reminderId, attemptCount: attempts });
        }

        const failedAttempt = attempts + 1;
        const retryAt = retryAtAfterFailure(failedAttempt, {
          clock: () => now,
          scheduledStart: new Date(scheduledStart),
        });
        const terminalRetryState = retryAt
          ? 'pending'
          : (failedAttempt === MAX_REMINDER_ATTEMPTS ? 'failed' : 'skipped');
        const retryOutcome = retryAt
          ? 'claim_expired'
          : (failedAttempt === MAX_REMINDER_ATTEMPTS ? 'attempts_exhausted' : 'no_retry_before_appointment');
        await save(reminder, {
          ...clearClaim(reminder),
          attemptCount: failedAttempt,
          lastAttemptAtUtc: now,
          ...(retryAt ? { nextAttemptAtUtc: retryAt } : {}),
          state: terminalRetryState,
          outcomeCode: retryOutcome,
        }, transaction);
        return outcome(retryAt ? 'expired_claim_retried' : retryOutcome, {
          appointmentId,
          reminderId,
          attemptCount: failedAttempt,
          nextAttemptAtUtc: retryAt,
        });
      }

      if (dueAt > now.getTime() || nextAttemptAt > now.getTime()) {
        return outcome('not_due', { appointmentId, reminderId });
      }
      const attempts = attemptCount(reminder);
      if (attempts >= MAX_REMINDER_ATTEMPTS) {
        await save(reminder, {
          ...clearClaim(reminder),
          state: 'failed',
          outcomeCode: 'attempts_exhausted',
        }, transaction);
        return outcome('attempts_exhausted', { appointmentId, reminderId, attemptCount: attempts });
      }

      const claimToken = createClaimToken();
      if (typeof claimToken !== 'string' || !UUID_PATTERN.test(claimToken)) {
        throw new TypeError('Claim-token factory must return a UUID v4');
      }
      const leaseExpiresAtUtc = new Date(now.getTime() + leaseDurationMs);
      if (!Number.isFinite(leaseExpiresAtUtc.getTime())) throw new RangeError('Claim lease expiry is invalid');
      await save(reminder, { claimToken, leaseExpiresAtUtc }, transaction);
      return outcome('claimed', {
        appointmentId,
        reminderId,
        claimToken,
        scheduleRevision: currentRevision,
        patientId: ownership.patientId,
        recipientUserId: ownership.recipientUserId,
        leaseExpiresAtUtc,
      });
    });
  }

  async function claimDueBatch({ shouldStop = () => false } = {}) {
    if (typeof shouldStop !== 'function') throw new TypeError('shouldStop must be a function');
    if (shouldStop()) return [];
    const now = readClock(clock);
    const candidates = await AppointmentReminder.findAll({
      where: {
        state: 'pending',
        [Op.or]: [
          { claimToken: null, nextAttemptAtUtc: { [Op.lte]: now } },
          { claimToken: { [Op.ne]: null }, leaseExpiresAtUtc: { [Op.lte]: now } },
        ],
      },
      attributes: ['appointmentReminderId', 'appointmentId', 'scheduleRevision', 'claimToken'],
      order: [['nextAttemptAtUtc', 'ASC'], ['appointmentReminderId', 'ASC']],
      limit: batchSize,
    });
    const results = [];
    for (const candidate of candidates) {
      if (shouldStop()) break;
      let normalized;
      try {
        normalized = normalizeCandidate(candidate);
      } catch (error) {
        if (!RECOVERABLE_CANDIDATE_ERROR_NAMES.has(error?.name)) throw error;
        logCode(logger, 'warn', 'candidate_processing_error');
        results.push(outcome('candidate_error'));
        continue;
      }
      results.push(await processCandidate(normalized));
    }
    return results;
  }

  async function validateClaimForDelivery({ appointmentId, claimToken, scheduleRevision }) {
    const normalizedAppointmentId = databaseId(appointmentId, 'appointmentId');
    const normalizedRevision = revisionValue(scheduleRevision);
    if (typeof claimToken !== 'string' || !UUID_PATTERN.test(claimToken)) {
      throw new TypeError('claimToken must be a UUID v4');
    }

    return sequelize.transaction(async (transaction) => {
      const { appointment, reminder } = await lockAppointmentThenReminder(normalizedAppointmentId, transaction);
      if (!appointment) return outcome('appointment_missing', { appointmentId: normalizedAppointmentId });
      if (!reminder) return outcome('reminder_missing', { appointmentId: normalizedAppointmentId });
      if (reminder.state !== 'pending') return outcome('not_pending', { appointmentId: normalizedAppointmentId });
      if (String(reminder.claimToken ?? '') !== claimToken
        || revisionValue(reminder.scheduleRevision) !== normalizedRevision) {
        return outcome('stale_claim', { appointmentId: normalizedAppointmentId });
      }

      const terminalOutcome = TERMINAL_OUTCOMES[appointment.status];
      if (terminalOutcome) {
        await closeIneligible(reminder, 'cancelled', terminalOutcome, transaction);
        return outcome('cancelled_terminal', { appointmentId: normalizedAppointmentId });
      }

      const now = readClock(clock);
      const eligibility = evaluatePendingReminder({
        appointment,
        expectedAppointmentStart: reminder.scheduledStartUtc,
        dueAt: reminder.dueAtUtc,
      }, { clock: () => now });
      if (eligibility === 'skip_started') {
        await closeIneligible(reminder, 'skipped', 'appointment_started', transaction);
        return outcome('skipped_started', { appointmentId: normalizedAppointmentId });
      }
      if (eligibility !== 'deliver') {
        if (eligibility === 'cancel') {
          await closeIneligible(reminder, 'cancelled', 'appointment_ineligible', transaction);
          return outcome('cancelled_ineligible', { appointmentId: normalizedAppointmentId });
        }
        if (eligibility === 'stale') logCode(logger, 'warn', 'schedule_snapshot_mismatch');
        return outcome(eligibility === 'stale' ? 'schedule_snapshot_mismatch' : 'not_due', {
          appointmentId: normalizedAppointmentId,
        });
      }

      const leaseExpiry = instant(reminder.leaseExpiresAtUtc, 'Reminder leaseExpiresAtUtc');
      if (leaseExpiry <= now.getTime()) return outcome('lease_expired', { appointmentId: normalizedAppointmentId });
      if (instant(reminder.nextAttemptAtUtc, 'Reminder nextAttemptAtUtc') > now.getTime()) {
        return outcome('not_due', { appointmentId: normalizedAppointmentId });
      }
      const attempts = attemptCount(reminder);
      if (attempts >= MAX_REMINDER_ATTEMPTS) {
        await save(reminder, {
          ...clearClaim(reminder),
          state: 'failed',
          outcomeCode: 'attempts_exhausted',
        }, transaction);
        return outcome('attempts_exhausted', { appointmentId: normalizedAppointmentId, attemptCount: attempts });
      }
      const ownership = await verifyPatientOwnership(appointment, reminder, transaction);
      if (!ownership) {
        logCode(logger, 'warn', 'patient_relationship_mismatch');
        await closeIneligible(reminder, 'failed', 'patient_relationship_mismatch', transaction);
        return outcome('patient_relationship_mismatch', { appointmentId: normalizedAppointmentId });
      }

      return outcome('eligible_for_delivery', {
        appointmentId: normalizedAppointmentId,
        reminderId: databaseId(reminder.appointmentReminderId, 'appointmentReminderId'),
        patientId: ownership.patientId,
        recipientUserId: ownership.recipientUserId,
        claimToken,
        scheduleRevision: normalizedRevision,
      });
    });
  }

  async function recordProcessingFailure({ appointmentId, claimToken, scheduleRevision, outcomeCode }) {
    const normalizedAppointmentId = databaseId(appointmentId, 'appointmentId');
    const normalizedRevision = revisionValue(scheduleRevision);
    if (typeof claimToken !== 'string' || !UUID_PATTERN.test(claimToken)) {
      throw new TypeError('claimToken must be a UUID v4');
    }
    const failureCode = SAFE_FAILURE_CODES.has(outcomeCode) ? outcomeCode : 'delivery_failed';

    return sequelize.transaction(async (transaction) => {
      const { appointment, reminder } = await lockAppointmentThenReminder(normalizedAppointmentId, transaction);
      if (!appointment) return outcome('appointment_missing', { appointmentId: normalizedAppointmentId });
      if (!reminder) return outcome('reminder_missing', { appointmentId: normalizedAppointmentId });
      if (reminder.state !== 'pending') return outcome('not_pending', { appointmentId: normalizedAppointmentId });
      if (String(reminder.claimToken ?? '') !== claimToken
        || revisionValue(reminder.scheduleRevision) !== normalizedRevision) {
        return outcome('stale_claim', { appointmentId: normalizedAppointmentId });
      }

      const now = readClock(clock);
      const leaseExpiry = instant(reminder.leaseExpiresAtUtc, 'Reminder leaseExpiresAtUtc');
      if (leaseExpiry <= now.getTime()) return outcome('lease_expired', { appointmentId: normalizedAppointmentId });

      const terminalOutcome = TERMINAL_OUTCOMES[appointment.status];
      if (terminalOutcome) {
        await closeIneligible(reminder, 'cancelled', terminalOutcome, transaction);
        return outcome('cancelled_terminal', { appointmentId: normalizedAppointmentId });
      }
      const eligibility = evaluatePendingReminder({
        appointment,
        expectedAppointmentStart: reminder.scheduledStartUtc,
        dueAt: reminder.dueAtUtc,
      }, { clock: () => now });
      if (eligibility === 'skip_started') {
        await closeIneligible(reminder, 'skipped', 'appointment_started', transaction);
        return outcome('skipped_started', { appointmentId: normalizedAppointmentId });
      }
      if (eligibility !== 'deliver') {
        if (eligibility === 'cancel') {
          await closeIneligible(reminder, 'cancelled', 'appointment_ineligible', transaction);
          return outcome('cancelled_ineligible', { appointmentId: normalizedAppointmentId });
        }
        if (eligibility === 'stale') logCode(logger, 'warn', 'schedule_snapshot_mismatch');
        return outcome(eligibility === 'stale' ? 'schedule_snapshot_mismatch' : 'not_due', {
          appointmentId: normalizedAppointmentId,
        });
      }
      if (instant(reminder.nextAttemptAtUtc, 'Reminder nextAttemptAtUtc') > now.getTime()) {
        return outcome('not_due', { appointmentId: normalizedAppointmentId });
      }

      const ownership = await verifyPatientOwnership(appointment, reminder, transaction);
      if (!ownership) {
        logCode(logger, 'warn', 'patient_relationship_mismatch');
        await closeIneligible(reminder, 'failed', 'patient_relationship_mismatch', transaction);
        return outcome('patient_relationship_mismatch', { appointmentId: normalizedAppointmentId });
      }

      const currentAttempts = attemptCount(reminder);
      if (currentAttempts >= MAX_REMINDER_ATTEMPTS) {
        await save(reminder, {
          ...clearClaim(reminder),
          state: 'failed',
          outcomeCode: 'attempts_exhausted',
        }, transaction);
        return outcome('attempts_exhausted', { appointmentId: normalizedAppointmentId, attemptCount: currentAttempts });
      }

      const failedAttempt = currentAttempts + 1;
      const scheduledStart = instant(appointment.scheduledStart, 'Appointment scheduledStart');
      const retryAt = retryAtAfterFailure(failedAttempt, {
        clock: () => now,
        scheduledStart: new Date(scheduledStart),
      });
      const nextState = retryAt
        ? 'pending'
        : (failedAttempt === MAX_REMINDER_ATTEMPTS ? 'failed' : 'skipped');
      const finalOutcome = retryAt
        ? failureCode
        : (failedAttempt === MAX_REMINDER_ATTEMPTS ? 'attempts_exhausted' : 'no_retry_before_appointment');
      await save(reminder, {
        ...clearClaim(reminder),
        attemptCount: failedAttempt,
        lastAttemptAtUtc: now,
        ...(retryAt ? { nextAttemptAtUtc: retryAt } : {}),
        state: nextState,
        outcomeCode: finalOutcome,
      }, transaction);
      return outcome(retryAt ? 'retry_scheduled' : finalOutcome, {
        appointmentId: normalizedAppointmentId,
        reminderId: databaseId(reminder.appointmentReminderId, 'appointmentReminderId'),
        attemptCount: failedAttempt,
        nextAttemptAtUtc: retryAt,
      });
    });
  }

  return Object.freeze({
    claimDueBatch,
    validateClaimForDelivery,
    recordProcessingFailure,
    batchSize,
    leaseDurationMs,
  });
}

module.exports = { BATCH_SIZE, MAX_CLAIM_LEASE_MS, createAppointmentReminderWorkerService };
