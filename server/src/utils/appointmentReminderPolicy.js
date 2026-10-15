const REMINDER_LEAD_TIME_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDER_ATTEMPTS = 5;
const MAX_CLAIM_LEASE_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000];
const REMINDER_ELIGIBLE_STATUSES = new Set(['scheduled', 'confirmed']);
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const OFFSET_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

function toInstant(value, label) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if (Number.isFinite(new Date(value).getTime())) return value;
  } else if (typeof value === 'string') {
    const match = OFFSET_TIMESTAMP.exec(value);
    if (match) {
      const timestamp = Date.parse(value);
      // Date.parse normalizes dates such as February 30; reject that normalization.
      const calendarDate = new Date(`${match[1]}T00:00:00Z`);
      if (
        Number.isFinite(timestamp)
        && Number.isFinite(calendarDate.getTime())
        && calendarDate.toISOString().slice(0, 10) === match[1]
      ) return timestamp;
    }
  }

  throw new TypeError(`${label} must be a valid absolute timestamp`);
}

function readClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  return toInstant(clock(), 'clock value');
}

function isReminderStatusEligible(status) {
  return REMINDER_ELIGIBLE_STATUSES.has(status);
}

function calculateReminderDueAt(appointment, { clock = () => new Date() } = {}) {
  if (!appointment || !isReminderStatusEligible(appointment.status)) return null;

  const now = readClock(clock);
  const scheduledStart = toInstant(appointment.scheduledStart, 'scheduledStart');
  if (scheduledStart <= now) return null;

  return new Date(Math.max(scheduledStart - REMINDER_LEAD_TIME_MS, now));
}

function evaluatePendingReminder(
  { appointment, expectedAppointmentStart, dueAt },
  { clock = () => new Date() } = {},
) {
  if (!appointment || !isReminderStatusEligible(appointment.status)) return 'cancel';

  const now = readClock(clock);
  const scheduledStart = toInstant(appointment.scheduledStart, 'scheduledStart');
  if (scheduledStart <= now) return 'skip_started';

  if (toInstant(expectedAppointmentStart, 'expectedAppointmentStart') !== scheduledStart) {
    return 'stale';
  }

  if (toInstant(dueAt, 'dueAt') > now) return 'not_due';
  return 'deliver';
}

function normalizeId(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive integer`);
    }
    return String(value);
  }

  if (
    typeof value === 'string'
    && value.length <= 20
    && /^[1-9]\d*$/.test(value)
    && BigInt(value) <= MAX_UNSIGNED_BIGINT
  ) return value;
  throw new TypeError(`${label} must be a positive integer within the unsigned BIGINT range`);
}

function buildReminderIdempotencyKey(appointmentId, patientUserId) {
  const appointmentKey = normalizeId(appointmentId, 'appointmentId');
  const patientKey = normalizeId(patientUserId, 'patientUserId');
  return `appointment-reminder:v1:${appointmentKey}:${patientKey}`;
}

function retryAtAfterFailure(failedAttempt, { clock = () => new Date(), scheduledStart } = {}) {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1 || failedAttempt > MAX_REMINDER_ATTEMPTS) {
    throw new TypeError(`failedAttempt must be between 1 and ${MAX_REMINDER_ATTEMPTS}`);
  }
  // Omitting scheduledStart preserves delay-only calculations; appointment retries must supply it.
  const start = scheduledStart === undefined ? null : toInstant(scheduledStart, 'scheduledStart');
  if (failedAttempt === MAX_REMINDER_ATTEMPTS) return null;

  const retryAt = toInstant(readClock(clock) + RETRY_DELAYS_MS[failedAttempt - 1], 'retryAt');
  if (start !== null && retryAt >= start) return null;
  return new Date(retryAt);
}

module.exports = {
  REMINDER_LEAD_TIME_MS,
  MAX_REMINDER_ATTEMPTS,
  MAX_CLAIM_LEASE_MS,
  calculateReminderDueAt,
  isReminderStatusEligible,
  evaluatePendingReminder,
  buildReminderIdempotencyKey,
  retryAtAfterFailure,
};
