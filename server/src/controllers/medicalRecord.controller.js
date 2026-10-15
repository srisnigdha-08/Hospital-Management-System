const path = require('path');
const fs = require('fs');
const {
  sequelize, MedicalRecord, Prescription, PrescriptionItem, MedicalAttachment,
  Patient, Doctor, User, Appointment, AppointmentReminder,
} = require('../models');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const auditLog = require('../services/auditLog.service');
const { createAppointmentReminderLifecycle } = require('../services/appointmentReminderLifecycle.service');
const { getPagination, buildMeta } = require('../utils/pagination');
const {
  ALLOWED_EXT_MAP,
  validateFileSignature,
  cleanupUploadedFile,
  resolveSafeFilePath,
} = require('../utils/fileSecurity');
const { CLINICAL_APPOINTMENT_STATUSES, assertDoctorCanAccessPatient } = require('../services/careRelationship.service');

const appointmentReminderLifecycle = createAppointmentReminderLifecycle({ AppointmentReminder, Patient });

const ATTACHMENT_PUBLIC_ATTRIBUTES = [
  'attachmentId',
  'recordId',
  'fileName',
  'fileType',
  'fileSizeBytes',
  'uploadedBy',
  'uploadedAt',
];

const recordIncludes = [
  { model: Patient, include: [{ model: User, attributes: ['userId', 'firstName', 'lastName'] }] },
  { model: Doctor, include: [{ model: User, attributes: ['userId', 'firstName', 'lastName'] }] },
  { model: Prescription, include: [{ model: PrescriptionItem, as: 'items' }] },
  {
    model: MedicalAttachment,
    as: 'attachments',
    attributes: ATTACHMENT_PUBLIC_ATTRIBUTES,
  },
];

/** Asserts that caller has permission to view a specific medical record. */
async function assertCanAccessRecord(req, record) {
  if (req.user.roleName === 'receptionist') {
    throw ApiError.forbidden('Receptionists are not permitted to access clinical records');
  }
  if (req.user.roleName === 'admin') {
    return;
  }
  if (req.user.roleName === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.userId } });
    if (!patient || patient.patientId !== record.patientId) {
      throw ApiError.forbidden('You do not have access to this medical record');
    }
    return;
  }
  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) {
      throw ApiError.forbidden('No doctor profile is linked to this account');
    }
    if (doctor.doctorId === record.doctorId) {
      return;
    }
    await assertDoctorCanAccessPatient(doctor.doctorId, record.patientId);
    return;
  }
  throw ApiError.forbidden('Unauthorized role for medical record access');
}

/** Doctors may only author records under their own doctor profile. */
async function resolveDoctorIdForRequest(req) {
  if (req.user.roleName !== 'doctor') return req.body.doctorId || null;
  const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
  if (!doctor) throw ApiError.forbidden('No doctor profile is linked to this account');
  return doctor.doctorId;
}

