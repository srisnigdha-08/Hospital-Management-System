require('./helpers/require-test-environment');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');

const app = require('../src/app');
const env = require('../src/config/env');
const { validateJwtSecrets } = env;
const {
  User,
  Role,
  Patient,
  Doctor,
  Appointment,
  AuditLog,
} = require('../src/models');
const { signAccessToken } = require('../src/services/token.service');

describe('Phase 3.1: Critical Authorization & JWT Hardening Suite', () => {
  let server;
  let baseUrl;

  const tokens = {};
  const users = {};
  const doctors = {};
  const patients = {};
  const createdAppointmentIds = [];
  const createdUserIds = [];

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
    if (createdAppointmentIds.length > 0) {
      await AuditLog.destroy({
        where: {
          action: 'UPDATE_APPOINTMENT_STATUS',
          entityType: 'Appointment',
          entityId: { [Op.in]: createdAppointmentIds },
        },
      }).catch(() => {});
    }
    // Clean up created appointments
    if (createdAppointmentIds.length > 0) {
      await Appointment.destroy({
        where: { appointmentId: { [Op.in]: createdAppointmentIds } },
      }).catch(() => {});
    }
    // Clean up created temporary users
    if (createdUserIds.length > 0) {
      await User.destroy({
        where: { userId: { [Op.in]: createdUserIds } },
      }).catch(() => {});
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  function trackAppointment(id) {
    if (id) createdAppointmentIds.push(id);
    return id;
  }

  // =========================================================================
  // Section 1: JWT Secret Configuration Validation
  // =========================================================================
  describe('1. JWT Secret Configuration Validation', () => {
    test('1a. Production validation throws when access secret is missing or empty', () => {
      assert.throws(
        () => validateJwtSecrets('', 'valid-refresh-secret-min-32-chars-long-abc', true),
        /JWT_ACCESS_SECRET is required/
      );
      assert.throws(
        () => validateJwtSecrets(null, 'valid-refresh-secret-min-32-chars-long-abc', true),
        /JWT_ACCESS_SECRET is required/
      );
      assert.throws(
        () => validateJwtSecrets('   ', 'valid-refresh-secret-min-32-chars-long-abc', true),
        /JWT_ACCESS_SECRET is required/
      );
    });

    test('1b. Production validation throws when refresh secret is missing or empty', () => {
      assert.throws(
        () => validateJwtSecrets('valid-access-secret-min-32-chars-long-abc', '', true),
        /JWT_REFRESH_SECRET is required/
      );
      assert.throws(
        () => validateJwtSecrets('valid-access-secret-min-32-chars-long-abc', null, true),
        /JWT_REFRESH_SECRET is required/
      );
    });

    test('1c. Production validation throws when secrets use known insecure defaults', () => {
      assert.throws(
        () => validateJwtSecrets('dev-access-secret-change-me', 'valid-refresh-secret-min-32-chars-long-abc', true),
        /cannot use a known insecure default/
      );
      assert.throws(
        () => validateJwtSecrets('valid-access-secret-min-32-chars-long-abc', 'replace-with-a-different-long-random-string', true),
        /cannot use a known insecure default/
      );
      assert.throws(
        () => validateJwtSecrets('change-me', 'valid-refresh-secret-min-32-chars-long-abc', true),
        /cannot use a known insecure default/
      );
    });

    test('1d. Production validation throws when secrets are under 32 characters', () => {
      assert.throws(
        () => validateJwtSecrets('short-access-secret-under-32', 'valid-refresh-secret-min-32-chars-long-abc', true),
        /must be at least 32 characters long/
      );
      assert.throws(
        () => validateJwtSecrets('valid-access-secret-min-32-chars-long-abc', 'short-refresh-secret-under-32', true),
        /must be at least 32 characters long/
      );
    });

    test('1e. Production validation throws when access and refresh secrets are identical', () => {
      const sameSecret = 'an-identical-secret-that-is-at-least-32-characters-long!';
      assert.throws(
        () => validateJwtSecrets(sameSecret, sameSecret, true),
        /must be distinct values/
      );
    });

    test('1f. Production validation succeeds and trims distinct 32+ char secrets', () => {
      const access = '   custom-production-access-secret-32-chars-minimum!   ';
      const refresh = '   custom-production-refresh-secret-32-chars-minimum!   ';
      const result = validateJwtSecrets(access, refresh, true);
      assert.equal(result.accessSecret, access.trim());
      assert.equal(result.refreshSecret, refresh.trim());
    });

    test('1g. Development validation provides distinct fallbacks when unset', () => {
      const result = validateJwtSecrets(undefined, undefined, false);
      assert.ok(result.accessSecret);
      assert.ok(result.refreshSecret);
      assert.notEqual(result.accessSecret, result.refreshSecret);
    });
  });

  // =========================================================================
  // Section 2: Algorithm Pinning & Token Verification Security
  // =========================================================================
  describe('2. Algorithm Pinning & Token Verification Security', () => {
    test('2a. Valid HS256 access token is accepted on /api/auth/me (200 OK)', async () => {
      assert.equal(jwt.decode(tokens.patient1).tokenVersion, users.patient1.tokenVersion);
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${tokens.patient1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.user.email, users.patient1.email);
    });

    test('2a-1. Access token with an outdated token version is rejected', async () => {
      const staleToken = jwt.sign(
        { sub: users.patient1.userId, role: users.patient1.roleId, tokenVersion: users.patient1.tokenVersion + 1 },
        env.jwt.accessSecret,
        { algorithm: 'HS256', expiresIn: '15m' }
      );
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${staleToken}` },
      });
      assert.equal(res.status, 401);
    });

    test('2a-2. Access token without a token version is rejected', async () => {
      const legacyToken = jwt.sign(
        { sub: users.patient1.userId, role: users.patient1.roleId },
        env.jwt.accessSecret,
        { algorithm: 'HS256', expiresIn: '15m' }
      );
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${legacyToken}` },
      });
      assert.equal(res.status, 401);
    });

    test('2b. Token signed with algorithm "none" is rejected (401 Unauthorized)', async () => {
      // Craft an unsigned token with alg: none
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: users.patient1.userId,
        role: users.patient1.roleId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      const unsignedToken = `${header}.${payload}.`;

      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${unsignedToken}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Invalid access token');
    });

    test('2c. Token signed with unexpected algorithm (HS384) is rejected (401 Unauthorized)', async () => {
      const hs384Token = jwt.sign(
        { sub: users.patient1.userId, role: users.patient1.roleId },
        env.jwt.accessSecret,
        { algorithm: 'HS384', expiresIn: '15m' }
      );

      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${hs384Token}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Invalid access token');
    });

    test('2d. Tampered token payload is rejected (401 Unauthorized)', async () => {
      const [header, payload, signature] = tokens.patient1.split('.');
      // Tamper the payload: change subject to patient 2's ID
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      decoded.sub = users.patient2.userId;
      const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Invalid access token');
    });

    test('2e. Token signed with incorrect secret is rejected (401 Unauthorized)', async () => {
      const wrongSecretToken = jwt.sign(
        { sub: users.patient1.userId, role: users.patient1.roleId },
        'this-is-a-completely-different-wrong-secret-32-chars!',
        { algorithm: 'HS256', expiresIn: '15m' }
      );

      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${wrongSecretToken}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Invalid access token');
    });

    test('2f. Expired access token is rejected with explicit expiration error (401)', async () => {
      const expiredToken = jwt.sign(
        { sub: users.patient1.userId, role: users.patient1.roleId },
        env.jwt.accessSecret,
        { algorithm: 'HS256', expiresIn: '-1s' }
      );

      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Access token expired');
    });

    test('2g. Forged role claim in token does NOT elevate privileges (role resolved from DB)', async () => {
      // Patient 1 creates token with forged role claim pointing to admin (role: 1)
      const adminRole = await Role.findOne({ where: { roleName: 'admin' } });
      const forgedToken = jwt.sign(
        { sub: users.patient1.userId, role: adminRole.roleId, tokenVersion: users.patient1.tokenVersion },
        env.jwt.accessSecret,
        { algorithm: 'HS256', expiresIn: '15m' }
      );

      // Attempt to access admin-only endpoint: GET /api/users
      const res = await fetch(`${baseUrl}/api/users`, {
        headers: { Authorization: `Bearer ${forgedToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.message, /not permitted/i);
    });
  });

  // =========================================================================
  // Section 3: Appointment Object-Level Authorization (IDOR / BOLA Prevention)
  // =========================================================================
  describe('3. Appointment Object-Level Authorization (IDOR / BOLA Prevention)', () => {
    let testApptId;

    before(async () => {
      // Create a test appointment belonging to Patient 1 and Doctor 1
      const appt = await Appointment.create({
        patientId: patients.p1.patientId,
        doctorId: doctors.d1.doctorId,
        departmentId: doctors.d1.departmentId || 1,
        bookedByUserId: users.patient1.userId,
        scheduledStart: new Date('2028-05-10T10:00:00Z'),
        scheduledEnd: new Date('2028-05-10T10:30:00Z'),
        status: 'scheduled',
        reason: 'CONFIDENTIAL_TEST_EXAM_P1_D1',
      });
      testApptId = trackAppointment(appt.appointmentId);
    });

    test('3a. Patient 1 can retrieve their own appointment (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.patient1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.appointmentId, testApptId);
      assert.equal(json.data.reason, 'CONFIDENTIAL_TEST_EXAM_P1_D1');
      assert.deepEqual(Object.keys(json.data.Patient).sort(), ['User', 'patientId']);
      assert.deepEqual(Object.keys(json.data.Patient.User).sort(), ['firstName', 'lastName']);
    });

    test('3b. Patient 2 cannot retrieve Patient 1 appointment (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.patient2}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'You do not have access to this appointment');
    });

    test('3c. Attending Doctor (Doctor 1) can retrieve the appointment (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.appointmentId, testApptId);
    });

    test('3d. Unrelated Doctor (Doctor 2) cannot retrieve the appointment (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'You do not have access to this appointment');
    });

    test('3e. Receptionist can retrieve the appointment (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.receptionist}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.appointmentId, testApptId);
    });

    test('3f. Administrator can retrieve the appointment (200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.appointmentId, testApptId);
    });

    test('3g. Non-existent appointment returns 404 Not Found before authorization check', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/999999999`, {
        headers: { Authorization: `Bearer ${tokens.patient1}` },
      });
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Appointment not found');
    });

    test('3h. Patient account with missing patient profile fails closed (403 Forbidden)', async () => {
      // Create a temporary user with patient role but no Patient profile
      const patientRole = await Role.findOne({ where: { roleName: 'patient' } });
      const orphanUser = await User.create({
        roleId: patientRole.roleId,
        firstName: 'Orphan',
        lastName: 'Patient',
        email: `orphan.patient.${Date.now()}@hms.test`,
        phone: '9999999999',
        passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASHDUMMYHASH',
      });
      createdUserIds.push(orphanUser.userId);
      const orphanToken = signAccessToken(orphanUser);

      const res = await fetch(`${baseUrl}/api/appointments/${testApptId}`, {
        headers: { Authorization: `Bearer ${orphanToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'No patient profile is linked to this account');
    });
  });

  // =========================================================================
  // Section 4: Doctor Global Search Query Scoping
  // =========================================================================
  describe('4. Doctor Global Search Query Scoping', () => {
    let apptDoc1Id;
    let apptDoc2Id;
    const searchToken = `SEARCH_TOKEN_${Date.now()}`;

    before(async () => {
      // Create distinct appointments matching the same search term for Doctor 1 and Doctor 2
      const [a1, a2] = await Promise.all([
        Appointment.create({
          patientId: patients.p1.patientId,
          doctorId: doctors.d1.doctorId,
          departmentId: doctors.d1.departmentId || 1,
          bookedByUserId: users.patient1.userId,
          scheduledStart: new Date('2028-06-01T10:00:00Z'),
          scheduledEnd: new Date('2028-06-01T10:30:00Z'),
          status: 'scheduled',
          reason: `Followup Consultation ${searchToken} Alpha`,
        }),
        Appointment.create({
          patientId: patients.p2.patientId,
          doctorId: doctors.d2.doctorId,
          departmentId: doctors.d2.departmentId || 1,
          bookedByUserId: users.patient2.userId,
          scheduledStart: new Date('2028-06-01T11:00:00Z'),
          scheduledEnd: new Date('2028-06-01T11:30:00Z'),
          status: 'scheduled',
          reason: `Specialist Checkup ${searchToken} Beta`,
        }),
      ]);
      apptDoc1Id = trackAppointment(a1.appointmentId);
      apptDoc2Id = trackAppointment(a2.appointmentId);
    });

    test('4a. Doctor 1 search query only returns Doctor 1 appointments and omits Doctor 2', async () => {
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(searchToken)}`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      const returnedAppts = json.data.appointments;
      // Must contain Doctor 1's appointment
      const doc1Match = returnedAppts.find((a) => a.appointmentId === apptDoc1Id);
      assert.ok(doc1Match, 'Doctor 1 appointment should be found');
      assert.equal(doc1Match.doctorId, doctors.d1.doctorId);
      assert.deepEqual(Object.keys(doc1Match.Patient).sort(), ['User', 'patientId']);
      assert.deepEqual(Object.keys(doc1Match.Patient.User).sort(), ['firstName', 'lastName']);

      // Must NOT contain Doctor 2's appointment
      const doc2Match = returnedAppts.find((a) => a.appointmentId === apptDoc2Id);
      assert.equal(doc2Match, undefined, 'Doctor 2 appointment must not be visible to Doctor 1');
    });

    test('4b. Doctor 2 search query only returns Doctor 2 appointments and omits Doctor 1', async () => {
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(searchToken)}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      const returnedAppts = json.data.appointments;
      const doc2Match = returnedAppts.find((a) => a.appointmentId === apptDoc2Id);
      assert.ok(doc2Match, 'Doctor 2 appointment should be found');

      const doc1Match = returnedAppts.find((a) => a.appointmentId === apptDoc1Id);
      assert.equal(doc1Match, undefined, 'Doctor 1 appointment must not be visible to Doctor 2');
    });

    test('4c. Receptionist and Admin search returns appointments for both doctors', async () => {
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(searchToken)}`, {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      const returnedAppts = json.data.appointments;
      const doc1Match = returnedAppts.find((a) => a.appointmentId === apptDoc1Id);
      const doc2Match = returnedAppts.find((a) => a.appointmentId === apptDoc2Id);
      assert.ok(doc1Match, 'Admin sees Doctor 1 appointment');
      assert.ok(doc2Match, 'Admin sees Doctor 2 appointment');
    });

    test('4d. Doctor search fails closed (403 Forbidden) if doctor profile is missing', async () => {
      const docRole = await Role.findOne({ where: { roleName: 'doctor' } });
      const orphanDocUser = await User.create({
        roleId: docRole.roleId,
        firstName: 'Orphan',
        lastName: 'Doctor',
        email: `orphan.doctor.${Date.now()}@hms.test`,
        phone: '8888888888',
        passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASH',
      });
      createdUserIds.push(orphanDocUser.userId);
      const orphanDocToken = signAccessToken(orphanDocUser);

      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(searchToken)}`, {
        headers: { Authorization: `Bearer ${orphanDocToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'No doctor profile is linked to this account');
    });
  });

  // =========================================================================
  // Section 5: Patient Directory and Record Relationship Authorization
  // =========================================================================
  describe('5. Patient Directory and Record Relationship Authorization', () => {
    test('5a. Doctor patient directory returns identifiers and names only', async () => {
      const res = await fetch(`${baseUrl}/api/patients?limit=100`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.data.length > 0);

      for (const patient of json.data) {
        assert.deepEqual(Object.keys(patient).sort(), ['User', 'patientId']);
        assert.deepEqual(Object.keys(patient.User).sort(), ['firstName', 'lastName']);
      }
    });

    test('5b. Doctor search returns patient identifiers and names only', async () => {
      const term = users.patient1.firstName;
      const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(term)}`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      const result = json.data.patients.find((patient) => patient.patientId === patients.p1.patientId);
      assert.ok(result, 'Patient name search should find the patient');
      assert.deepEqual(Object.keys(result).sort(), ['User', 'patientId']);
      assert.deepEqual(Object.keys(result.User).sort(), ['firstName', 'lastName']);
    });

    test('5c. Doctor without a care relationship cannot retrieve or edit patient details', async () => {
      const detail = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(detail.status, 403);

      const update = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokens.doctor2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Unauthorized update' }),
      });
      assert.equal(update.status, 403);
    });

    test('5d. Doctor without a care relationship cannot add patient contacts or insurance', async () => {
      const contact = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/emergency-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Test Contact', relationship: 'Relative', phone: '+15555550123' }),
      });
      assert.equal(contact.status, 403);

      const insurance = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/insurance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName: 'Test Provider', policyNumber: 'TEST-POLICY' }),
      });
      assert.equal(insurance.status, 403);
    });

    test('5e. Doctor with an established care relationship can retrieve patient details', async () => {
      const res = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.patientId, patients.p1.patientId);
      assert.ok(Array.isArray(json.data.emergencyContacts));
    });

    test('5f. Doctor account without a doctor profile cannot use patient directory or detail routes', async () => {
      const doctorRole = await Role.findOne({ where: { roleName: 'doctor' } });
      const orphanDoctor = await User.create({
        roleId: doctorRole.roleId,
        firstName: 'Orphan',
        lastName: 'Doctor',
        email: `orphan.patient-access.${Date.now()}@hms.test`,
        passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASH',
      });
      createdUserIds.push(orphanDoctor.userId);
      const orphanToken = signAccessToken(orphanDoctor);

      const list = await fetch(`${baseUrl}/api/patients`, {
        headers: { Authorization: `Bearer ${orphanToken}` },
      });
      assert.equal(list.status, 403);

      const detail = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${orphanToken}` },
      });
      assert.equal(detail.status, 403);
    });
  });

  // =========================================================================
  // Section 6: Doctor Appointment Status Ownership
  // =========================================================================
  describe('6. Doctor Appointment Status Ownership', () => {
    let ownedAppointmentId;

    before(async () => {
      const appointment = await Appointment.create({
        patientId: patients.p1.patientId,
        doctorId: doctors.d1.doctorId,
        departmentId: doctors.d1.departmentId || 1,
        bookedByUserId: users.patient1.userId,
        scheduledStart: new Date('2028-07-10T10:00:00Z'),
        scheduledEnd: new Date('2028-07-10T10:30:00Z'),
        status: 'scheduled',
        reason: 'Status ownership regression test',
      });
      ownedAppointmentId = trackAppointment(appointment.appointmentId);
    });

    test('6a. Doctor cannot change another doctor\'s appointment status', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${ownedAppointmentId}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokens.doctor2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      assert.equal(res.status, 403);
    });

    test('6b. Doctor can change status on their own appointment', async () => {
      const res = await fetch(`${baseUrl}/api/appointments/${ownedAppointmentId}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).data.status, 'confirmed');
    });

    test('6c. Terminal appointments cannot be moved to another status', async () => {
      for (const [index, terminalStatus] of ['cancelled', 'completed', 'no_show'].entries()) {
        const appointment = await Appointment.create({
          patientId: patients.p1.patientId,
          doctorId: doctors.d1.doctorId,
          departmentId: doctors.d1.departmentId || 1,
          bookedByUserId: users.patient1.userId,
          scheduledStart: new Date(`2028-07-11T${10 + index}:00:00Z`),
          scheduledEnd: new Date(`2028-07-11T${10 + index}:30:00Z`),
          status: terminalStatus,
          reason: 'Terminal appointment lifecycle regression test',
        });
        trackAppointment(appointment.appointmentId);

        const res = await fetch(`${baseUrl}/api/appointments/${appointment.appointmentId}/status`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed' }),
        });
        assert.equal(res.status, 400, `${terminalStatus} appointment should reject status changes`);
        await appointment.reload();
        assert.equal(appointment.status, terminalStatus);
      }
    });
  });

  // =========================================================================
  // Section 7: Dashboard Audit Activity Authorization
  // =========================================================================
  describe('7. Dashboard Audit Activity Authorization', () => {
    test('7a. Receptionist summary omits global audit activity', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: { Authorization: `Bearer ${tokens.receptionist}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.deepEqual(json.data.recentActivities, []);
    });

    test('7b. Administrator summary retains global audit activity', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.data.recentActivities));
    });

    test('7c. Doctor dashboard appointment summaries expose patient ID and name only', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      for (const activity of json.data.recentActivities) {
        assert.deepEqual(Object.keys(activity.Patient).sort(), ['User', 'patientId']);
        assert.deepEqual(Object.keys(activity.Patient.User).sort(), ['firstName', 'lastName']);
      }
    });
  });

  // =========================================================================
  // Section 8: Nested Patient Input Validation
  // =========================================================================
  describe('8. Nested Patient Input Validation', () => {
    test('8a. Emergency contact creation rejects missing required fields', async () => {
      const res = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/emergency-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.patient1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Incomplete Contact' }),
      });
      assert.equal(res.status, 400);
    });

    test('8b. Insurance creation rejects missing required fields', async () => {
      const res = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/insurance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.patient1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName: 'Incomplete Provider' }),
      });
      assert.equal(res.status, 400);
    });
  });

});
