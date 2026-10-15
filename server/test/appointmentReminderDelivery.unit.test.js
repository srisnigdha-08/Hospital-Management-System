'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { UniqueConstraintError } = require('sequelize');
const { createAppointmentReminderDeliveryService } = require('../src/services/appointmentReminderDelivery.service');

const NOW = new Date('2026-04-16T12:00:00.000Z');
const START = new Date('2026-04-17T12:00:00.000Z');
const START_B = new Date('2026-04-18T12:00:00.000Z');
const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';
const UPDATE_LOCK = 'UPDATE';

function reminderFixture(overrides = {}) {
  return {
    appointmentReminderId: '801',
    appointmentId: '42',
    patientId: '71',
    idempotencyKey: 'appointment-reminder:v1:42:9001',
    scheduledStartUtc: new Date(START),
    dueAtUtc: new Date(NOW),
    nextAttemptAtUtc: new Date(NOW),
    scheduleRevision: '1',
    state: 'pending',
    attemptCount: 0,
    claimToken: TOKEN_A,
    leaseExpiresAtUtc: new Date(NOW.getTime() + 60_000),
    lastAttemptAtUtc: null,
    deliveredAtUtc: null,
    outcomeCode: null,
    async save({ transaction }) {
      assert.equal(transaction.LOCK.UPDATE, UPDATE_LOCK);
      return this;
    },
    ...overrides,
  };
}

function notificationFixture(reminder = reminderFixture(), overrides = {}) {
  return {
    notificationId: '301',
    userId: '9001',
    type: 'appointment_reminder',
    title: 'Appointment reminder',
    message: 'You have an appointment coming up. Please review your appointment details.',
    relatedAppointmentId: '42',
    appointmentReminderId: reminder.appointmentReminderId,
    reminderScheduledStartUtc: new Date(reminder.scheduledStartUtc),
    isRead: false,
    ...overrides,
  };
}

