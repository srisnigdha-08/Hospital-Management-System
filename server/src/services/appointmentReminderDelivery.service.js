'use strict';

const { UniqueConstraintError } = require('sequelize');
const {
  MAX_CLAIM_LEASE_MS,
  MAX_REMINDER_ATTEMPTS,
  buildReminderIdempotencyKey,
  evaluatePendingReminder,
} = require('../utils/appointmentReminderPolicy');

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMINDER_UNIQUE_CONSTRAINT = 'uq_notifications_appointment_reminder';
const REMINDER_UNIQUE_FIELDS = new Set(['appointment_reminder_id', 'appointmentReminderId']);
const ELIGIBLE_STATUSES = new Set(['scheduled', 'confirmed']);
const REMINDER_TITLE = 'Appointment reminder';
const REMINDER_MESSAGE = 'You have an appointment coming up. Please review your appointment details.';
const DELIVERY_CROSSED_START = Symbol('delivery-crossed-appointment-start');
const FAILURE_CATEGORY = Object.freeze({
  NOT_COMMITTED: 'definitively_not_committed',
  UNCERTAIN: 'outcome_uncertain',
  NON_DELIVERY: 'non_delivery_validation_failure',
});
const VALIDATION_ERROR_NAMES = new Set(['TypeError', 'RangeError', 'SequelizeValidationError']);

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
    throw new TypeError('scheduleRevision must be a valid unsigned BIGINT revision');
  }
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(normalized) || BigInt(normalized) > MAX_UNSIGNED_BIGINT) {
    throw new TypeError('scheduleRevision must be a valid unsigned BIGINT revision');
  }
  return normalized;
}

