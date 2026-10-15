const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_REMINDER_ATTEMPTS,
  calculateReminderDueAt,
  isReminderStatusEligible,
  evaluatePendingReminder,
  buildReminderIdempotencyKey,
  retryAtAfterFailure,
} = require('../src/utils/appointmentReminderPolicy');

const NOW = '2026-01-02T12:00:00.000Z';
const START_A = '2026-01-03T12:00:00.000Z';
const START_B = '2026-01-04T12:00:00.000Z';
const clockAt = (value) => () => new Date(value);
const appointmentAt = (scheduledStart, status = 'scheduled') => ({ status, scheduledStart });

// Test-only snapshots illustrate future service contracts, not a production persistence API.
// They cannot prove locking, atomicity, uniqueness, or the ordering of real concurrent writes.
function pendingSnapshot(overrides = {}) {
  return {
    state: 'pending',
    expectedAppointmentStart: START_A,
    dueAt: NOW,
    scheduleRevision: '1',
    attemptCount: 2,
    claimToken: 'synthetic-claim-a',
    leaseExpiresAt: '2026-01-02T12:01:00.000Z',
    idempotencyKey: buildReminderIdempotencyKey(42, 9001),
    ...overrides,
  };
}

function replacePendingSnapshot(snapshot, appointment, clock) {
  if (snapshot.state !== 'pending') return snapshot;
  const dueAt = calculateReminderDueAt(appointment, { clock });
  const sameStart = Date.parse(snapshot.expectedAppointmentStart) === Date.parse(appointment.scheduledStart);
  if (dueAt && sameStart) return snapshot;
  return {
    ...snapshot,
    state: dueAt ? 'pending' : (isReminderStatusEligible(appointment.status) ? 'skipped' : 'cancelled'),
    expectedAppointmentStart: appointment.scheduledStart,
    dueAt: dueAt?.toISOString() ?? snapshot.dueAt,
    scheduleRevision: (BigInt(snapshot.scheduleRevision) + 1n).toString(),
    claimToken: null,
    leaseExpiresAt: null,
  };
}

function claimIsEligible(snapshot, work, appointment, clock) {
  const now = clock().getTime();
  const leaseExpiresAt = snapshot.leaseExpiresAt === null ? NaN : Date.parse(snapshot.leaseExpiresAt);
  if (
    snapshot.state !== 'pending'
    || typeof snapshot.claimToken !== 'string' || !snapshot.claimToken
    || snapshot.claimToken !== work.claimToken
    || snapshot.scheduleRevision !== work.scheduleRevision
    || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now
  ) return false;
  return evaluatePendingReminder({ appointment, ...snapshot }, { clock: clockAt(now) }) === 'deliver';
}