const createRecord = asyncHandler(async (req, res) => {
  const { patientId, appointmentId, visitDate, symptoms, diagnosis, treatmentNotes, followUpDate, prescriptionItems } = req.body;

  const doctorId = await resolveDoctorIdForRequest(req);
  if (!doctorId) throw ApiError.badRequest('doctorId is required');

  const [patient, doctor] = await Promise.all([Patient.findByPk(patientId), Doctor.findByPk(doctorId)]);
  if (!patient) throw ApiError.notFound('Patient not found');
  if (!doctor) throw ApiError.notFound('Doctor not found');

  const record = await sequelize.transaction(async (t) => {
    let appointment = null;
    if (appointmentId) {
      appointment = await Appointment.findByPk(appointmentId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!appointment) throw ApiError.notFound('Appointment not found');
      if (String(appointment.patientId) !== String(patientId) || String(appointment.doctorId) !== String(doctorId)) {
        throw ApiError.badRequest('Appointment must belong to the specified patient and doctor');
      }
      if (!CLINICAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
        throw ApiError.badRequest(`Cannot create a medical record for an appointment that is ${appointment.status}`);
      }
    } else if (req.user.roleName === 'doctor') {
      await assertDoctorCanAccessPatient(doctorId, patientId, t);
    }

    const created = await MedicalRecord.create(
      { patientId, doctorId, appointmentId: appointmentId || null, visitDate, symptoms, diagnosis, treatmentNotes, followUpDate: followUpDate || null },
      { transaction: t }
    );

    if (Array.isArray(prescriptionItems) && prescriptionItems.length) {
      const prescription = await Prescription.create({ recordId: created.recordId }, { transaction: t });
      await PrescriptionItem.bulkCreate(
        prescriptionItems.map((item) => ({ ...item, prescriptionId: prescription.prescriptionId })),
        { transaction: t }
      );
    }

    if (appointment && ['scheduled', 'confirmed'].includes(appointment.status)) {
      await Appointment.update({ status: 'completed' }, { where: { appointmentId }, transaction: t });
      await appointmentReminderLifecycle.invalidatePending(appointment, 'completed', t);
    }

    return created;
  });

  await auditLog.record({ userId: req.user.userId, action: 'CREATE_MEDICAL_RECORD', entityType: 'MedicalRecord', entityId: record.recordId, ipAddress: req.ip });

  const full = await MedicalRecord.findByPk(record.recordId, { include: recordIncludes });
  new ApiResponse(201, full, 'Medical record created').send(res);
});

const listRecords = asyncHandler(async (req, res) => {
  if (req.user.roleName === 'receptionist') {
    throw ApiError.forbidden('Receptionists are not permitted to access clinical records');
  }

  const { page, limit, offset } = getPagination(req.query);
  const where = {};

  if (req.user.roleName === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.userId } });
    where.patientId = patient ? patient.patientId : -1;
  } else if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) {
      where.doctorId = -1;
    } else if (req.query.patientId) {
      const patientId = Number(req.query.patientId);
      await assertDoctorCanAccessPatient(doctor.doctorId, patientId);
      where.patientId = patientId;
    } else {
      where.doctorId = doctor.doctorId;
    }
  } else {
    // admin
    if (req.query.patientId) where.patientId = req.query.patientId;
    if (req.query.doctorId) where.doctorId = req.query.doctorId;
  }

  const { rows, count } = await MedicalRecord.findAndCountAll({
    where,
    include: recordIncludes,
    limit,
    offset,
    order: [['visitDate', 'DESC']],
    distinct: true,
  });

  new ApiResponse(200, rows, 'OK', buildMeta({ page, limit, total: count })).send(res);
});

const getRecord = asyncHandler(async (req, res) => {
  const record = await MedicalRecord.findByPk(req.params.id, { include: recordIncludes });
  if (!record) throw ApiError.notFound('Medical record not found');

  await assertCanAccessRecord(req, record);

  new ApiResponse(200, record).send(res);
});

const updateRecord = asyncHandler(async (req, res) => {
  const record = await MedicalRecord.findByPk(req.params.id);
  if (!record) throw ApiError.notFound('Medical record not found');

  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor || doctor.doctorId !== record.doctorId) {
      throw ApiError.forbidden('You may only update records where you are the attending doctor');
    }
  }

  const { diagnosis, symptoms, treatmentNotes, followUpDate } = req.body;
  Object.assign(record, {
    ...(diagnosis !== undefined && { diagnosis }),
    ...(symptoms !== undefined && { symptoms }),
    ...(treatmentNotes !== undefined && { treatmentNotes }),
    ...(followUpDate !== undefined && { followUpDate: followUpDate || null }),
  });
  await record.save();

  await auditLog.record({ userId: req.user.userId, action: 'UPDATE_MEDICAL_RECORD', entityType: 'MedicalRecord', entityId: record.recordId, ipAddress: req.ip });

  const full = await MedicalRecord.findByPk(record.recordId, { include: recordIncludes });
  new ApiResponse(200, full, 'Medical record updated').send(res);
});