function persistedInstant(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid persisted Date`);
  }
  return value.getTime();
}

function readClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Delivery clock must return a valid Date');
  }
  return new Date(value.getTime());
}

function plainRow(row) {
  return typeof row?.get === 'function' ? row.get({ plain: true }) : row;
}

function outcome(code, extra = {}) {
  return { outcome: code, ...extra };
}

function validationOutcome(code, extra = {}) {
  return outcome(code, { failureCategory: FAILURE_CATEGORY.NON_DELIVERY, ...extra });
}

function isReminderUniqueConflict(error) {
  if (!(error instanceof UniqueConstraintError)) return false;
  const constraint = error.constraint || error.parent?.constraint || error.original?.constraint;
  if (constraint === REMINDER_UNIQUE_CONSTRAINT) return true;
  const fields = Object.keys(error.fields || {});
  return fields.length === 1 && REMINDER_UNIQUE_FIELDS.has(fields[0]);
}

function sameId(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function notificationMatches(notification, { reminder, appointmentId, recipientUserId }) {
  if (!notification) return false;
  return notification.type === 'appointment_reminder'
    && notification.title === REMINDER_TITLE
    && notification.message === REMINDER_MESSAGE
    && sameId(notification.userId, recipientUserId)
    && sameId(notification.relatedAppointmentId, appointmentId)
    && sameId(notification.appointmentReminderId, reminder.appointmentReminderId)
    && notification.reminderScheduledStartUtc instanceof Date
    && notification.reminderScheduledStartUtc.getTime() === persistedInstant(
      reminder.scheduledStartUtc,
      'Reminder scheduledStartUtc'
    );
}

function createAppointmentReminderDeliveryService({ Appointment, AppointmentReminder, Patient, Notification, sequelize, clock = () => new Date() }) {
  if (!Appointment || !AppointmentReminder || !Patient || !Notification || typeof sequelize?.transaction !== 'function') {
    throw new TypeError('Appointment, AppointmentReminder, Patient, Notification, and a transaction provider are required');
  }
  if (typeof clock !== 'function') throw new TypeError('Delivery clock must be a function');

  function normalizeClaim(rawClaim) {
    const claim = plainRow(rawClaim);
    const normalized = {
      appointmentId: databaseId(claim?.appointmentId, 'appointmentId'),
      reminderId: databaseId(claim?.reminderId, 'reminderId'),
      patientId: databaseId(claim?.patientId, 'patientId'),
      recipientUserId: databaseId(claim?.recipientUserId, 'recipientUserId'),
      scheduleRevision: revisionValue(claim?.scheduleRevision),
      claimToken: claim?.claimToken,
    };
    if (typeof normalized.claimToken !== 'string' || !UUID_PATTERN.test(normalized.claimToken)) {
      throw new TypeError('claimToken must be a UUID v4');
    }
    return normalized;
  }

  async function lockRows(claim, transaction) {
    if (!transaction?.LOCK?.UPDATE) throw new TypeError('Reminder delivery requires an UPDATE-locked transaction');
    const appointment = await Appointment.findByPk(claim.appointmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!appointment) return { appointment: null, reminder: null, notification: null };

    const reminder = await AppointmentReminder.findOne({
      where: { appointmentId: claim.appointmentId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reminder) return { appointment, reminder: null, notification: null };

    const notification = await Notification.findOne({
      where: { appointmentReminderId: reminder.appointmentReminderId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return { appointment, reminder, notification };
  }

  async function ownershipMatches(appointment, reminder, claim, transaction) {
    if (!sameId(appointment.patientId, reminder.patientId)) return false;
    const patient = await Patient.findByPk(appointment.patientId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!patient || !patient.userId) return false;

    let patientId;
    let recipientUserId;
    try {
      patientId = databaseId(patient.patientId, 'patientId');
      recipientUserId = databaseId(patient.userId, 'recipientUserId');
    } catch {
      return false;
    }

    if (patientId !== databaseId(appointment.patientId, 'appointment.patientId')) return false;
    if (patientId !== claim.patientId || recipientUserId !== claim.recipientUserId) return false;
    return reminder.idempotencyKey === buildReminderIdempotencyKey(claim.appointmentId, recipientUserId);
  }

  async function checkDeliveryState({ claim, appointment, reminder, notification, transaction, now }) {
    if (!appointment) return validationOutcome('appointment_missing');
    if (!reminder || !sameId(reminder.appointmentReminderId, claim.reminderId)) {
      return validationOutcome('reminder_missing_or_replaced');
    }

    if (reminder.state === 'delivered') {
      const ownershipValid = await ownershipMatches(appointment, reminder, claim, transaction);
      const notificationValid = ownershipValid && notificationMatches(notification, {
        reminder,
        appointmentId: claim.appointmentId,
        recipientUserId: claim.recipientUserId,
      });
      const deliveredAtValid = reminder.deliveredAtUtc instanceof Date
        && Number.isFinite(reminder.deliveredAtUtc.getTime());
      return notificationValid && deliveredAtValid
        ? outcome('already_delivered', { reminderId: claim.reminderId })
        : validationOutcome('inconsistent_delivery_state', { reminderId: claim.reminderId });
    }
    if (reminder.state !== 'pending') return validationOutcome('not_pending', { reminderId: claim.reminderId });

    if (!sameId(reminder.claimToken, claim.claimToken)
      || revisionValue(reminder.scheduleRevision) !== claim.scheduleRevision) {
      return validationOutcome('stale_claim', { reminderId: claim.reminderId });
    }

    if (notification) return validationOutcome('inconsistent_delivery_state', { reminderId: claim.reminderId });
    if (!await ownershipMatches(appointment, reminder, claim, transaction)) {
      return validationOutcome('claim_ownership_mismatch', { reminderId: claim.reminderId });
    }

    const hasToken = reminder.claimToken !== null && reminder.claimToken !== undefined;
    const hasLease = reminder.leaseExpiresAtUtc !== null && reminder.leaseExpiresAtUtc !== undefined;
    if (!hasToken || !hasLease || !UUID_PATTERN.test(reminder.claimToken)) {
      return validationOutcome('invalid_claim_state', { reminderId: claim.reminderId });
    }
    const leaseExpiry = persistedInstant(reminder.leaseExpiresAtUtc, 'Reminder leaseExpiresAtUtc');
    if (leaseExpiry <= now.getTime()) return validationOutcome('lease_expired', { reminderId: claim.reminderId });
    if (leaseExpiry - now.getTime() > MAX_CLAIM_LEASE_MS) {
      return validationOutcome('invalid_claim_state', { reminderId: claim.reminderId });
    }

    const attemptCount = reminder.attemptCount;
    if (!Number.isInteger(attemptCount) || attemptCount < 0 || attemptCount > MAX_REMINDER_ATTEMPTS) {
      throw new TypeError('Reminder attempt count is invalid');
    }
    if (attemptCount >= MAX_REMINDER_ATTEMPTS) return validationOutcome('attempts_exhausted', { reminderId: claim.reminderId });

    if (!ELIGIBLE_STATUSES.has(appointment.status)) return validationOutcome('appointment_ineligible', { reminderId: claim.reminderId });
    const scheduledStart = persistedInstant(appointment.scheduledStart, 'Appointment scheduledStart');
    const snapshotStart = persistedInstant(reminder.scheduledStartUtc, 'Reminder scheduledStartUtc');
    if (snapshotStart !== scheduledStart) return validationOutcome('schedule_snapshot_mismatch', { reminderId: claim.reminderId });
    if (scheduledStart <= now.getTime()) return validationOutcome('appointment_started', { reminderId: claim.reminderId });

    const dueAt = persistedInstant(reminder.dueAtUtc, 'Reminder dueAtUtc');
    const nextAttemptAt = persistedInstant(reminder.nextAttemptAtUtc, 'Reminder nextAttemptAtUtc');
    const policyOutcome = evaluatePendingReminder({
      appointment,
      expectedAppointmentStart: reminder.scheduledStartUtc,
      dueAt: reminder.dueAtUtc,
    }, { clock: () => now });
    if (policyOutcome !== 'deliver' || dueAt > now.getTime() || nextAttemptAt > now.getTime()) {
      return validationOutcome('not_due', { reminderId: claim.reminderId });
    }

    return outcome('eligible', {
      reminderId: claim.reminderId,
      scheduledStart,
    });
  }

  async function deliverInTransaction(claim, transaction, markWriteAttempted) {
    const rows = await lockRows(claim, transaction);
    const now = readClock(clock);
    const state = await checkDeliveryState({ ...rows, claim, transaction, now });
    if (state.outcome === 'already_delivered') return state;
    if (state.outcome !== 'eligible') return state;

    const { appointment, reminder } = rows;
    markWriteAttempted();
    await Notification.create({
      userId: claim.recipientUserId,
      type: 'appointment_reminder',
      title: REMINDER_TITLE,
      message: REMINDER_MESSAGE,
      relatedAppointmentId: claim.appointmentId,
      appointmentReminderId: reminder.appointmentReminderId,
      reminderScheduledStartUtc: new Date(reminder.scheduledStartUtc.getTime()),
    }, { transaction });

    const deliveredAt = readClock(clock);
    if (deliveredAt.getTime() >= state.scheduledStart) {
      const error = new Error('Appointment started during reminder delivery');
      error.code = DELIVERY_CROSSED_START;
      throw error;
    }
    Object.assign(reminder, {
      state: 'delivered',
      attemptCount: reminder.attemptCount + 1,
      lastAttemptAtUtc: deliveredAt,
      deliveredAtUtc: deliveredAt,
      claimToken: null,
      leaseExpiresAtUtc: null,
      outcomeCode: 'delivered',
    });
    await reminder.save({ transaction });
    if (readClock(clock).getTime() >= state.scheduledStart) {
      const error = new Error('Appointment started during reminder delivery');
      error.code = DELIVERY_CROSSED_START;
      throw error;
    }
    return outcome('delivered', { reminderId: claim.reminderId });
  }

  // Reconciliation is read-only: it never repairs a partial notification/reminder state.
  async function reconcile(claim, uncertain = false) {
    try {
      return await sequelize.transaction(async (transaction) => {
        const rows = await lockRows(claim, transaction);
        if (!rows.appointment || !rows.reminder) {
          return outcome('uncertain_commit_outcome', { failureCategory: FAILURE_CATEGORY.UNCERTAIN });
        }
        const now = readClock(clock);
        const state = await checkDeliveryState({ ...rows, claim, transaction, now });
        if (state.outcome === 'already_delivered') return state;
        if (state.outcome === 'eligible') {
          return outcome('not_committed_retryable', {
            failureCategory: FAILURE_CATEGORY.UNCERTAIN,
            reminderId: claim.reminderId,
            retryAfterUtc: new Date(rows.reminder.leaseExpiresAtUtc.getTime()),
          });
        }
        if (state.outcome === 'inconsistent_delivery_state') return state;
        if (uncertain) return outcome('uncertain_commit_outcome', { failureCategory: FAILURE_CATEGORY.UNCERTAIN });
        return state;
      });
    } catch {
      return outcome('uncertain_commit_outcome', { failureCategory: FAILURE_CATEGORY.UNCERTAIN });
    }
  }

  async function deliverClaim(rawClaim) {
    const claim = normalizeClaim(rawClaim);
    let callbackCompleted = false;
    let writeAttempted = false;
    try {
      return await sequelize.transaction(async (transaction) => {
        const result = await deliverInTransaction(claim, transaction, () => { writeAttempted = true; });
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      if (error?.code === DELIVERY_CROSSED_START) {
        return validationOutcome('appointment_started', { reminderId: claim.reminderId });
      }
      if (isReminderUniqueConflict(error)) return reconcile(claim);
      if (callbackCompleted && writeAttempted) return reconcile(claim, true);
      if (writeAttempted) {
        // The managed callback rejected after a write began, so Sequelize never
        // reached commit. Only this path is safe for immediate attempt accounting.
        return outcome('definitively_not_committed', {
          failureCategory: FAILURE_CATEGORY.NOT_COMMITTED,
          failureCode: 'delivery_failed',
          reminderId: claim.reminderId,
        });
      }
      if (VALIDATION_ERROR_NAMES.has(error?.name)) {
        return validationOutcome('non_delivery_validation_failure', { reminderId: claim.reminderId });
      }
      throw error;
    }
  }

  return Object.freeze({ deliverClaim });
}

module.exports = { createAppointmentReminderDeliveryService };
