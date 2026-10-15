const { body, param } = require('express-validator');

const createRules = [
  body('name').trim().notEmpty().withMessage('Department name is required'),
  body('description').optional().trim().isLength({ max: 500 }),
  body('location').optional().trim().isLength({ max: 120 }),
];

const updateRules = [
  param('id').isInt().withMessage('Invalid department id'),
  body('name').optional().trim().notEmpty(),
  body('isActive').optional().isBoolean(),
];

const idParamRule = [param('id').isInt().withMessage('Invalid department id')];

module.exports = { createRules, updateRules, idParamRule };
