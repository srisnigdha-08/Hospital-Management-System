const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAppointmentReminderLifecycle } = require('../src/services/appointmentReminderLifecycle.service');

const NOW = new Date('2026-01-01T00:00:00.000Z');
const START_A = new Date('2026-01-03T12:00:00.000Z');
const START_B = new Date('2026-01-05T18:00:00.000Z');
const clock = () => new Date(NOW);
const transaction = { LOCK: { UPDATE: 'UPDATE' } };

function appointmentFixture({ start = START_A, status = 'scheduled', patientId = 71 } = {}) {
  const persisted = { appointmentId: 42, patientId, status, scheduledStart: new Date(start) };
  const appointment = {
    appointmentId: 42,
    patientId,
    status,
    scheduledStart: new Date('2026-01-04T00:00:00.000Z'),
    async reload(options) {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      Object.assign(this, persisted, { scheduledStart: new Date(persisted.scheduledStart) });
      return this;
    },
  };
  return { appointment, persisted };
}

function reminderFixture(overrides = {}) {
  return {
    appointmentId: 42,
    patientId: 71,
    idempotencyKey: 'appointment-reminder:v1:42:9001',
    scheduledStartUtc: new Date(START_A),
    dueAtUtc: new Date('2026-01-02T12:00:00.000Z'),
    nextAttemptAtUtc: new Date('2026-01-02T12:00:00.000Z'),
    scheduleRevision: '1',
    state: 'pending',
    attemptCount: 0,
    claimToken: 'synthetic-claim',
    leaseExpiresAtUtc: new Date('2026-01-02T12:01:00.000Z'),
    lastAttemptAtUtc: null,
    outcomeCode: null,
    async save(options) {
      assert.equal(options.transaction, transaction);
      return this;
    },
    ...overrides,
  };
}

function harness({ persistedReminder = null, patient = { patientId: 71, userId: 9001 }, failCreate = false } = {}) {
  const calls = { patientLookups: [], reminderLookups: [], created: [] };
  const AppointmentReminder = {
    async findOne(options) {
      calls.reminderLookups.push(options);
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return persistedReminder;
    },
    async create(values, options) {
      assert.equal(options.transaction, transaction);
      if (failCreate) throw new Error('synthetic reminder insert failure');
      const created = reminderFixture(values);
      calls.created.push(created);
      return created;
    },
  };
  const Patient = {
    async findByPk(patientId, options) {
      calls.patientLookups.push({ patientId, options });
      assert.equal(options.transaction, transaction);
      return patient;
    },
  };
  return {
    lifecycle: createAppointmentReminderLifecycle({ AppointmentReminder, Patient, clock }),
    calls,
  };
}

