const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { sequelize, User, Role, Doctor, DoctorSchedule, Department } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const auditLog = require('../services/auditLog.service');
const { getPagination, buildMeta } = require('../utils/pagination');

const SALT_ROUNDS = 12;

const doctorIncludes = [
  { model: Department },
  { model: User, attributes: ['userId', 'firstName', 'lastName', 'email', 'phone', 'isActive', 'avatarUrl'] },
  { model: DoctorSchedule },
];

/** Admin-only: creates the login account and doctor profile together. */
const createDoctor = asyncHandler(async (req, res) => {
  const {
    firstName, lastName, email, phone, password,
    departmentId, specialization, qualification, experienceYears,
    licenseNumber, consultationFee, bio, schedules,
  } = req.body;

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) throw ApiError.conflict('An account with this email already exists');

  const existingLicense = await Doctor.findOne({ where: { licenseNumber } });
  if (existingLicense) throw ApiError.conflict('A doctor with this license number already exists');

  const doctorRole = await Role.findOne({ where: { roleName: 'doctor' } });

  const doctor = await sequelize.transaction(async (t) => {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create(
      { roleId: doctorRole.roleId, firstName, lastName, email, phone, passwordHash },
      { transaction: t }
    );

    const created = await Doctor.create(
      {
        userId: user.userId,
        departmentId,
        specialization,
        qualification,
        experienceYears: experienceYears || 0,
        licenseNumber,
        consultationFee: consultationFee || 0,
        bio,
      },
      { transaction: t }
    );

    if (Array.isArray(schedules) && schedules.length) {
      await DoctorSchedule.bulkCreate(
        schedules.map((s) => ({ ...s, doctorId: created.doctorId })),
        { transaction: t }
      );
    }

    return created;
  });

  await auditLog.record({ userId: req.user.userId, action: 'CREATE_DOCTOR', entityType: 'Doctor', entityId: doctor.doctorId, ipAddress: req.ip });

  const full = await Doctor.findByPk(doctor.doctorId, { include: doctorIncludes });
  new ApiResponse(201, full, 'Doctor created').send(res);
});

const listDoctors = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const where = {};
  if (req.query.department) where.departmentId = req.query.department;

  const userWhere = {};
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    userWhere[Op.or] = [{ firstName: { [Op.like]: term } }, { lastName: { [Op.like]: term } }];
  }

  const { rows, count } = await Doctor.findAndCountAll({
    where,
    include: [
      { model: Department },
      { model: User, attributes: ['userId', 'firstName', 'lastName', 'email', 'phone', 'isActive', 'avatarUrl'], where: userWhere },
    ],
    limit,
    offset,
    order: [['doctorId', 'DESC']],
    distinct: true,
  });

  new ApiResponse(200, rows, 'OK', buildMeta({ page, limit, total: count })).send(res);
});

const getDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findByPk(req.params.id, { include: doctorIncludes });
  if (!doctor) throw ApiError.notFound('Doctor not found');
  new ApiResponse(200, doctor).send(res);
});

const updateDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findByPk(req.params.id);
  if (!doctor) throw ApiError.notFound('Doctor not found');

  const { departmentId, specialization, qualification, experienceYears, consultationFee, bio, isAvailable } = req.body;
  Object.assign(doctor, {
    ...(departmentId !== undefined && { departmentId }),
    ...(specialization !== undefined && { specialization }),
    ...(qualification !== undefined && { qualification }),
    ...(experienceYears !== undefined && { experienceYears }),
    ...(consultationFee !== undefined && { consultationFee }),
    ...(bio !== undefined && { bio }),
    ...(isAvailable !== undefined && { isAvailable }),
  });
  await doctor.save();

  await auditLog.record({ userId: req.user.userId, action: 'UPDATE_DOCTOR', entityType: 'Doctor', entityId: doctor.doctorId, ipAddress: req.ip });

  const full = await Doctor.findByPk(doctor.doctorId, { include: doctorIncludes });
  new ApiResponse(200, full, 'Doctor updated').send(res);
});

const deleteDoctor = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findByPk(req.params.id);
  if (!doctor) throw ApiError.notFound('Doctor not found');

  await User.update({ isActive: false }, { where: { userId: doctor.userId } });
  doctor.isAvailable = false;
  await doctor.save();

  await auditLog.record({ userId: req.user.userId, action: 'DEACTIVATE_DOCTOR', entityType: 'Doctor', entityId: doctor.doctorId, ipAddress: req.ip });
  new ApiResponse(200, null, 'Doctor deactivated').send(res);
});

/** Replaces a doctor's weekly recurring schedule. */
const setSchedule = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findByPk(req.params.id);
  if (!doctor) throw ApiError.notFound('Doctor not found');
  if (req.user.roleName === 'doctor' && doctor.userId !== req.user.userId) {
    throw ApiError.forbidden('You can only edit your own schedule');
  }

  const { schedules } = req.body;
  if (!Array.isArray(schedules)) throw ApiError.badRequest('schedules must be an array');

  await sequelize.transaction(async (t) => {
    await DoctorSchedule.destroy({ where: { doctorId: doctor.doctorId }, transaction: t });
    if (schedules.length) {
      await DoctorSchedule.bulkCreate(
        schedules.map((s) => ({ ...s, doctorId: doctor.doctorId })),
        { transaction: t }
      );
    }
  });

  const updated = await DoctorSchedule.findAll({ where: { doctorId: doctor.doctorId }, order: [['dayOfWeek', 'ASC']] });
  new ApiResponse(200, updated, 'Schedule updated').send(res);
});

module.exports = { createDoctor, listDoctors, getDoctor, updateDoctor, deleteDoctor, setSchedule };
