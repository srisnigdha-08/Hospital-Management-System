const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize, User, Role, Patient, PatientEmergencyContact, PatientInsurance, Doctor,
} = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const auditLog = require('../services/auditLog.service');
const { getPagination, buildMeta } = require('../utils/pagination');
const { assertDoctorCanAccessPatient } = require('../services/careRelationship.service');

const SALT_ROUNDS = 12;

const patientIncludes = [
  { model: User, attributes: ['userId', 'firstName', 'lastName', 'email', 'phone', 'isActive', 'avatarUrl'] },
  { model: PatientEmergencyContact, as: 'emergencyContacts' },
  { model: PatientInsurance, as: 'insurancePolicies' },
];

/** Enforces patient ownership and the clinical relationship rule for doctors. */
async function assertCanAccessPatient(req, patient) {
  if (['admin', 'receptionist'].includes(req.user.roleName)) return;
  if (req.user.roleName === 'patient' && patient.userId === req.user.userId) return;
  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) throw ApiError.forbidden('No doctor profile is linked to this account');
    await assertDoctorCanAccessPatient(doctor.doctorId, patient.patientId);
    return;
  }
  throw ApiError.forbidden('You do not have access to this patient record');
}

/** Admin/Receptionist-only: creates the login account and full patient profile together. */
const createPatient = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone, password,
    dateOfBirth, gender, bloodGroup,
    addressLine1, addressLine2, city, state, postalCode, country,
    emergencyContacts, insurancePolicies,
  } = req.body;

  const existing = await User.findOne({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const patientRole = await Role.findOne({ where: { roleName: 'patient' } });
  const passwordHash = await bcrypt.hash(password || crypto.randomBytes(8).toString('hex'), SALT_ROUNDS);

  const patient = await sequelize.transaction(async (t) => {
    const user = await User.create(
      { roleId: patientRole.roleId, firstName, lastName, email, phone, passwordHash },
      { transaction: t }
    );

    const created = await Patient.create(
      {
        userId: user.userId,
        dateOfBirth,
        gender,
        bloodGroup: bloodGroup || 'unknown',
        addressLine1, addressLine2, city, state, postalCode, country,
        registrationNumber: `REG-TMP-${crypto.randomBytes(4).toString('hex')}`,
      },
      { transaction: t }
    );
    created.registrationNumber = `REG-${String(created.patientId).padStart(6, '0')}`;
    await created.save({ transaction: t });

    if (Array.isArray(emergencyContacts) && emergencyContacts.length) {
      await PatientEmergencyContact.bulkCreate(
        emergencyContacts.map((c) => ({
          patientId: created.patientId,
          fullName: c.fullName,
          relationship: c.relationship,
          phone: c.phone,
          email: c.email || null,
          isPrimary: c.isPrimary ?? false,
        })),
        { transaction: t }
      );
    }
    if (Array.isArray(insurancePolicies) && insurancePolicies.length) {
      await PatientInsurance.bulkCreate(
        insurancePolicies.map((p) => ({
          patientId: created.patientId,
          providerName: p.providerName,
          policyNumber: p.policyNumber,
          groupNumber: p.groupNumber || null,
          validFrom: p.validFrom || null,
          validUntil: p.validUntil || null,
        })),
        { transaction: t }
      );
    }

    return created;
  });

  await auditLog.record({ userId: req.user.userId, action: 'CREATE_PATIENT', entityType: 'Patient', entityId: patient.patientId, ipAddress: req.ip });

  const full = await Patient.findByPk(patient.patientId, { include: patientIncludes });
  new ApiResponse(201, full, 'Patient registered').send(res);
});

const listPatients = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const isDoctor = req.user.roleName === 'doctor';
  if (isDoctor) {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) throw ApiError.forbidden('No doctor profile is linked to this account');
  }

  const userWhere = {};
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    const searchableFields = [{ firstName: { [Op.like]: term } }, { lastName: { [Op.like]: term } }];
    if (!isDoctor) searchableFields.push({ email: { [Op.like]: term } });
    userWhere[Op.or] = searchableFields;
  }
  const where = {};
  if (!isDoctor && req.query.gender) where.gender = req.query.gender;
  if (!isDoctor && req.query.bloodGroup) where.bloodGroup = req.query.bloodGroup;

  const { rows, count } = await Patient.findAndCountAll({
    ...(isDoctor && { attributes: ['patientId'] }),
    where,
    include: [{
      model: User,
      attributes: isDoctor ? ['firstName', 'lastName'] : ['userId', 'firstName', 'lastName', 'email', 'phone', 'isActive', 'avatarUrl'],
      where: userWhere,
    }],
    limit,
    offset,
    order: [['patientId', 'DESC']],
    distinct: true,
  });

  new ApiResponse(200, rows, 'OK', buildMeta({ page, limit, total: count })).send(res);
});