describe('appointment reminder lifecycle service (database-free fakes)', () => {
  test('enrolls one pending reminder from the reloaded appointment and its patient account', async () => {
    const { appointment } = appointmentFixture();
    const { lifecycle, calls } = harness();
    const reminder = await lifecycle.enrollCreatedAppointment(appointment, transaction);

    assert.equal(calls.created.length, 1);
    assert.equal(calls.patientLookups[0].patientId, 71);
    assert.equal(reminder.appointmentId, 42);
    assert.equal(reminder.patientId, 71);
    assert.equal(reminder.idempotencyKey, 'appointment-reminder:v1:42:9001');
    assert.equal(reminder.scheduledStartUtc.toISOString(), START_A.toISOString());
    assert.equal(reminder.dueAtUtc.toISOString(), '2026-01-02T12:00:00.000Z');
    assert.equal(reminder.nextAttemptAtUtc.toISOString(), reminder.dueAtUtc.toISOString());
    assert.equal(reminder.state, 'pending');
    assert.equal(reminder.scheduleRevision, 1);
    assert.equal(reminder.attemptCount, 0);
    assert.equal(reminder.claimToken, null);
  });

  test('normalizes the reminder snapshot from the persisted appointment start to whole seconds', async () => {
    const { appointment, persisted } = appointmentFixture();
    persisted.scheduledStart = new Date('2026-01-03T12:00:00.789Z');
    const { lifecycle } = harness();
    const reminder = await lifecycle.enrollCreatedAppointment(appointment, transaction);
    assert.equal(appointment.scheduledStart.toISOString(), '2026-01-03T12:00:00.000Z');
    assert.equal(reminder.scheduledStartUtc.toISOString(), '2026-01-03T12:00:00.000Z');
    assert.equal(reminder.dueAtUtc.toISOString(), '2026-01-02T12:00:00.000Z');
  });

  test('does not enroll an appointment that has started or is terminal', async () => {
    for (const [status, start] of [
      ['scheduled', new Date('2025-12-31T23:59:59.000Z')],
      ['cancelled', START_A], ['completed', START_A], ['no_show', START_A],
    ]) {
      const { appointment, persisted } = appointmentFixture({ status, start });
      const { lifecycle, calls } = harness();
      assert.equal(await lifecycle.enrollCreatedAppointment(appointment, transaction), null);
      assert.equal(calls.patientLookups.length, 0);
      assert.equal(calls.created.length, 0);
      Object.assign(persisted, { status });
    }
  });

  test('uses the persisted patient relationship rather than any request-supplied identity', async () => {
    const { appointment } = appointmentFixture({ patientId: 72 });
    const { lifecycle, calls } = harness({ patient: { patientId: 72, userId: 9002 } });
    appointment.requestPatientId = 999;
    const reminder = await lifecycle.enrollCreatedAppointment(appointment, transaction);
    assert.equal(calls.patientLookups[0].patientId, 72);
    assert.equal(reminder.patientId, 72);
    assert.equal(reminder.idempotencyKey, 'appointment-reminder:v1:42:9002');
  });

  test('repeated creation enrollment returns the existing row without re-arming it', async () => {
    const existing = reminderFixture({
      state: 'delivered',
      deliveredAtUtc: new Date('2026-01-02T12:00:00.000Z'),
      claimToken: null,
      leaseExpiresAtUtc: null,
    });
    const { appointment } = appointmentFixture();
    const { lifecycle, calls } = harness({ persistedReminder: existing });
    assert.equal(await lifecycle.enrollCreatedAppointment(appointment, transaction), existing);
    assert.equal(existing.state, 'delivered');
    assert.equal(existing.scheduleRevision, '1');
    assert.equal(calls.created.length, 0);
  });

  test('rescheduling a pending reminder A to B to A advances revision and preserves attempts', async () => {
    const reminder = reminderFixture({
      attemptCount: 2,
      nextAttemptAtUtc: new Date('2026-01-02T13:00:00.000Z'),
    });
    const { appointment, persisted } = appointmentFixture();
    const { lifecycle } = harness({ persistedReminder: reminder });

    persisted.scheduledStart = new Date(START_B);
    await lifecycle.replacePendingSchedule(appointment, transaction);
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.scheduledStartUtc.toISOString(), START_B.toISOString());
    assert.equal(reminder.attemptCount, 2);
    assert.equal(reminder.nextAttemptAtUtc.toISOString(), '2026-01-04T18:00:00.000Z');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);

    persisted.scheduledStart = new Date(START_A);
    await lifecycle.replacePendingSchedule(appointment, transaction);
    assert.equal(reminder.scheduleRevision, '3');
    assert.equal(reminder.scheduledStartUtc.toISOString(), START_A.toISOString());
    assert.equal(reminder.attemptCount, 2);
    assert.equal(reminder.idempotencyKey, 'appointment-reminder:v1:42:9001');
  });

  test('does not re-arm delivered or other non-pending reminders', async () => {
    for (const state of ['delivered', 'cancelled', 'skipped', 'failed']) {
      const reminder = reminderFixture({ state, claimToken: null, leaseExpiresAtUtc: null });
      const before = { ...reminder };
      const { appointment, persisted } = appointmentFixture();
      const { lifecycle } = harness({ persistedReminder: reminder });
      persisted.scheduledStart = new Date(START_B);
      assert.equal(await lifecycle.replacePendingSchedule(appointment, transaction), reminder);
      assert.equal(reminder.scheduledStartUtc.getTime(), before.scheduledStartUtc.getTime());
      assert.equal(reminder.state, state);
      assert.equal(reminder.scheduleRevision, before.scheduleRevision);
    }
  });

  test('invalidates pending reminders for cancellation, completion, and no-show', async () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      const reminder = reminderFixture({ attemptCount: 3 });
      const { appointment } = appointmentFixture();
      const { lifecycle } = harness({ persistedReminder: reminder });
      await lifecycle.invalidatePending(appointment, status, transaction);
      assert.equal(reminder.state, 'cancelled');
      assert.equal(reminder.scheduleRevision, '2');
      assert.equal(reminder.claimToken, null);
      assert.equal(reminder.leaseExpiresAtUtc, null);
      assert.equal(reminder.attemptCount, 3);
      assert.equal(reminder.outcomeCode, `appointment_${status}`);

      await lifecycle.invalidatePending(appointment, status, transaction);
      assert.equal(reminder.scheduleRevision, '2');
    }
  });

  test('missing reminders are a safe no-op for reschedule and terminal transitions', async () => {
    const { appointment, persisted } = appointmentFixture();
    const { lifecycle } = harness();
    assert.equal(await lifecycle.replacePendingSchedule(appointment, transaction), null);
    persisted.scheduledStart = new Date(START_B);
    assert.equal(await lifecycle.invalidatePending(appointment, 'completed', transaction), null);
  });

  test('a start that becomes ineligible while rescheduling is skipped and its claim is cleared', async () => {
    const reminder = reminderFixture();
    const { appointment, persisted } = appointmentFixture();
    const { lifecycle } = harness({ persistedReminder: reminder });
    persisted.scheduledStart = new Date('2025-12-31T23:59:59.000Z');
    await lifecycle.replacePendingSchedule(appointment, transaction);
    assert.equal(reminder.state, 'skipped');
    assert.equal(reminder.outcomeCode, 'appointment_started');
    assert.equal(reminder.scheduledStartUtc.toISOString(), '2025-12-31T23:59:59.000Z');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);
  });

  test('preserves the attempt budget and skips when the retained backoff has no pre-start window', async () => {
    const reminder = reminderFixture({
      attemptCount: 4,
      scheduledStartUtc: new Date(START_B),
      nextAttemptAtUtc: new Date('2026-01-03T12:00:00.000Z'),
    });
    const { appointment, persisted } = appointmentFixture();
    const { lifecycle } = harness({ persistedReminder: reminder });
    persisted.scheduledStart = new Date('2026-01-03T12:00:00.000Z');
    await lifecycle.replacePendingSchedule(appointment, transaction);
    assert.equal(reminder.state, 'skipped');
    assert.equal(reminder.outcomeCode, 'no_retry_before_appointment');
    assert.equal(reminder.attemptCount, 4);

    const exhausted = reminderFixture({ attemptCount: 5 });
    const second = harness({ persistedReminder: exhausted });
    const { appointment: nextAppointment, persisted: nextPersisted } = appointmentFixture();
    nextPersisted.scheduledStart = new Date(START_B);
    await second.lifecycle.replacePendingSchedule(nextAppointment, transaction);
    assert.equal(exhausted.state, 'failed');
    assert.equal(exhausted.outcomeCode, 'attempts_exhausted');
    assert.equal(exhausted.attemptCount, 5);
  });

  test('rejects inconsistent patient ownership and propagates reminder failures for transaction rollback', async () => {
    const mismatch = reminderFixture({ patientId: 999 });
    const { appointment } = appointmentFixture();
    const mismatchHarness = harness({ persistedReminder: mismatch });
    await assert.rejects(mismatchHarness.lifecycle.replacePendingSchedule(appointment, transaction), /patient does not match/);

    const { appointment: newAppointment } = appointmentFixture();
    const failureHarness = harness({ failCreate: true });
    let transactionRolledBack = false;
    let appointmentWriteVisible = false;
    const fakeTransaction = async (callback) => {
      try {
        return await callback(transaction);
      } catch (error) {
        appointmentWriteVisible = false;
        transactionRolledBack = true;
        throw error;
      }
    };
    await assert.rejects(fakeTransaction(async (tx) => {
      appointmentWriteVisible = true;
      await failureHarness.lifecycle.enrollCreatedAppointment(newAppointment, tx);
    }), /synthetic reminder insert failure/);
    assert.equal(transactionRolledBack, true);
    assert.equal(appointmentWriteVisible, false);
  });

  test('refuses reminder writes without an update-locked transaction', async () => {
    const { appointment } = appointmentFixture();
    const { lifecycle } = harness();
    await assert.rejects(lifecycle.enrollCreatedAppointment(appointment, {}), /transaction with an UPDATE lock/);
  });
});

