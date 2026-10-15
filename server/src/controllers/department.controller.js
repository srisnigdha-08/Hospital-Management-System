const { Op } = require('sequelize');
const { Department, Doctor } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const auditLog = require('../services/auditLog.service');
const { getPagination, buildMeta } = require('../utils/pagination');

const listDepartments = asyncHandler(async (req, res) => {
  if (req.query.all === 'true') {
    const departments = await Department.findAll({ where: { isActive: true }, order: [['name', 'ASC']] });
    return new ApiResponse(200, departments).send(res);
  }

  const { page, limit, offset } = getPagination(req.query);
  const where = req.query.search ? { name: { [Op.like]: `%${req.query.search}%` } } : {};

  const { rows, count } = await Department.findAndCountAll({ where, limit, offset, order: [['name', 'ASC']] });
  new ApiResponse(200, rows, 'OK', buildMeta({ page, limit, total: count })).send(res);
});

const getDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findByPk(req.params.id, {
    include: [{ model: Doctor, attributes: ['doctorId', 'specialization'] }],
  });
  if (!department) throw ApiError.notFound('Department not found');
  new ApiResponse(200, department).send(res);
});

const createDepartment = asyncHandler(async (req, res) => {
  const { name, description, location } = req.body;
  const existing = await Department.findOne({ where: { name } });
  if (existing) throw ApiError.conflict('A department with this name already exists');

  const department = await Department.create({ name, description, location });
  await auditLog.record({ userId: req.user.userId, action: 'CREATE_DEPARTMENT', entityType: 'Department', entityId: department.departmentId, ipAddress: req.ip });

  new ApiResponse(201, department, 'Department created').send(res);
});

const updateDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findByPk(req.params.id);
  if (!department) throw ApiError.notFound('Department not found');

  const { name, description, location, isActive } = req.body;
  Object.assign(department, {
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(location !== undefined && { location }),
    ...(isActive !== undefined && { isActive }),
  });
  await department.save();

  await auditLog.record({ userId: req.user.userId, action: 'UPDATE_DEPARTMENT', entityType: 'Department', entityId: department.departmentId, ipAddress: req.ip });
  new ApiResponse(200, department, 'Department updated').send(res);
});

const deleteDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findByPk(req.params.id);
  if (!department) throw ApiError.notFound('Department not found');

  const doctorCount = await Doctor.count({ where: { departmentId: department.departmentId } });
  if (doctorCount > 0) {
    throw ApiError.conflict('This department still has doctors assigned to it. Reassign them before deleting.');
  }

  await department.destroy();
  await auditLog.record({ userId: req.user.userId, action: 'DELETE_DEPARTMENT', entityType: 'Department', entityId: Number(req.params.id), ipAddress: req.ip });
  new ApiResponse(200, null, 'Department deleted').send(res);
});

module.exports = { listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment };
