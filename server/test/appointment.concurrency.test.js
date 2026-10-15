require('./helpers/require-test-environment');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Op } = require('sequelize');

const app = require('../src/app');
const {
  User,
  Role,
  Patient,
  Doctor,
  Appointment,
  AuditLog,
  Notification,
} = require('../src/models');
const { signAccessToken } = require('../src/services/token.service');

describe('Appointment Concurrency & Booking Safety Suite', () => {
  let server;
  let baseUrl;
  const tokens = {};
  const users = {};
  const doctors = {};
  const patients = {};
  const createdAppointmentIds = [];

  before(async () => {
    // 1. Start HTTP server on ephemeral port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 2. Fetch seed users and generate tokens
    const [p1User, p2User, d1User, d2User, recUser, adminUser] = await Promise.all([
      User.findOne({ where: { email: 'karan.shah@hms.test' }, include: [{ model: Role }] }),
      User.findOne({ where: { email: 'priya.nair@hms.test' }, include: [{ model: Role }] }),
      User.findOne({ where: { email: 'r.verma@hms.test' }, include: [{ model: Role }] }),
      User.findOne({ where: { email: 's.iyer@hms.test' }, include: [{ model: Role }] }),
      User.findOne({ where: { email: 'n.fernandes@hms.test' }, include: [{ model: Role }] }),
      User.findOne({ where: { email: 'admin@hms.test' }, include: [{ model: Role }] }),
    ]);

    tokens.patient1 = signAccessToken(p1User);
    tokens.patient2 = signAccessToken(p2User);
    tokens.doctor1 = signAccessToken(d1User);
    tokens.doctor2 = signAccessToken(d2User);
    tokens.receptionist = signAccessToken(recUser);
    tokens.admin = signAccessToken(adminUser);

    users.patient1 = p1User;
    users.patient2 = p2User;
    users.doctor1 = d1User;
    users.doctor2 = d2User;
    users.receptionist = recUser;
    users.admin = adminUser;

    const [pat1, pat2, doc1, doc2] = await Promise.all([
      Patient.findOne({ where: { userId: p1User.userId } }),
      Patient.findOne({ where: { userId: p2User.userId } }),
      Doctor.findOne({ where: { userId: d1User.userId } }),
      Doctor.findOne({ where: { userId: d2User.userId } }),
    ]);

    patients.p1 = pat1;
    patients.p2 = pat2;
    doctors.d1 = doc1;
    doctors.d2 = doc2;
  });

  after(async () => {
    // Clean up created appointments
    if (createdAppointmentIds.length > 0) {
      await Promise.all([
        AuditLog.destroy({
          where: { entityType: 'Appointment', entityId: { [Op.in]: createdAppointmentIds } },
        }),
        Notification.destroy({
          where: { relatedAppointmentId: { [Op.in]: createdAppointmentIds } },
        }),
      ]).catch(() => {});
      await Appointment.destroy({
        where: { appointmentId: { [Op.in]: createdAppointmentIds } },
      }).catch(() => {});
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Helper to record created appointments for cleanup
  function trackAppointment(id) {
    if (id) createdAppointmentIds.push(id);
    return id;
  }

  let fixtureSlotSequence = 0;
  async function createAppointmentFixture(status = 'scheduled') {
    const scheduledStart = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000 + fixtureSlotSequence++ * 60 * 60 * 1000);
    scheduledStart.setSeconds(0, 0);
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d1.doctorId,
      departmentId: doctors.d1.departmentId,
      bookedByUserId: users.patient1.userId,
      scheduledStart,
      scheduledEnd: new Date(scheduledStart.getTime() + 30 * 60 * 1000),
      status,
      reason: 'Lifecycle regression fixture',
    });
    trackAppointment(appointment.appointmentId);
    return appointment;
  }

  // 1. Normal booking succeeds
  test('1. Normal appointment booking succeeds (201 Created)', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-10T09:00:00.000Z',
        durationMinutes: 30,
        reason: 'Routine checkup',
      }),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.status, 'scheduled');
    assert.equal(json.data.doctorId, doctors.d1.doctorId);
    assert.equal(json.data.patientId, patients.p1.patientId);
    trackAppointment(json.data.appointmentId);
  });

  // 2. Sequential conflicting booking is rejected with 409
  test('2. Sequential conflicting booking for occupied slot is rejected with 409 Conflict', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-10T09:00:00.000Z',
        durationMinutes: 30,
        reason: 'Attempted duplicate booking',
      }),
    });

    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.message, /already has an appointment/i);
  });

  // 3. Two genuinely concurrent requests for the exact same slot result in exactly one 201 and one 409
  test('3. Two concurrent requests for the same doctor and slot result in exactly one 201 and one 409', async () => {
    const slot = '2027-01-11T10:00:00.000Z';

    const reqA = fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
        reason: 'Concurrent booking Patient 1',
      }),
    });

    const reqB = fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
        reason: 'Concurrent booking Patient 2',
      }),
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    const jsonA = await resA.json();
    const jsonB = await resB.json();

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], 'Exactly one request must succeed (201) and one must conflict (409)');

    if (resA.status === 201) trackAppointment(jsonA.data.appointmentId);
    if (resB.status === 201) trackAppointment(jsonB.data.appointmentId);

    // Verify in database that exactly ONE appointment row exists for this doctor and slot
    const dbAppointments = await Appointment.findAll({
      where: {
        doctorId: doctors.d1.doctorId,
        scheduledStart: new Date(slot),
        status: { [Op.notIn]: ['cancelled', 'no_show'] },
      },
    });
    assert.equal(dbAppointments.length, 1, 'Database must contain exactly 1 appointment for the slot');
  });

  // 4. Overlapping intervals with different durations are rejected
  test('4. Overlapping time intervals with different durations are rejected (409 Conflict)', async () => {
    // Book 60-minute window from 11:00 to 12:00
    const resBase = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-12T11:00:00.000Z',
        durationMinutes: 60,
        reason: '60-minute base window',
      }),
    });
    assert.equal(resBase.status, 201);
    const jsonBase = await resBase.json();
    trackAppointment(jsonBase.data.appointmentId);

    // Attempt overlapping 30-minute booking from 11:30 to 12:00 (inside window)
    const resInside = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-12T11:30:00.000Z',
        durationMinutes: 30,
        reason: 'Inside overlap attempt',
      }),
    });
    assert.equal(resInside.status, 409);

    // Attempt overlapping booking starting before and ending inside (10:45 to 11:15)
    const resStraddle = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-12T10:45:00.000Z',
        durationMinutes: 30,
        reason: 'Straddling start overlap attempt',
      }),
    });
    assert.equal(resStraddle.status, 409);
  });

  // 5. Adjacent, non-overlapping appointments are accepted
  test('5. Contiguous, non-overlapping appointments are both accepted (201 Created)', async () => {
    // Slot 1: 14:00 - 14:30
    const res1 = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-13T14:00:00.000Z',
        durationMinutes: 30,
      }),
    });
    assert.equal(res1.status, 201);
    const json1 = await res1.json();
    trackAppointment(json1.data.appointmentId);

    // Slot 2: 14:30 - 15:00 (starts exactly when Slot 1 ends)
    const res2 = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: '2027-01-13T14:30:00.000Z',
        durationMinutes: 30,
      }),
    });
    assert.equal(res2.status, 201);
    const json2 = await res2.json();
    trackAppointment(json2.data.appointmentId);
  });

  // 6. Cancelled and no-show appointments do not block new bookings
  test('6. Cancelled and no-show appointments do not block new bookings for the slot', async () => {
    const slot = '2027-01-14T09:00:00.000Z';

    // 1. Book and then cancel
    const resInitial = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });
    assert.equal(resInitial.status, 201);
    const jsonInitial = await resInitial.json();
    trackAppointment(jsonInitial.data.appointmentId);

    // Cancel appointment
    const resCancel = await fetch(`${baseUrl}/api/appointments/${jsonInitial.data.appointmentId}/cancel`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ reason: 'Patient plans changed' }),
    });
    assert.equal(resCancel.status, 200);

    // 2. Re-book same slot now that prior appointment is cancelled
    const resRebook1 = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });
    assert.equal(resRebook1.status, 201);
    const jsonRebook1 = await resRebook1.json();
    trackAppointment(jsonRebook1.data.appointmentId);

    // 3. Mark as no_show by receptionist/admin
    const resNoShow = await fetch(`${baseUrl}/api/appointments/${jsonRebook1.data.appointmentId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'no_show' }),
    });
    assert.equal(resNoShow.status, 200);

    // 4. Re-book same slot again now that prior appointment is no_show
    const resRebook2 = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });
    assert.equal(resRebook2.status, 201);
    const jsonRebook2 = await resRebook2.json();
    trackAppointment(jsonRebook2.data.appointmentId);
  });

  // 7. Simultaneous bookings for different doctors can both succeed
  test('7. Simultaneous bookings for different doctors at the same time both succeed (201 Created)', async () => {
    const slot = '2027-01-15T10:00:00.000Z';

    const reqDoc1 = fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });

    const reqDoc2 = fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d2.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });

    const [resDoc1, resDoc2] = await Promise.all([reqDoc1, reqDoc2]);
    assert.equal(resDoc1.status, 201, 'Booking for Doctor 1 should succeed');
    assert.equal(resDoc2.status, 201, 'Booking for Doctor 2 should succeed concurrently');

    const jsonDoc1 = await resDoc1.json();
    const jsonDoc2 = await resDoc2.json();
    trackAppointment(jsonDoc1.data.appointmentId);
    trackAppointment(jsonDoc2.data.appointmentId);
  });

  // 8. Failed bookings leave no partial appointment records
  test('8. Failed bookings leave no partial or phantom appointment records in database', async () => {
    const slot = '2027-01-16T15:00:00.000Z';

    // 1. Initial valid booking
    const resInit = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });
    assert.equal(resInit.status, 201);
    const jsonInit = await resInit.json();
    trackAppointment(jsonInit.data.appointmentId);

    // 2. Count appointments in DB
    const countBefore = await Appointment.count({
      where: { doctorId: doctors.d1.doctorId, scheduledStart: new Date(slot) },
    });
    assert.equal(countBefore, 1);

    // 3. Trigger 409 conflict
    const resFail = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
      }),
    });
    assert.equal(resFail.status, 409);

    // 4. Assert count in DB is STILL exactly 1
    const countAfter = await Appointment.count({
      where: { doctorId: doctors.d1.doctorId, scheduledStart: new Date(slot) },
    });
    assert.equal(countAfter, 1, 'Transaction rollback must leave no partial records');
  });

  // 9. Rescheduling into an occupied slot is rejected
  test('9. Rescheduling into an occupied slot is rejected with 409 Conflict', async () => {
    const slotA = '2027-01-17T09:00:00.000Z';
    const slotB = '2027-01-17T10:00:00.000Z';

    // Book Appointment A at 09:00
    const resA = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slotA,
        durationMinutes: 30,
      }),
    });
    assert.equal(resA.status, 201);
    const jsonA = await resA.json();
    trackAppointment(jsonA.data.appointmentId);

    // Book Appointment B at 10:00
    const resB = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        doctorId: doctors.d1.doctorId,
        scheduledStart: slotB,
        durationMinutes: 30,
      }),
    });
    assert.equal(resB.status, 201);
    const jsonB = await resB.json();
    trackAppointment(jsonB.data.appointmentId);

    // Patient 2 attempts to reschedule Appointment B into occupied slot A (09:00)
    const resReschedule = await fetch(`${baseUrl}/api/appointments/${jsonB.data.appointmentId}/reschedule`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({
        scheduledStart: slotA,
        durationMinutes: 30,
      }),
    });
    assert.equal(resReschedule.status, 409);
    const jsonReschedule = await resReschedule.json();
    assert.match(jsonReschedule.message, /already has an appointment/i);

    // Verify Appointment B remains unchanged at 10:00 in database
    const apptB = await Appointment.findByPk(jsonB.data.appointmentId);
    assert.equal(new Date(apptB.scheduledStart).toISOString(), slotB);
  });

  // 10. Concurrent rescheduling attempts cannot introduce conflicts
  test('10. Concurrent rescheduling attempts for the same destination slot serialize safely', async () => {
    const slotX = '2027-01-18T08:00:00.000Z';
    const slotY = '2027-01-18T08:30:00.000Z';
    const targetSlot = '2027-01-18T09:00:00.000Z';

    const [resX, resY] = await Promise.all([
      fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.patient1}`,
        },
        body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slotX }),
      }),
      fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.patient2}`,
        },
        body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slotY }),
      }),
    ]);
    assert.equal(resX.status, 201);
    assert.equal(resY.status, 201);
    const jsonX = await resX.json();
    const jsonY = await resY.json();
    trackAppointment(jsonX.data.appointmentId);
    trackAppointment(jsonY.data.appointmentId);

    // Both attempt to reschedule to the same targetSlot concurrently
    const reqRescheduleX = fetch(`${baseUrl}/api/appointments/${jsonX.data.appointmentId}/reschedule`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ scheduledStart: targetSlot, durationMinutes: 30 }),
    });

    const reqRescheduleY = fetch(`${baseUrl}/api/appointments/${jsonY.data.appointmentId}/reschedule`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient2}`,
      },
      body: JSON.stringify({ scheduledStart: targetSlot, durationMinutes: 30 }),
    });

    const [resRx, resRy] = await Promise.all([reqRescheduleX, reqRescheduleY]);
    const statuses = [resRx.status, resRy.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Exactly one reschedule succeeds (200) and one is rejected (409)');

    // Verify only 1 appointment occupies targetSlot
    const targetCount = await Appointment.count({
      where: {
        doctorId: doctors.d1.doctorId,
        scheduledStart: new Date(targetSlot),
        status: { [Op.notIn]: ['cancelled', 'no_show'] },
      },
    });
    assert.equal(targetCount, 1, 'Only one appointment can occupy target slot in database');
  });

  // 11. Admin and receptionist booking paths use the same concurrency protection
  test('11. Admin and receptionist booking paths use the same concurrency protection', async () => {
    const slot = '2027-01-19T14:00:00.000Z';

    // 1. Admin books slot for Patient 1
    const resAdmin = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.admin}`,
      },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
        reason: 'Administrative booking',
      }),
    });
    assert.equal(resAdmin.status, 201);
    const jsonAdmin = await resAdmin.json();
    trackAppointment(jsonAdmin.data.appointmentId);

    // 2. Receptionist attempts conflicting booking for Patient 2 at same slot -> rejected with 409
    const resReceptionist = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({
        patientId: patients.p2.patientId,
        doctorId: doctors.d1.doctorId,
        scheduledStart: slot,
        durationMinutes: 30,
        reason: 'Receptionist duplicate booking',
      }),
    });
    assert.equal(resReceptionist.status, 409);
    const jsonReceptionist = await resReceptionist.json();
    assert.match(jsonReceptionist.message, /already has an appointment/i);

    // 3. Concurrent booking race between Admin and Receptionist for a fresh slot
    const raceSlot = '2027-01-19T16:00:00.000Z';
    const [raceAdmin, raceRec] = await Promise.all([
      fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.admin}`,
        },
        body: JSON.stringify({
          patientId: patients.p1.patientId,
          doctorId: doctors.d1.doctorId,
          scheduledStart: raceSlot,
        }),
      }),
      fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.receptionist}`,
        },
        body: JSON.stringify({
          patientId: patients.p2.patientId,
          doctorId: doctors.d1.doctorId,
          scheduledStart: raceSlot,
        }),
      }),
    ]);

    const raceStatuses = [raceAdmin.status, raceRec.status].sort();
    assert.deepEqual(raceStatuses, [201, 409], 'Concurrent administrative bookings must resolve to exactly one 201 and one 409');
    const jsonRaceAdmin = await raceAdmin.json();
    const jsonRaceRec = await raceRec.json();
    if (raceAdmin.status === 201) trackAppointment(jsonRaceAdmin.data.appointmentId);
    if (raceRec.status === 201) trackAppointment(jsonRaceRec.data.appointmentId);
  });

  // 12. Cancelled appointment cannot be changed to confirmed
  test('12. Cancelled appointment cannot be changed to confirmed (400 Bad Request, DB status unchanged)', async () => {
    const slot = '2027-01-20T09:00:00.000Z';
    const resCreate = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slot, durationMinutes: 30 }),
    });
    assert.equal(resCreate.status, 201);
    const jsonCreate = await resCreate.json();
    const apptId = trackAppointment(jsonCreate.data.appointmentId);

    const resCancel = await fetch(`${baseUrl}/api/appointments/${apptId}/cancel`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ reason: 'Patient plans changed' }),
    });
    assert.equal(resCancel.status, 200);

    const resUpdate = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resUpdate.status, 400);
    const jsonUpdate = await resUpdate.json();
    assert.match(jsonUpdate.message, /Cannot update status of an appointment that is already cancelled/i);

    const dbAppt = await Appointment.findByPk(apptId);
    assert.equal(dbAppt.status, 'cancelled');
  });

  // 13. No-show appointment cannot be changed to confirmed
  test('13. No-show appointment cannot be changed to confirmed (400 Bad Request, DB status unchanged)', async () => {
    const slot = '2027-01-20T10:00:00.000Z';
    const resCreate = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slot, durationMinutes: 30 }),
    });
    assert.equal(resCreate.status, 201);
    const jsonCreate = await resCreate.json();
    const apptId = trackAppointment(jsonCreate.data.appointmentId);

    const resNoShow = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'no_show' }),
    });
    assert.equal(resNoShow.status, 200);

    const resUpdate = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resUpdate.status, 400);
    const jsonUpdate = await resUpdate.json();
    assert.match(jsonUpdate.message, /Cannot update status of an appointment that is already no_show/i);

    const dbAppt = await Appointment.findByPk(apptId);
    assert.equal(dbAppt.status, 'no_show');
  });

  // 14. Completed appointment cannot be reopened
  test('14. Completed appointment cannot be reopened (400 Bad Request, DB status unchanged)', async () => {
    const slot = '2027-01-20T11:00:00.000Z';
    const resCreate = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slot, durationMinutes: 30 }),
    });
    assert.equal(resCreate.status, 201);
    const jsonCreate = await resCreate.json();
    const apptId = trackAppointment(jsonCreate.data.appointmentId);

    const resConfirm = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resConfirm.status, 200);

    const resComplete = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.doctor1}`,
      },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(resComplete.status, 200);

    // Attempt to reopen to confirmed
    const resReopen = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resReopen.status, 400);
    const jsonReopen = await resReopen.json();
    assert.match(jsonReopen.message, /Cannot update status of an appointment that is already completed/i);

    // Attempt to change to no_show
    const resNoShow = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'no_show' }),
    });
    assert.equal(resNoShow.status, 400);

    const dbAppt = await Appointment.findByPk(apptId);
    assert.equal(dbAppt.status, 'completed');
  });

  // 15. Legitimate status transitions succeed and update database correctly
  test('15. Legitimate status transitions for non-terminal appointments succeed (scheduled -> confirmed -> completed)', async () => {
    const slot = '2027-01-20T14:00:00.000Z';
    const resCreate = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      },
      body: JSON.stringify({ doctorId: doctors.d1.doctorId, scheduledStart: slot, durationMinutes: 30 }),
    });
    assert.equal(resCreate.status, 201);
    const jsonCreate = await resCreate.json();
    const apptId = trackAppointment(jsonCreate.data.appointmentId);
    assert.equal(jsonCreate.data.status, 'scheduled');

    // scheduled -> confirmed
    const resConfirm = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resConfirm.status, 200);
    const jsonConfirm = await resConfirm.json();
    assert.equal(jsonConfirm.data.status, 'confirmed');

    let dbAppt = await Appointment.findByPk(apptId);
    assert.equal(dbAppt.status, 'confirmed');

    // Idempotent update: confirmed -> confirmed returns 200
    const resIdempotent = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.receptionist}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    assert.equal(resIdempotent.status, 200);

    // confirmed -> completed
    const resComplete = await fetch(`${baseUrl}/api/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.doctor1}`,
      },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(resComplete.status, 200);
    const jsonComplete = await resComplete.json();
    assert.equal(jsonComplete.data.status, 'completed');

    dbAppt = await Appointment.findByPk(apptId);
    assert.equal(dbAppt.status, 'completed');
  });

  test('16. All terminal statuses reject cancellation and rescheduling without changing persisted fields', async () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      const appointment = await createAppointmentFixture(status);
      const originalStart = new Date(appointment.scheduledStart).getTime();
      const originalEnd = new Date(appointment.scheduledEnd).getTime();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.patient1}`,
      };

      const cancel = await fetch(`${baseUrl}/api/appointments/${appointment.appointmentId}/cancel`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ reason: 'Terminal status regression' }),
      });
      assert.equal(cancel.status, 400, `${status} appointment cancellation must be rejected`);

      const reschedule = await fetch(`${baseUrl}/api/appointments/${appointment.appointmentId}/reschedule`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ scheduledStart: new Date(originalStart + 7 * 24 * 60 * 60 * 1000).toISOString() }),
      });
      assert.equal(reschedule.status, 400, `${status} appointment rescheduling must be rejected`);

      const persisted = await Appointment.findByPk(appointment.appointmentId);
      assert.equal(persisted.status, status);
      assert.equal(new Date(persisted.scheduledStart).getTime(), originalStart);
      assert.equal(new Date(persisted.scheduledEnd).getTime(), originalEnd);
    }
  });

  test('17. Concurrent cancellation and completion serialize without overwriting a terminal state', async () => {
    const appointment = await createAppointmentFixture('scheduled');
    const [cancel, complete] = await Promise.all([
      fetch(`${baseUrl}/api/appointments/${appointment.appointmentId}/cancel`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.patient1}`,
        },
        body: JSON.stringify({ reason: 'Concurrent lifecycle regression' }),
      }),
      fetch(`${baseUrl}/api/appointments/${appointment.appointmentId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.doctor1}`,
        },
        body: JSON.stringify({ status: 'completed' }),
      }),
    ]);

    assert.deepEqual([cancel.status, complete.status].sort(), [200, 400]);
    const winnerResponse = cancel.status === 200 ? cancel : complete;
    const winner = await winnerResponse.json();
    const persisted = await Appointment.findByPk(appointment.appointmentId);
    assert.equal(persisted.status, winner.data.status);
    assert.ok(['cancelled', 'completed'].includes(persisted.status));
  });
});