test('appointment lifecycle controllers call reminder changes within their existing transactions (source contract)', () => {
  const appointmentSource = fs.readFileSync(path.resolve(__dirname, '../src/controllers/appointment.controller.js'), 'utf8');
  const medicalRecordSource = fs.readFileSync(path.resolve(__dirname, '../src/controllers/medicalRecord.controller.js'), 'utf8');

  for (const method of [
    'enrollCreatedAppointment',
    'replacePendingSchedule',
    "invalidatePending(lockedAppointment, 'cancelled', t)",
    'invalidatePending(appointment, status, t)',
  ]) {
    const callIndex = appointmentSource.indexOf(method);
    const lastTransactionStart = appointmentSource.lastIndexOf('sequelize.transaction', callIndex);
    const possibleEnds = ['\n    );', '\n  ));'].map((ending) => {
      const index = appointmentSource.indexOf(ending, lastTransactionStart);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    });
    const transactionEnd = Math.min(...possibleEnds);
    assert.ok(callIndex > lastTransactionStart && callIndex < transactionEnd, `${method} must execute in its lifecycle transaction`);
  }

  const completionCall = medicalRecordSource.indexOf("invalidatePending(appointment, 'completed', t)");
  const completionUpdate = medicalRecordSource.indexOf("Appointment.update({ status: 'completed' }");
  const transactionStart = medicalRecordSource.lastIndexOf('sequelize.transaction', completionCall);
  const transactionEnd = medicalRecordSource.indexOf('\n  });', transactionStart);
  assert.ok(completionCall > completionUpdate && completionCall < transactionEnd);
});
