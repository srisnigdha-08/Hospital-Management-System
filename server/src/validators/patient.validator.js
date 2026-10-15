const { body, param, query } = require('express-validator');

const createRules = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('phone').optional({ values: 'falsy' }).isMobilePhone('any').withMessage('Invalid phone number'),
  body('dateOfBirth').isISO8601().toDate().withMessage('A valid date of birth is required'),
  body('gender').isIn(['male', 'female', 'other']).withMessage('Invalid gender'),
  body('bloodGroup')
    .optional()
    .isIn(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']),
  body('emergencyContacts').optional().isArray(),
  body('emergencyContacts.*.fullName').trim().notEmpty().isLength({ max: 120 }),
  body('emergencyContacts.*.relationship').trim().notEmpty().isLength({ max: 60 }),
  body('emergencyContacts.*.phone').trim().notEmpty().isMobilePhone('any'),
  body('emergencyContacts.*.email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('emergencyContacts.*.isPrimary').optional().isBoolean(),
  body('insurancePolicies').optional().isArray(),
  body('insurancePolicies.*.providerName').trim().notEmpty().isLength({ max: 120 }),
  body('insurancePolicies.*.policyNumber').trim().notEmpty().isLength({ max: 80 }),
  body('insurancePolicies.*.groupNumber').optional({ values: 'falsy' }).isLength({ max: 80 }),
  body('insurancePolicies.*.validFrom').optional({ values: 'falsy' }).isISO8601(),
  body('insurancePolicies.*.validUntil').optional({ values: 'falsy' }).isISO8601(),
];

const updateRules = [
  param('id').isInt().withMessage('Invalid patient id'),
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('phone').optional({ values: 'falsy' }).isMobilePhone('any'),
  body('gender').optional().isIn(['male', 'female', 'other']),
  body('bloodGroup').optional().isIn(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']),
  body('addressLine1').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
  body('addressLine2').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
  body('city').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('state').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('postalCode').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
  body('country').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
];

const emergencyContactRules = [
  body('fullName').trim().notEmpty().isLength({ max: 120 }),
  body('relationship').trim().notEmpty().isLength({ max: 60 }),
  body('phone').trim().notEmpty().isMobilePhone('any'),
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('isPrimary').optional().isBoolean(),
];

const insuranceRules = [
  body('providerName').trim().notEmpty().isLength({ max: 120 }),
  body('policyNumber').trim().notEmpty().isLength({ max: 80 }),
  body('groupNumber').optional({ values: 'falsy' }).isLength({ max: 80 }),
  body('validFrom').optional({ values: 'falsy' }).isISO8601(),
  body('validUntil').optional({ values: 'falsy' }).isISO8601(),
];

const idParamRule = [param('id').isInt().withMessage('Invalid patient id')];

const listQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().trim(),
];

module.exports = { createRules, updateRules, emergencyContactRules, insuranceRules, idParamRule, listQueryRules };
