const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  REMINDER_LEAD_TIME_MS,
  MAX_REMINDER_ATTEMPTS,
  calculateReminderDueAt,
  isReminderStatusEligible,
  evaluatePendingReminder,
  buildReminderIdempotencyKey,
  retryAtAfterFailure,
} = require('../src/utils/appointmentReminderPolicy');

function fixedClock(value) {
  const timestamp = new Date(value).getTime();
  return () => new Date(timestamp);
}

describe('appointment reminder scheduling policy (database-free)', () => {
  test('schedules standard reminders exactly 24 absolute hours before start', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const dueAt = calculateReminderDueAt(
      { status: 'scheduled', scheduledStart: '2026-01-03T12:00:00.000Z' },
      { clock: fixedClock(now) },
    );

    assert.equal(dueAt.toISOString(), '2026-01-02T12:00:00.000Z');
    assert.equal(new Date('2026-01-03T12:00:00.000Z') - dueAt, REMINDER_LEAD_TIME_MS);
  });

  test('schedules an appointment booked inside the 24-hour window immediately', () => {
    const now = '2026-01-02T08:00:00.000Z';
    const dueAt = calculateReminderDueAt(
      { status: 'scheduled', scheduledStart: '2026-01-02T20:00:00.000Z' },
      { clock: fixedClock(now) },
    );

    assert.equal(dueAt.toISOString(), now);
  });

  test('does not schedule a reminder when the appointment has already started', () => {
    assert.equal(
      calculateReminderDueAt(
        { status: 'confirmed', scheduledStart: '2026-01-02T07:59:59.999Z' },
        { clock: fixedClock('2026-01-02T08:00:00.000Z') },
      ),
      null,
    );
  });

  test('only scheduled and confirmed appointments are eligible', () => {
    assert.equal(isReminderStatusEligible('scheduled'), true);
    assert.equal(isReminderStatusEligible('confirmed'), true);
    for (const status of ['cancelled', 'completed', 'no_show']) {
      assert.equal(isReminderStatusEligible(status), false, `${status} must not be eligible`);
      assert.equal(
        calculateReminderDueAt(
          { status, scheduledStart: '2026-01-03T12:00:00.000Z' },
          { clock: fixedClock('2026-01-01T00:00:00.000Z') },
        ),
        null,
      );
    }
  });

  test('invalidates a pending reminder after rescheduling and evaluates the replacement time', () => {
    const oldStart = '2026-01-03T12:00:00.000Z';
    const newStart = '2026-01-05T18:00:00.000Z';
    const appointment = { status: 'scheduled', scheduledStart: newStart };
    const now = '2026-01-04T00:00:00.000Z';

    assert.equal(
      evaluatePendingReminder(
        { appointment, expectedAppointmentStart: oldStart, dueAt: '2026-01-02T12:00:00.000Z' },
        { clock: fixedClock(now) },
      ),
      'stale',
    );
    assert.equal(
      calculateReminderDueAt(appointment, { clock: fixedClock(now) }).toISOString(),
      '2026-01-04T18:00:00.000Z',
    );
    assert.equal(
      evaluatePendingReminder(
        { appointment, expectedAppointmentStart: newStart, dueAt: '2026-01-04T18:00:00.000Z' },
        { clock: fixedClock(now) },
      ),
      'not_due',
    );
  });

  test('cancels pending reminders for cancelled, completed, and no-show appointments', () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      assert.equal(
        evaluatePendingReminder(
          {
            appointment: { status, scheduledStart: '2026-01-03T12:00:00.000Z' },
            expectedAppointmentStart: '2026-01-03T12:00:00.000Z',
            dueAt: '2026-01-02T12:00:00.000Z',
          },
          { clock: fixedClock('2026-01-02T12:00:00.000Z') },
        ),
        'cancel',
        `${status} must cancel pending reminders`,
      );
    }
  });

  test('delivers overdue reminders after downtime only while the appointment is still in the future', () => {
    const dueAt = '2026-01-02T12:00:00.000Z';
    const now = '2026-01-03T11:59:00.000Z';

    assert.equal(
      evaluatePendingReminder(
        {
          appointment: { status: 'confirmed', scheduledStart: '2026-01-03T12:00:00.000Z' },
          expectedAppointmentStart: '2026-01-03T12:00:00.000Z',
          dueAt,
        },
        { clock: fixedClock(now) },
      ),
      'deliver',
    );
    assert.equal(
      evaluatePendingReminder(
        {
          appointment: { status: 'confirmed', scheduledStart: '2026-01-03T11:59:00.000Z' },
          expectedAppointmentStart: '2026-01-03T11:59:00.000Z',
          dueAt,
        },
        { clock: fixedClock(now) },
      ),
      'skip_started',
    );
  });

  test('keeps due-time arithmetic absolute across midnight and DST transitions', () => {
    const clock = fixedClock('2026-03-01T00:00:00.000Z');
    const newYork = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const springStart = new Date('2026-03-09T04:00:00.000Z');
    const springDue = calculateReminderDueAt(
      { status: 'scheduled', scheduledStart: springStart },
      { clock },
    );
    assert.equal(springDue.toISOString(), '2026-03-08T04:00:00.000Z');
    assert.equal(newYork.format(springDue), 'Mar 7, 2026, 11:00 PM');
    assert.equal(newYork.format(springStart), 'Mar 9, 2026, 12:00 AM');
    assert.equal(springStart - springDue, REMINDER_LEAD_TIME_MS);

    const fallStart = new Date('2026-11-02T05:00:00.000Z');
    const fallDue = calculateReminderDueAt(
      { status: 'scheduled', scheduledStart: fallStart },
      { clock },
    );
    assert.equal(fallDue.toISOString(), '2026-11-01T05:00:00.000Z');
    assert.equal(newYork.format(fallDue), 'Nov 1, 2026, 1:00 AM');
    assert.equal(newYork.format(fallStart), 'Nov 2, 2026, 12:00 AM');
    assert.equal(fallStart - fallDue, REMINDER_LEAD_TIME_MS);
  });

  test('builds a stable patient-scoped idempotency key across retries and reschedules', () => {
    const first = buildReminderIdempotencyKey(42, 9001);
    const retry = buildReminderIdempotencyKey('42', '9001');
    assert.equal(first, 'appointment-reminder:v1:42:9001');
    assert.equal(retry, first);
  });

  test('uses bounded exponential retry timing with no more than five attempts', () => {
    const failedAt = '2026-01-01T00:00:00.000Z';
    const expectedMinutes = [1, 2, 4, 8];

    for (let attempt = 1; attempt < MAX_REMINDER_ATTEMPTS; attempt += 1) {
      const retryAt = retryAtAfterFailure(attempt, { clock: fixedClock(failedAt) });
      assert.equal(retryAt.getTime(), new Date(failedAt).getTime() + expectedMinutes[attempt - 1] * 60_000);
    }
    assert.equal(retryAtAfterFailure(MAX_REMINDER_ATTEMPTS, { clock: fixedClock(failedAt) }), null);
  });

  test('the exact 24-hour boundary is due immediately without changing the lead time', () => {
    const now = '2026-01-02T12:00:00.000Z';
    const appointment = { status: 'scheduled', scheduledStart: '2026-01-03T12:00:00.000Z' };
    assert.equal(calculateReminderDueAt(appointment, { clock: fixedClock(now) }).toISOString(), now);
  });

  test('eligibility begins at due-time equality and ends at appointment-start equality', () => {
    const input = {
      appointment: { status: 'confirmed', scheduledStart: '2026-01-03T12:00:00.000Z' },
      expectedAppointmentStart: '2026-01-03T12:00:00.000Z',
      dueAt: '2026-01-02T12:00:00.000Z',
    };
    const decisions = [
      ['2026-01-02T11:59:59.999Z', 'not_due'],
      ['2026-01-02T12:00:00.000Z', 'deliver'],
      ['2026-01-03T11:59:59.999Z', 'deliver'],
      ['2026-01-03T12:00:00.000Z', 'skip_started'],
      ['2026-01-03T12:00:00.001Z', 'skip_started'],
    ];
    for (const [now, expected] of decisions) {
      assert.equal(evaluatePendingReminder(input, { clock: fixedClock(now) }), expected, now);
    }
    assert.equal(calculateReminderDueAt(input.appointment, {
      clock: fixedClock(input.appointment.scheduledStart),
    }), null);
  });

  test('a short-notice appointment one millisecond in the future is eligible now', () => {
    const clock = fixedClock('2026-01-02T12:00:00.000Z');
    const appointment = { status: 'scheduled', scheduledStart: '2026-01-02T12:00:00.001Z' };
    const dueAt = calculateReminderDueAt(appointment, { clock });
    assert.equal(dueAt.toISOString(), clock().toISOString());
    assert.equal(evaluatePendingReminder({
      appointment, expectedAppointmentStart: appointment.scheduledStart, dueAt,
    }, { clock }), 'deliver');
  });

  test('equivalent explicit offsets, Date objects, and epoch milliseconds identify the same instant', () => {
    const start = '2026-01-03T12:00:00.000Z';
    for (const scheduledStart of [
      start, '2026-01-03T17:30:00+05:30', '2026-01-03T07:00:00-05:00',
      '2026-01-03T12:00Z', new Date(start), Date.parse(start),
    ]) {
      const appointment = { status: 'scheduled', scheduledStart };
      const dueAt = calculateReminderDueAt(appointment, { clock: fixedClock('2026-01-01T00:00:00Z') });
      assert.equal(dueAt.toISOString(), '2026-01-02T12:00:00.000Z');
      assert.equal(evaluatePendingReminder({ appointment, expectedAppointmentStart: start, dueAt }, {
        clock: fixedClock('2026-01-02T12:00:00Z'),
      }), 'deliver');
    }
  });

  test('rejects invalid, ambiguous, normalized-invalid, and out-of-range appointment instants', () => {
    const invalid = [
      undefined, null, true, {}, new Date(NaN), NaN, Infinity, -Infinity,
      8_640_000_000_000_001, -8_640_000_000_000_001, 1.5,
      '', '2026-01-03', '2026-01-03T12:00:00', '2026-01-03T12:00:00.000',
      'January 3, 2026 12:00:00Z', '2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z',
      '2026-04-31T12:00:00Z', '2026-13-01T12:00:00Z', '2026-01-00T12:00:00Z',
      '2026-01-03T24:00:00Z', '2026-01-03T12:60:00Z', '2026-01-03T12:00:60Z',
      '2026-01-03T12:00:00+24:00', '2026-01-03T12:00:00+05:60',
      '2026-01-03T12:00:00.0001Z', '2026-01-03T12:00:00Z ',
    ];
    for (const scheduledStart of invalid) {
      assert.throws(() => calculateReminderDueAt({ status: 'scheduled', scheduledStart }, {
        clock: fixedClock('2026-01-01T00:00:00Z'),
      }), /scheduledStart must be a valid absolute timestamp/, String(scheduledStart));
    }
  });

  test('accepts leap-day instants without calendar normalization', () => {
    assert.equal(calculateReminderDueAt({
      status: 'scheduled', scheduledStart: '2028-02-29T12:00:00+05:30',
    }, { clock: fixedClock('2028-02-01T00:00:00Z') }).toISOString(), '2028-02-28T06:30:00.000Z');
  });

  test('validates the injected clock and pending reminder timestamps', () => {
    const appointment = { status: 'scheduled', scheduledStart: '2026-01-03T12:00:00Z' };
    assert.throws(() => calculateReminderDueAt(appointment, { clock: null }), /clock must be a function/);
    for (const value of [new Date(NaN), Infinity, '2026-01-01T00:00:00', '2026-02-30T00:00:00Z']) {
      assert.throws(() => calculateReminderDueAt(appointment, { clock: () => value }), /clock value must be a valid absolute timestamp/);
    }
    for (const field of ['expectedAppointmentStart', 'dueAt']) {
      const input = { appointment, expectedAppointmentStart: appointment.scheduledStart, dueAt: '2026-01-02T12:00:00Z' };
      input[field] = '2026-01-02T12:00:00';
      assert.throws(() => evaluatePendingReminder(input, { clock: fixedClock('2026-01-02T12:00:00Z') }),
        new RegExp(`${field} must be a valid absolute timestamp`));
    }
  });

  test('missing appointments and unknown statuses fail closed', () => {
    for (const appointment of [null, undefined, { status: 'unknown' }, { status: 'Scheduled' }]) {
      const clock = () => { throw new Error('Ineligible input must not reach the clock'); };
      assert.equal(calculateReminderDueAt(appointment, { clock }), null);
      assert.equal(evaluatePendingReminder({ appointment }, { clock }), 'cancel');
    }
  });

  test('local midnight and both occurrences of a fall-back hour remain absolute instants', () => {
    const clock = fixedClock('2026-01-01T00:00:00Z');
    const samples = [
      ['2026-03-09T00:00:00-04:00', '2026-03-08T04:00:00.000Z'],
      ['2026-11-01T01:30:00-04:00', '2026-10-31T05:30:00.000Z'],
      ['2026-11-01T01:30:00-05:00', '2026-10-31T06:30:00.000Z'],
      ['2026-06-02T00:00:00+05:30', '2026-05-31T18:30:00.000Z'],
    ];
    for (const [scheduledStart, expected] of samples) {
      const dueAt = calculateReminderDueAt({ status: 'scheduled', scheduledStart }, { clock });
      assert.equal(dueAt.toISOString(), expected);
      assert.equal(Date.parse(scheduledStart) - dueAt.getTime(), REMINDER_LEAD_TIME_MS);
    }
  });

  test('appointment-aware retries must fall strictly before the appointment start', () => {
    const now = '2026-01-02T12:00:00.000Z';
    const clock = fixedClock(now);
    for (const [index, minutes] of [1, 2, 4, 8].entries()) {
      const retryAt = Date.parse(now) + minutes * 60_000;
      assert.equal(retryAtAfterFailure(index + 1, { clock, scheduledStart: retryAt + 1 }).getTime(), retryAt);
      for (const scheduledStart of [retryAt, retryAt - 1, Date.parse(now), Date.parse(now) - 1]) {
        assert.equal(retryAtAfterFailure(index + 1, { clock, scheduledStart }), null);
      }
    }
    assert.equal(retryAtAfterFailure(5, { clock, scheduledStart: '2026-01-03T12:00:00Z' }), null);
  });

  test('retry arithmetic remains absolute across a DST transition', () => {
    assert.equal(retryAtAfterFailure(1, {
      clock: fixedClock('2026-03-08T01:59:30-05:00'),
      scheduledStart: '2026-03-08T03:10:00-04:00',
    }).toISOString(), '2026-03-08T07:00:30.000Z');
  });

  test('rejects invalid retry counts, ambiguous retry cutoffs, and timestamp overflow', () => {
    for (const count of [0, -1, 6, 1.5, '1', null, undefined, NaN, Infinity]) {
      assert.throws(() => retryAtAfterFailure(count, { clock: fixedClock('2026-01-01T00:00:00Z') }),
        /failedAttempt must be between 1 and 5/);
    }
    assert.throws(() => retryAtAfterFailure(1, {
      clock: fixedClock('2026-01-01T00:00:00Z'), scheduledStart: '2026-01-03T12:00:00',
    }), /scheduledStart must be a valid absolute timestamp/);
    assert.throws(() => retryAtAfterFailure(1, { clock: () => 8_640_000_000_000_000 }),
      /retryAt must be a valid absolute timestamp/);
  });

  test('idempotency keys retain exact large identifiers and separate appointments and patients', () => {
    assert.equal(buildReminderIdempotencyKey('18446744073709551615', '9007199254740993'),
      'appointment-reminder:v1:18446744073709551615:9007199254740993');
    assert.equal(buildReminderIdempotencyKey(Number.MAX_SAFE_INTEGER, 9001),
      buildReminderIdempotencyKey(String(Number.MAX_SAFE_INTEGER), '9001'));
    assert.notEqual(buildReminderIdempotencyKey(42, 9001), buildReminderIdempotencyKey(43, 9001));
    assert.notEqual(buildReminderIdempotencyKey(42, 9001), buildReminderIdempotencyKey(42, 9002));
  });

  test('rejects invalid, lossy, non-canonical, and out-of-range identifiers in either key position', () => {
    for (const invalid of [
      0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, undefined, true, {},
      '', '0', '-1', '+1', '01', ' 1', '1 ', '1.0', '1e3', '1:2',
      '18446744073709551616', '999999999999999999999999999999',
    ]) {
      assert.throws(() => buildReminderIdempotencyKey(invalid, 9001), /appointmentId must be a positive integer/);
      assert.throws(() => buildReminderIdempotencyKey(42, invalid), /patientUserId must be a positive integer/);
    }
  });

  test('policy decisions do not mutate appointment or Date inputs', () => {
    const start = new Date('2026-01-03T12:00:00Z');
    const appointment = Object.freeze({ status: 'confirmed', scheduledStart: start });
    const now = new Date('2026-01-02T12:00:00Z');
    const dueAt = calculateReminderDueAt(appointment, { clock: () => now });
    assert.equal(evaluatePendingReminder({ appointment, expectedAppointmentStart: start, dueAt }, { clock: () => now }), 'deliver');
    retryAtAfterFailure(1, { clock: () => now, scheduledStart: start });
    assert.equal(start.toISOString(), '2026-01-03T12:00:00.000Z');
    assert.equal(now.toISOString(), '2026-01-02T12:00:00.000Z');
  });
});
