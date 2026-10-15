const { body, param, query } = require('express-validator');

const createRules = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('phone').optional({ values: 'falsy' }).isMobilePhone('any'),
  body('departmentId').isInt().withMessage('A valid department is required'),
  body('specialization').trim().notEmpty().withMessage('Specialization is required'),
  body('qualification').trim().notEmpty().withMessage('Qualification is required'),
  body('experienceYears').optional().isInt({ min: 0 }),
  body('licenseNumber').trim().notEmpty().withMessage('License number is required'),
  body('consultationFee').optional().isFloat({ min: 0 }),
  body('schedules').optional().isArray(),
];

const updateRules = [
  param('id').isInt().withMessage('Invalid doctor id'),
  body('departmentId').optional().isInt(),
  body('specialization').optional().trim().notEmpty(),
  body('experienceYears').optional().isInt({ min: 0 }),
  body('consultationFee').optional().isFloat({ min: 0 }),
  body('isAvailable').optional().isBoolean(),
];

const idParamRule = [param('id').isInt().withMessage('Invalid doctor id')];

const listQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('department').optional().isInt(),
  query('search').optional().trim(),
];

module.exports = { createRules, updateRules, idParamRule, listQueryRules };