const getPatient = asyncHandler(async (req, res) => {
  const patient = await Patient.findByPk(req.params.id, { include: patientIncludes });
  if (!patient) throw ApiError.notFound('Patient not found');
  await assertCanAccessPatient(req, patient);
  new ApiResponse(200, patient).send(res);
});

/** Returns the patient profile for the currently authenticated patient user. */
const getMyPatientProfile = asyncHandler(async (req, res) => {
  if (req.user.roleName !== 'patient') throw ApiError.forbidden('Only patient accounts have a patient profile');
  const patient = await Patient.findOne({ where: { userId: req.user.userId }, include: patientIncludes });
  if (!patient) throw ApiError.notFound('Patient profile not found');
  new ApiResponse(200, patient).send(res);
});

const updatePatient = asyncHandler(async (req, res) => {
  const patient = await Patient.findByPk(req.params.id);
  if (!patient) throw ApiError.notFound('Patient not found');
  await assertCanAccessPatient(req, patient);

  const {
    gender, bloodGroup, addressLine1, addressLine2, city, state, postalCode, country,
    firstName, lastName, phone,
  } = req.body;

  Object.assign(patient, {
    ...(gender !== undefined && { gender }),
    ...(bloodGroup !== undefined && { bloodGroup }),
    ...(addressLine1 !== undefined && { addressLine1 }),
    ...(addressLine2 !== undefined && { addressLine2 }),
    ...(city !== undefined && { city }),
    ...(state !== undefined && { state }),
    ...(postalCode !== undefined && { postalCode }),
    ...(country !== undefined && { country }),
  });
  await patient.save();

  if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
    await User.update(
      { ...(firstName !== undefined && { firstName }), ...(lastName !== undefined && { lastName }), ...(phone !== undefined && { phone }) },
      { where: { userId: patient.userId } }
    );
  }

  await auditLog.record({ userId: req.user.userId, action: 'UPDATE_PATIENT', entityType: 'Patient', entityId: patient.patientId, ipAddress: req.ip });

  const full = await Patient.findByPk(patient.patientId, { include: patientIncludes });
  new ApiResponse(200, full, 'Patient updated').send(res);
});

const deletePatient = asyncHandler(async (req, res) => {
  const patient = await Patient.findByPk(req.params.id);
  if (!patient) throw ApiError.notFound('Patient not found');

  await User.update({ isActive: false }, { where: { userId: patient.userId } });

  await auditLog.record({ userId: req.user.userId, action: 'DEACTIVATE_PATIENT', entityType: 'Patient', entityId: patient.patientId, ipAddress: req.ip });
  new ApiResponse(200, null, 'Patient account deactivated').send(res);
});

const addEmergencyContact = asyncHandler(async (req, res) => {
  const patient = await Patient.findByPk(req.params.id);
  if (!patient) throw ApiError.notFound('Patient not found');
  await assertCanAccessPatient(req, patient);

  const { fullName, relationship, phone, email, isPrimary } = req.body;
  const contact = await PatientEmergencyContact.create({
    patientId: patient.patientId,
    fullName,
    relationship,
    phone,
    email: email || null,
    isPrimary: isPrimary ?? false,
  });
  new ApiResponse(201, contact, 'Emergency contact added').send(res);
});

const addInsurance = asyncHandler(async (req, res) => {
  const patient = await Patient.findByPk(req.params.id);
  if (!patient) throw ApiError.notFound('Patient not found');
  await assertCanAccessPatient(req, patient);

  const { providerName, policyNumber, groupNumber, validFrom, validUntil } = req.body;
  const insurance = await PatientInsurance.create({
    patientId: patient.patientId,
    providerName,
    policyNumber,
    groupNumber: groupNumber || null,
    validFrom: validFrom || null,
    validUntil: validUntil || null,
  });
  new ApiResponse(201, insurance, 'Insurance policy added').send(res);
});

module.exports = {
  createPatient, listPatients, getPatient, getMyPatientProfile, updatePatient, deletePatient,
  addEmergencyContact, addInsurance, assertCanAccessPatient,
};