const uploadAttachment = asyncHandler(async (req, res) => {
  if (req.user.roleName === 'receptionist') {
    if (req.file) await cleanupUploadedFile(req.file.path);
    throw ApiError.forbidden('Receptionists are not permitted to upload clinical attachments');
  }

  const record = await MedicalRecord.findByPk(req.params.id);
  if (!record) {
    if (req.file) await cleanupUploadedFile(req.file.path);
    throw ApiError.notFound('Medical record not found');
  }

  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) {
      if (req.file) await cleanupUploadedFile(req.file.path);
      throw ApiError.forbidden('Doctor profile not found');
    }
    if (doctor.doctorId !== record.doctorId) {
      if (req.file) await cleanupUploadedFile(req.file.path);
      throw ApiError.forbidden('Only the attending doctor or an administrator may upload attachments to this record');
    }
  } else if (req.user.roleName !== 'admin') {
    if (req.file) await cleanupUploadedFile(req.file.path);
    throw ApiError.forbidden('Only the attending doctor or an administrator may upload attachments to this record');
  }

  if (!req.file) throw ApiError.badRequest('No file was uploaded');

  const ext = path.extname(req.file.originalname || '').toLowerCase();

  try {
    // Magic byte / file signature inspection
    await validateFileSignature(req.file.path, ext);

    const safeFilename = path.basename(req.file.path);
    const normalizedPosixPath = path.posix.join(env.upload.dir, safeFilename);

    const attachment = await MedicalAttachment.create({
      recordId: record.recordId,
      fileName: req.file.originalname,
      filePath: normalizedPosixPath,
      fileType: req.file.mimetype,
      fileSizeBytes: req.file.size,
      uploadedBy: req.user.userId,
    });

    await auditLog.record({
      userId: req.user.userId,
      action: 'UPLOAD_ATTACHMENT',
      entityType: 'MedicalRecord',
      entityId: record.recordId,
      ipAddress: req.ip,
    });

    const safeAttachment = {
      attachmentId: attachment.attachmentId,
      recordId: attachment.recordId,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
      fileSizeBytes: attachment.fileSizeBytes,
      uploadedBy: attachment.uploadedBy,
      uploadedAt: attachment.uploadedAt,
    };

    new ApiResponse(201, safeAttachment, 'Attachment uploaded').send(res);
  } catch (err) {
    await cleanupUploadedFile(req.file.path);
    throw err;
  }
});

const downloadAttachment = asyncHandler(async (req, res) => {
  const { id: recordId, attachmentId } = req.params;

  const record = await MedicalRecord.findByPk(recordId);
  if (!record) throw ApiError.notFound('Medical record not found');

  const attachment = await MedicalAttachment.findOne({
    where: { attachmentId, recordId },
  });
  if (!attachment) throw ApiError.notFound('Attachment not found for this medical record');

  await assertCanAccessRecord(req, record);

  const uploadDir = path.resolve(process.cwd(), env.upload.dir);
  const absolutePath = resolveSafeFilePath(uploadDir, attachment.filePath);

  if (!fs.existsSync(absolutePath)) {
    throw ApiError.notFound('Attachment file not found on storage');
  }

  // Safe headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  const ext = path.extname(attachment.fileName || '').toLowerCase();
  const safeMime = ALLOWED_EXT_MAP[ext]?.mime || 'application/octet-stream';
  res.setHeader('Content-Type', safeMime);

  await auditLog.record({
    userId: req.user.userId,
    action: 'DOWNLOAD_ATTACHMENT',
    entityType: 'MedicalAttachment',
    entityId: attachment.attachmentId,
    ipAddress: req.ip,
  });

  res.download(absolutePath, attachment.fileName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to download file' });
    }
  });
});

module.exports = {
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  uploadAttachment,
  downloadAttachment,
};
