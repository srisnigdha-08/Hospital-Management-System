const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User, Role, Doctor, Patient } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const auditLog = require('../services/auditLog.service');
const { getPagination, buildMeta } = require('../utils/pagination');

const SALT_ROUNDS = 12;

/** Admin-only: creates a receptionist or admin account. Doctor accounts are
 *  created via POST /api/doctors (they need doctor-specific fields), and
 *  patient accounts via POST /api/auth/register or POST /api/patients. */
const createStaffUser = asyncHandler(async (req, res) => {
  const { firstName, lastName, email, phone, password, role } = req.body;

  if (!['admin', 'receptionist'].includes(role)) {
    throw ApiError.badRequest('This endpoint only creates admin or receptionist accounts');
  }

  const existing = await User.findOne({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const roleRow = await Role.findOne({ where: { roleName: role } });
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await User.create({ roleId: roleRow.roleId, firstName, lastName, email, phone, passwordHash });

  await auditLog.record({ userId: req.user.userId, action: 'CREATE_STAFF_USER', entityType: 'User', entityId: user.userId, ipAddress: req.ip });

  new ApiResponse(201, user.toSafeJSON(), 'Staff account created').send(res);
});

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const where = {};

  if (req.query.role) {
    const roleRow = await Role.findOne({ where: { roleName: req.query.role } });
    where.roleId = roleRow ? roleRow.roleId : -1;
  }
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    where[Op.or] = [{ firstName: { [Op.like]: term } }, { lastName: { [Op.like]: term } }, { email: { [Op.like]: term } }];
  }

  const { rows, count } = await User.findAndCountAll({
    where,
    include: [{ model: Role }],
    limit,
    offset,
    order: [['userId', 'DESC']],
  });

  new ApiResponse(200, rows.map((u) => ({ ...u.toSafeJSON(), roleName: u.Role.roleName })), 'OK', buildMeta({ page, limit, total: count })).send(res);
});

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.params.id, { include: [{ model: Role }] });
  if (!user) throw ApiError.notFound('User not found');
  new ApiResponse(200, { ...user.toSafeJSON(), roleName: user.Role.roleName }).send(res);
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const { firstName, lastName, phone, isActive } = req.body;
  Object.assign(user, {
    ...(firstName !== undefined && { firstName }),
    ...(lastName !== undefined && { lastName }),
    ...(phone !== undefined && { phone }),
    ...(isActive !== undefined && { isActive }),
  });
  await user.save();

  await auditLog.record({ userId: req.user.userId, action: 'UPDATE_USER', entityType: 'User', entityId: user.userId, ipAddress: req.ip });

  new ApiResponse(200, user.toSafeJSON(), 'User updated').send(res);
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const [hasDoctor, hasPatient] = await Promise.all([
    Doctor.findOne({ where: { userId: user.userId } }),
    Patient.findOne({ where: { userId: user.userId } }),
  ]);
  if (hasDoctor || hasPatient) {
    throw ApiError.conflict('This user has a linked doctor or patient profile. Deactivate the account instead of deleting it.');
  }

  await user.destroy();
  await auditLog.record({ userId: req.user.userId, action: 'DELETE_USER', entityType: 'User', entityId: Number(req.params.id), ipAddress: req.ip });

  new ApiResponse(200, null, 'User deleted').send(res);
});

module.exports = { createStaffUser, listUsers, getUser, updateUser, deleteUser };