describe('future reminder contracts (test-only snapshots; no persistence)', () => {
  test('replacing pending work advances the revision, clears its lease, and preserves lifetime attempts and key', () => {
    const before = Object.freeze(pendingSnapshot());
    const after = replacePendingSnapshot(before, appointmentAt(START_B), clockAt(NOW));
    assert.equal(after.state, 'pending');
    assert.equal(after.expectedAppointmentStart, START_B);
    assert.equal(after.dueAt, '2026-01-03T12:00:00.000Z');
    assert.equal(after.scheduleRevision, '2');
    assert.equal(after.claimToken, null);
    assert.equal(after.leaseExpiresAt, null);
    assert.equal(after.attemptCount, before.attemptCount);
    assert.equal(after.idempotencyKey, before.idempotencyKey);
    assert.equal(before.scheduleRevision, '1');
  });

  test('A to B to A keeps distinct revisions even when timestamp-only eligibility matches again', () => {
    const first = pendingSnapshot();
    const second = replacePendingSnapshot(first, appointmentAt(START_B), clockAt(NOW));
    const third = replacePendingSnapshot(second, appointmentAt(START_A), clockAt(NOW));
    assert.deepEqual([first.scheduleRevision, second.scheduleRevision, third.scheduleRevision], ['1', '2', '3']);
    assert.equal(evaluatePendingReminder({ appointment: appointmentAt(START_A), ...first }, { clock: clockAt(NOW) }), 'deliver');
    const newClaim = { ...third, claimToken: 'synthetic-claim-c', leaseExpiresAt: first.leaseExpiresAt };
    assert.equal(claimIsEligible(newClaim, first, appointmentAt(START_A), clockAt(NOW)), false);
    // Matching the token deliberately isolates the revision check from the token check.
    assert.equal(claimIsEligible(newClaim, { ...first, claimToken: newClaim.claimToken }, appointmentAt(START_A), clockAt(NOW)), false);
    assert.equal(claimIsEligible(newClaim, newClaim, appointmentAt(START_A), clockAt(NOW)), true);
    assert.equal(third.attemptCount, first.attemptCount);
    assert.equal(third.idempotencyKey, first.idempotencyKey);
  });

  test('an unchanged pending schedule does not invalidate its claim or advance the revision', () => {
    const snapshot = pendingSnapshot();
    assert.equal(replacePendingSnapshot(snapshot, appointmentAt('2026-01-03T17:30:00+05:30'), clockAt(NOW)), snapshot);
  });

  test('delivered reminders remain delivered after repeated rescheduling and terminal status changes', () => {
    const snapshot = Object.freeze(pendingSnapshot({ state: 'delivered', claimToken: null, leaseExpiresAt: null }));
    for (const appointment of [appointmentAt(START_B), appointmentAt(START_A), appointmentAt(START_A, 'cancelled')]) {
      assert.equal(replacePendingSnapshot(snapshot, appointment, clockAt(NOW)), snapshot);
      assert.equal(snapshot.state, 'delivered');
      assert.equal(claimIsEligible(snapshot, snapshot, appointment, clockAt(NOW)), false);
    }
  });

  test('no non-pending outcome is re-armed by rescheduling', () => {
    for (const state of ['cancelled', 'skipped', 'failed']) {
      const snapshot = pendingSnapshot({ state, claimToken: null, leaseExpiresAt: null });
      assert.equal(replacePendingSnapshot(snapshot, appointmentAt(START_B), clockAt(NOW)), snapshot);
    }
  });

  test('each terminal appointment status invalidates pending claims without refunding attempts', () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      const before = pendingSnapshot();
      const appointment = appointmentAt(START_A, status);
      const after = replacePendingSnapshot(before, appointment, clockAt(NOW));
      assert.equal(after.state, 'cancelled');
      assert.equal(after.scheduleRevision, '2');
      assert.equal(after.claimToken, null);
      assert.equal(after.leaseExpiresAt, null);
      assert.equal(after.attemptCount, before.attemptCount);
      assert.equal(after.idempotencyKey, before.idempotencyKey);
      assert.equal(claimIsEligible(after, before, appointment, clockAt(NOW)), false);
    }
  });

  test('rescheduling cannot reset the five-attempt lifetime budget', () => {
    let snapshot = pendingSnapshot({ attemptCount: 0, claimToken: null, leaseExpiresAt: null });
    for (let attempt = 1; attempt <= MAX_REMINDER_ATTEMPTS; attempt += 1) {
      // A future durable service must commit this counter increment atomically with claiming.
      snapshot = { ...snapshot, attemptCount: attempt };
      const appointment = appointmentAt(attempt % 2 ? START_B : START_A);
      snapshot = replacePendingSnapshot(snapshot, appointment, clockAt(NOW));
      assert.equal(snapshot.attemptCount, attempt);
      const next = retryAtAfterFailure(snapshot.attemptCount, { clock: clockAt(NOW), scheduledStart: appointment.scheduledStart });
      assert.equal(next === null, attempt === MAX_REMINDER_ATTEMPTS);
    }
    snapshot = replacePendingSnapshot(snapshot, appointmentAt(START_A), clockAt(NOW));
    assert.equal(snapshot.attemptCount, 5);
    assert.equal(retryAtAfterFailure(snapshot.attemptCount, { clock: clockAt(NOW), scheduledStart: START_A }), null);
  });

  test('lease eligibility ends exactly at expiry, even before the appointment starts', () => {
    const snapshot = pendingSnapshot();
    assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt('2026-01-02T12:00:59.999Z')), true);
    assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt(snapshot.leaseExpiresAt)), false);
    assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt('2026-01-02T12:01:00.001Z')), false);
  });

  test('a replacement claim rejects the previous token even with an unchanged revision', () => {
    const old = pendingSnapshot();
    const current = { ...old, claimToken: 'synthetic-claim-b', leaseExpiresAt: '2026-01-02T12:02:00.000Z' };
    const clock = clockAt('2026-01-02T12:01:00.001Z');
    assert.equal(claimIsEligible(current, old, appointmentAt(START_A), clock), false);
    assert.equal(claimIsEligible(current, current, appointmentAt(START_A), clock), true);
  });

  test('missing claims and invalid or missing lease timestamps are not eligible', () => {
    for (const override of [{ claimToken: null }, { claimToken: '' }, { leaseExpiresAt: null }, { leaseExpiresAt: 'invalid' }]) {
      const snapshot = pendingSnapshot(override);
      assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt(NOW)), false);
    }
  });

  test('a current token and revision cannot override the appointment-start boundary', () => {
    const snapshot = pendingSnapshot({ leaseExpiresAt: '2026-01-03T12:01:00.000Z' });
    assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt(START_A)), false);
    assert.equal(claimIsEligible(snapshot, snapshot, appointmentAt(START_A), clockAt('2026-01-03T12:00:00.001Z')), false);
  });
});
