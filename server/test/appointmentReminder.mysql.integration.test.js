'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { hasLauncherOwnedContext } = require('./run-appointmentReminder.mysql.integration');
const { barrier, deferred, waitForGate } = require('./helpers/reminderIntegrationGates');

const optIn = process.env.MERIDIAN_REMINDER_MYSQL_INTEGRATION === '1';
const launchedByHarness = hasLauncherOwnedContext(process.env);

if (!optIn) {
  test('reminder MySQL integration requires explicit opt-in', { skip: 'set MERIDIAN_REMINDER_MYSQL_INTEGRATION=1 and use the dedicated runner' }, () => {});
} else if (!launchedByHarness) {
  test('reminder MySQL integration must use the isolated dedicated runner', () => {
    assert.fail('Run npm run test:reminders:mysql; launcher-owned execution context is required');
  });
} else {
  require('./helpers/require-test-environment');

  const {
    sequelize,
    Role,
    User,
    Department,
    Doctor,
    Patient,
    Appointment,
    AppointmentReminder,
    Notification,
  } = require('../src/models');
  const { checkSchemaPreflight } = require('../src/config/db');
  const { inspectReminderSchema } = require('../src/migrations/reminderSchemaContract');
  const { createAppointmentReminderLifecycle } = require('../src/services/appointmentReminderLifecycle.service');
  const { createAppointmentReminderWorkerService } = require('../src/services/appointmentReminderWorker.service');
  const { createAppointmentReminderDeliveryService } = require('../src/services/appointmentReminderDelivery.service');

  const MINUTE = 60_000;
  const LEASE_MS = 30_000;
  const WARN_LOGGER = { warn() {} };

  function modelWithOverrides(Model, overrides = {}) {
    return new Proxy(Model, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (Object.prototype.hasOwnProperty.call(overrides, property)) {
          return overrides[property](typeof value === 'function' ? value.bind(target) : value);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    });
  }

  function makeWorker(fixture, overrides = {}) {
    return createAppointmentReminderWorkerService({
      Appointment: overrides.Appointment || Appointment,
      AppointmentReminder: overrides.AppointmentReminder || AppointmentReminder,
      Patient: overrides.Patient || Patient,
      sequelize: overrides.sequelize || sequelize,
      clock: () => new Date(fixture.clockNow),
      leaseDurationMs: LEASE_MS,
      batchSize: overrides.batchSize || 25,
      logger: WARN_LOGGER,
    });
  }

  function makeDelivery(fixture, overrides = {}) {
    return createAppointmentReminderDeliveryService({
      Appointment: overrides.Appointment || Appointment,
      AppointmentReminder: overrides.AppointmentReminder || AppointmentReminder,
      Patient: overrides.Patient || Patient,
      Notification: overrides.Notification || Notification,
      sequelize: overrides.sequelize || sequelize,
      clock: () => new Date(fixture.clockNow),
    });
  }

  async function createFixture({ startOffsetMs = 2 * 60 * MINUTE, now = null } = {}) {
    const unique = randomUUID().replaceAll('-', '');
    const clockNow = now ? new Date(now) : new Date(Math.floor(Date.now() / 1000) * 1000);
    const scheduledStart = new Date(Math.floor((clockNow.getTime() + startOffsetMs) / 1000) * 1000);
    const fixture = {
      clockNow,
      userIds: [],
      roleIds: [],
      departmentId: null,
      doctorId: null,
      patientId: null,
      appointmentId: null,
      reminderId: null,
    };

    await sequelize.transaction(async (transaction) => {
      const patientRole = await Role.create({ roleName: `it_p_${unique.slice(0, 20)}`, description: 'Synthetic reminder integration role' }, { transaction });
      const doctorRole = await Role.create({ roleName: `it_d_${unique.slice(0, 20)}`, description: 'Synthetic reminder integration role' }, { transaction });
      fixture.roleIds.push(patientRole.roleId, doctorRole.roleId);

      const patientUser = await User.create({
        roleId: patientRole.roleId,
        firstName: 'Synthetic',
        lastName: 'Patient',
        email: `it-p-${unique}@example.invalid`,
        passwordHash: '$integration$not-a-login-credential$',
        tokenVersion: 0,
        isActive: false,
      }, { transaction });
      const doctorUser = await User.create({
        roleId: doctorRole.roleId,
        firstName: 'Synthetic',
        lastName: 'Doctor',
        email: `it-d-${unique}@example.invalid`,
        passwordHash: '$integration$not-a-login-credential$',
        tokenVersion: 0,
        isActive: false,
      }, { transaction });
      fixture.userIds.push(patientUser.userId, doctorUser.userId);

      const department = await Department.create({ name: `Reminder IT ${unique}` }, { transaction });
      fixture.departmentId = department.departmentId;
      const doctor = await Doctor.create({
        userId: doctorUser.userId,
        departmentId: department.departmentId,
        specialization: 'Synthetic testing',
        qualification: 'Synthetic testing',
        experienceYears: 0,
        licenseNumber: `IT-${unique}`,
        consultationFee: 0,
        isAvailable: true,
      }, { transaction });
      fixture.doctorId = doctor.doctorId;

      const patient = await Patient.create({
        userId: patientUser.userId,
        dateOfBirth: '2000-01-01',
        gender: 'other',
        bloodGroup: 'unknown',
        registrationNumber: `IT-${unique.slice(0, 26)}`,
      }, { transaction });
      fixture.patientId = patient.patientId;

      const appointment = await Appointment.create({
        patientId: patient.patientId,
        doctorId: doctor.doctorId,
        departmentId: department.departmentId,
        scheduledStart,
        scheduledEnd: new Date(scheduledStart.getTime() + 30 * MINUTE),
        status: 'scheduled',
        reason: 'Synthetic reminder integration fixture',
        bookedByUserId: patientUser.userId,
      }, { transaction });
      fixture.appointmentId = appointment.appointmentId;

      const lifecycle = createAppointmentReminderLifecycle({
        AppointmentReminder,
        Patient,
        clock: () => new Date(clockNow),
      });
      const reminder = await lifecycle.enrollCreatedAppointment(appointment, transaction);
      assert.ok(reminder, 'future synthetic appointment should receive a reminder');
      fixture.reminderId = reminder.appointmentReminderId;
    });

    fixture.patientUserId = fixture.userIds[0];
    fixture.clock = (next) => { fixture.clockNow = new Date(next); };
    fixture.cleanup = async () => {
      await sequelize.transaction(async (transaction) => {
        if (fixture.appointmentId) {
          await Notification.destroy({ where: { relatedAppointmentId: fixture.appointmentId }, transaction });
          await Appointment.destroy({ where: { appointmentId: fixture.appointmentId }, transaction });
        }
        if (fixture.patientId) await Patient.destroy({ where: { patientId: fixture.patientId }, transaction });
        if (fixture.doctorId) await Doctor.destroy({ where: { doctorId: fixture.doctorId }, transaction });
        if (fixture.userIds.length) await User.destroy({ where: { userId: fixture.userIds }, transaction });
        if (fixture.departmentId) await Department.destroy({ where: { departmentId: fixture.departmentId }, transaction });
        if (fixture.roleIds.length) await Role.destroy({ where: { roleId: fixture.roleIds }, transaction });
      });
    };
    return fixture;
  }

  async function registerCleanup(t, fixture) {
    t.after(fixture.cleanup);
  }

  async function claimReminder(fixture, worker = makeWorker(fixture)) {
    const results = await worker.claimDueBatch();
    const claim = results.find((result) => result.outcome === 'claimed');
    assert.ok(claim, `expected reminder to be claimed; outcomes: ${results.map((result) => result.outcome).join(', ')}`);
    return claim;
  }

  async function reminderFor(fixture) {
    return AppointmentReminder.findOne({ where: { appointmentId: fixture.appointmentId } });
  }

  async function notificationCount(fixture) {
    return Notification.count({ where: { relatedAppointmentId: fixture.appointmentId } });
  }

  async function createAlternatePatientAccount(fixture) {
    const user = await User.create({
      roleId: fixture.roleIds[0],
      firstName: 'Synthetic',
      lastName: 'Alternate',
      email: `it-alt-${randomUUID()}@example.invalid`,
      passwordHash: '$integration$not-a-login-credential$',
      tokenVersion: 0,
      isActive: false,
    });
    fixture.userIds.push(user.userId);
    return user;
  }

  before(async () => {
    await sequelize.authenticate();
    assert.equal(await checkSchemaPreflight(sequelize), true, 'required database schema preflight must pass');
    assert.equal(await inspectReminderSchema(sequelize), true, 'reminder and notification enum schema contract must pass');
    assert.equal(
      await AppointmentReminder.count(),
      0,
      'dedicated integration database must contain no reminder rows before the suite starts'
    );
  });

  after(async () => {
    await sequelize.close();
  });

  test('MySQL reminder integration cases', { concurrency: 1 }, async (t) => {
    await t.test('two independent transactions cannot claim the same reminder', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const bothAtAppointmentLock = barrier(2);
      const connectionIds = [];
      const tracedAppointment = () => modelWithOverrides(Appointment, {
        findByPk: (findByPk) => async (id, options) => {
          if (options?.transaction && options.lock) {
            connectionIds.push(options.transaction.connection?.threadId);
            await bothAtAppointmentLock();
          }
          return findByPk(id, options);
        },
      });
      const workerA = makeWorker(fixture, { Appointment: tracedAppointment() });
      const workerB = makeWorker(fixture, { Appointment: tracedAppointment() });
      const [a, b] = await Promise.all([workerA.claimDueBatch(), workerB.claimDueBatch()]);
      const outcomes = [...a, ...b].map((result) => result.outcome);
      assert.equal(outcomes.filter((value) => value === 'claimed').length, 1);
      assert.equal(new Set(connectionIds).size, 2, 'claims must use independent MySQL connections');
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'pending');
      assert.ok(persisted.claimToken);
      assert.equal(persisted.attemptCount, 0);
    });

    await t.test('appointment lock winner rescheduling prevents delivery of the old schedule', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      const locked = deferred();
      const continueLifecycle = deferred();
      const lifecycle = createAppointmentReminderLifecycle({ AppointmentReminder, Patient, clock: () => new Date(fixture.clockNow) });
      const lifecycleTransaction = sequelize.transaction(async (transaction) => {
        const appointment = await Appointment.findByPk(fixture.appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
        locked.resolve();
        await waitForGate(continueLifecycle.promise);
        const nextStart = new Date(appointment.scheduledStart.getTime() + 60 * MINUTE);
        await appointment.update({ scheduledStart: nextStart, scheduledEnd: new Date(nextStart.getTime() + 30 * MINUTE) }, { transaction });
        await lifecycle.replacePendingSchedule(appointment, transaction);
      });
      await waitForGate(locked.promise);
      const deliveryAttempted = deferred();
      const deliveryAppointment = modelWithOverrides(Appointment, {
        findByPk: (findByPk) => async (...args) => {
          deliveryAttempted.resolve();
          return findByPk(...args);
        },
      });
      const delivery = makeDelivery(fixture, { Appointment: deliveryAppointment });
      const deliveryResultPromise = delivery.deliverClaim(claim);
      await waitForGate(deliveryAttempted.promise);
      continueLifecycle.resolve();
      await lifecycleTransaction;
      const deliveryResult = await deliveryResultPromise;
      assert.equal(deliveryResult.outcome, 'stale_claim');
      assert.equal(await notificationCount(fixture), 0);
      const persisted = await reminderFor(fixture);
      assert.equal(String(persisted.scheduleRevision), '2');
      assert.equal(persisted.claimToken, null);
      const appointment = await Appointment.findByPk(fixture.appointmentId);
      assert.equal(persisted.scheduledStartUtc.getTime(), appointment.scheduledStart.getTime());
    });

    await t.test('appointment lock winner terminal transitions invalidate the claim before delivery', async (t) => {
      for (const status of ['cancelled', 'completed', 'no_show']) {
        await t.test(status, async (subtest) => {
          const fixture = await createFixture();
          await registerCleanup(subtest, fixture);
          const claim = await claimReminder(fixture);
          const locked = deferred();
          const continueLifecycle = deferred();
          const lifecycle = createAppointmentReminderLifecycle({ AppointmentReminder, Patient, clock: () => new Date(fixture.clockNow) });
          const lifecycleTransaction = sequelize.transaction(async (transaction) => {
            const appointment = await Appointment.findByPk(fixture.appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
            locked.resolve();
            await waitForGate(continueLifecycle.promise);
            await appointment.update({ status }, { transaction });
            await lifecycle.invalidatePending(appointment, status, transaction);
          });
          await waitForGate(locked.promise);
          const deliveryAttempted = deferred();
          const delivery = makeDelivery(fixture, {
            Appointment: modelWithOverrides(Appointment, {
              findByPk: (findByPk) => async (...args) => {
                deliveryAttempted.resolve();
                return findByPk(...args);
              },
            }),
          });
          const resultPromise = delivery.deliverClaim(claim);
          await waitForGate(deliveryAttempted.promise);
          continueLifecycle.resolve();
          await lifecycleTransaction;
          assert.equal((await resultPromise).outcome, 'not_pending');
          assert.equal(await notificationCount(fixture), 0);
          const persisted = await reminderFor(fixture);
          assert.equal(persisted.state, 'cancelled');
          assert.equal(persisted.attemptCount, 0);
        });
      }
    });

    await t.test('claim validation locks appointment, reminder, then patient', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const trace = [];
      const tracedAppointment = modelWithOverrides(Appointment, {
        findByPk: (findByPk) => async (...args) => {
          if (args[1]?.transaction) trace.push(['appointment', args[1].lock]);
          return findByPk(...args);
        },
      });
      const tracedReminder = modelWithOverrides(AppointmentReminder, {
        findOne: (findOne) => async (...args) => {
          if (args[0]?.transaction) trace.push(['reminder', args[0].lock]);
          return findOne(...args);
        },
      });
      const tracedPatient = modelWithOverrides(Patient, {
        findByPk: (findByPk) => async (...args) => {
          if (args[1]?.transaction) trace.push(['patient', args[1].lock]);
          return findByPk(...args);
        },
      });
      const worker = makeWorker(fixture, {
        Appointment: tracedAppointment,
        AppointmentReminder: tracedReminder,
        Patient: tracedPatient,
      });
      assert.equal((await claimReminder(fixture, worker)).outcome, 'claimed');
      assert.deepEqual(trace.map(([name]) => name), ['appointment', 'reminder', 'patient']);
      assert.ok(trace.every(([, lock]) => lock === 'UPDATE'));
    });

    await t.test('notification insert failure rolls back all delivery writes', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      const failingNotification = modelWithOverrides(Notification, {
        create: (create) => async (...args) => {
          await create(...args);
          throw new Error('synthetic failure after notification insert');
        },
      });
      const result = await makeDelivery(fixture, { Notification: failingNotification }).deliverClaim(claim);
      assert.equal(result.outcome, 'definitively_not_committed');
      assert.equal(await notificationCount(fixture), 0);
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'pending');
      assert.equal(persisted.attemptCount, 0);
      assert.equal(persisted.claimToken, claim.claimToken);
    });

    await t.test('reminder update failure rolls back the preceding notification insert', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      const failingReminder = modelWithOverrides(AppointmentReminder, {
        findOne: (findOne) => async (...args) => {
          const row = await findOne(...args);
          if (!row) return row;
          return new Proxy(row, {
            get(target, property) {
              if (property === 'save') {
                return async (options) => {
                  await target.save(options);
                  throw new Error('synthetic failure after reminder update');
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, property, value) {
              return Reflect.set(target, property, value, target);
            },
          });
        },
      });
      const result = await makeDelivery(fixture, { AppointmentReminder: failingReminder }).deliverClaim(claim);
      assert.equal(result.outcome, 'definitively_not_committed');
      assert.equal(await notificationCount(fixture), 0);
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'pending');
      assert.equal(persisted.attemptCount, 0);
      assert.equal(persisted.claimToken, claim.claimToken);
    });

    await t.test('concurrent duplicate deliveries persist one patient notification', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      const bothAtAppointmentLock = barrier(2);
      const connectionIds = [];
      const appointmentModel = modelWithOverrides(Appointment, {
        findByPk: (findByPk) => async (id, options) => {
          if (options?.transaction && options.lock) {
            connectionIds.push(options.transaction.connection?.threadId);
            await bothAtAppointmentLock();
          }
          return findByPk(id, options);
        },
      });
      const deliveryA = makeDelivery(fixture, { Appointment: appointmentModel });
      const deliveryB = makeDelivery(fixture, { Appointment: appointmentModel });
      const results = await Promise.all([deliveryA.deliverClaim(claim), deliveryB.deliverClaim(claim)]);
      assert.equal(new Set(connectionIds).size, 2, 'deliveries must use independent MySQL connections');
      assert.equal(results.filter((result) => ['delivered', 'already_delivered'].includes(result.outcome)).length, 2);
      assert.equal(await notificationCount(fixture), 1);
      const notification = await Notification.findOne({ where: { appointmentReminderId: fixture.reminderId } });
      assert.equal(String(notification.userId), String(fixture.patientUserId));
      assert.notEqual(String(notification.userId), String(fixture.userIds[1]));
      const reminder = await reminderFor(fixture);
      assert.equal(reminder.state, 'delivered');
      assert.equal(reminder.attemptCount, 1);
      await assert.rejects(
        Notification.create({
          userId: fixture.patientUserId,
          type: 'appointment_reminder',
          title: notification.title,
          message: notification.message,
          relatedAppointmentId: fixture.appointmentId,
          appointmentReminderId: fixture.reminderId,
          reminderScheduledStartUtc: notification.reminderScheduledStartUtc,
        }),
        (error) => error.name === 'SequelizeUniqueConstraintError'
      );
      assert.equal(await notificationCount(fixture), 1);
    });

    await t.test('post-commit acknowledgement loss reconciles authoritative delivered state', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      let loseAcknowledgement = true;
      const transactionProvider = {
        transaction: async (callback) => {
          const committed = await sequelize.transaction(callback);
          if (loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new Error('synthetic lost commit acknowledgement');
          }
          return committed;
        },
      };
      const result = await makeDelivery(fixture, { sequelize: transactionProvider }).deliverClaim(claim);
      assert.equal(result.outcome, 'already_delivered');
      assert.equal(await notificationCount(fixture), 1);
      assert.equal((await reminderFor(fixture)).state, 'delivered');
    });

    await t.test('uncertain callback outcome reconciles a rolled-back attempt without duplicate delivery', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      let abortAfterCallback = true;
      const transactionProvider = {
        transaction: (callback) => sequelize.transaction(async (transaction) => {
          const result = await callback(transaction);
          if (abortAfterCallback) {
            abortAfterCallback = false;
            throw new Error('synthetic failure before commit');
          }
          return result;
        }),
      };
      const result = await makeDelivery(fixture, { sequelize: transactionProvider }).deliverClaim(claim);
      assert.equal(result.outcome, 'not_committed_retryable');
      assert.equal(result.failureCategory, 'outcome_uncertain');
      assert.equal(await notificationCount(fixture), 0);
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'pending');
      assert.equal(persisted.claimToken, claim.claimToken);
      assert.equal(result.retryAfterUtc.getTime(), persisted.leaseExpiresAtUtc.getTime());
    });

    await t.test('expired lease is recovered with a bounded attempt and retry', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const worker = makeWorker(fixture);
      const claim = await claimReminder(fixture, worker);
      fixture.clock(new Date(claim.leaseExpiresAtUtc.getTime() + 1));
      const result = (await worker.claimDueBatch())[0];
      assert.equal(result.outcome, 'expired_claim_retried');
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.attemptCount, 1);
      assert.equal(persisted.claimToken, null);
      assert.equal(persisted.leaseExpiresAtUtc, null);
      assert.equal(persisted.nextAttemptAtUtc.getTime(), fixture.clockNow.getTime() + MINUTE);
    });

    await t.test('patient account reassignment is quarantined and an old claim cannot notify the former user', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const oldClaim = await claimReminder(fixture);
      const alternate = await createAlternatePatientAccount(fixture);
      await sequelize.transaction(async (transaction) => {
        const patient = await Patient.findByPk(fixture.patientId, { transaction, lock: transaction.LOCK.UPDATE });
        patient.userId = alternate.userId;
        await patient.save({ transaction });
      });
      const result = await makeDelivery(fixture).deliverClaim(oldClaim);
      assert.equal(result.outcome, 'claim_ownership_mismatch');
      assert.equal(await notificationCount(fixture), 0);
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'pending');
      assert.equal(persisted.attemptCount, 0);

      const secondFixture = await createFixture();
      await registerCleanup(t, secondFixture);
      const secondAlternate = await createAlternatePatientAccount(secondFixture);
      await sequelize.transaction(async (transaction) => {
        const patient = await Patient.findByPk(secondFixture.patientId, { transaction, lock: transaction.LOCK.UPDATE });
        patient.userId = secondAlternate.userId;
        await patient.save({ transaction });
      });
      const quarantine = (await makeWorker(secondFixture).claimDueBatch())[0];
      assert.equal(quarantine.outcome, 'patient_relationship_mismatch');
      const quarantined = await reminderFor(secondFixture);
      assert.equal(quarantined.state, 'failed');
      assert.equal(quarantined.attemptCount, 0);
      assert.equal(quarantined.claimToken, null);
      assert.equal(await notificationCount(secondFixture), 0);
    });

    await t.test('five-attempt lifetime limit and retry delays are persisted', async (t) => {
      const fixture = await createFixture({ startOffsetMs: 2 * 60 * 60 * MINUTE });
      await registerCleanup(t, fixture);
      const worker = makeWorker(fixture);
      const retryDelays = [MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE];
      for (let failedAttempt = 1; failedAttempt <= 5; failedAttempt += 1) {
        const claim = await claimReminder(fixture, worker);
        const failure = await worker.recordProcessingFailure({
          appointmentId: claim.appointmentId,
          claimToken: claim.claimToken,
          scheduleRevision: claim.scheduleRevision,
          outcomeCode: 'worker_error',
        });
        const persisted = await reminderFor(fixture);
        assert.equal(persisted.attemptCount, failedAttempt);
        assert.equal(persisted.lastAttemptAtUtc.getTime(), fixture.clockNow.getTime());
        if (failedAttempt < 5) {
          assert.equal(failure.outcome, 'retry_scheduled');
          assert.equal(persisted.nextAttemptAtUtc.getTime(), fixture.clockNow.getTime() + retryDelays[failedAttempt - 1]);
          fixture.clock(persisted.nextAttemptAtUtc);
        } else {
          assert.equal(failure.outcome, 'attempts_exhausted');
          assert.equal(persisted.state, 'failed');
        }
      }
      assert.equal((await worker.claimDueBatch()).length, 0);
    });

    await t.test('retry at or beyond appointment start is not scheduled', async (t) => {
      const fixture = await createFixture({ startOffsetMs: 30_000 });
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      const result = await makeWorker(fixture).recordProcessingFailure({
        appointmentId: claim.appointmentId,
        claimToken: claim.claimToken,
        scheduleRevision: claim.scheduleRevision,
        outcomeCode: 'worker_error',
      });
      assert.equal(result.outcome, 'no_retry_before_appointment');
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.attemptCount, 1);
      assert.equal(persisted.state, 'skipped');
      assert.equal(persisted.nextAttemptAtUtc.getTime(), persisted.scheduledStartUtc.getTime() - 30_000);
    });

    await t.test('quarantined candidates stop consuming later batch slots', async (t) => {
      const sharedNow = new Date(Math.floor(Date.now() / 1000) * 1000);
      const invalidA = await createFixture({ now: sharedNow });
      await registerCleanup(t, invalidA);
      const invalidB = await createFixture({ now: sharedNow });
      await registerCleanup(t, invalidB);
      const valid = await createFixture({ now: sharedNow });
      await registerCleanup(t, valid);
      for (const fixture of [invalidA, invalidB]) {
        const alternate = await createAlternatePatientAccount(fixture);
        await sequelize.transaction(async (transaction) => {
          const patient = await Patient.findByPk(fixture.patientId, { transaction, lock: transaction.LOCK.UPDATE });
          patient.userId = alternate.userId;
          await patient.save({ transaction });
        });
      }
      const worker = makeWorker(valid, { batchSize: 2 });
      const firstBatch = await worker.claimDueBatch();
      assert.equal(firstBatch.length, 2);
      assert.ok(firstBatch.every((result) => result.outcome === 'patient_relationship_mismatch'));
      const nextBatch = await worker.claimDueBatch();
      assert.equal(nextBatch.length, 1);
      assert.equal(nextBatch[0].outcome, 'claimed');
      assert.equal((await reminderFor(invalidA)).state, 'failed');
      assert.equal((await reminderFor(invalidB)).state, 'failed');
      assert.equal((await reminderFor(valid)).state, 'pending');
    });

    await t.test('rescheduling after delivery never re-arms the reminder', async (t) => {
      const fixture = await createFixture();
      await registerCleanup(t, fixture);
      const claim = await claimReminder(fixture);
      assert.equal((await makeDelivery(fixture).deliverClaim(claim)).outcome, 'delivered');
      const lifecycle = createAppointmentReminderLifecycle({ AppointmentReminder, Patient, clock: () => new Date(fixture.clockNow) });
      await sequelize.transaction(async (transaction) => {
        const appointment = await Appointment.findByPk(fixture.appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
        const nextStart = new Date(appointment.scheduledStart.getTime() + 60 * MINUTE);
        await appointment.update({ scheduledStart: nextStart, scheduledEnd: new Date(nextStart.getTime() + 30 * MINUTE) }, { transaction });
        await lifecycle.replacePendingSchedule(appointment, transaction);
      });
      const persisted = await reminderFor(fixture);
      assert.equal(persisted.state, 'delivered');
      assert.equal(persisted.attemptCount, 1);
      assert.equal(await notificationCount(fixture), 1);
    });

    await t.test('current reminder schema and notification enum pass database preflight', async () => {
      assert.equal(await checkSchemaPreflight(sequelize), true);
      assert.equal(await inspectReminderSchema(sequelize), true);
      assert.ok(Notification.getAttributes().type.values.includes('appointment_reminder'));
    });
  });
}
