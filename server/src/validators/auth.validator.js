const { body } = require('express-validator');

const strongPassword = body('password')
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters')
  .matches(/[A-Z]/)
  .withMessage('Password must contain an uppercase letter')
  .matches(/[0-9]/)
  .withMessage('Password must contain a number');

const registerRules = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('phone').optional({ values: 'falsy' }).isMobilePhone('any').withMessage('Invalid phone number'),
  strongPassword,
  body('role')
    .optional()
    .isIn(['patient', 'doctor', 'receptionist', 'admin'])
    .withMessage('Invalid role'),
];

const loginRules = [
  body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

const forgotPasswordRules = [body('email').isEmail().withMessage('A valid email is required').normalizeEmail()];

const resetPasswordRules = [
  body('token').notEmpty().withMessage('Reset token is required'),
  strongPassword,
];

const changePasswordRules = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('New password must contain an uppercase letter')
    .matches(/[0-9]/)
    .withMessage('New password must contain a number'),
];

const refreshRules = [body('refreshToken').notEmpty().withMessage('Refresh token is required')];

module.exports = {
  registerRules,
  loginRules,
  forgotPasswordRules,
  resetPasswordRules,
  changePasswordRules,
  refreshRules,
};