function makeHarness({
  reminder: reminderOverrides = {},
  appointment: appointmentOverrides = {},
  patient: patientOverrides = {},
  existingNotification = null,
  clock = () => new Date(NOW),
  failNotificationOnce = false,
  notificationError = null,
  failReminderSaveOnce = false,
  raceWithUniqueConflict = false,
  externalDeliveredOnUniqueConflict = false,
  externalNotificationOverrides = {},
  commitFailure = null,
  failReconciliationRead = false,
} = {}) {
  const events = [];
  const reminder = reminderFixture(reminderOverrides);
  const appointment = {
    appointmentId: '42',
    patientId: '71',
    status: 'scheduled',
    scheduledStart: new Date(START),
    ...appointmentOverrides,
  };
  const patient = { patientId: '71', userId: '9001', ...patientOverrides };
  const committedNotifications = existingNotification ? [existingNotification] : [];
  const externalNotifications = [];
  let nextNotificationId = 302;
  let transactionNumber = 0;
  let notificationFailurePending = failNotificationOnce;
  let saveFailurePending = failReminderSaveOnce;
  let uniqueRacePending = raceWithUniqueConflict;
  let commitFailurePending = commitFailure;

  function clone(value) {
    return value instanceof Date ? new Date(value) : value;
  }

  function reminderSnapshot() {
    return Object.fromEntries(Object.entries(reminder).map(([key, value]) => [key, clone(value)]));
  }

  function restore(snapshot, notificationCount) {
    for (const key of Object.keys(reminder)) {
      if (!Object.hasOwn(snapshot, key)) delete reminder[key];
    }
    Object.assign(reminder, snapshot);
    committedNotifications.splice(notificationCount);
    if (externalDeliveredOnUniqueConflict && externalNotifications.length > 0) {
      Object.assign(reminder, {
        state: 'delivered',
        attemptCount: 1,
        deliveredAtUtc: new Date(NOW),
        claimToken: null,
        leaseExpiresAtUtc: null,
      });
    }
  }

  const Appointment = {
    async findByPk(id, options) {
      events.push('appointment-lock');
      assert.equal(String(id), appointment.appointmentId);
      assert.equal(options.transaction.LOCK.UPDATE, UPDATE_LOCK);
      assert.equal(options.lock, UPDATE_LOCK);
      if (failReconciliationRead && options.transaction.number > 1) throw new Error('synthetic reconciliation read failure');
      return appointment;
    },
  };
  const AppointmentReminder = {
    async findOne(options) {
      events.push('reminder-lock');
      assert.equal(String(options.where.appointmentId), appointment.appointmentId);
      assert.equal(options.transaction.LOCK.UPDATE, UPDATE_LOCK);
      assert.equal(options.lock, UPDATE_LOCK);
      return reminder;
    },
  };
  const Patient = {
    async findByPk(id, options) {
      events.push('patient-read');
      assert.equal(String(id), String(appointment.patientId));
      assert.ok(options.transaction);
      assert.equal(options.lock, UPDATE_LOCK);
      return patient;
    },
  };
  const Notification = {
    async findOne(options) {
      events.push('notification-read');
      assert.equal(String(options.where.appointmentReminderId), reminder.appointmentReminderId);
      assert.ok(options.transaction);
      assert.equal(options.lock, UPDATE_LOCK);
      return committedNotifications.find((row) => String(row.appointmentReminderId) === reminder.appointmentReminderId)
        || externalNotifications.find((row) => String(row.appointmentReminderId) === reminder.appointmentReminderId)
        || null;
    },
    async create(values, options) {
      events.push('notification-create');
      assert.ok(options.transaction);
      events.push(`notification-create-tx:${options.transaction.number}`);
      assert.equal(values.type, 'appointment_reminder');
      assert.equal(values.userId, '9001');
      assert.equal(values.relatedAppointmentId, '42');
      assert.equal(values.appointmentReminderId, reminder.appointmentReminderId);
      assert.equal(values.reminderScheduledStartUtc.getTime(), START.getTime());
      assert.doesNotMatch(values.message, /diagnosis|prescription|blood|clinical/i);
      if (uniqueRacePending) {
        uniqueRacePending = false;
        externalNotifications.push(notificationFixture(reminder, { notificationId: '999', ...externalNotificationOverrides }));
        throw new UniqueConstraintError({ fields: { appointment_reminder_id: reminder.appointmentReminderId } });
      }
      if (notificationFailurePending) {
        notificationFailurePending = false;
        throw new Error('synthetic notification insert failure');
      }
      if (notificationError) throw notificationError;
      const row = { notificationId: String(nextNotificationId++), ...values, isRead: false };
      committedNotifications.push(row);
      return row;
    },
  };
  reminder.save = async ({ transaction }) => {
    events.push('reminder-save');
    assert.ok(transaction);
    events.push(`reminder-save-tx:${transaction.number}`);
    if (saveFailurePending) {
      saveFailurePending = false;
      throw new Error('synthetic reminder update failure');
    }
    return reminder;
  };

  const sequelize = {
    async transaction(callback) {
      const number = ++transactionNumber;
      const transaction = { number, LOCK: { UPDATE: UPDATE_LOCK } };
      const snapshot = reminderSnapshot();
      const notificationCount = committedNotifications.length;
      events.push(`transaction-start:${number}`);
      let failedAfterCallbackForCommit = false;
      try {
        const result = await callback(transaction);
        events.push(`transaction-callback-complete:${number}`);
        if (commitFailurePending) {
          const mode = commitFailurePending;
          commitFailurePending = null;
          if (mode === 'rolled-back') restore(snapshot, notificationCount);
          failedAfterCallbackForCommit = true;
          throw new Error('synthetic commit outcome unknown');
        }
        return result;
      } catch (error) {
        if (!failedAfterCallbackForCommit) restore(snapshot, notificationCount);
        throw error;
      }
    },
  };
  const service = createAppointmentReminderDeliveryService({ Appointment, AppointmentReminder, Patient, Notification, sequelize, clock });
  const claim = {
    appointmentId: '42',
    reminderId: '801',
    patientId: '71',
    recipientUserId: '9001',
    claimToken: TOKEN_A,
    scheduleRevision: '1',
  };
  return { service, reminder, appointment, patient, claim, events, committedNotifications, externalNotifications };
}

