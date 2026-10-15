'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const {
  BATCH_SIZE,
  MAX_CLAIM_LEASE_MS,
  createAppointmentReminderWorkerService,
} = require('../src/services/appointmentReminderWorker.service');

const NOW = new Date('2026-04-16T12:00:00.000Z');
const START = new Date('2026-04-17T12:00:00.000Z');
const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';
const LOCK_UPDATE = 'UPDATE';

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
    claimToken: null,
    leaseExpiresAtUtc: null,
    lastAttemptAtUtc: null,
    deliveredAtUtc: null,
    outcomeCode: null,
    async save({ transaction }) {
      assert.equal(transaction.LOCK.UPDATE, LOCK_UPDATE);
      return this;
    },
    ...overrides,
  };
}

function makeHarness({
  reminder = reminderFixture(),
  appointment = { appointmentId: '42', patientId: '71', status: 'scheduled', scheduledStart: new Date(START) },
  patient = { patientId: '71', userId: '9001' },
  clock = () => new Date(NOW),
  tokenFactory = () => TOKEN_A,
  candidateRows,
  leaseDurationMs = 30_000,
  batchSize,
  respectCurrentState = false,
  saveFailure = false,
  patientReadError = null,
} = {}) {
  const events = [];
  let queryOptions;
  const transaction = { LOCK: { UPDATE: LOCK_UPDATE } };
  const dbReminder = reminder;
  const snapshot = (value) => ({
    appointmentReminderId: value.appointmentReminderId,
    appointmentId: value.appointmentId,
    scheduleRevision: value.scheduleRevision,
    claimToken: value.claimToken,
  });
  const rows = candidateRows ?? [snapshot(dbReminder)];
  const Appointment = {
    async findByPk(id, options) {
      events.push('appointment-lock');
      assert.equal(String(id), String(appointment.appointmentId));
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, LOCK_UPDATE);
      return appointment;
    },
  };
  const AppointmentReminder = {
    async findAll(options) {
      queryOptions = options;
      if (respectCurrentState && dbReminder.state !== 'pending') return [];
      return rows.slice(0, options.limit);
    },
    async findOne(options) {
      events.push('reminder-lock');
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, LOCK_UPDATE);
      assert.equal(String(options.where.appointmentId), String(appointment.appointmentId));
      return dbReminder;
    },
  };
  const Patient = {
    async findByPk(id, options) {
      assert.equal(String(id), String(appointment.patientId));
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, LOCK_UPDATE);
      events.push('patient-lock');
      if (patientReadError) throw patientReadError;
      return patient;
    },
  };
  dbReminder.save = async ({ transaction: saveTransaction }) => {
    assert.equal(saveTransaction, transaction);
    events.push('save');
    if (saveFailure) throw new Error('synthetic write failure');
    return dbReminder;
  };
  const sequelize = {
    async transaction(callback) {
      events.push('transaction-start');
      const before = { ...dbReminder };
      try {
        return await callback(transaction);
      } catch (error) {
        for (const key of Object.keys(dbReminder)) {
          if (!Object.hasOwn(before, key)) delete dbReminder[key];
        }
        Object.assign(dbReminder, before);
        throw error;
      }
    },
  };
  const logger = { warn: (message) => events.push(`warn:${message}`) };
  const service = createAppointmentReminderWorkerService({
    Appointment,
    AppointmentReminder,
    Patient,
    sequelize,
    clock,
    createClaimToken: tokenFactory,
    leaseDurationMs,
    batchSize,
    logger,
    Op,
  });
  return { service, reminder: dbReminder, appointment, events, getQuery: () => queryOptions };
}

