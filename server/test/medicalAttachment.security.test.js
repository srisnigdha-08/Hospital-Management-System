require('./helpers/require-test-environment');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const app = require('../src/app');
const env = require('../src/config/env');
const {
  User,
  Role,
  Patient,
  Doctor,
  MedicalRecord,
  Prescription,
  MedicalAttachment,
  Appointment,
  PatientEmergencyContact,
  PatientInsurance,
  AuditLog,
} = require('../src/models');
const { signAccessToken } = require('../src/services/token.service');
const { cleanupUploadedFile, resolveSafeFilePath } = require('../src/utils/fileSecurity');

describe('Medical Attachment Security & Access Control Suite', () => {
  let server;
  let baseUrl;
  let tokens = {};
  let users = {};
  let doctors = {};
  let patients = {};
  let testRecord;
  let testAttachment;
  let testFilePath;
  let unrelatedPatient;
  let unrelatedPatientUser;
  const createdFiles = [];
  const createdAppointments = [];
  const createdRecords = [];
  const createdAttachments = [];
  const createdContacts = [];
  const createdInsurance = [];

  before(async () => {
    // 1. Start HTTP server on ephemeral port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 2. Fetch seed users and generate JWT access tokens
    const allUsers = await User.findAll({ include: [{ model: Role }] });
    for (const u of allUsers) {
      const roleName = u.Role?.roleName;
      users[roleName] = users[roleName] || u;
      tokens[roleName] = signAccessToken(u);
    }

    // Specific users
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

    const patientRole = await Role.findOne({ where: { roleName: 'patient' } });
    const fixtureId = crypto.randomUUID();
    unrelatedPatientUser = await User.create({
      roleId: patientRole.roleId,
      firstName: 'Isolated',
      lastName: 'Regression',
      email: `phase4-unrelated-${fixtureId}@example.test`,
      passwordHash: crypto.randomBytes(32).toString('hex'),
    });
    unrelatedPatient = await Patient.create({
      userId: unrelatedPatientUser.userId,
      dateOfBirth: '1990-01-01',
      gender: 'other',
      registrationNumber: `T-${fixtureId.replaceAll('-', '').slice(0, 28)}`,
    });

    // 3. Create or find test medical record (Patient 1, Doctor 1)
    testRecord = await MedicalRecord.findOne({
      where: { patientId: pat1.patientId, doctorId: doc1.doctorId },
    });
    if (!testRecord) {
      testRecord = await MedicalRecord.create({
        patientId: pat1.patientId,
        doctorId: doc1.doctorId,
        visitDate: '2026-10-10',
        diagnosis: 'Test Hypertension',
        symptoms: 'Headache',
      });
      createdRecords.push(testRecord);
    }

    // 4. Create a valid test PDF file on disk
    const uploadDir = path.resolve(process.cwd(), env.upload.dir);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const testFileName = `test-valid-${Date.now()}.pdf`;
    testFilePath = path.join(uploadDir, testFileName);
    const pdfContent = Buffer.from('%PDF-1.4\n%Test valid PDF content for security audit\n%%EOF');
    fs.writeFileSync(testFilePath, pdfContent);
    createdFiles.push(testFilePath);

    // 5. Create test attachment record in database
    testAttachment = await MedicalAttachment.create({
      recordId: testRecord.recordId,
      fileName: 'lab-report.pdf',
      filePath: path.posix.join(env.upload.dir, testFileName),
      fileType: 'application/pdf',
      fileSizeBytes: pdfContent.length,
      uploadedBy: d1User.userId,
    });
  });

  after(async () => {
    for (const record of createdRecords) {
      await AuditLog.destroy({ where: { entityType: 'MedicalRecord', entityId: record.recordId } }).catch(() => {});
    }
    for (const contact of createdContacts) {
      await PatientEmergencyContact.destroy({ where: { contactId: contact.contactId } }).catch(() => {});
    }
    for (const policy of createdInsurance) {
      await PatientInsurance.destroy({ where: { insuranceId: policy.insuranceId } }).catch(() => {});
    }
    // Clean up test attachment and files
    if (testAttachment) {
      await MedicalAttachment.destroy({ where: { attachmentId: testAttachment.attachmentId } }).catch(() => {});
    }
    for (const a of createdAttachments) {
      await MedicalAttachment.destroy({ where: { attachmentId: a.attachmentId } }).catch(() => {});
    }
    for (const r of createdRecords) {
      await MedicalRecord.destroy({ where: { recordId: r.recordId } }).catch(() => {});
    }
    for (const appt of createdAppointments) {
      await Appointment.destroy({ where: { appointmentId: appt.appointmentId } }).catch(() => {});
    }
    for (const f of createdFiles) {
      await cleanupUploadedFile(f).catch(() => {});
    }
    if (unrelatedPatient) {
      await Patient.destroy({ where: { patientId: unrelatedPatient.patientId } }).catch(() => {});
    }
    if (unrelatedPatientUser) {
      await User.destroy({ where: { userId: unrelatedPatientUser.userId } }).catch(() => {});
    }
    // Clean up test server
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function assertNoMedicalRecordSideEffects(diagnosis) {
    const [records, prescriptionCount] = await Promise.all([
      MedicalRecord.findAll({ where: { diagnosis }, attributes: ['recordId'] }),
      Prescription.count({
        include: [{ model: MedicalRecord, required: true, attributes: [], where: { diagnosis } }],
      }),
    ]);
    for (const record of records) {
      if (!createdRecords.some((created) => created.recordId === record.recordId)) createdRecords.push(record);
    }
    assert.equal(records.length, 0, 'Rejected request must not create a medical-record row');
    assert.equal(prescriptionCount, 0, 'Rejected request must not create a prescription row');
  }

  function sideEffectTestDiagnosis() {
    return `Phase 4 rejected write ${crypto.randomUUID()}`;
  }

  // 1. Unauthenticated download rejected
  test('1. Unauthenticated attachment download is rejected with 401', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`
    );
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // 2. Patient can download their own attachment
  test('2. A patient can download their own attachment (200 with safe headers)', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.patient1}` },
      }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const content = await res.text();
    assert.ok(content.startsWith('%PDF-1.4'));
  });

  // 3. Patient cannot download another patient's attachment
  test("3. A patient cannot download another patient's attachment (403 Forbidden)", async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.patient2}` },
      }
    );
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // 4. Attachment ID belonging to another record is rejected
  test('4. An attachment ID belonging to another record is rejected with 404', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/99999/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.patient1}` },
      }
    );
    assert.equal(res.status, 404);
  });

  // 5. Attending doctor can access patient attachment
  test("5. Attending doctor can access their patient's attachment (200)", async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      }
    );
    assert.equal(res.status, 200);
  });

  // 6. Unauthorized doctor cannot access attachment
  test('6. Doctor without care relationship cannot access patient attachment (403)', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      }
    );
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // 7. Receptionist cannot access clinical attachments or upload them
  test('7a. Receptionist cannot download clinical attachments (403 Forbidden)', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.receptionist}` },
      }
    );
    assert.equal(res.status, 403);
  });

  test('7b. Receptionist cannot upload clinical attachments (403 Forbidden)', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }),
      'rec-test.pdf'
    );

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.receptionist}` },
        body: fd,
      }
    );
    assert.equal(res.status, 403);
  });

  test('7c. Patient cannot upload an attachment to their own medical record (403 Forbidden)', async () => {
    const uploadDir = path.resolve(process.cwd(), env.upload.dir);
    const filesBefore = new Set(fs.readdirSync(uploadDir));
    const fileName = `patient-upload-${crypto.randomUUID()}.pdf`;
    const pdf = Buffer.from('%PDF-1.4\n%Synthetic patient upload rejection check\n%%EOF');
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), fileName);

    let response;
    let responseBody;
    try {
      response = await fetch(
        `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.patient1}` },
          body: fd,
        }
      );
      responseBody = await response.json();
    } finally {
      const unexpectedAttachments = await MedicalAttachment.findAll({
        where: { recordId: testRecord.recordId, fileName },
      });
      createdAttachments.push(...unexpectedAttachments);
      for (const attachment of unexpectedAttachments) {
        createdFiles.push(path.resolve(process.cwd(), attachment.filePath));
      }

      const filesAfter = new Set(fs.readdirSync(uploadDir));
      const unexpectedFiles = [...filesAfter].filter((name) => !filesBefore.has(name));

      assert.equal(unexpectedAttachments.length, 0, 'Rejected patient upload must not create attachment metadata');
      assert.deepEqual(unexpectedFiles, [], 'Rejected patient upload must not leave an uploaded file');
    }

    assert.equal(response.status, 403);
    assert.equal(responseBody.success, false);
  });

  test('7d. Receptionist cannot list medical records (403 Forbidden)', async () => {
    const res = await fetch(`${baseUrl}/api/medical-records`, {
      headers: { Authorization: `Bearer ${tokens.receptionist}` },
    });
    assert.equal(res.status, 403);
  });

  // 8. Admin can access attachments
  test('8. Admin can access attachments according to policy (200)', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      }
    );
    assert.equal(res.status, 200);
  });

  // 9. Missing records, missing attachments, and missing files handled safely
  test('9a. Non-existent attachment ID returns 404', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/99999`,
      {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      }
    );
    assert.equal(res.status, 404);
  });

  test('9b. Attachment pointing to non-existent file on storage returns 404', async () => {
    const ghost = await MedicalAttachment.create({
      recordId: testRecord.recordId,
      fileName: 'ghost.pdf',
      filePath: 'uploads/ghost-missing-file.pdf',
      fileType: 'application/pdf',
      uploadedBy: users.admin.userId,
    });

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${ghost.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      }
    );
    assert.equal(res.status, 404);
    await MedicalAttachment.destroy({ where: { attachmentId: ghost.attachmentId } });
  });

  // 10. Path traversal and manipulated stored paths are rejected
  test('10. Path traversal and manipulated paths are rejected safely', () => {
    const uploadDir = path.resolve(process.cwd(), env.upload.dir);

    // Traversal attempts must throw forbidden or badRequest
    assert.throws(() => {
      resolveSafeFilePath(uploadDir, '../../etc/passwd');
    });

    assert.throws(() => {
      resolveSafeFilePath(uploadDir, 'uploads/../../package.json');
    });

    assert.throws(() => {
      resolveSafeFilePath(uploadDir, null);
    });

    assert.throws(() => {
      resolveSafeFilePath(uploadDir, 'uploads/evil\0file.pdf');
    });
  });

  // 11. Unsupported extensions and mismatched file signatures are rejected
  test('11a. Unsupported file extension (.exe) is rejected with 400', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([Buffer.from('MZ executable test')], { type: 'application/x-msdownload' }),
      'malicious.exe'
    );

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
        body: fd,
      }
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /Unsupported file extension/i);
  });

  test('11b. Mismatched file signature (.pdf extension with fake content) is rejected with 400', async () => {
    const fd = new FormData();
    // Claiming PDF MIME and extension, but content is executable / fake bytes
    fd.append(
      'file',
      new Blob([Buffer.from('NOT A PDF FILE AT ALL - JUST RANDOM TEXT')], { type: 'application/pdf' }),
      'fake.pdf'
    );

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
        body: fd,
      }
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /signature does not match/i);
  });

  // 12. Oversized uploads return 400 Bad Request
  test('12. Oversized uploads return 400 Bad Request rather than 500 error', async () => {
    const maxMb = env.upload.maxMb;
    const oversizedBytes = (maxMb + 1) * 1024 * 1024;
    // Buffer with PDF header but oversized
    const header = Buffer.from('%PDF-1.4\n');
    const filler = Buffer.alloc(oversizedBytes - header.length);
    const largePdf = Buffer.concat([header, filler]);

    const fd = new FormData();
    fd.append('file', new Blob([largePdf], { type: 'application/pdf' }), 'large.pdf');

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
        body: fd,
      }
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /limit/i);
  });

  // 13. Failed uploads do not leave orphaned files
  test('13. Failed uploads do not leave orphaned files on disk', async () => {
    const uploadDir = path.resolve(process.cwd(), env.upload.dir);
    const filesBefore = new Set(fs.readdirSync(uploadDir));

    const fd = new FormData();
    fd.append(
      'file',
      new Blob([Buffer.from('FAKE CONTENT')], { type: 'application/pdf' }),
      'orphan-probe.pdf'
    );

    // Upload will fail due to signature mismatch
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
        body: fd,
      }
    );
    assert.equal(res.status, 400);

    const filesAfter = new Set(fs.readdirSync(uploadDir));
    // Verify no new files remain in uploadDir
    for (const f of filesAfter) {
      assert.ok(
        filesBefore.has(f),
        `Orphaned file "${f}" was left in upload directory after failed upload!`
      );
    }
  });

  // 14. Old public attachment URL no longer exposes file
  test('14. Public static /uploads URL returns 404 (no unauthenticated file serving)', async () => {
    const filename = path.basename(testFilePath);
    const res = await fetch(`${baseUrl}/uploads/${filename}`);
    assert.equal(res.status, 404);
  });

  // 15. Existing medical-record and auth functionality does not regress
  test('15a. Patient can list their own medical records', async () => {
    const res = await fetch(`${baseUrl}/api/medical-records`, {
      headers: { Authorization: `Bearer ${tokens.patient1}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.length > 0);
    assert.equal(json.data[0].patientId, patients.p1.patientId);
  });

  test('15b. Doctor 1 can fetch their patient medical record by ID', async () => {
    const res = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
      headers: { Authorization: `Bearer ${tokens.doctor1}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.recordId, testRecord.recordId);
  });

  test('15c. Successful valid attachment upload works for authorized doctor', async () => {
    const validPdf = Buffer.from('%PDF-1.4\n%Valid upload content\n%%EOF');
    const fd = new FormData();
    fd.append('file', new Blob([validPdf], { type: 'application/pdf' }), 'valid-test.pdf');

    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
        body: fd,
      }
    );
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.attachmentId);
    assert.equal(json.data.filePath, undefined, 'filePath must not be exposed in upload response');

    // Clean up created attachment via DB lookup
    const saved = await MedicalAttachment.findByPk(json.data.attachmentId);
    if (saved) {
      const diskPath = path.resolve(process.cwd(), saved.filePath);
      await cleanupUploadedFile(diskPath);
      await saved.destroy();
    }
  });

  // --- Phase 1.1 Regression Tests: Fix 1 (Clinical Appointment Statuses & Access Scope) ---

  test('16a. Doctor with only a no-show appointment cannot access patient medical records or attachments (403)', async () => {
    // Create no-show appointment for Doctor 2 with Patient 1
    const appt = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      departmentId: doctors.d2.departmentId,
      scheduledStart: new Date('2026-10-15T09:00:00Z'),
      scheduledEnd: new Date('2026-10-15T09:30:00Z'),
      status: 'no_show',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appt);

    try {
      // 1. Attempt to fetch specific record authored by Doctor 1
      const resRecord = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resRecord.status, 403, 'Doctor with no-show appointment must receive 403 on record detail');

      // 2. Attempt to download attachment
      const resAttach = await fetch(
        `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
        {
          headers: { Authorization: `Bearer ${tokens.doctor2}` },
        }
      );
      assert.equal(resAttach.status, 403, 'Doctor with no-show appointment must receive 403 on attachment download');

      // 3. Attempt to list patient records
      const resList = await fetch(`${baseUrl}/api/medical-records?patientId=${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resList.status, 403, 'Doctor with no-show appointment must receive 403 on listing patient records');
    } finally {
      await appt.destroy();
    }
  });

  test('16b. Doctor with only a cancelled appointment cannot access patient medical records or attachments (403)', async () => {
    // Create cancelled appointment for Doctor 2 with Patient 1
    const appt = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      departmentId: doctors.d2.departmentId,
      scheduledStart: new Date('2026-10-16T10:00:00Z'),
      scheduledEnd: new Date('2026-10-16T10:30:00Z'),
      status: 'cancelled',
      cancellationReason: 'Patient cancelled',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appt);

    try {
      const resRecord = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resRecord.status, 403, 'Doctor with cancelled appointment must receive 403 on record detail');

      const resAttach = await fetch(
        `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
        {
          headers: { Authorization: `Bearer ${tokens.doctor2}` },
        }
      );
      assert.equal(resAttach.status, 403, 'Doctor with cancelled appointment must receive 403 on attachment download');

      const resList = await fetch(`${baseUrl}/api/medical-records?patientId=${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resList.status, 403, 'Doctor with cancelled appointment must receive 403 on listing patient records');
    } finally {
      await appt.destroy();
    }
  });

  test('16c. Authorized doctor retains legitimate clinical access (scheduled/confirmed/completed)', async () => {
    // 1. Attending doctor (Doctor 1) has legitimate access
    const resDoc1 = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
      headers: { Authorization: `Bearer ${tokens.doctor1}` },
    });
    assert.equal(resDoc1.status, 200, 'Attending doctor retains legitimate access to their record');

    // 2. Doctor 2 with active clinical appointment (confirmed) has legitimate clinical access
    const appt = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      departmentId: doctors.d2.departmentId,
      scheduledStart: new Date('2026-10-17T11:00:00Z'),
      scheduledEnd: new Date('2026-10-17T11:30:00Z'),
      status: 'confirmed',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appt);

    try {
      const resRecord = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resRecord.status, 200, 'Doctor with confirmed appointment can access clinical record');

      const resAttach = await fetch(
        `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
        {
          headers: { Authorization: `Bearer ${tokens.doctor2}` },
        }
      );
      assert.equal(resAttach.status, 200, 'Doctor with confirmed appointment can download attachment');

      const resList = await fetch(`${baseUrl}/api/medical-records?patientId=${patients.p1.patientId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resList.status, 200, 'Doctor with confirmed appointment can list patient records');
    } finally {
      await appt.destroy();
    }
  });

  test('16d. Unrelated historical record does not automatically grant unrestricted access to another doctor\'s records', async () => {
    // Doctor 2 authored an old historical record for Patient 1 in the past
    const historicalRecord = await MedicalRecord.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      visitDate: '2024-05-10',
      diagnosis: 'Past Minor Sprain',
      symptoms: 'Mild ankle swelling',
    });
    createdRecords.push(historicalRecord);

    try {
      // Doctor 2 has NO active/completed appointment with Patient 1.
      // Doctor 2 must NOT be able to access Doctor 1's record.
      const resOtherRecord = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resOtherRecord.status, 403, 'Historical record alone must not grant access to another doctor\'s record');

      // Doctor 2 must NOT be able to download attachment from Doctor 1's record
      const resOtherAttach = await fetch(
        `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
        {
          headers: { Authorization: `Bearer ${tokens.doctor2}` },
        }
      );
      assert.equal(resOtherAttach.status, 403, 'Historical record alone must not grant access to another doctor\'s attachment');

      // But Doctor 2 DOES retain access to their own historical record
      const resOwnRecord = await fetch(`${baseUrl}/api/medical-records/${historicalRecord.recordId}`, {
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
      });
      assert.equal(resOwnRecord.status, 200, 'Doctor can still access their own authored historical record');
    } finally {
      await historicalRecord.destroy();
    }
  });

  // --- Phase 1.1 Regression Tests: Fix 2 (Restrict Uploads to Attending Doctor or Admin) ---

  test('17a. Non-attending doctor cannot upload attachment even if they have an active appointment (403)', async () => {
    // Doctor 2 has a confirmed appointment with Patient 1
    const appt = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      departmentId: doctors.d2.departmentId,
      scheduledStart: new Date('2026-10-18T14:00:00Z'),
      scheduledEnd: new Date('2026-10-18T14:30:00Z'),
      status: 'confirmed',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appt);

    const validPdf = Buffer.from('%PDF-1.4\n%Attempted upload by non-attending doctor\n%%EOF');
    const fd = new FormData();
    fd.append('file', new Blob([validPdf], { type: 'application/pdf' }), 'doc2-probe.pdf');

    try {
      // Doctor 2 attempts to upload to testRecord (authored by Doctor 1)
      const res = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.doctor2}` },
        body: fd,
      });
      assert.equal(res.status, 403, 'Non-attending doctor must be rejected with 403 Forbidden');
      const data = await res.json();
      assert.match(data.message, /attending doctor or an administrator/i);
    } finally {
      await appt.destroy();
    }
  });

  test('17b. Attending doctor and admin are authorized to upload attachments (201)', async () => {
    // 1. Attending doctor (Doctor 1) upload
    const validDocPdf = Buffer.from('%PDF-1.4\n%Attending doctor valid upload\n%%EOF');
    const fdDoc = new FormData();
    fdDoc.append('file', new Blob([validDocPdf], { type: 'application/pdf' }), 'attending-upload.pdf');

    const resDoc = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}` },
      body: fdDoc,
    });
    assert.equal(resDoc.status, 201, 'Attending doctor upload must succeed with 201 Created');
    const jsonDoc = await resDoc.json();
    assert.ok(jsonDoc.data.attachmentId);
    assert.equal(jsonDoc.data.filePath, undefined);

    const savedDocAttach = await MedicalAttachment.findByPk(jsonDoc.data.attachmentId);
    if (savedDocAttach) {
      await cleanupUploadedFile(path.resolve(process.cwd(), savedDocAttach.filePath));
      await savedDocAttach.destroy();
    }

    // 2. Admin upload
    const validAdminPdf = Buffer.from('%PDF-1.4\n%Admin valid upload\n%%EOF');
    const fdAdmin = new FormData();
    fdAdmin.append('file', new Blob([validAdminPdf], { type: 'application/pdf' }), 'admin-upload.pdf');

    const resAdmin = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}` },
      body: fdAdmin,
    });
    assert.equal(resAdmin.status, 201, 'Admin upload must succeed with 201 Created');
    const jsonAdmin = await resAdmin.json();
    assert.ok(jsonAdmin.data.attachmentId);
    assert.equal(jsonAdmin.data.filePath, undefined);

    const savedAdminAttach = await MedicalAttachment.findByPk(jsonAdmin.data.attachmentId);
    if (savedAdminAttach) {
      await cleanupUploadedFile(path.resolve(process.cwd(), savedAdminAttach.filePath));
      await savedAdminAttach.destroy();
    }
  });

  // --- Phase 1.1 Regression Tests: Fix 3 (Stop Exposing Internal File Paths) ---

  test('18a. GET /api/medical-records and GET /api/medical-records/:id do not expose internal filePath', async () => {
    // 1. Check detail endpoint GET /api/medical-records/:id
    const resDetail = await fetch(`${baseUrl}/api/medical-records/${testRecord.recordId}`, {
      headers: { Authorization: `Bearer ${tokens.doctor1}` },
    });
    assert.equal(resDetail.status, 200);
    const jsonDetail = await resDetail.json();
    assert.ok(Array.isArray(jsonDetail.data.attachments), 'Record attachments must be an array');
    assert.ok(jsonDetail.data.attachments.length > 0, 'Record must have attachments');

    for (const attach of jsonDetail.data.attachments) {
      assert.equal(attach.filePath, undefined, 'Detail endpoint must not expose filePath');
      assert.ok(attach.attachmentId, 'attachmentId must be present');
      assert.ok(attach.recordId, 'recordId must be present');
      assert.ok(attach.fileName, 'fileName must be present');
      assert.ok(attach.fileType, 'fileType must be present');
      assert.ok(attach.fileSizeBytes, 'fileSizeBytes must be present');
      assert.ok(attach.uploadedBy, 'uploadedBy must be present');
      assert.ok(attach.uploadedAt, 'uploadedAt must be present');
    }

    // 2. Check list endpoint GET /api/medical-records
    const resList = await fetch(`${baseUrl}/api/medical-records`, {
      headers: { Authorization: `Bearer ${tokens.doctor1}` },
    });
    assert.equal(resList.status, 200);
    const jsonList = await resList.json();
    assert.ok(Array.isArray(jsonList.data), 'List records must return array');

    for (const rec of jsonList.data) {
      if (Array.isArray(rec.attachments)) {
        for (const attach of rec.attachments) {
          assert.equal(attach.filePath, undefined, 'List endpoint must not expose filePath');
          assert.ok(attach.attachmentId, 'attachmentId must be present');
          assert.ok(attach.fileName, 'fileName must be present');
        }
      }
    }
  });

  test('18b. Authenticated attachment download continues to function without filePath exposed in metadata', async () => {
    const res = await fetch(
      `${baseUrl}/api/medical-records/${testRecord.recordId}/attachments/${testAttachment.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${tokens.doctor1}` },
      }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const content = await res.text();
    assert.ok(content.startsWith('%PDF-1.4'), 'File content should match stored PDF header');
  });

  test('19a. Doctor cannot create a record for a patient without a care relationship', async () => {
    const diagnosis = sideEffectTestDiagnosis();
    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: unrelatedPatient.patientId,
        visitDate: '2026-10-17',
        diagnosis,
        prescriptionItems: [{ medicineName: 'Regression medicine', dosage: '1', frequency: 'daily', duration: '1 day' }],
      }),
    });

    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.message, /care relationship/i);
    await assertNoMedicalRecordSideEffects(diagnosis);
  });

  test('19b. Doctor cannot attach a medical record to another doctor\'s appointment', async () => {
    const diagnosis = sideEffectTestDiagnosis();
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d2.doctorId,
      departmentId: doctors.d2.departmentId,
      scheduledStart: new Date('2026-10-18T11:00:00Z'),
      scheduledEnd: new Date('2026-10-18T11:30:00Z'),
      status: 'scheduled',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appointment);

    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        appointmentId: appointment.appointmentId,
        visitDate: '2026-10-18',
        diagnosis,
        prescriptionItems: [{ medicineName: 'Regression medicine', dosage: '1', frequency: 'daily', duration: '1 day' }],
      }),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /belong to the specified patient and doctor/i);
    await assertNoMedicalRecordSideEffects(diagnosis);
    await appointment.reload();
    assert.equal(appointment.status, 'scheduled');
  });

  test('19c. Cancelled appointments cannot be completed through medical-record creation', async () => {
    const diagnosis = sideEffectTestDiagnosis();
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d1.doctorId,
      departmentId: doctors.d1.departmentId,
      scheduledStart: new Date('2026-10-19T11:00:00Z'),
      scheduledEnd: new Date('2026-10-19T11:30:00Z'),
      status: 'cancelled',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appointment);

    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        appointmentId: appointment.appointmentId,
        visitDate: '2026-10-19',
        diagnosis,
        prescriptionItems: [{ medicineName: 'Regression medicine', dosage: '1', frequency: 'daily', duration: '1 day' }],
      }),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /appointment that is cancelled/i);
    await assertNoMedicalRecordSideEffects(diagnosis);
    await appointment.reload();
    assert.equal(appointment.status, 'cancelled');
  });

  test('19d. Doctor can create a matching record and complete its appointment', async () => {
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d1.doctorId,
      departmentId: doctors.d1.departmentId,
      scheduledStart: new Date('2026-10-20T11:00:00Z'),
      scheduledEnd: new Date('2026-10-20T11:30:00Z'),
      status: 'confirmed',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appointment);

    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        appointmentId: appointment.appointmentId,
        visitDate: '2026-10-20',
        diagnosis: 'Authorization regression test',
      }),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    createdRecords.push(await MedicalRecord.findByPk(json.data.recordId));
    await appointment.reload();
    assert.equal(appointment.status, 'completed');
  });

  test('19d-1. Doctor can create a record without an appointment when a care relationship exists', async () => {
    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        visitDate: '2026-10-20',
        diagnosis: 'Authorization regression test without appointment ID',
      }),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    createdRecords.push(await MedicalRecord.findByPk(json.data.recordId));
    assert.equal(json.data.appointmentId, null);
  });

  test('19e. Administrator cannot attach an appointment to a different patient record', async () => {
    const diagnosis = sideEffectTestDiagnosis();
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d1.doctorId,
      departmentId: doctors.d1.departmentId,
      scheduledStart: new Date('2026-10-21T11:00:00Z'),
      scheduledEnd: new Date('2026-10-21T11:30:00Z'),
      status: 'scheduled',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appointment);

    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p2.patientId,
        doctorId: doctors.d1.doctorId,
        appointmentId: appointment.appointmentId,
        visitDate: '2026-10-21',
        diagnosis,
        prescriptionItems: [{ medicineName: 'Regression medicine', dosage: '1', frequency: 'daily', duration: '1 day' }],
      }),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /belong to the specified patient and doctor/i);
    await assertNoMedicalRecordSideEffects(diagnosis);
    await appointment.reload();
    assert.equal(appointment.status, 'scheduled');
  });

  test('19e-1. No-show appointments cannot be completed through medical-record creation', async () => {
    const diagnosis = sideEffectTestDiagnosis();
    const appointment = await Appointment.create({
      patientId: patients.p1.patientId,
      doctorId: doctors.d1.doctorId,
      departmentId: doctors.d1.departmentId,
      scheduledStart: new Date('2026-10-22T11:00:00Z'),
      scheduledEnd: new Date('2026-10-22T11:30:00Z'),
      status: 'no_show',
      bookedByUserId: users.admin.userId,
    });
    createdAppointments.push(appointment);

    const res = await fetch(`${baseUrl}/api/medical-records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.doctor1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patients.p1.patientId,
        appointmentId: appointment.appointmentId,
        visitDate: '2026-10-22',
        diagnosis,
        prescriptionItems: [{ medicineName: 'Regression medicine', dosage: '1', frequency: 'daily', duration: '1 day' }],
      }),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /appointment that is no_show/i);
    await assertNoMedicalRecordSideEffects(diagnosis);
    await appointment.reload();
    assert.equal(appointment.status, 'no_show');
  });

  test('19f. Emergency-contact creation ignores caller-supplied identifiers', async () => {
    const res = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/emergency-contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.patient1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: 999999999,
        patientId: patients.p2.patientId,
        isActive: false,
        unexpectedField: 'must not persist',
        fullName: 'Regression Contact',
        relationship: 'Relative',
        phone: '+15555550123',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.notEqual(json.data.contactId, 999999999);
    assert.equal(json.data.patientId, patients.p1.patientId);
    assert.equal(json.data.isActive, undefined);
    assert.equal(json.data.unexpectedField, undefined);
    const savedContact = await PatientEmergencyContact.findByPk(json.data.contactId);
    assert.equal(savedContact.patientId, patients.p1.patientId);
    assert.equal(savedContact.isActive, undefined);
    createdContacts.push(savedContact);
  });

  test('19g. Insurance creation ignores caller-supplied identifiers and active state', async () => {
    const res = await fetch(`${baseUrl}/api/patients/${patients.p1.patientId}/insurance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.patient1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        insuranceId: 999999999,
        patientId: patients.p2.patientId,
        providerName: 'Regression Provider',
        policyNumber: 'REGRESSION-POLICY',
        isActive: false,
        unexpectedField: 'must not persist',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.notEqual(json.data.insuranceId, 999999999);
    assert.equal(json.data.patientId, patients.p1.patientId);
    assert.equal(json.data.isActive, true);
    assert.equal(json.data.unexpectedField, undefined);
    const savedPolicy = await PatientInsurance.findByPk(json.data.insuranceId);
    assert.equal(savedPolicy.patientId, patients.p1.patientId);
    assert.equal(savedPolicy.isActive, true);
    assert.equal(savedPolicy.unexpectedField, undefined);
    createdInsurance.push(savedPolicy);
  });
});
