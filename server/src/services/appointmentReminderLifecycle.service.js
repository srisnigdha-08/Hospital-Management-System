const {
  MAX_REMINDER_ATTEMPTS,
  buildReminderIdempotencyKey,
  calculateReminderDueAt,
  isReminderStatusEligible,
} = require('../utils/appointmentReminderPolicy');
const { parseAppointmentTimestamp } = require('../utils/appointmentTimestamp');

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const TERMINAL_OUTCOMES = Object.freeze({
  cancelled: 'appointment_cancelled',
  completed: 'appointment_completed',
  no_show: 'appointment_no_show',
});

function requireTransaction(transaction) {
  if (!transaction || !transaction.LOCK || transaction.LOCK.UPDATE === undefined) {
    throw new TypeError('A transaction with an UPDATE lock is required for reminder lifecycle changes');
  }
}

function persistedStart(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(Math.floor(value.getTime() / 1000) * 1000);
  }
  if (typeof value === 'string') return parseAppointmentTimestamp(value);
  throw new TypeError('Persisted appointment start must be a valid database timestamp');
}

function incrementRevision(value) {
  let current;
  if (typeof value === 'number' && Number.isSafeInteger(value)) current = BigInt(value);
  else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) current = BigInt(value);
  else if (typeof value === 'bigint') current = value;
  else throw new TypeError('Reminder schedule revision is invalid');

  if (current < 1n || current >= MAX_UNSIGNED_BIGINT) {
    throw new RangeError('Reminder schedule revision cannot be incremented safely');
  }
  return (current + 1n).toString();
}

function attemptCountOf(reminder) {
  const value = reminder.attemptCount;
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_ATTEMPTS) {
    throw new TypeError('Reminder attempt count is invalid');
  }
  return value;
}

function timeValue(value, field) {
  const timestamp = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(timestamp)) throw new TypeError(`Reminder ${field} is invalid`);
  return timestamp;
}

function saveReminder(reminder, changes, transaction) {
  Object.assign(reminder, changes);
  return reminder.save({ transaction });
}