describe('appointment reminder atomic delivery (synthetic database-free fakes)', () => {
  test('creates one generic patient notification and marks the reminder delivered in the same transaction', async () => {
    const h = makeHarness();
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'delivered');
    assert.equal(h.committedNotifications.length, 1);
    assert.equal(h.reminder.state, 'delivered');
    assert.equal(h.reminder.attemptCount, 1, 'successful delivery consumes one lifetime attempt');
    assert.equal(h.reminder.lastAttemptAtUtc.toISOString(), NOW.toISOString());
    assert.equal(h.reminder.deliveredAtUtc.toISOString(), NOW.toISOString());
    assert.equal(h.reminder.claimToken, null);
    assert.equal(h.reminder.leaseExpiresAtUtc, null);
    assert.deepEqual(h.events.slice(1, 4), ['appointment-lock', 'reminder-lock', 'notification-read']);
    assert.ok(h.events.indexOf('patient-read') < h.events.indexOf('notification-create'));
    assert.ok(h.events.includes('notification-create'));
    assert.ok(h.events.includes('reminder-save'));
    const notificationTransaction = h.events.find((event) => event.startsWith('notification-create-tx:')).split(':')[1];
    const reminderTransaction = h.events.find((event) => event.startsWith('reminder-save-tx:')).split(':')[1];
    assert.equal(notificationTransaction, reminderTransaction);
  });

  test('notification creation and reminder update are both in the managed transaction', async () => {
    const h = makeHarness();
    await h.service.deliverClaim(h.claim);
    assert.equal(h.events.filter((event) => event.startsWith('transaction-start')).length, 1);
    assert.ok(h.events.indexOf('notification-create') < h.events.indexOf('reminder-save'));
    assert.equal(h.events.filter((event) => event.endsWith('appointment-lock')).length, 1);
    assert.equal(h.events.filter((event) => event.endsWith('reminder-lock')).length, 1);
  });

  test('notification insertion failure is classified as definitely uncommitted after fake rollback', async () => {
    const h = makeHarness({ failNotificationOnce: true });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'definitively_not_committed');
    assert.equal(result.failureCategory, 'definitively_not_committed');
    assert.equal(result.failureCode, 'delivery_failed');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.reminder.claimToken, TOKEN_A);
    assert.equal(h.reminder.attemptCount, 0);
    assert.equal(h.committedNotifications.length, 0);
  });

  test('reminder update failure is classified as definitely uncommitted after fake rollback of both writes', async () => {
    const h = makeHarness({ failReminderSaveOnce: true });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'definitively_not_committed');
    assert.equal(result.failureCategory, 'definitively_not_committed');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.reminder.claimToken, TOKEN_A);
    assert.equal(h.reminder.attemptCount, 0);
    assert.equal(h.committedNotifications.length, 0);
  });

  test('a repeated call for a delivered reminder reconciles the existing notification without duplicating it', async () => {
    const reminder = reminderFixture({
      state: 'delivered',
      attemptCount: 1,
      claimToken: null,
      leaseExpiresAtUtc: null,
      lastAttemptAtUtc: new Date(NOW),
      deliveredAtUtc: new Date(NOW),
      outcomeCode: 'delivered',
    });
    const h = makeHarness({ reminder, existingNotification: notificationFixture(reminder) });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'already_delivered');
    assert.equal(h.committedNotifications.length, 1);
    assert.equal(h.events.includes('notification-create'), false);
  });

  test('successful delivery preserves lifetime failures and refuses reminders at the attempt limit', async () => {
    const priorAttempts = makeHarness({ reminder: reminderFixture({ attemptCount: 2 }) });
    assert.equal((await priorAttempts.service.deliverClaim(priorAttempts.claim)).outcome, 'delivered');
    assert.equal(priorAttempts.reminder.attemptCount, 3);

    const exhausted = makeHarness({ reminder: reminderFixture({ attemptCount: 5 }) });
    assert.equal((await exhausted.service.deliverClaim(exhausted.claim)).outcome, 'attempts_exhausted');
    assert.equal(exhausted.reminder.attemptCount, 5);
    assert.equal(exhausted.events.includes('notification-create'), false);
  });

  test('a delivered reminder without its matching notification is inconsistent, never repaired blindly', async () => {
    const reminder = reminderFixture({ state: 'delivered', deliveredAtUtc: new Date(NOW), claimToken: null, leaseExpiresAtUtc: null });
    const h = makeHarness({ reminder });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(h.events.includes('notification-create'), false);
  });

  test('a delivered reminder linked to the wrong recipient is inconsistent and never duplicated', async () => {
    const reminder = reminderFixture({ state: 'delivered', attemptCount: 1, claimToken: null, leaseExpiresAtUtc: null, deliveredAtUtc: new Date(NOW) });
    const h = makeHarness({
      reminder,
      existingNotification: notificationFixture(reminder, { userId: '9002' }),
    });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(h.events.includes('notification-create'), false);
    assert.equal(h.committedNotifications.length, 1);

    const sensitiveContent = makeHarness({
      reminder,
      existingNotification: notificationFixture(reminder, { message: 'Synthetic diagnosis details' }),
    });
    assert.equal((await sensitiveContent.service.deliverClaim(sensitiveContent.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(sensitiveContent.events.includes('notification-create'), false);
  });

  test('stale claim tokens and schedule revisions cannot mutate a newer claim', async () => {
    const staleToken = makeHarness({ reminder: reminderFixture({ claimToken: TOKEN_B }) });
    assert.equal((await staleToken.service.deliverClaim(staleToken.claim)).outcome, 'stale_claim');
    assert.equal(staleToken.reminder.claimToken, TOKEN_B);
    assert.equal(staleToken.events.includes('notification-create'), false);

    const staleRevision = makeHarness({ reminder: reminderFixture({ scheduleRevision: '2' }) });
    assert.equal((await staleRevision.service.deliverClaim(staleRevision.claim)).outcome, 'stale_claim');
    assert.equal(staleRevision.reminder.scheduleRevision, '2');
    assert.equal(staleRevision.events.includes('notification-create'), false);
  });

  test('expired lease at equality and not-yet-due reminders are rejected without a notification', async () => {
    const expired = makeHarness({ reminder: reminderFixture({ leaseExpiresAtUtc: new Date(NOW) }) });
    assert.equal((await expired.service.deliverClaim(expired.claim)).outcome, 'lease_expired');

    const notDue = makeHarness({ reminder: reminderFixture({ dueAtUtc: new Date(NOW.getTime() + 1) }) });
    assert.equal((await notDue.service.deliverClaim(notDue.claim)).outcome, 'not_due');
    const oversizedLease = makeHarness({
      reminder: reminderFixture({ leaseExpiresAtUtc: new Date(NOW.getTime() + 5 * 60_000 + 1) }),
    });
    assert.equal((await oversizedLease.service.deliverClaim(oversizedLease.claim)).outcome, 'invalid_claim_state');
    for (const h of [expired, notDue, oversizedLease]) assert.equal(h.events.includes('notification-create'), false);
  });

  test('appointment-start equality, cancellation, completion, and no-show block delivery', async () => {
    const started = makeHarness({
      appointment: { scheduledStart: new Date(NOW) },
      reminder: reminderFixture({ scheduledStartUtc: new Date(NOW) }),
    });
    assert.equal((await started.service.deliverClaim(started.claim)).outcome, 'appointment_started');

    for (const status of ['cancelled', 'completed', 'no_show']) {
      const h = makeHarness({ appointment: { status } });
      assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'appointment_ineligible');
      assert.equal(h.events.includes('notification-create'), false);
    }
    assert.equal(started.events.includes('notification-create'), false);
  });

  test('rechecks the appointment-start boundary around slow transactional writes and rolls them back', async () => {
    for (const crossingCheck of [2, 3]) {
      let clockReads = 0;
      const h = makeHarness({ clock: () => {
        clockReads += 1;
        return new Date(clockReads >= crossingCheck ? START : NOW);
      } });
      assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'appointment_started');
      assert.equal(h.reminder.state, 'pending');
      assert.equal(h.reminder.claimToken, TOKEN_A);
      assert.equal(h.reminder.attemptCount, 0);
      assert.equal(h.committedNotifications.length, 0);
    }
  });

  test('a reschedule that wins the appointment lock fails the old schedule snapshot closed', async () => {
    const h = makeHarness({ appointment: { scheduledStart: new Date(START_B) } });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'schedule_snapshot_mismatch');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.events.includes('notification-create'), false);
    assert.deepEqual(h.events.slice(1, 3), ['appointment-lock', 'reminder-lock']);

    const rescheduled = makeHarness({
      appointment: { scheduledStart: new Date(START_B) },
      reminder: reminderFixture({
        scheduledStartUtc: new Date(START_B),
        scheduleRevision: '2',
        claimToken: null,
        leaseExpiresAtUtc: null,
      }),
    });
    assert.equal((await rescheduled.service.deliverClaim(rescheduled.claim)).outcome, 'stale_claim');
    assert.equal(rescheduled.events.includes('notification-create'), false);

    const cancelled = makeHarness({
      appointment: { status: 'cancelled' },
      reminder: reminderFixture({ state: 'cancelled', scheduleRevision: '2', claimToken: null, leaseExpiresAtUtc: null }),
    });
    assert.equal((await cancelled.service.deliverClaim(cancelled.claim)).outcome, 'not_pending');
    assert.equal(cancelled.events.includes('notification-create'), false);
  });

  test('appointment, reminder, and patient ownership must agree with the claimed recipient', async () => {
    const wrongPatientClaim = makeHarness();
    assert.equal((await wrongPatientClaim.service.deliverClaim({ ...wrongPatientClaim.claim, patientId: '72' })).outcome, 'claim_ownership_mismatch');

    const wrongRecipientClaim = makeHarness();
    assert.equal((await wrongRecipientClaim.service.deliverClaim({ ...wrongRecipientClaim.claim, recipientUserId: '9002' })).outcome, 'claim_ownership_mismatch');

    const wrongPatientRow = makeHarness({ reminder: reminderFixture({ patientId: '72' }) });
    assert.equal((await wrongPatientRow.service.deliverClaim(wrongPatientRow.claim)).outcome, 'claim_ownership_mismatch');

    const changedPatientUser = makeHarness({ patient: { userId: '9002' } });
    assert.equal((await changedPatientUser.service.deliverClaim(changedPatientUser.claim)).outcome, 'claim_ownership_mismatch');
    for (const h of [wrongPatientClaim, wrongRecipientClaim, wrongPatientRow, changedPatientUser]) {
      assert.equal(h.events.includes('notification-create'), false);
    }
  });

  test('an idempotency key inconsistent with the authoritative patient cannot be delivered', async () => {
    const h = makeHarness({ reminder: reminderFixture({ idempotencyKey: 'appointment-reminder:v1:42:9002' }) });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'claim_ownership_mismatch');
    assert.equal(h.events.includes('notification-create'), false);
  });

  test('a pending reminder with an existing linked notification is not marked delivered by inference', async () => {
    const reminder = reminderFixture();
    const h = makeHarness({ reminder, existingNotification: notificationFixture(reminder) });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.events.includes('notification-create'), false);
  });

  test('a named unique-link conflict is reconciled but a pending reminder is not reported delivered', async () => {
    const h = makeHarness({ raceWithUniqueConflict: true });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'inconsistent_delivery_state');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.externalNotifications.length, 1);
    assert.equal(h.committedNotifications.length, 0);
  });

  test('the actual unique-link conflict branch reconciles an externally committed delivery without reinserting', async () => {
    const h = makeHarness({ raceWithUniqueConflict: true, externalDeliveredOnUniqueConflict: true });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'already_delivered');
    assert.equal(h.reminder.state, 'delivered');
    assert.equal(h.externalNotifications.length, 1);
    assert.equal(h.externalNotifications[0].userId, h.claim.recipientUserId);
    assert.equal(h.externalNotifications[0].appointmentReminderId, h.claim.reminderId);
    assert.equal(h.events.filter((event) => event === 'notification-create').length, 1);
    assert.equal(h.events.filter((event) => event.startsWith('transaction-start:')).length, 2);
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'already_delivered');
    assert.equal(h.events.filter((event) => event === 'notification-create').length, 1);
  });

  test('unique-link conflict reconciliation rejects an externally committed notification for another recipient', async () => {
    const h = makeHarness({
      raceWithUniqueConflict: true,
      externalDeliveredOnUniqueConflict: true,
      externalNotificationOverrides: { userId: '9002' },
    });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(h.externalNotifications.length, 1);
    assert.equal(h.events.filter((event) => event === 'notification-create').length, 1);
  });

  test('unique-link conflict reconciliation rejects an externally committed notification with another reminder link', async () => {
    const h = makeHarness({
      raceWithUniqueConflict: true,
      externalDeliveredOnUniqueConflict: true,
      externalNotificationOverrides: { appointmentReminderId: '802' },
    });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'inconsistent_delivery_state');
    assert.equal(h.externalNotifications.length, 1);
    assert.equal(h.events.filter((event) => event === 'notification-create').length, 1);
  });

  test('an unrelated unique-constraint failure is not mistaken for the reminder-link idempotency race', async () => {
    const h = makeHarness({
      notificationError: new UniqueConstraintError({ fields: { notification_id: '301' } }),
    });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'definitively_not_committed');
    assert.equal(result.failureCategory, 'definitively_not_committed');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.committedNotifications.length, 0);
    assert.equal(h.events.filter((event) => event.startsWith('transaction-start')).length, 1);
  });

  test('a transaction rejection after committed writes reconciles to already delivered', async () => {
    const h = makeHarness({ commitFailure: 'committed' });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'already_delivered');
    assert.equal(h.reminder.state, 'delivered');
    assert.equal(h.committedNotifications.length, 1);
    assert.equal(h.events.filter((event) => event === 'transaction-start:2').length, 1);
  });

  test('a transaction rejection after rollback reports retryability without retrying delivery', async () => {
    const h = makeHarness({ commitFailure: 'rolled-back' });
    const result = await h.service.deliverClaim(h.claim);
    assert.equal(result.outcome, 'not_committed_retryable');
    assert.equal(result.retryAfterUtc.toISOString(), h.reminder.leaseExpiresAtUtc.toISOString());
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.committedNotifications.length, 0);
    assert.equal(h.events.filter((event) => event === 'notification-create').length, 1);
  });

  test('unreadable reconciliation after a commit error returns an explicit uncertain outcome', async () => {
    const h = makeHarness({ commitFailure: 'committed', failReconciliationRead: true });
    assert.equal((await h.service.deliverClaim(h.claim)).outcome, 'uncertain_commit_outcome');
    assert.equal(h.committedNotifications.length, 1);
  });

  test('a retryable insertion error is deferred for bounded attempt accounting before another delivery', async () => {
    const h = makeHarness({ failNotificationOnce: true });
    const failed = await h.service.deliverClaim(h.claim);
    assert.equal(failed.outcome, 'definitively_not_committed');
    assert.equal(h.reminder.state, 'pending');
    assert.equal(h.committedNotifications.length, 0);
    assert.equal(h.reminder.attemptCount, 0, 'delivery service leaves attempt accounting to the worker failure recorder');
  });

  test('an old worker cannot overwrite a newer claim or delivered state', async () => {
    const newerClaim = makeHarness({ reminder: reminderFixture({ claimToken: TOKEN_B, scheduleRevision: '2' }) });
    assert.equal((await newerClaim.service.deliverClaim(newerClaim.claim)).outcome, 'stale_claim');
    assert.equal(newerClaim.reminder.claimToken, TOKEN_B);
    assert.equal(newerClaim.reminder.scheduleRevision, '2');

    const delivered = reminderFixture({ state: 'delivered', attemptCount: 1, claimToken: null, leaseExpiresAtUtc: null, deliveredAtUtc: new Date(NOW) });
    const existing = notificationFixture(delivered);
    const alreadyDone = makeHarness({ reminder: delivered, existingNotification: existing });
    assert.equal((await alreadyDone.service.deliverClaim(alreadyDone.claim)).outcome, 'already_delivered');
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.attemptCount, 1);
  });

  test('invalid reminder identifiers, claims, and revisions are rejected before a transaction', async () => {
    const h = makeHarness();
    await assert.rejects(h.service.deliverClaim({ ...h.claim, reminderId: '0' }), /reminderId/);
    await assert.rejects(h.service.deliverClaim({ ...h.claim, claimToken: 'not-a-uuid' }), /claimToken/);
    await assert.rejects(h.service.deliverClaim({ ...h.claim, scheduleRevision: 'bad' }), /scheduleRevision/);
    assert.equal(h.events.some((event) => event.startsWith('transaction-start')), false);
  });
});