describe('appointment reminder worker service (synthetic database-free fakes)', () => {
  test('discovers at most 25 due or expired candidates in deterministic order without locking discovery rows', async () => {
    const candidate = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: null };
    const h = makeHarness({ candidateRows: Array.from({ length: 30 }, () => ({ ...candidate })) });
    const results = await h.service.claimDueBatch();
    assert.equal(results.length, 25);
    const query = h.getQuery();
    assert.equal(query.limit, BATCH_SIZE);
    assert.equal(query.limit, 25);
    assert.deepEqual(query.attributes, ['appointmentReminderId', 'appointmentId', 'scheduleRevision', 'claimToken']);
    assert.deepEqual(query.order, [['nextAttemptAtUtc', 'ASC'], ['appointmentReminderId', 'ASC']]);
    const branches = query.where[Op.or];
    assert.equal(branches.length, 2);
    assert.equal(branches[0].claimToken, null);
    assert.ok(branches[0].nextAttemptAtUtc[Op.lte] instanceof Date);
    assert.ok(branches[1].claimToken[Op.ne] === null);
    assert.ok(branches[1].leaseExpiresAtUtc[Op.lte] instanceof Date);
    assert.equal(query.lock, undefined, 'discovery is advisory and takes no row lock');
  });

  test('accepts a smaller bounded batch and stops claiming when shutdown is requested', async () => {
    const candidate = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: null };
    const h = makeHarness({ candidateRows: Array.from({ length: 5 }, () => ({ ...candidate })), batchSize: 2 });
    const results = await h.service.claimDueBatch();
    assert.equal(results.length, 2);

    const stopped = makeHarness({ candidateRows: [candidate] });
    assert.deepEqual(await stopped.service.claimDueBatch({ shouldStop: () => true }), []);
    assert.equal(stopped.events.includes('appointment-lock'), false);

    const interrupted = makeHarness({ candidateRows: [candidate, { ...candidate, appointmentId: '43' }] });
    let stopChecks = 0;
    const interruptedResults = await interrupted.service.claimDueBatch({ shouldStop: () => ++stopChecks >= 3 });
    assert.equal(interruptedResults.length, 1);
    assert.equal(interrupted.events.filter((event) => event === 'transaction-start').length, 1);
    assert.throws(() => makeHarness({ batchSize: BATCH_SIZE + 1 }), /batchSize/);
  });

  test('isolates malformed candidate identifiers before opening a transaction', async () => {
    const good = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: null };
    const h = makeHarness({ candidateRows: [
      { ...good, appointmentId: 'invalid' },
      good,
    ] });
    const results = await h.service.claimDueBatch();
    assert.deepEqual(results.map(({ outcome }) => outcome), ['candidate_error', 'claimed']);
    assert.equal(h.events.filter((event) => event === 'transaction-start').length, 1);
  });

  test('claims due work under appointment-reminder-patient locks and leaves attempt history unchanged', async () => {
    const h = makeHarness();
    const [result] = await h.service.claimDueBatch();
    assert.equal(result.outcome, 'claimed');
    assert.equal(result.claimToken, TOKEN_A);
    assert.equal(result.scheduleRevision, '1');
    assert.equal(result.patientId, '71');
    assert.equal(result.recipientUserId, '9001');
    assert.equal(h.reminder.claimToken, TOKEN_A);
    assert.equal(h.reminder.leaseExpiresAtUtc.toISOString(), '2026-04-16T12:00:30.000Z');
    assert.equal(h.reminder.attemptCount, 0);
    assert.equal(h.reminder.scheduleRevision, '1');
    assert.deepEqual(h.events.filter((entry) => entry.endsWith('-lock')), ['appointment-lock', 'reminder-lock', 'patient-lock']);
  });

  test('the exact due-time boundary is eligible, while a future retry time is not', async () => {
    const equalDue = makeHarness({ reminder: reminderFixture({ dueAtUtc: NOW, nextAttemptAtUtc: NOW }) });
    assert.equal((await equalDue.service.claimDueBatch())[0].outcome, 'claimed');

    const future = makeHarness({ reminder: reminderFixture({ nextAttemptAtUtc: new Date(NOW.getTime() + 1) }) });
    assert.equal((await future.service.claimDueBatch())[0].outcome, 'not_due');
    assert.equal(future.reminder.claimToken, null);
  });

  test('skips at the appointment-start boundary and cancels each terminal status', async () => {
    const atStart = makeHarness({
      appointment: { appointmentId: '42', patientId: '71', status: 'scheduled', scheduledStart: new Date(NOW) },
      reminder: reminderFixture({ scheduledStartUtc: new Date(NOW) }),
    });
    assert.equal((await atStart.service.claimDueBatch())[0].outcome, 'skipped_started');
    assert.equal(atStart.reminder.state, 'skipped');
    assert.equal(atStart.reminder.claimToken, null);

    for (const status of ['cancelled', 'completed', 'no_show']) {
      const h = makeHarness({ appointment: { appointmentId: '42', patientId: '71', status, scheduledStart: new Date(START) } });
      assert.equal((await h.service.claimDueBatch())[0].outcome, 'cancelled_terminal');
      assert.equal(h.reminder.state, 'cancelled');
      assert.equal(h.reminder.outcomeCode, `appointment_${status}`);
      assert.equal(h.reminder.scheduleRevision, '2');
      assert.equal(h.reminder.claimToken, null);
    }
  });

  test('quarantines a stale start snapshot without repairing it and rejects mismatched patient relationships', async () => {
    const stale = makeHarness({ reminder: reminderFixture({ scheduledStartUtc: new Date('2026-04-18T12:00:00.000Z') }) });
    assert.equal((await stale.service.claimDueBatch())[0].outcome, 'schedule_snapshot_quarantined');
    assert.equal(stale.reminder.claimToken, null);
    assert.equal(stale.reminder.state, 'failed');
    assert.equal(stale.reminder.outcomeCode, 'schedule_snapshot_mismatch');
    assert.equal(stale.reminder.scheduledStartUtc.toISOString(), '2026-04-18T12:00:00.000Z');
    assert.equal(stale.reminder.scheduleRevision, '2');
    assert.ok(stale.events.some((entry) => entry.includes('schedule_snapshot_mismatch')));

    const mismatch = makeHarness({ reminder: reminderFixture({ patientId: '72' }), respectCurrentState: true });
    assert.equal((await mismatch.service.claimDueBatch())[0].outcome, 'patient_relationship_mismatch');
    assert.equal(mismatch.reminder.state, 'failed');
    assert.equal(mismatch.reminder.outcomeCode, 'patient_relationship_mismatch');
    assert.equal(mismatch.reminder.claimToken, null);
    assert.equal(mismatch.reminder.scheduleRevision, '2');
    assert.equal(mismatch.reminder.attemptCount, 0, 'relationship quarantine is not a delivery attempt');
    assert.deepEqual(await mismatch.service.claimDueBatch(), [], 'quarantined rows leave pending candidate discovery');
    assert.equal(mismatch.events.filter((entry) => entry === 'transaction-start').length, 1);
  });

  test('quarantines a reassigned patient account under ordered locks without consuming an attempt or retaining a batch candidate', async () => {
    const reminder = reminderFixture();
    const h = makeHarness({
      reminder,
      patient: { patientId: '71', userId: '9002' },
      respectCurrentState: true,
    });

    assert.equal((await h.service.claimDueBatch())[0].outcome, 'patient_relationship_mismatch');
    assert.deepEqual(h.events.filter((entry) => entry.endsWith('-lock')), [
      'appointment-lock',
      'reminder-lock',
      'patient-lock',
    ]);
    assert.equal(reminder.state, 'failed');
    assert.equal(reminder.outcomeCode, 'patient_relationship_mismatch');
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);
    assert.equal(reminder.attemptCount, 0);

    const repeated = makeHarness({ reminder, respectCurrentState: true });
    assert.deepEqual(await repeated.service.claimDueBatch(), []);
    assert.equal(repeated.events.filter((entry) => entry === 'transaction-start').length, 0);
    assert.equal(repeated.getQuery().where.state, 'pending', 'candidate discovery excludes quarantined rows');
  });

  test('does not quarantine or clear a replacement claim when a reassigned-account candidate is stale', async () => {
    const reminder = reminderFixture({ scheduleRevision: '2', claimToken: TOKEN_B });
    const stale = makeHarness({
      reminder,
      patient: { patientId: '71', userId: '9002' },
      candidateRows: [{ appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: TOKEN_A }],
    });
    assert.equal((await stale.service.claimDueBatch())[0].outcome, 'stale_candidate');
    assert.equal(reminder.state, 'pending');
    assert.equal(reminder.outcomeCode, null);
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.claimToken, TOKEN_B);
    assert.equal(reminder.attemptCount, 0);
    assert.equal(stale.events.includes('patient-lock'), false, 'stale work must not inspect or quarantine the newer relationship state');
    assert.equal(stale.events.includes('save'), false);
  });

  test('propagates transient patient lookup failures without quarantining or consuming an attempt', async () => {
    const reminder = reminderFixture();
    const h = makeHarness({ reminder, patientReadError: new Error('synthetic transient read failure') });

    await assert.rejects(h.service.claimDueBatch(), /synthetic transient read failure/);
    assert.equal(reminder.state, 'pending');
    assert.equal(reminder.outcomeCode, null);
    assert.equal(reminder.scheduleRevision, '1');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.attemptCount, 0);
    assert.equal(h.events.includes('save'), false);
  });

  test('quarantines a patient relationship that becomes invalid before claim validation', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) });
    const h = makeHarness({ reminder, appointment: {
      appointmentId: '42', patientId: '72', status: 'scheduled', scheduledStart: new Date(START),
    } });
    const result = await h.service.validateClaimForDelivery({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1',
    });
    assert.equal(result.outcome, 'patient_relationship_mismatch');
    assert.equal(reminder.state, 'failed');
    assert.equal(reminder.outcomeCode, 'patient_relationship_mismatch');
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.attemptCount, 0);
    assert.deepEqual(h.events.filter((entry) => entry.endsWith('-lock')), ['appointment-lock', 'reminder-lock']);
  });

  test('quarantines an account reassignment during active-claim validation before delivery can proceed', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) });
    const h = makeHarness({ reminder, patient: { patientId: '71', userId: '9002' } });

    const result = await h.service.validateClaimForDelivery({
      appointmentId: '42',
      claimToken: TOKEN_A,
      scheduleRevision: '1',
    });

    assert.equal(result.outcome, 'patient_relationship_mismatch');
    assert.equal(reminder.state, 'failed');
    assert.equal(reminder.outcomeCode, 'patient_relationship_mismatch');
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);
    assert.equal(reminder.attemptCount, 0);
    assert.deepEqual(h.events.filter((entry) => entry.endsWith('-lock')), [
      'appointment-lock',
      'reminder-lock',
      'patient-lock',
    ]);
  });

  test('quarantines a malformed expired claim under ordered locks and does not reconsider the corrupt row', async () => {
    const reminder = reminderFixture({
      claimToken: 'malformed-token',
      leaseExpiresAtUtc: new Date(NOW),
    });
    const candidate = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: 'malformed-token' };
    const h = makeHarness({ reminder, candidateRows: [candidate] });
    const [result] = await h.service.claimDueBatch();

    assert.equal(result.outcome, 'invalid_claim_quarantined');
    assert.deepEqual(h.events.filter((entry) => entry.endsWith('-lock')), ['appointment-lock', 'reminder-lock']);
    assert.equal(reminder.state, 'failed');
    assert.equal(reminder.outcomeCode, 'invalid_claim_state');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(reminder.attemptCount, 0, 'quarantine is not a delivery attempt');

    const repeated = makeHarness({ reminder, candidateRows: [candidate] });
    assert.equal((await repeated.service.claimDueBatch())[0].outcome, 'not_pending');
    assert.equal(repeated.events.filter((entry) => entry === 'save').length, 0);
  });

  test('does not quarantine or overwrite a newer claim when a malformed candidate becomes stale', async () => {
    const reminder = reminderFixture({
      scheduleRevision: '2',
      claimToken: TOKEN_B,
      leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000),
    });
    const oldCandidate = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: 'malformed-token' };
    const h = makeHarness({ reminder, candidateRows: [oldCandidate] });

    assert.equal((await h.service.claimDueBatch())[0].outcome, 'stale_candidate');
    assert.equal(reminder.state, 'pending');
    assert.equal(reminder.claimToken, TOKEN_B);
    assert.equal(reminder.scheduleRevision, '2');
    assert.equal(h.events.includes('save'), false);
  });

  test('an active claim is not duplicated after a concurrent candidate becomes stale', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_B, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) });
    const h = makeHarness({ reminder, candidateRows: [{
      appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: null,
    }] });
    assert.equal((await h.service.claimDueBatch())[0].outcome, 'stale_candidate');
    assert.equal(reminder.claimToken, TOKEN_B);
  });

  test('rejects a candidate from an older schedule revision without changing the current reminder', async () => {
    const reminder = reminderFixture({ scheduleRevision: '3' });
    const h = makeHarness({
      reminder,
      candidateRows: [{ appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '2', claimToken: null }],
    });
    assert.equal((await h.service.claimDueBatch())[0].outcome, 'stale_candidate');
    assert.equal(reminder.scheduleRevision, '3');
    assert.equal(reminder.claimToken, null);
  });

  test('an expired claim consumes one attempt and schedules the one-minute retry', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW) });
    const h = makeHarness({ reminder });
    const [result] = await h.service.claimDueBatch();
    assert.equal(result.outcome, 'expired_claim_retried');
    assert.equal(reminder.attemptCount, 1);
    assert.equal(reminder.lastAttemptAtUtc.toISOString(), NOW.toISOString());
    assert.equal(reminder.nextAttemptAtUtc.toISOString(), '2026-04-16T12:01:00.000Z');
    assert.equal(reminder.claimToken, null);
    assert.equal(reminder.leaseExpiresAtUtc, null);

    const oldCandidate = { appointmentReminderId: '801', appointmentId: '42', scheduleRevision: '1', claimToken: TOKEN_A };
    const repeated = makeHarness({ reminder, candidateRows: [oldCandidate] });
    assert.equal((await repeated.service.claimDueBatch())[0].outcome, 'stale_candidate');
    assert.equal(reminder.attemptCount, 1, 'the same expired token cannot consume another attempt');
  });

  test('expired claims respect the fifth-attempt limit and skip a retry at appointment start', async () => {
    const exhausted = makeHarness({ reminder: reminderFixture({
      attemptCount: 4,
      claimToken: TOKEN_A,
      leaseExpiresAtUtc: new Date(NOW),
    }) });
    assert.equal((await exhausted.service.claimDueBatch())[0].outcome, 'attempts_exhausted');
    assert.equal(exhausted.reminder.attemptCount, 5);
    assert.equal(exhausted.reminder.state, 'failed');

    const noWindow = makeHarness({
      appointment: { appointmentId: '42', patientId: '71', status: 'scheduled', scheduledStart: new Date(NOW.getTime() + 60_000) },
      reminder: reminderFixture({
        scheduledStartUtc: new Date(NOW.getTime() + 60_000),
        claimToken: TOKEN_A,
        leaseExpiresAtUtc: new Date(NOW),
      }),
    });
    assert.equal((await noWindow.service.claimDueBatch())[0].outcome, 'no_retry_before_appointment');
    assert.equal(noWindow.reminder.attemptCount, 1);
    assert.equal(noWindow.reminder.state, 'skipped');
  });

  test('validates a live claim, its ownership, revision, lease, due time, and current schedule without delivering', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) });
    const h = makeHarness({ reminder });
    assert.deepEqual(Object.keys(h.service).sort(), [
      'batchSize',
      'claimDueBatch',
      'leaseDurationMs',
      'recordProcessingFailure',
      'validateClaimForDelivery',
    ]);
    const claim = { appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1' };
    const result = await h.service.validateClaimForDelivery(claim);
    assert.equal(result.outcome, 'eligible_for_delivery');
    assert.equal(result.recipientUserId, '9001');
    assert.equal(reminder.state, 'pending', 'eligibility does not mark a reminder delivered');
    assert.equal(reminder.attemptCount, 0);

    const staleToken = await h.service.validateClaimForDelivery({ ...claim, claimToken: TOKEN_B });
    assert.equal(staleToken.outcome, 'stale_claim');
    const staleRevision = await h.service.validateClaimForDelivery({ ...claim, scheduleRevision: '2' });
    assert.equal(staleRevision.outcome, 'stale_claim');
  });

  test('rejects expired claims at lease equality and never allows delivery at appointment start', async () => {
    const expired = makeHarness({ reminder: reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW) }) });
    assert.equal((await expired.service.validateClaimForDelivery({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1',
    })).outcome, 'lease_expired');

    const started = makeHarness({
      appointment: { appointmentId: '42', patientId: '71', status: 'scheduled', scheduledStart: new Date(NOW) },
      reminder: reminderFixture({ scheduledStartUtc: new Date(NOW), claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) }),
    });
    assert.equal((await started.service.validateClaimForDelivery({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1',
    })).outcome, 'skipped_started');
    assert.equal(started.reminder.state, 'skipped');
  });

  test('records only current live claim failures, applies bounded backoff, and sanitizes failure codes', async () => {
    const reminder = reminderFixture({ claimToken: TOKEN_A, leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000) });
    const h = makeHarness({ reminder });
    const result = await h.service.recordProcessingFailure({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1', outcomeCode: 'not-a-safe-code\nsecret',
    });
    assert.equal(result.outcome, 'retry_scheduled');
    assert.equal(reminder.attemptCount, 1);
    assert.equal(reminder.lastAttemptAtUtc.toISOString(), NOW.toISOString());
    assert.equal(reminder.nextAttemptAtUtc.toISOString(), '2026-04-16T12:01:00.000Z');
    assert.equal(reminder.outcomeCode, 'delivery_failed');
    assert.equal(reminder.claimToken, null);

    const stale = makeHarness({ reminder: reminderFixture({
      claimToken: TOKEN_B,
      leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000),
    }) });
    assert.equal((await stale.service.recordProcessingFailure({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1', outcomeCode: 'worker_error',
    })).outcome, 'stale_claim');
    assert.equal(stale.reminder.attemptCount, 0);
    assert.equal(stale.reminder.claimToken, TOKEN_B);
  });

  test('does not schedule an attempt whose retry would occur at or after appointment start', async () => {
    const start = new Date(NOW.getTime() + 60_000);
    const h = makeHarness({
      appointment: { appointmentId: '42', patientId: '71', status: 'scheduled', scheduledStart: start },
      reminder: reminderFixture({
        scheduledStartUtc: start,
        claimToken: TOKEN_A,
        leaseExpiresAtUtc: new Date(NOW.getTime() + 10_000),
      }),
    });
    assert.equal((await h.service.recordProcessingFailure({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: '1', outcomeCode: 'provider_unavailable',
    })).outcome, 'no_retry_before_appointment');
    assert.equal(h.reminder.attemptCount, 1);
    assert.equal(h.reminder.state, 'skipped');
    assert.equal(h.reminder.claimToken, null);
  });

  test('propagates write failures so the transaction provider can roll the claim back', async () => {
    const h = makeHarness({ saveFailure: true });
    await assert.rejects(h.service.claimDueBatch(), /synthetic write failure/);
    assert.equal(h.reminder.claimToken, null);
  });

  test('rejects invalid identifiers, tokens, lease configuration, and malformed claim tokens', async () => {
    assert.throws(() => makeHarness({ leaseDurationMs: 0 }), /leaseDurationMs/);
    assert.throws(() => makeHarness({ leaseDurationMs: Number.POSITIVE_INFINITY }), /leaseDurationMs/);
    assert.throws(() => makeHarness({ leaseDurationMs: MAX_CLAIM_LEASE_MS + 1 }), /leaseDurationMs/);
    assert.doesNotThrow(() => makeHarness({ leaseDurationMs: MAX_CLAIM_LEASE_MS }));
    const h = makeHarness();
    await assert.rejects(h.service.validateClaimForDelivery({
      appointmentId: '0', claimToken: TOKEN_A, scheduleRevision: '1',
    }), /appointmentId/);
    await assert.rejects(h.service.validateClaimForDelivery({
      appointmentId: '42', claimToken: 'not-a-uuid', scheduleRevision: '1',
    }), /claimToken/);
    await assert.rejects(h.service.recordProcessingFailure({
      appointmentId: '42', claimToken: TOKEN_A, scheduleRevision: 'not-a-revision', outcomeCode: 'worker_error',
    }), /schedule revision/);
    assert.equal(h.reminder.claimToken, null);
  });
});