function createAppointmentReminderLifecycle({ AppointmentReminder, Patient, clock = () => new Date() }) {
  if (!AppointmentReminder || !Patient) {
    throw new TypeError('AppointmentReminder and Patient models are required');
  }

  async function reloadAppointment(appointment, transaction) {
    if (!appointment || typeof appointment.reload !== 'function') {
      throw new TypeError('A persisted appointment instance is required');
    }
    await appointment.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (!appointment.appointmentId || !appointment.patientId || !appointment.status) {
      throw new TypeError('Persisted appointment identity or lifecycle fields are missing');
    }
    appointment.scheduledStart = persistedStart(appointment.scheduledStart);
    return appointment;
  }

  async function findReminder(appointmentId, transaction) {
    return AppointmentReminder.findOne({
      where: { appointmentId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  async function patientForAppointment(appointment, transaction) {
    const patient = await Patient.findByPk(appointment.patientId, { transaction });
    if (!patient || !patient.userId) {
      throw new Error('Cannot enroll an appointment reminder without its persisted patient account');
    }
    return patient;
  }

  async function enrollCreatedAppointment(appointment, transaction) {
    requireTransaction(transaction);
    await reloadAppointment(appointment, transaction);

    const dueAt = calculateReminderDueAt(appointment, { clock });
    if (!dueAt) return null;

    const patient = await patientForAppointment(appointment, transaction);
    const idempotencyKey = buildReminderIdempotencyKey(appointment.appointmentId, patient.userId);
    const existing = await findReminder(appointment.appointmentId, transaction);
    if (existing) {
      if (String(existing.patientId) !== String(appointment.patientId)) {
        throw new Error('Existing appointment reminder patient does not match the persisted appointment');
      }
      return existing;
    }

    return AppointmentReminder.create({
      appointmentId: appointment.appointmentId,
      patientId: appointment.patientId,
      idempotencyKey,
      scheduledStartUtc: appointment.scheduledStart,
      dueAtUtc: dueAt,
      nextAttemptAtUtc: dueAt,
      scheduleRevision: 1,
      state: 'pending',
      attemptCount: 0,
      claimToken: null,
      leaseExpiresAtUtc: null,
      lastAttemptAtUtc: null,
      deliveredAtUtc: null,
      outcomeCode: null,
    }, { transaction });
  }

  async function replacePendingSchedule(appointment, transaction) {
    requireTransaction(transaction);
    await reloadAppointment(appointment, transaction);
    const reminder = await findReminder(appointment.appointmentId, transaction);
    if (!reminder || reminder.state !== 'pending') return reminder;

    if (String(reminder.patientId) !== String(appointment.patientId)) {
      throw new Error('Pending appointment reminder patient does not match the persisted appointment');
    }
    const patient = await patientForAppointment(appointment, transaction);
    const idempotencyKey = buildReminderIdempotencyKey(appointment.appointmentId, patient.userId);
    const currentStart = timeValue(reminder.scheduledStartUtc, 'scheduled start snapshot');
    const nextStart = appointment.scheduledStart.getTime();
    if (currentStart === nextStart) return reminder;

    const scheduleRevision = incrementRevision(reminder.scheduleRevision);
    const dueAt = calculateReminderDueAt(appointment, { clock });
    const now = clock();
    const nowDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (!Number.isFinite(nowDate.getTime())) throw new TypeError('Reminder clock returned an invalid timestamp');

    if (!dueAt) {
      const isStarted = isReminderStatusEligible(appointment.status);
      return saveReminder(reminder, {
        idempotencyKey,
        scheduledStartUtc: appointment.scheduledStart,
        dueAtUtc: nowDate,
        nextAttemptAtUtc: nowDate,
        scheduleRevision,
        state: isStarted ? 'skipped' : 'cancelled',
        claimToken: null,
        leaseExpiresAtUtc: null,
        outcomeCode: isStarted ? 'appointment_started' : (TERMINAL_OUTCOMES[appointment.status] || 'appointment_ineligible'),
      }, transaction);
    }

    const attempts = attemptCountOf(reminder);
    const nextAttemptAtUtc = attempts === 0
      ? dueAt
      : new Date(Math.max(timeValue(reminder.nextAttemptAtUtc, 'next attempt time'), dueAt.getTime()));
    const noRetryWindow = attempts > 0 && nextAttemptAtUtc.getTime() >= nextStart;
    const attemptsExhausted = attempts >= MAX_REMINDER_ATTEMPTS;

    return saveReminder(reminder, {
      idempotencyKey,
      scheduledStartUtc: appointment.scheduledStart,
      dueAtUtc: dueAt,
      nextAttemptAtUtc,
      scheduleRevision,
      state: attemptsExhausted ? 'failed' : (noRetryWindow ? 'skipped' : 'pending'),
      claimToken: null,
      leaseExpiresAtUtc: null,
      outcomeCode: attemptsExhausted
        ? 'attempts_exhausted'
        : (noRetryWindow ? 'no_retry_before_appointment' : reminder.outcomeCode),
    }, transaction);
  }

  async function invalidatePending(appointment, terminalStatus, transaction) {
    requireTransaction(transaction);
    if (!appointment || !appointment.appointmentId) {
      throw new TypeError('A persisted appointment is required to invalidate its reminder');
    }
    const outcomeCode = TERMINAL_OUTCOMES[terminalStatus];
    if (!outcomeCode) throw new TypeError('A terminal appointment status is required');

    const reminder = await findReminder(appointment.appointmentId, transaction);
    if (!reminder || reminder.state !== 'pending') return reminder;

    return saveReminder(reminder, {
      scheduleRevision: incrementRevision(reminder.scheduleRevision),
      state: 'cancelled',
      claimToken: null,
      leaseExpiresAtUtc: null,
      outcomeCode,
    }, transaction);
  }

  return { enrollCreatedAppointment, replacePendingSchedule, invalidatePending };
}

module.exports = { createAppointmentReminderLifecycle };
